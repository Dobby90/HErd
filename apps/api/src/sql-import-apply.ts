import { createHash, randomUUID } from 'node:crypto';
import { duplicateDocument } from '@erd/model';
import type { Catalog, ErdDocument, SqlTarget } from '@erd/model';
import type { ImportApplied, ParseSqlJob } from '@erd/sql-contract';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { ApiError, objectBody, uuid } from './api-error.js';
import type { Authenticate } from './auth.js';
import type { DocumentLimits } from './config.js';
import { transaction } from './database.js';
import { findDocument, findProject, inputDocument, insertDocument, requireRole, storedDocument, title } from './projects.js';

function draft(catalog: Catalog, target: SqlTarget, id: string, name: string): ErdDocument {
  const columns = new Map(catalog.columns.map(column => [column.id, column]));
  const instances: ErdDocument['views'][number]['instances'] = [];
  let y = 0;
  const perRow = 4;
  for (let i = 0; i < catalog.tables.length; i += perRow) {
    const row = catalog.tables.slice(i, i + perRow);
    let rowHeight = 0;
    for (const [index, table] of row.entries()) {
      const height = 84 + table.columnIds.reduce((total, id) => total + 28 + Math.ceil((columns.get(id)?.physicalName.length ?? 0) / 16) * 22, 0);
      rowHeight = Math.max(rowHeight, height);
      instances.push({ id: 'placement-' + table.id, tableId: table.id, x: index * 360, y });
    }
    y += rowHeight + 64;
  }
  const candidate: ErdDocument = {
    id: 'import-candidate', name, target, formatVersion: 1, catalog, relationships: [], extensions: [],
    views: [{ id: 'import-view', name: '기본 뷰', instances, notes: [], groups: [] }],
  };
  return duplicateDocument(candidate, id, name);
}

function applyOptions(body: Record<string, unknown>) {
  const { mode, lossFingerprint } = body;
  if (lossFingerprint !== undefined && (typeof lossFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(lossFingerprint))) {
    throw new ApiError(400, 'INVALID_LOSS_FINGERPRINT', '분석 결과의 손실 확인 값을 사용하세요.');
  }
  if (mode === 'create') return { mode, name: title(body.name), lossFingerprint } as const;
  const baseRevision = body.baseRevision;
  if (mode !== 'replace' || typeof baseRevision !== 'number' || !Number.isSafeInteger(baseRevision) || baseRevision < 1 || baseRevision > 2147483647) {
    throw new ApiError(400, 'INVALID_IMPORT_APPLY', '적용 방식과 기준 리비전을 확인하세요.');
  }
  return { mode, erdId: uuid(body.erdId), baseRevision, lossFingerprint } as const;
}

export function registerSqlImportApply(api: FastifyInstance, pool: Pool, authenticate: Authenticate, limits: DocumentLimits) {
  api.post<{ Params: { jobId: string } }>('/api/sql/jobs/:jobId/apply', async (request, reply) => {
    const { user } = await authenticate(request, true);
    const jobId = uuid(request.params.jobId);
    const body = objectBody(request.body);
    const mutationId = uuid(body.mutationId);
    const options = applyOptions(body);
    const digest = createHash('sha256').update(JSON.stringify([jobId, options])).digest('hex');
    const { result, replay } = await transaction(pool, async client => {
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
      await client.query('DELETE FROM sql_import_mutations WHERE user_id = $1 AND mutation_id = $2 AND expires_at <= clock_timestamp()', [user.id, mutationId]);
      const { rows: [prior] } = await client.query<{ projectId: string; matches: boolean; result: ImportApplied }>(
        `SELECT project_id AS "projectId", request_hash = $3 AS matches, result FROM sql_import_mutations
        WHERE user_id = $1 AND mutation_id = $2`, [user.id, mutationId, digest]);
      if (prior) {
        requireRole((await findProject(client, user.id, prior.projectId, 'share')).role, 'editor');
        if (!prior.matches) throw new ApiError(409, 'MUTATION_MISMATCH', '같은 요청 ID에 다른 가져오기 적용 값이 전달됐습니다.');
        return { result: prior.result, replay: true };
      }

      const scope = "SELECT project_id AS \"projectId\" FROM sql_jobs WHERE id = $1 AND user_id = $2 AND kind = 'parse' AND (expires_at IS NULL OR expires_at > clock_timestamp())";
      const { rows: [jobScope] } = await client.query<{ projectId: string }>(scope, [jobId, user.id]);
      if (!jobScope) throw new ApiError(404, 'SQL_JOB_NOT_FOUND', '가져오기 분석을 찾을 수 없거나 만료되었습니다.');
      requireRole((await findProject(client, user.id, jobScope.projectId, 'share')).role, 'editor');
      const { rows: [job] } = await client.query<Pick<ParseSqlJob, 'state' | 'target' | 'output'>>(
        `SELECT state, target, output FROM sql_jobs WHERE id = $1 AND (expires_at IS NULL OR expires_at > clock_timestamp()) FOR UPDATE`, [jobId]);
      if (!job) throw new ApiError(404, 'SQL_JOB_NOT_FOUND', '가져오기 분석을 찾을 수 없거나 만료되었습니다.');
      if (job.state !== 'succeeded' || !job.output?.catalog || !job.output.lossFingerprint) {
        throw new ApiError(409, 'SQL_IMPORT_NOT_READY', '적용할 수 있는 분석 결과가 필요합니다.');
      }
      if ((job.output.losses?.length || options.lossFingerprint) && options.lossFingerprint !== job.output.lossFingerprint) {
        throw new ApiError(409, 'SQL_LOSS_CONFIRMATION_REQUIRED', '이 분석의 제외 항목을 확인해 주세요.');
      }
      const { catalog } = job.output;
      let result: ImportApplied;
      if (options.mode === 'create') {
        const document = inputDocument(draft(catalog, job.target, randomUUID(), options.name), limits);
        const saved = await insertDocument(client, user.id, jobScope.projectId, document, limits);
        result = { erdId: document.id, revision: saved.revision, updatedAt: saved.updatedAt.toISOString() };
      } else {
        const row = await findDocument(client, user.id, options.erdId, 'update');
        if (row.projectId !== jobScope.projectId) throw new ApiError(404, 'ERD_NOT_FOUND', '이 프로젝트에서 대상 ERD를 찾을 수 없습니다.');
        requireRole(row.role, 'editor');
        if (row.revision !== options.baseRevision) throw new ApiError(409, 'REVISION_CONFLICT', '대상 문서가 변경되었습니다.', { revision: row.revision });
        const original = storedDocument(row, limits);
        if (original.target.dialectId !== job.target.dialectId || original.target.engineVersion !== job.target.engineVersion) {
          throw new ApiError(409, 'DOCUMENT_TARGET_MISMATCH', '분석과 대상 문서의 SQL 대상이 다릅니다.');
        }
        const document = inputDocument(draft(catalog, original.target, row.id, original.name), limits);
        await client.query(`INSERT INTO erd_revisions (id, erd_id, source_revision, payload, kind, created_by)
          VALUES ($1,$2,$3,$4,'before-import',$5)`, [randomUUID(), row.id, row.revision, JSON.stringify(row.payload), user.id]);
        const { rows: [saved] } = await client.query<{ revision: number; updatedAt: Date }>(`UPDATE erds
          SET title = $2, payload = $3, revision = revision + 1, updated_by = $4, updated_at = clock_timestamp()
          WHERE id = $1 RETURNING revision, updated_at AS "updatedAt"`, [row.id, document.name, JSON.stringify(document), user.id]);
        result = { erdId: row.id, revision: saved.revision, updatedAt: saved.updatedAt.toISOString() };
      }
      await client.query(`INSERT INTO sql_import_mutations (user_id, mutation_id, project_id, erd_id, request_hash, result)
        VALUES ($1,$2,$3,$4,$5,$6)`, [user.id, mutationId, jobScope.projectId, result.erdId, digest, JSON.stringify(result)]);
      return { result, replay: false };
    });
    return reply.code(!replay && options.mode === 'create' ? 201 : 200).send(result);
  });
}
