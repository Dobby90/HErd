import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { lockMembershipChanges, requireActiveAccount } from './account-access.js';
import { ApiError, objectBody, uuid } from './api-error.js';
import type { Authenticate } from './auth.js';
import { transaction } from './database.js';
import { findProject, requireRole } from './projects.js';
import type { Role } from './projects.js';
import { userSearch } from './user-search.js';

type ProjectParams = { projectId: string };
type MemberParams = ProjectParams & { userId: string };
type AccountSummary = { id: string; displayName: string; username: string | null };

// Older OIDC accounts may have the provider subject stored as their display name.
const memberName = `CASE
  WHEN u.issuer NOT IN ('urn:herd:password', 'urn:herd:development') AND u.display_name = left(u.subject, 200)
    THEN 'OIDC 사용자 ' || left(u.id::text, 8)
  ELSE u.display_name
END`;
const memberIdentity = `u.id, ${memberName} AS "displayName", p.username`;
const credentials = 'LEFT JOIN password_credentials p ON p.user_id = u.id';

function roleOf(value: unknown): Role {
  if (value === 'owner' || value === 'editor' || value === 'viewer') return value;
  throw new ApiError(400, 'INVALID_ROLE', '프로젝트 역할을 선택하세요.');
}

export function registerProjectMembers(api: FastifyInstance, pool: Pool, authenticate: Authenticate) {
  const path = '/api/projects/:projectId/members';
  api.get<{ Params: ProjectParams }>(path, async request => {
    const { user } = await authenticate(request);
    const projectId = uuid(request.params.projectId);
    return transaction(pool, async client => {
      requireRole((await findProject(client, user.id, projectId, 'share')).role, 'owner');
      const { rows } = await client.query(`SELECT ${memberIdentity}, u.disabled_at IS NOT NULL AS disabled, m.role
        FROM project_members m JOIN users u ON u.id = m.user_id ${credentials} WHERE m.project_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, "displayName", u.id`, [projectId]);
      return rows;
    });
  });

  api.get<{ Params: ProjectParams; Querystring: { q?: string } }>(path + '/candidates', async request => {
    const { user } = await authenticate(request);
    const projectId = uuid(request.params.projectId);
    return transaction(pool, async client => {
      requireRole((await findProject(client, user.id, projectId, 'share')).role, 'owner');
      const query = userSearch(request.query.q, 1);
      const { rows } = await client.query<AccountSummary>(`SELECT ${memberIdentity}
        FROM users u ${credentials} WHERE u.disabled_at IS NULL
        AND (strpos(lower(${memberName}), lower($2)) > 0 OR strpos(p.username, lower($2)) > 0)
        AND NOT EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = $1 AND m.user_id = u.id)
        ORDER BY lower(${memberName}), p.username, u.id LIMIT 21`, [projectId, query]);
      return { users: rows.slice(0, 20), hasMore: rows.length > 20 };
    });
  });

  api.post<{ Params: ProjectParams }>(path, async (request, reply) => {
    const { user } = await authenticate(request, true);
    const projectId = uuid(request.params.projectId);
    const body = objectBody(request.body);
    const targetId = uuid(body.userId);
    const role = roleOf(body.role);
    const member = await transaction(pool, async client => {
      await lockMembershipChanges(client);
      await requireActiveAccount(client, user.id);
      requireRole((await findProject(client, user.id, projectId, 'update')).role, 'owner');
      const { rows: [target] } = await client.query<AccountSummary>(`SELECT ${memberIdentity}
        FROM users u ${credentials} WHERE u.id = $1 AND u.disabled_at IS NULL FOR SHARE OF u`, [targetId]);
      if (!target) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '추가할 수 있는 사용자를 찾을 수 없습니다.');
      const { rowCount } = await client.query(`INSERT INTO project_members (project_id, user_id, role)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [projectId, target.id, role]);
      if (!rowCount) throw new ApiError(409, 'ALREADY_A_MEMBER', '이미 이 프로젝트에 추가된 사용자입니다.');
      return { ...target, role, disabled: false };
    });
    return reply.code(201).send(member);
  });

  for (const method of ['PATCH', 'DELETE'] as const) {
    api.route<{ Params: MemberParams }>({ method, url: path + '/:userId', handler: async (request, reply) => {
      const { user } = await authenticate(request, true);
      const projectId = uuid(request.params.projectId);
      const targetId = uuid(request.params.userId);
      const role = method === 'PATCH' ? roleOf(objectBody(request.body).role) : undefined;
      await transaction(pool, async client => {
        await lockMembershipChanges(client);
        await requireActiveAccount(client, user.id);
        requireRole((await findProject(client, user.id, projectId, 'update')).role, 'owner');
        const key = [projectId, targetId];
        const { rows: [member] } = await client.query<{ role: Role }>(
          'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', key);
        if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', '프로젝트 멤버를 찾을 수 없습니다.');
        if (member.role === 'owner' && role !== 'owner') {
          const { rowCount } = await client.query(`SELECT 1 FROM project_members m JOIN users u ON u.id = m.user_id
            WHERE m.project_id = $1 AND m.user_id <> $2 AND m.role = 'owner' AND u.disabled_at IS NULL LIMIT 1`, key);
          if (!rowCount) throw new ApiError(409, 'LAST_OWNER', '프로젝트에는 활성 소유자가 한 명 이상 있어야 합니다.');
        }
        if (role) await client.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [...key, role]);
        else await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', key);
      });
      return reply.code(204).send();
    } });
  }
}
