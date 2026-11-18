import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export function createDatabase(connectionString: string): Pool {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000 });
}

export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let unusable = false;
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      unusable = true;
    }
    throw error;
  } finally {
    client.release(unusable);
  }
}

export async function migrate(pool: Pool, directory = resolve('db/migrations')) {
  const files = (await readdir(directory)).filter(file => /^\d{3}-[a-z-]+\.sql$/.test(file)).sort();
  if (!files.length) throw new Error('No service database migrations found.');
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(171504031)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const installed = new Map(rows.map(row => [row.name, row.checksum]));
    if (rows.some(row => !files.includes(row.name))) throw new Error('An applied migration file is missing.');
    const applied: string[] = [];
    for (const file of files) {
      const sql = await readFile(join(directory, file), 'utf8');
      const digest = createHash('sha256').update(sql).digest('hex');
      if (installed.has(file)) {
        if (installed.get(file) !== digest) throw new Error('Applied migration changed: ' + file);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, digest]);
      applied.push(file);
    }
    return applied;
  });
}
