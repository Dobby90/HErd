import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, objectBody } from './api-error.js';

type IssueSession = (request: FastifyRequest, reply: FastifyReply, user: (client: PoolClient) => Promise<string>) => Promise<void>;
const dummySalt = randomBytes(16);
const dummyHash = randomBytes(64);
const bodyLimit = 4096;
const throttled = () => new ApiError(429, 'AUTH_THROTTLED', '인증 요청이 많습니다. 잠시 후 다시 시도하세요.');
const invalidLogin = () => new ApiError(401, 'INVALID_CREDENTIALS', '아이디 또는 비밀번호가 올바르지 않습니다.');
const duplicate = () => new ApiError(409, 'USERNAME_UNAVAILABLE', '이미 사용 중인 아이디입니다.');

function credentials(body: Record<string, unknown>) {
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : '';
  const password = body.password;
  if (!/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(username) || typeof password !== 'string' ||
      !password.length || Buffer.byteLength(password) > 512) return;
  return { username, password };
}

export function registerLocalAuth(api: FastifyInstance, pool: Pool, assertOrigin: (request: FastifyRequest) => void, issueSession: IssueSession) {
  let active = 0;
  async function derive(password: string, salt: Buffer) {
    if (active >= 2) throw throttled();
    active++;
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, value) => {
          if (error) reject(error);
          else resolve(value);
        });
      });
    } finally {
      active--;
    }
  }

  async function countAttempt(key: string, max: number, seconds: number) {
    const { rowCount } = await pool.query(`INSERT INTO password_attempts (key, attempts, expires_at)
      VALUES ($1, 1, now() + $3 * interval '1 second')
      ON CONFLICT (key) DO UPDATE SET
        attempts = CASE WHEN password_attempts.expires_at <= now() THEN 1 ELSE password_attempts.attempts + 1 END,
        expires_at = CASE WHEN password_attempts.expires_at <= now() THEN EXCLUDED.expires_at ELSE password_attempts.expires_at END
      WHERE password_attempts.expires_at <= now() OR password_attempts.attempts < $2`, [key, max, seconds]);
    if (!rowCount) throw throttled();
  }

  api.post('/api/auth/register', { bodyLimit }, async (request, reply) => {
    assertOrigin(request);
    const body = objectBody(request.body);
    const input = credentials(body);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    if (!input || !displayName || displayName.length > 100 || displayName.includes('\0')) {
      throw new ApiError(400, 'INVALID_ACCOUNT', '아이디는 영문 소문자·숫자로 시작하는 3~64자, 표시 이름은 1~100자로 입력하고 비밀번호를 입력하세요.');
    }
    await countAttempt('register', 60, 3600);
    const existing = await pool.query('SELECT 1 FROM password_credentials WHERE username = $1', [input.username]);
    if (existing.rowCount) throw duplicate();
    const salt = randomBytes(16);
    const passwordHash = await derive(input.password, salt);
    await issueSession(request, reply, async client => {
      const id = randomUUID();
      await client.query("INSERT INTO users (id, issuer, subject, display_name) VALUES ($1, 'urn:herd:password', $1::uuid::text, $2)", [id, displayName]);
      const inserted = await client.query(`INSERT INTO password_credentials (user_id, username, password_salt, password_hash)
        VALUES ($1, $2, $3, $4) ON CONFLICT (username) DO NOTHING`, [id, input.username, salt, passwordHash]);
      if (!inserted.rowCount) throw duplicate();
      return id;
    });
    return reply.code(204).send();
  });

  api.post('/api/auth/password', { bodyLimit }, async (request, reply) => {
    assertOrigin(request);
    const input = credentials(objectBody(request.body));
    if (!input) throw invalidLogin();
    await countAttempt('login', 600, 600);
    const accountKey = createHash('sha256').update(input.username).digest('hex');
    await countAttempt('account:' + accountKey, 10, 600);
    const { rows: [account] } = await pool.query<{ user_id: string; password_salt: Buffer; password_hash: Buffer }>(
      'SELECT user_id, password_salt, password_hash FROM password_credentials WHERE username = $1', [input.username]);
    const candidate = await derive(input.password, account?.password_salt ?? dummySalt);
    if (!timingSafeEqual(candidate, account?.password_hash ?? dummyHash) || !account) throw invalidLogin();
    await issueSession(request, reply, async () => account.user_id);
    return reply.code(204).send();
  });
}
