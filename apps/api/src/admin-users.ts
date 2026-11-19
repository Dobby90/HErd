import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { lockMembershipChanges, requireActiveAccount } from './account-access.js';
import { ApiError, objectBody, uuid } from './api-error.js';
import type { Authenticate } from './auth.js';
import { transaction } from './database.js';
import { userSearch } from './user-search.js';

const pageSize = 25;

function requireAdmin(isAdmin: boolean) {
  if (!isAdmin) throw new ApiError(403, 'ADMIN_REQUIRED', '서비스 관리자 권한이 필요합니다.');
}

export function registerAdminUsers(api: FastifyInstance, pool: Pool, authenticate: Authenticate) {
  const path = '/api/admin/users';
  api.get<{ Querystring: { q?: string; page?: string } }>(path, async request => {
    const { user } = await authenticate(request);
    requireAdmin(user.isAdmin);
    const query = userSearch(request.query.q, 0);
    const page = request.query.page ?? '1';
    if (typeof page !== 'string' || !/^[1-9][0-9]{0,7}$/.test(page)) {
      throw new ApiError(400, 'INVALID_PAGE', '페이지 번호를 확인하세요.');
    }
    const { rows } = await pool.query(`SELECT u.id, u.display_name AS "displayName", p.username,
      u.is_admin AS "isAdmin", u.disabled_at IS NOT NULL AS disabled,
      CASE WHEN p.user_id IS NOT NULL THEN 'password'
        WHEN u.issuer = 'urn:herd:development' THEN 'development' ELSE 'oidc' END AS "authMethod"
      FROM users u LEFT JOIN password_credentials p ON p.user_id = u.id
      WHERE $1 = '' OR strpos(lower(u.display_name), lower($1)) > 0
        OR strpos(p.username, lower($1)) > 0
      ORDER BY lower(u.display_name), u.id LIMIT $3 OFFSET $2`, [query, (Number(page) - 1) * pageSize, pageSize + 1]);
    return { users: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
  });

  api.patch<{ Params: { userId: string } }>(path + '/:userId', { bodyLimit: 4096 }, async (request, reply) => {
    const { user } = await authenticate(request, true);
    requireAdmin(user.isAdmin);
    const targetId = uuid(request.params.userId);
    const { disabled } = objectBody(request.body);
    if (typeof disabled !== 'boolean') throw new ApiError(400, 'INVALID_ACCOUNT_STATUS', '변경할 계정 상태를 선택하세요.');
    const changed = await transaction(pool, async client => {
      await lockMembershipChanges(client);
      requireAdmin((await requireActiveAccount(client, user.id)).isAdmin);
      const { rows: [target] } = await client.query<{ isAdmin: boolean; disabled: boolean }>(
        'SELECT is_admin AS "isAdmin", disabled_at IS NOT NULL AS disabled FROM users WHERE id = $1 FOR UPDATE', [targetId]);
      if (!target) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '사용자를 찾을 수 없습니다.');
      if (target.isAdmin) throw new ApiError(409, 'ADMIN_ACCOUNT_PROTECTED', '서비스 관리자 계정은 사용자 관리에서 상태를 변경할 수 없습니다.');
      if (target.disabled === disabled) return false;
      if (disabled) {
        const { rowCount } = await client.query(`SELECT 1 FROM project_members owned
          WHERE owned.user_id = $1 AND owned.role = 'owner' AND NOT EXISTS (
            SELECT 1 FROM project_members other JOIN users u ON u.id = other.user_id
            WHERE other.project_id = owned.project_id AND other.user_id <> $1 AND other.role = 'owner' AND u.disabled_at IS NULL
          ) LIMIT 1`, [targetId]);
        if (rowCount) throw new ApiError(409, 'LAST_OWNER', '이 계정이 유일한 활성 소유자인 프로젝트에 다른 소유자를 지정하세요.');
      }
      await client.query('UPDATE users SET disabled_at = CASE WHEN $2 THEN now() END WHERE id = $1', [targetId, disabled]);
      if (disabled) await client.query('DELETE FROM sessions WHERE user_id = $1', [targetId]);
      return true;
    });
    if (changed) request.log.info({ actorId: user.id, targetId, disabled }, 'Account status changed');
    return reply.code(204).send();
  });
}
