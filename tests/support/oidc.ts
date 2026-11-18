import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export async function mockIdentityProvider() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'fixture-key', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { subject: string; nonce: string; challenge: string; redirect: string }>();
  const clientId = 'herd-test';
  const clientSecret = 'fixture-client-secret';
  let issuer = '';
  let exchanges = 0;

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', issuer);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration') {
      json({
        issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token', jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'], code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic'],
      });
    } else if (url.pathname === '/jwks') {
      json({ keys: [jwk] });
    } else if (url.pathname === '/authorize') {
      const query = url.searchParams;
      const redirect = query.get('redirect_uri');
      const nonce = query.get('nonce');
      const challenge = query.get('code_challenge');
      if (!redirect || !nonce || !challenge || query.get('code_challenge_method') !== 'S256' || query.get('client_id') !== clientId ||
        !query.get('state') || query.get('response_type') !== 'code' || !query.get('scope')?.includes('openid')) {
        json({ error: 'invalid_request' }, 400);
        return;
      }
      const code = randomUUID();
      const subject = query.get('test_subject') ?? 'alice';
      codes.set(code, { subject, nonce: query.has('bad_nonce') ? 'incorrect' : nonce, challenge, redirect });
      const callback = new URL(redirect);
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', query.get('state')!);
      response.writeHead(302, { location: callback.href }).end();
    } else if (url.pathname === '/token' && request.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const data of request) chunks.push(data);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const code = body.get('code') ?? '';
      const grant = codes.get(code);
      codes.delete(code);
      exchanges += 1;
      const authorization = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(request.headers.authorization ?? '');
      const credentials = authorization ? Buffer.from(authorization[1], 'base64').toString().split(':')
        .map(value => new URLSearchParams('value=' + value).get('value')) : [];
      const check = {
        knownCode: Boolean(grant),
        client: credentials.length === 2 && credentials[0] === clientId && credentials[1] === clientSecret,
        grantType: body.get('grant_type') === 'authorization_code',
        redirect: body.get('redirect_uri') === grant?.redirect,
        pkce: createHash('sha256').update(body.get('code_verifier') ?? '').digest('base64url') === grant?.challenge,
      };
      const invalid = Object.entries(check).filter(([, valid]) => !valid).map(([name]) => name);
      if (invalid.length || !grant) {
        json({ error: 'invalid_grant', error_description: 'Failed checks: ' + invalid.join(', ') }, 400);
        return;
      }
      const encode = (input: unknown) => Buffer.from(JSON.stringify(input)).toString('base64url');
      const iat = Math.floor(Date.now() / 1000);
      const input = encode({ alg: 'RS256', kid: jwk.kid }) + '.' +
        encode({ iss: issuer, aud: clientId, sub: grant.subject, name: grant.subject, iat, exp: iat + 600, nonce: grant.nonce });
      const signature = sign('sha256', Buffer.from(input), keys.privateKey);
      json({ access_token: 'fixture-access-token', token_type: 'Bearer', id_token: input + '.' + signature.toString('base64url') });
    } else {
      json({ error: 'not_found' }, 404);
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot start mock OIDC issuer.');
  issuer = 'http://127.0.0.1:' + address.port;
  return {
    settings: { issuer: new URL(issuer), clientId, clientSecret, allowHttp: true },
    get exchanges() { return exchanges; },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  };
}
