import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as oidc from 'openid-client';
import type { Pool } from 'pg';
import { ApiError } from './api-error.js';
import type { AuthSettings } from './config.js';
import { transaction } from './database.js';

interface User {
  id: string;
  displayName: string;
}

interface Session {
  user: User;
  token: string;
  csrfToken: string;
}

const sessionLifetime = 60 * 60 * 24 * 7;
const loginLifetime = 60 * 10;
const token = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const callbackPath = '/api/auth/callback';
const workspacePath = '/?workspace=1';

export async function registerAuth(api: FastifyInstance, pool: Pool, settings: AuthSettings) {
  await api.register(cookie);
  const secure = settings.origin.startsWith('https:');
  const sessionCookie = secure ? '__Host-herd-session' : 'herd-session';
  const loginCookie = secure ? '__Host-herd-login' : 'herd-login';
  const options: CookieSerializeOptions = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  const redirectUri = new URL(callbackPath, settings.origin);
  let configuration: Promise<oidc.Configuration> | undefined;

  function provider() {
    const settingsOidc = settings.oidc;
    if (!settingsOidc) throw new ApiError(404, 'OIDC_UNAVAILABLE', 'OIDC 로그인이 설정되지 않았습니다.');
    configuration ??= oidc.discovery(settingsOidc.issuer, settingsOidc.clientId, settingsOidc.clientSecret,
      oidc.ClientSecretBasic(settingsOidc.clientSecret), {
        execute: settingsOidc.allowHttp
          ? [oidc.allowInsecureRequests, oidc.enableNonRepudiationChecks]
          : [oidc.enableNonRepudiationChecks],
        timeout: 10,
      }).catch(() => {
        configuration = undefined;
        throw new ApiError(502, 'OIDC_UNAVAILABLE', '로그인 공급자에 연결하지 못했습니다.');
      });
    return configuration;
  }

  function assertOrigin(request: FastifyRequest) {
    if (request.headers.origin !== settings.origin) throw new ApiError(403, 'CSRF_REJECTED', '요청 출처를 확인할 수 없습니다.');
  }

  async function session(request: FastifyRequest): Promise<Session | undefined> {
    const raw = request.cookies[sessionCookie];
    if (!raw) return;
    const { rows } = await pool.query<User>(`SELECT u.id, u.display_name AS "displayName"
      FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`, [hash(raw)]);
    if (rows[0]) return { user: rows[0], token: raw, csrfToken: hash('herd:csrf:' + raw) };
  }

  async function requireUser(request: FastifyRequest, write = false): Promise<Session> {
    const current = await session(request);
    if (!current) throw new ApiError(401, 'LOGIN_REQUIRED', '로그인이 필요합니다.');
    if (write) {
      assertOrigin(request);
      const supplied = request.headers['x-csrf-token'];
      if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) ||
          !timingSafeEqual(Buffer.from(current.csrfToken), Buffer.from(supplied))) {
        throw new ApiError(403, 'CSRF_REJECTED', '요청을 확인할 수 없습니다. 화면을 다시 열어 주세요.');
      }
    }
    return current;
  }

  async function createSession(request: FastifyRequest, reply: FastifyReply, issuer: string, subject: string, displayName: string) {
    const raw = token();
    await transaction(pool, async client => {
      const { rows: [user] } = await client.query<{ id: string }>(`INSERT INTO users (id, issuer, subject, display_name)
        VALUES ($1, $2, $3, $4) ON CONFLICT (issuer, subject) DO UPDATE SET display_name = EXCLUDED.display_name RETURNING id`,
      [randomUUID(), issuer, subject, displayName]);
      const previous = request.cookies[sessionCookie];
      await client.query('DELETE FROM sessions WHERE expires_at <= now() OR token_hash = $1', [previous ? hash(previous) : null]);
      await client.query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + $3 * interval '1 second')",
        [hash(raw), user.id, sessionLifetime]);
    });
    reply.setCookie(sessionCookie, raw, { ...options, maxAge: sessionLifetime });
  }

  api.addHook('onRequest', (_request, reply, done) => {
    reply.header('Cache-Control', 'no-store');
    done();
  });

  api.get('/api/me', async request => {
    const current = await session(request);
    return { user: current?.user ?? null, csrfToken: current?.csrfToken ?? null,
      auth: { oidc: Boolean(settings.oidc), development: settings.devLogin } };
  });

  api.get<{ Querystring: { returnTo?: string } }>('/api/auth/login', async (request, reply) => {
    const config = await provider();
    const raw = token();
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    let returnTo = workspacePath;
    if (typeof request.query.returnTo === 'string') {
      try {
        const requested = new URL(request.query.returnTo, settings.origin);
        if (requested.origin === settings.origin && requested.pathname === '/' && requested.searchParams.has('workspace')) {
          returnTo = requested.pathname + requested.search;
        }
      } catch {
        // Use the workspace entry point for invalid return URLs.
      }
    }
    const previous = request.cookies[loginCookie];
    await transaction(pool, async client => {
      await client.query('DELETE FROM oidc_logins WHERE expires_at <= now() OR token_hash = $1', [previous ? hash(previous) : null]);
      await client.query(`INSERT INTO oidc_logins (token_hash, state, nonce, verifier, return_to, expires_at)
        VALUES ($1, $2, $3, $4, $5, now() + $6 * interval '1 second')`,
      [hash(raw), state, nonce, verifier, returnTo, loginLifetime]);
    });
    const destination = oidc.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri.href, scope: 'openid profile', state, nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    });
    return reply.setCookie(loginCookie, raw, { ...options, maxAge: loginLifetime }).redirect(destination.href);
  });

  api.get(callbackPath, async (request, reply) => {
    const raw = request.cookies[loginCookie];
    const config = await provider();
    reply.clearCookie(loginCookie, options);
    if (!raw) throw new ApiError(401, 'OIDC_LOGIN_EXPIRED', '로그인을 처음부터 다시 시작해 주세요.');
    const { rows: [pending] } = await pool.query<{ state: string; nonce: string; verifier: string; return_to: string }>(
      'DELETE FROM oidc_logins WHERE token_hash = $1 AND expires_at > now() RETURNING state, nonce, verifier, return_to', [hash(raw)]);
    if (!pending) throw new ApiError(401, 'OIDC_LOGIN_EXPIRED', '로그인을 처음부터 다시 시작해 주세요.');
    const callback = new URL(redirectUri);
    callback.search = new URL(request.url, settings.origin).search;
    const claims = await oidc.authorizationCodeGrant(config, callback, {
      expectedState: pending.state, expectedNonce: pending.nonce, pkceCodeVerifier: pending.verifier,
    }).then(result => result.claims()).catch(() => {
      throw new ApiError(401, 'OIDC_LOGIN_FAILED', '로그인 응답을 확인하지 못했습니다. 다시 로그인해 주세요.');
    });
    if (!claims?.iss || !claims.sub) throw new ApiError(401, 'OIDC_LOGIN_FAILED', '사용자 식별 정보를 확인하지 못했습니다.');
    await createSession(request, reply, claims.iss, claims.sub,
      typeof claims.name === 'string' && claims.name ? claims.name.slice(0, 200) : claims.sub.slice(0, 200));
    return reply.redirect(pending.return_to);
  });

  if (settings.devLogin) {
    api.post('/api/auth/development', async (request, reply) => {
      assertOrigin(request);
      await createSession(request, reply, 'urn:herd:development', 'developer', '로컬 개발 계정');
      return reply.code(204).send();
    });
  }

  api.post('/api/auth/logout', async (request, reply) => {
    const current = await requireUser(request, true);
    await pool.query('DELETE FROM sessions WHERE token_hash = $1', [hash(current.token)]);
    return reply.clearCookie(sessionCookie, options).code(204).send();
  });

  return requireUser;
}
