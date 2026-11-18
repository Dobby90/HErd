import { randomUUID } from 'node:crypto';
import type { ErdDocument } from '@erd/model';
import type { PoolClient } from 'pg';
import type { CheckpointSettings } from './config.js';

export type SnapshotKind = 'manual' | 'checkpoint' | 'before-import' | 'before-restore';
export interface SnapshotSource {
  id: string;
  revision: number;
  payload: unknown;
}

export async function insertSnapshot(db: PoolClient, userId: string, source: SnapshotSource, kind: SnapshotKind, description = '') {
  const id = randomUUID();
  const { rows: [{ createdAt }] } = await db.query<{ createdAt: Date }>(`INSERT INTO erd_revisions
    (id, erd_id, source_revision, payload, kind, created_by, description, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,clock_timestamp()) RETURNING created_at AS "createdAt"`,
  [id, source.id, source.revision, JSON.stringify(source.payload), kind, userId, description]);
  return { id, createdAt };
}

export async function checkpoint(db: PoolClient, userId: string, before: SnapshotSource, revision: number,
  document: ErdDocument, settings: CheckpointSettings) {
  // The caller already holds the ERD row lock. Keep cadence and pruning under the same lock as the save.
  const { rowCount } = await db.query(`INSERT INTO erd_revisions (id, erd_id, source_revision, payload, kind, created_by, created_at)
    SELECT $1, $2, $3, $4::jsonb, 'checkpoint', $5, clock_timestamp()
    WHERE $4::jsonb IS DISTINCT FROM $6::jsonb AND NOT EXISTS (
      SELECT 1 FROM erd_revisions WHERE erd_id = $2 AND kind = 'checkpoint'
      AND created_at > clock_timestamp() - $7 * interval '1 millisecond'
    )`, [randomUUID(), before.id, revision, JSON.stringify(document), userId, JSON.stringify(before.payload), settings.intervalMs]);
  if (rowCount) {
    await db.query(`DELETE FROM erd_revisions WHERE id IN (
      SELECT id FROM erd_revisions WHERE erd_id = $1 AND kind = 'checkpoint'
      ORDER BY source_revision DESC, id OFFSET $2
    )`, [before.id, settings.keep]);
  }
}
