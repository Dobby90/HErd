import { randomUUID } from 'node:crypto';
import { deserializeDocument, duplicateDocument, erdDocumentSchema, validateDocumentStructure } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import type { SqlService } from '@erd/sql-service';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, objectBody, uuid } from './api-error.js';
import { registerAuth } from './auth.js';
import type { AuthSettings, DocumentLimits } from './config.js';
import { transaction } from './database.js';

type Role = 'owner' | 'editor' | 'viewer';
type Query = Pool | PoolClient;
type ProjectParams = { projectId: string };
type DocumentParams = { erdId: string };
interface Saved {
  revision: number;
  updatedAt: Date;
}

interface Project {
  id: string;
  name: string;
  role: Role;
  documentCount: number;
  updatedAt: Date;
}

interface DocumentRow extends Saved {
  id: string;
  projectId: string;
  role: Role;
  payload: unknown;
}

const projectFields = `p.id, p.name, m.role, p.updated_at AS "updatedAt",
  (SELECT count(*)::integer FROM erds WHERE project_id = p.id) AS "documentCount"`;
const documentFields = 'e.updated_at AS "updatedAt", e.revision';
const projectNotFound = () => new ApiError(404, 'PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.');
const documentNotFound = () => new ApiError(404, 'ERD_NOT_FOUND', 'ERD를 찾을 수 없습니다.');

function requireRole(role: Role, level: 'owner' | 'editor') {
  if (role !== 'owner' && (level === 'owner' || role !== 'editor')) {
    throw new ApiError(403, 'FORBIDDEN', '이 작업을 수행할 프로젝트 권한이 없습니다.');
  }
}

function title(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || value.includes('\0')) {
    throw new ApiError(400, 'INVALID_NAME', '이름은 1~200자로 입력하세요.');
  }
  return value.trim();
}

function assertCapacity(document: ErdDocument, limits: DocumentLimits) {
  if (document.catalog.tables.length > limits.tables || document.catalog.columns.length > limits.columns ||
      document.relationships.length + document.catalog.constraints.filter(item => item.kind === 'fk').length > limits.relationships) {
    throw new ApiError(413, 'DOCUMENT_TOO_LARGE', 'ERD 객체 수가 저장 한도를 초과합니다.');
  }
}

function assertBytes(value: string, limits: DocumentLimits) {
  if (Buffer.byteLength(value) > limits.bytes) {
    throw new ApiError(413, 'DOCUMENT_TOO_LARGE', 'ERD가 문서 저장 용량 한도를 초과합니다.', { limitBytes: limits.bytes });
  }
}

function inputDocument(value: unknown, limits: DocumentLimits): ErdDocument {
  if (value === undefined) throw new ApiError(400, 'INVALID_DOCUMENT', 'ERD 문서를 입력하세요.');
  assertBytes(JSON.stringify(value), limits);
  const shape = erdDocumentSchema.safeParse(value);
  if (!shape.success) {
    throw new ApiError(400, 'INVALID_DOCUMENT', 'ERD 문서 형식이 올바르지 않습니다.',
      shape.error.issues.slice(0, 25).map(issue => ({ path: issue.path, code: issue.code })));
  }
  const document = shape.data;
  uuid(document.id);
  title(document.name);
  assertCapacity(document, limits);
  const issues = validateDocumentStructure(document);
  if (issues.length) throw new ApiError(400, 'INVALID_DOCUMENT', 'ERD 문서의 내부 참조를 확인해 주세요.', issues.slice(0, 25));
  return document;
}

function storedDocument(row: DocumentRow, limits: DocumentLimits): ErdDocument {
  const serialized = JSON.stringify(row.payload);
  assertBytes(serialized, limits);
  let document: ErdDocument;
  try {
    document = deserializeDocument(serialized);
    if (document.id !== row.id) throw new Error('Stored ID mismatch.');
  } catch {
    throw new ApiError(422, 'UNREADABLE_DOCUMENT', '저장된 ERD 형식 또는 내부 참조를 읽을 수 없습니다.');
  }
  assertCapacity(document, limits);
  return document;
}

async function findProject(db: Query, userId: string, id: string, lock: '' | 'share' | 'update' = ''): Promise<Project> {
  const select = `SELECT ${projectFields} FROM projects p
    JOIN project_members m ON m.project_id = p.id AND m.user_id = $1 WHERE p.id = $2`;
  const params = [userId, id];
  const { rows: [project] } = await (lock === 'update' ? db.query<Project>(select + ' FOR UPDATE OF p, m', params)
    : lock === 'share' ? db.query<Project>(select + ' FOR SHARE OF p, m', params) : db.query<Project>(select, params));
  if (!project) throw projectNotFound();
  return project;
}

async function findDocument(db: Query, userId: string, id: string, lock: '' | 'share' | 'update' = ''): Promise<DocumentRow> {
  if (!lock) {
    const { rows: [document] } = await db.query<DocumentRow>(`SELECT e.id, e.project_id AS "projectId", e.payload, ${documentFields}, m.role
      FROM erds e JOIN project_members m ON m.project_id = e.project_id AND m.user_id = $1 WHERE e.id = $2`, [userId, id]);
    if (!document) throw documentNotFound();
    return document;
  }

  // Lock membership and project before the ERD so a cascading project delete cannot reverse the lock order.
  const { rows: [membership] } = await db.query<{ id: string; role: Role }>(`SELECT p.id, m.role
    FROM projects p JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
    WHERE p.id = (SELECT project_id FROM erds WHERE id = $2) FOR SHARE OF p, m`, [userId, id]);
  if (!membership) throw documentNotFound();
  const select = `SELECT e.id, e.project_id AS "projectId", e.payload, ${documentFields}
    FROM erds e WHERE e.id = $1 AND e.project_id = $2`;
  const { rows: [document] } = await db.query<Omit<DocumentRow, 'role'>>(
    select + (lock === 'update' ? ' FOR UPDATE OF e' : ' FOR SHARE OF e'), [id, membership.id]);
  if (!document) throw documentNotFound();
  return { ...document, role: membership.role };
}

async function insertDocument(db: Query, userId: string, projectId: string, document: ErdDocument, limits: DocumentLimits) {
  const serialized = JSON.stringify(document);
  assertBytes(serialized, limits);
  const { rows: [saved] } = await db.query<Saved>(`INSERT INTO erds (id, project_id, title, payload, updated_by)
    VALUES ($1, $2, $3, $4, $5) ON CONFLICT (id) DO NOTHING RETURNING revision, updated_at AS "updatedAt"`,
  [document.id, projectId, document.name, serialized, userId]);
  if (!saved) throw new ApiError(409, 'DOCUMENT_ID_CONFLICT', 'ERD ID가 이미 사용 중입니다.');
  return { document, ...saved };
}

interface RecordedMutation {
  matches: boolean;
  result: { revision: number; updatedAt: string };
}

async function saveDocument(pool: Pool, userId: string, id: string, body: Record<string, unknown>, limits: DocumentLimits) {
  const { baseRevision, document: rawDocument } = body;
  if (typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1 || baseRevision > 2147483647) {
    throw new ApiError(400, 'INVALID_REVISION', '기준 리비전이 올바르지 않습니다.');
  }
  const mutationId = uuid(body.mutationId);
  return transaction(pool, async client => {
    const row = await findDocument(client, userId, id, 'update');
    requireRole(row.role, 'editor');
    const document = inputDocument(rawDocument, limits);
    if (document.id !== id) throw new ApiError(400, 'DOCUMENT_ID_MISMATCH', '문서 ID가 요청 경로와 일치해야 합니다.');
    const { rows: [{ digest }] } = await client.query<{ digest: string }>(
      "SELECT encode(sha256(convert_to($1::jsonb::text, 'UTF8')), 'hex') AS digest", [JSON.stringify(body)]);
    const mutationKey = [userId, id, mutationId];
    const { rows: [recorded] } = await client.query<RecordedMutation>(`SELECT request_hash = $4 AS matches, result
      FROM erd_mutations WHERE user_id = $1 AND erd_id = $2 AND mutation_id = $3 AND expires_at > now()`, [...mutationKey, digest]);
    if (recorded) {
      if (recorded.matches) return recorded.result;
      throw new ApiError(409, 'MUTATION_MISMATCH', '같은 저장 요청 ID에 다른 문서가 전달됐습니다.');
    }
    if (row.revision !== baseRevision) {
      throw new ApiError(409, 'REVISION_CONFLICT', '서버에서 다른 변경사항을 먼저 저장했습니다.',
        { revision: row.revision, updatedAt: row.updatedAt });
    }
    const original = storedDocument(row, limits);
    if (original.target.dialectId !== document.target.dialectId || original.target.engineVersion !== document.target.engineVersion) {
      throw new ApiError(400, 'DOCUMENT_TARGET_MISMATCH', '기존 ERD의 SQL 대상은 변경할 수 없습니다.');
    }
    const { rows: [saved] } = await client.query<Saved>(`UPDATE erds SET title = $2, payload = $3,
      revision = revision + 1, updated_by = $4, updated_at = clock_timestamp()
      WHERE id = $1 RETURNING revision, updated_at AS "updatedAt"`, [id, document.name, JSON.stringify(document), userId]);
    await client.query('DELETE FROM erd_mutations WHERE erd_id = $1 AND expires_at <= now()', [id]);
    await client.query(`INSERT INTO erd_mutations (user_id, erd_id, mutation_id, request_hash, result)
      VALUES ($1, $2, $3, $4, $5)`, [...mutationKey, digest, JSON.stringify(saved)]);
    return saved;
  });
}

export async function registerProjects(api: FastifyInstance, pool: Pool, settings: AuthSettings, sql: SqlService, limits: DocumentLimits) {
  const authenticate = await registerAuth(api, pool, settings);
  api.get('/api/ready', async () => {
    try {
      const { rowCount } = await pool.query('SELECT 1 FROM schema_migrations WHERE name = $1', ['001-projects.sql']);
      if (!rowCount) throw new Error('Service migration is missing.');
      return { status: 'ready' };
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', '서비스 데이터베이스를 확인해 주세요.');
    }
  });

  api.get('/api/projects', async request => {
    const { user } = await authenticate(request);
    return (await pool.query<Project>(`SELECT ${projectFields} FROM projects p JOIN project_members m ON m.project_id = p.id
      WHERE m.user_id = $1 ORDER BY p.updated_at DESC, p.id`, [user.id])).rows;
  });

  api.post('/api/projects', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const name = title(objectBody(request.body).name);
    const id = randomUUID();
    const project = await transaction(pool, async client => {
      await client.query('INSERT INTO projects (id, name, created_by) VALUES ($1, $2, $3)', [id, name, user.id]);
      await client.query("INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')", [id, user.id]);
      return findProject(client, user.id, id);
    });
    return reply.code(201).send(project);
  });

  api.get<{ Params: ProjectParams }>('/api/projects/:projectId', async request => {
    const { user } = await authenticate(request);
    return findProject(pool, user.id, uuid(request.params.projectId));
  });

  api.patch<{ Params: ProjectParams }>('/api/projects/:projectId', async request => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.projectId);
    const name = title(objectBody(request.body).name);
    return transaction(pool, async client => {
      requireRole((await findProject(client, user.id, id, 'update')).role, 'owner');
      await client.query('UPDATE projects SET name = $2, updated_at = clock_timestamp() WHERE id = $1', [id, name]);
      return findProject(client, user.id, id);
    });
  });

  api.delete<{ Params: ProjectParams }>('/api/projects/:projectId', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.projectId);
    const expected = request.body === undefined ? undefined : objectBody(request.body).documentCount;
    await transaction(pool, async client => {
      requireRole((await findProject(client, user.id, id, 'update')).role, 'owner');
      const { documentCount } = await findProject(client, user.id, id);
      if (expected !== undefined && expected !== documentCount) {
        throw new ApiError(409, 'PROJECT_CHANGED', '포함된 ERD 수가 변경됐습니다. 삭제 대상을 다시 확인해 주세요.', { documentCount });
      }
      await client.query('DELETE FROM projects WHERE id = $1', [id]);
    });
    return reply.code(204).send();
  });

  api.get<{ Params: ProjectParams }>('/api/projects/:projectId/erds', async request => {
    const { user } = await authenticate(request);
    const id = uuid(request.params.projectId);
    await findProject(pool, user.id, id);
    return (await pool.query(`SELECT e.id, e.title, e.payload->'target' AS target, ${documentFields}
      FROM erds e JOIN project_members m ON m.project_id = e.project_id AND m.user_id = $2
      WHERE e.project_id = $1 ORDER BY e.updated_at DESC, e.id`, [id, user.id])).rows;
  });

  api.post<{ Params: ProjectParams }>('/api/projects/:projectId/erds', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const projectId = uuid(request.params.projectId);
    const { document: rawDocument } = objectBody(request.body);
    const saved = await transaction(pool, async client => {
      requireRole((await findProject(client, user.id, projectId, 'share')).role, 'editor');
      const document = inputDocument(rawDocument, limits);
      if ('diagnostics' in sql.capabilities(document.target)) {
        throw new ApiError(400, 'UNSUPPORTED_TARGET', '인증된 SQL 대상을 선택하세요.');
      }
      return insertDocument(client, user.id, projectId, document, limits);
    });
    return reply.code(201).send(saved);
  });

  api.get<{ Params: DocumentParams }>('/api/erds/:erdId', async request => {
    const { user } = await authenticate(request);
    const row = await findDocument(pool, user.id, uuid(request.params.erdId));
    return { document: storedDocument(row, limits), revision: row.revision, updatedAt: row.updatedAt };
  });

  api.put<{ Params: DocumentParams }>('/api/erds/:erdId', async request => {
    const { user } = await authenticate(request, true);
    return saveDocument(pool, user.id, uuid(request.params.erdId), objectBody(request.body), limits);
  });

  api.post<{ Params: DocumentParams }>('/api/erds/:erdId/duplicate', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.erdId);
    const supplied = request.body === undefined ? undefined : objectBody(request.body).name;
    const saved = await transaction(pool, async client => {
      const row = await findDocument(client, user.id, id, 'share');
      requireRole(row.role, 'editor');
      const original = storedDocument(row, limits);
      const name = supplied === undefined ? original.name.slice(0, 197) + ' 복제' : title(supplied);
      return insertDocument(client, user.id, row.projectId, duplicateDocument(original, randomUUID(), name), limits);
    });
    return reply.code(201).send(saved);
  });

  api.delete<{ Params: DocumentParams }>('/api/erds/:erdId', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.erdId);
    await transaction(pool, async client => {
      requireRole((await findDocument(client, user.id, id, 'update')).role, 'owner');
      await client.query('DELETE FROM erds WHERE id = $1', [id]);
    });
    return reply.code(204).send();
  });
}
