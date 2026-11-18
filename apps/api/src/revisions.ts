import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { ApiError, objectBody, revisionNumber, uuid } from './api-error.js';
import type { Authenticate } from './auth.js';
import type { DocumentLimits } from './config.js';
import { transaction } from './database.js';
import { assertRevision, assertTarget, documentMutation, findDocument, requireRole, storedDocument, updateDocument } from './projects.js';
import { insertSnapshot } from './revision-storage.js';
import type { SnapshotKind } from './revision-storage.js';

type DocumentParams = { erdId: string };
type SnapshotParams = DocumentParams & { snapshotId: string };
interface SnapshotInfo {
  id: string;
  kind: SnapshotKind;
  sourceRevision: number;
  author: string;
  createdAt: Date;
  description: string;
}
type Saved = Awaited<ReturnType<typeof updateDocument>>;

const metadata = `r.id, r.kind, r.source_revision AS "sourceRevision", r.created_at AS "createdAt",
  u.display_name AS author, r.description`;
const pageSize = 50;

async function snapshot(db: PoolClient, erdId: string, id: string) {
  const { rows: [result] } = await db.query<SnapshotInfo & { payload: unknown }>(`SELECT ${metadata}, r.payload
    FROM erd_revisions r JOIN users u ON u.id = r.created_by WHERE r.erd_id = $1 AND r.id = $2`, [erdId, id]);
  if (!result) throw new ApiError(404, 'SNAPSHOT_NOT_FOUND', '이 ERD에서 버전을 찾을 수 없습니다.');
  return result;
}

function descriptionOf(value: unknown) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) {
    throw new ApiError(400, 'INVALID_DESCRIPTION', '버전 설명은 200자 이내로 입력하세요.');
  }
  return value.trim();
}

export function registerRevisions(api: FastifyInstance, pool: Pool, authenticate: Authenticate, limits: DocumentLimits) {
  const path = '/api/erds/:erdId/revisions';
  api.get<{ Params: DocumentParams; Querystring: { offset?: string } }>(path, async request => {
    const { user } = await authenticate(request);
    const id = uuid(request.params.erdId);
    const offset = request.query.offset === undefined ? 0 : Number(request.query.offset);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2147483647) {
      throw new ApiError(400, 'INVALID_OFFSET', '이력 페이지를 확인하세요.');
    }
    return transaction(pool, async client => {
      const row = await findDocument(client, user.id, id, 'share');
      const { rows } = await client.query<SnapshotInfo>(`SELECT ${metadata}
        FROM erd_revisions r JOIN users u ON u.id = r.created_by WHERE r.erd_id = $1
        ORDER BY r.created_at DESC, r.id OFFSET $2 LIMIT $3`, [id, offset, pageSize + 1]);
      return { revision: row.revision, snapshots: rows.slice(0, pageSize), hasMore: rows.length > pageSize };
    });
  });
  api.post<{ Params: DocumentParams }>(path, async (request, reply) => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.erdId);
    const body = objectBody(request.body);
    const baseRevision = revisionNumber(body.baseRevision);
    const description = descriptionOf(body.description);
    const mutationId = body.mutationId === undefined ? undefined : uuid(body.mutationId);
    const version = await transaction(pool, async client => {
      const row = await findDocument(client, user.id, id, 'update');
      requireRole(row.role, 'editor');
      const mutation = mutationId && await documentMutation<SnapshotInfo>(
        client, user.id, id, mutationId, { operation: 'snapshot', baseRevision, description });
      if (mutation && mutation.replay) return mutation.replay;
      assertRevision(row, baseRevision);
      const payload = storedDocument(row, limits);
      const stamp = await insertSnapshot(client, user.id, { ...row, payload }, 'manual', description);
      const result: SnapshotInfo = { ...stamp, sourceRevision: row.revision, kind: 'manual', author: user.displayName, description };
      if (mutation) await mutation.record(result);
      return result;
    });
    return reply.code(201).send(version);
  });
  api.get<{ Params: SnapshotParams }>(path + '/:snapshotId', async request => {
    const { user } = await authenticate(request);
    const id = uuid(request.params.erdId);
    const snapshotId = uuid(request.params.snapshotId);
    return transaction(pool, async client => {
      await findDocument(client, user.id, id, 'share');
      const { payload, ...info } = await snapshot(client, id, snapshotId);
      return { ...info, document: storedDocument({ id, payload }, limits) };
    });
  });
  api.post<{ Params: SnapshotParams }>(path + '/:snapshotId/restore', async request => {
    const { user } = await authenticate(request, true);
    const id = uuid(request.params.erdId);
    const snapshotId = uuid(request.params.snapshotId);
    const body = objectBody(request.body);
    const baseRevision = revisionNumber(body.baseRevision);
    const mutationId = uuid(body.mutationId);
    return transaction(pool, async client => {
      const row = await findDocument(client, user.id, id, 'update');
      requireRole(row.role, 'editor');
      const mutation = await documentMutation<Saved>(client, user.id, id, mutationId, { operation: 'restore', snapshotId, baseRevision });
      if (mutation.replay) return mutation.replay;
      assertRevision(row, baseRevision);
      const source = await snapshot(client, id, snapshotId);
      const document = storedDocument({ id, payload: source.payload }, limits);
      assertTarget(storedDocument(row, limits), document);
      await insertSnapshot(client, user.id, row, 'before-restore', `리비전 ${source.sourceRevision} 복원 전`);
      const saved = await updateDocument(client, user.id, document);
      await mutation.record(saved);
      return saved;
    });
  });
}
