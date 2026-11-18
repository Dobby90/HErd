import { createHash, randomUUID } from 'node:crypto';
import { sqlTargetSchema } from '@erd/model';
import type { DialectRegistry } from '@erd/sql-service';
import type { GenerateJobOptions, SqlJob } from '@erd/sql-contract';
import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, objectBody, uuid } from './api-error.js';
import type { Authenticate } from './auth.js';
import { defaultSqlActive, defaultSqlInputBytes } from './config.js';
import type { DocumentLimits } from './config.js';
import { transaction } from './database.js';
import { findDocument, findProject, requireRole, storedDocument } from './projects.js';
import type { SqlQueue } from './sql-queue.js';

const fields = `j.id, j.erd_id AS "erdId", j.revision, j.kind, j.state, j.target,
  j.adapter_version AS "adapterVersion", j.options, j.expires_at AS "expiresAt", j.output`;
const missing = () => new ApiError(404, 'SQL_JOB_NOT_FOUND', 'SQL 작업이 없거나 결과 보관 기간이 지났습니다.');

function optionsFrom(input: unknown): GenerateJobOptions {
  const values = input === undefined ? {} : objectBody(input);
  const { tableIds, includeComments, previewOnly } = values;
  if ((tableIds !== undefined && (!Array.isArray(tableIds) || !tableIds.length || tableIds.some(id => typeof id !== 'string' || !id))) ||
      (includeComments !== undefined && typeof includeComments !== 'boolean') ||
      (previewOnly !== undefined && typeof previewOnly !== 'boolean') ||
      Object.keys(values).some(key => !['tableIds', 'includeComments', 'previewOnly'].includes(key))) {
    throw new ApiError(400, 'INVALID_SQL_OPTIONS', 'SQL 내보내기 옵션을 확인하세요.');
  }
  return { tableIds: Array.isArray(tableIds) ? [...new Set<string>(tableIds)].sort() : undefined,
    includeComments: includeComments ?? true, previewOnly: previewOnly ?? false };
}

function generateInput(body: Record<string, unknown>) {
  const revision = body.revision;
  if (body.kind !== 'generate' || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1 || revision > 2147483647) {
    throw new ApiError(400, 'INVALID_SQL_REQUEST', 'SQL 작업 종류와 기준 리비전을 확인하세요.');
  }
  return { kind: 'generate' as const, erdId: uuid(body.erdId), revision, options: optionsFrom(body.options) };
}

function parseInput(body: Record<string, unknown>, maxBytes: number) {
  const target = sqlTargetSchema.safeParse(body.target);
  const { sql, defaultNamespace } = body;
  if (!target.success || typeof sql !== 'string' || !sql.trim() || typeof defaultNamespace !== 'string' ||
      !defaultNamespace.trim() || Buffer.byteLength(defaultNamespace) > 63 || defaultNamespace.includes('\0') || sql.includes('\0')) {
    throw new ApiError(400, 'INVALID_SQL_REQUEST', 'SQL 대상, 기본 스키마와 UTF-8 SQL 텍스트를 확인하세요.');
  }
  if (Buffer.byteLength(sql) > maxBytes) {
    throw new ApiError(413, 'SQL_INPUT_TOO_LARGE', 'SQL 입력 크기 한도를 초과했습니다.', { limitBytes: maxBytes });
  }
  return { kind: 'parse' as const, target: target.data, sql, options: { defaultNamespace } };
}

async function jobFor(db: Pool | PoolClient, userId: string, id: string, lock = false) {
  const query = `SELECT ${fields} FROM sql_jobs j JOIN project_members m ON m.project_id = j.project_id AND m.user_id = $1
    WHERE j.user_id = $1 AND j.id = $2 AND (j.kind = 'generate' OR m.role <> 'viewer') AND (j.expires_at IS NULL OR j.expires_at > clock_timestamp())`;
  const { rows: [job] } = await db.query<SqlJob>(lock ? query + ' FOR UPDATE OF j FOR SHARE OF m' : query, [userId, id]);
  if (!job) throw missing();
  return job;
}

export function registerSqlJobs(api: FastifyInstance, pool: Pool, authenticate: Authenticate, registry: DialectRegistry,
  queue: SqlQueue, limits: DocumentLimits) {
  api.post<{ Params: { projectId: string } }>('/api/projects/:projectId/sql/jobs', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const projectId = uuid(request.params.projectId);
    const body = objectBody(request.body);
    const mutationId = uuid(body.mutationId);
    const input = body.kind === 'parse' ? parseInput(body, queue.settings.maxInputBytes ?? defaultSqlInputBytes) : generateInput(body);
    const digest = createHash('sha256').update(JSON.stringify({ projectId, input })).digest('hex');
    await queue.ready();
    const job = await transaction(pool, async client => {
      // Serialize a user's submissions before checking the active limit and mutation replay.
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      const row = input.kind === 'generate' ? await findDocument(client, user.id, input.erdId, 'share') : undefined;
      if (row && row.projectId !== projectId) throw missing();
      if (!row) requireRole((await findProject(client, user.id, projectId, 'share')).role, 'editor');
      await client.query('DELETE FROM sql_jobs WHERE user_id = $1 AND mutation_id = $2 AND expires_at <= clock_timestamp()', [user.id, mutationId]);
      const { rows: [prior] } = await client.query<{ id: string; matches: boolean }>(
        'SELECT id, request_hash = $3 AS matches FROM sql_jobs WHERE user_id = $1 AND mutation_id = $2', [user.id, mutationId, digest]);
      if (prior) {
        if (!prior.matches) throw new ApiError(409, 'MUTATION_MISMATCH', '같은 요청 ID에 다른 SQL 작업이 전달됐습니다.');
        return jobFor(client, user.id, prior.id);
      }
      if (input.kind === 'generate' && row?.revision !== input.revision) {
        throw new ApiError(409, 'REVISION_CONFLICT', '최신 서버 리비전으로 SQL 작업을 다시 요청하세요.', { revision: row?.revision });
      }
      await client.query('SELECT pg_advisory_xact_lock(171504032)');
      const { rows: [{ total }] } = await client.query<{ total: number }>(
        "SELECT count(*)::integer AS total FROM sql_jobs WHERE state IN ('queued', 'running')");
      if (total >= (queue.settings.maxActive ?? defaultSqlActive)) {
        throw new ApiError(429, 'SQL_QUEUE_FULL', 'SQL 작업 대기열이 가득 찼습니다. 잠시 후 다시 시도하세요.');
      }
      const { rows: [{ active }] } = await client.query<{ active: number }>(
        "SELECT count(*)::integer AS active FROM sql_jobs WHERE user_id = $1 AND state IN ('queued', 'running')", [user.id]);
      if (active >= queue.settings.userLimit) throw new ApiError(429, 'SQL_JOB_LIMIT', '진행 중인 SQL 작업을 완료하거나 취소한 뒤 다시 시도하세요.');
      const document = row && storedDocument(row, limits);
      const target = input.kind === 'parse' ? input.target : document!.target;
      const adapter = registry.get(target.dialectId);
      const certified = adapter?.metadata.profiles.some(profile => profile.status === 'certified' && profile.version === target.engineVersion);
      if (!adapter || !certified || (input.kind === 'parse' && adapter.capabilities(target).table?.import !== 'supported')) {
        throw new ApiError(422, 'UNSUPPORTED_TARGET', '인증된 SQL 작업 대상을 선택하세요.');
      }
      const id = randomUUID();
      const { rows: [created] } = await client.query<SqlJob>(`INSERT INTO sql_jobs AS j
        (id, project_id, erd_id, user_id, mutation_id, request_hash, revision, target, adapter_version, options, snapshot, kind)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING ${fields}`,
      [id, projectId, row?.id ?? null, user.id, mutationId, digest, row?.revision ?? null, JSON.stringify(target),
        adapter.metadata.adapterVersion, JSON.stringify(input.options),
        JSON.stringify(input.kind === 'parse' ? { sql: input.sql } : document), input.kind]);
      return created;
    });
    queue.wake();
    request.log.info({ jobId: job.id, kind: job.kind, status: job.state }, 'SQL job submitted');
    return reply.code(202).send(job);
  });

  api.get<{ Params: { jobId: string } }>('/api/sql/jobs/:jobId', async request => {
    const { user } = await authenticate(request);
    await queue.ready();
    return jobFor(pool, user.id, uuid(request.params.jobId));
  });

  api.delete<{ Params: { jobId: string } }>('/api/sql/jobs/:jobId', async request => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.jobId);
    await queue.ready();
    const job = await transaction(pool, async client => {
      const current = await jobFor(client, user.id, id, true);
      if (current.state !== 'queued' && current.state !== 'running') return current;
      const { rows: [cancelled] } = await client.query<SqlJob>(`UPDATE sql_jobs j SET state = 'cancelled', snapshot = NULL,
        expires_at = clock_timestamp() + $2 * interval '1 millisecond' WHERE id = $1 RETURNING ${fields}`, [id, queue.settings.ttlMs]);
      return cancelled;
    });
    if (job.state === 'cancelled') queue.cancel(id);
    request.log.info({ jobId: id, kind: job.kind, status: job.state }, 'SQL job cancellation requested');
    return job;
  });
}
