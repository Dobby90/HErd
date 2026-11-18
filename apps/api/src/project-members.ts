import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, objectBody, uuid } from './api-error.js';
import type { Authenticate } from './auth.js';
import { transaction } from './database.js';
import { findProject, requireRole } from './projects.js';
import type { Role } from './projects.js';

type ProjectParams = { projectId: string };
type MemberParams = ProjectParams & { userId: string };

function roleOf(value: unknown): Role {
  if (value === 'owner' || value === 'editor' || value === 'viewer') return value;
  throw new ApiError(400, 'INVALID_ROLE', '프로젝트 역할을 선택하세요.');
}

async function account(db: PoolClient, code: unknown) {
  const { rows: [user] } = await db.query<{ id: string; displayName: string }>(
    'SELECT id, display_name AS "displayName" FROM users WHERE share_code = $1', [uuid(code)]);
  if (!user) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', '이 공유 코드로 가입한 사용자를 찾을 수 없습니다.');
  return user;
}

export function registerProjectMembers(api: FastifyInstance, pool: Pool, authenticate: Authenticate) {
  const path = '/api/projects/:projectId/members';
  api.get<{ Params: ProjectParams }>(path, async request => {
    const { user } = await authenticate(request);
    const projectId = uuid(request.params.projectId);
    return transaction(pool, async client => {
      requireRole((await findProject(client, user.id, projectId, 'share')).role, 'owner');
      const { rows } = await client.query(`SELECT u.id, u.display_name AS "displayName", m.role
        FROM project_members m JOIN users u ON u.id = m.user_id WHERE m.project_id = $1
        ORDER BY CASE m.role WHEN 'owner' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.display_name, u.id`, [projectId]);
      return rows;
    });
  });

  api.post<{ Params: ProjectParams }>(path + '/lookup', async request => {
    const { user } = await authenticate(request, true);
    const projectId = uuid(request.params.projectId);
    return transaction(pool, async client => {
      requireRole((await findProject(client, user.id, projectId, 'share')).role, 'owner');
      const { displayName } = await account(client, objectBody(request.body).shareCode);
      return { displayName };
    });
  });

  api.post<{ Params: ProjectParams }>(path, async (request, reply) => {
    const { user } = await authenticate(request, true);
    const projectId = uuid(request.params.projectId);
    const body = objectBody(request.body);
    const role = roleOf(body.role);
    const member = await transaction(pool, async client => {
      requireRole((await findProject(client, user.id, projectId, 'update')).role, 'owner');
      const target = await account(client, body.shareCode);
      const { rowCount } = await client.query(`INSERT INTO project_members (project_id, user_id, role)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [projectId, target.id, role]);
      if (!rowCount) throw new ApiError(409, 'ALREADY_A_MEMBER', '이미 이 프로젝트에 추가된 사용자입니다.');
      return { ...target, role };
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
        requireRole((await findProject(client, user.id, projectId, 'update')).role, 'owner');
        const key = [projectId, targetId];
        const { rows: [member] } = await client.query<{ role: Role }>(
          'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2', key);
        if (!member) throw new ApiError(404, 'MEMBER_NOT_FOUND', '프로젝트 멤버를 찾을 수 없습니다.');
        if (member.role === 'owner' && role !== 'owner') {
          const { rowCount } = await client.query(`SELECT 1 FROM project_members
            WHERE project_id = $1 AND user_id <> $2 AND role = 'owner' LIMIT 1`, key);
          if (!rowCount) throw new ApiError(409, 'LAST_OWNER', '프로젝트에는 owner가 한 명 이상 있어야 합니다.');
        }
        if (role) await client.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [...key, role]);
        else await client.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', key);
      });
      return reply.code(204).send();
    } });
  }
}
