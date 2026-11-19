import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError, objectBody } from './api-error.js';
import type { Authenticate } from './auth.js';

export type DirectoryProfile = { publicName: string; alias: string };

export function userSearch(value: unknown, minimum: number) {
  const query = value === undefined ? '' : typeof value === 'string' ? value.trim() : undefined;
  if (query === undefined || query.length < minimum || query.length > 100 || query.includes('\0')) {
    throw new ApiError(400, 'INVALID_USER_SEARCH', minimum
      ? `이름 또는 별칭을 ${minimum}~100자로 입력하세요.` : '검색어는 100자까지 입력할 수 있습니다.');
  }
  return query;
}

export function registerUserDirectory(api: FastifyInstance, pool: Pool, authenticate: Authenticate) {
  api.patch('/api/me/directory', { bodyLimit: 4096 }, async (request, reply) => {
    const { user } = await authenticate(request, true);
    const body = objectBody(request.body);
    if (body.publicName === null && body.alias === null) {
      await pool.query('UPDATE users SET directory_name = NULL, directory_alias = NULL WHERE id = $1', [user.id]);
      return reply.code(204).send();
    }
    const publicName = typeof body.publicName === 'string' ? body.publicName.trim() : '';
    const alias = typeof body.alias === 'string' ? body.alias.trim().toLowerCase() : '';
    if (!publicName || publicName.length > 100 || publicName.includes('\0') || !/^[a-z0-9][a-z0-9_.-]{2,63}$/.test(alias)) {
      throw new ApiError(400, 'INVALID_DIRECTORY_PROFILE',
        '공개 이름은 1~100자, 별칭은 영문 또는 숫자로 시작하는 3~64자로 입력하세요.');
    }
    try {
      await pool.query('UPDATE users SET directory_name = $2, directory_alias = $3 WHERE id = $1', [user.id, publicName, alias]);
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'users_directory_alias_unique') {
        throw new ApiError(409, 'DIRECTORY_ALIAS_UNAVAILABLE', '이미 사용 중인 공개 별칭입니다.');
      }
      throw error;
    }
    return { publicName, alias };
  });
}
