import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

export function createDatabase(connectionString: string, purpose: 'service' | 'migration' = 'service'): Pool {
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5_000,
    statement_timeout: purpose === 'migration' ? 0 : 15_000, query_timeout: purpose === 'migration' ? 0 : 20_000 });
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

async function migrations(directory: string) {
  const files = (await readdir(directory)).filter(file => /^\d{3}-[a-z-]+\.sql$/.test(file)).sort();
  if (!files.length) throw new Error('No service database migrations found.');
  return Promise.all(files.map(async name => {
    const sql = await readFile(join(directory, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function migrationManifest() {
  return (await migrations(resolve('db/migrations'))).map(({ name, checksum }) => ({ name, checksum }));
}

export async function migrate(pool: Pool, directory = resolve('db/migrations')) {
  const files = await migrations(directory);
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(171504031)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    const installed = new Map(rows.map(row => [row.name, row.checksum]));
    const known = new Set(files.map(file => file.name));
    if (rows.some(row => !known.has(row.name))) throw new Error('An applied migration file is missing.');
    const applied: string[] = [];
    for (const { name, sql, checksum } of files) {
      if (installed.has(name)) {
        if (installed.get(name) !== checksum) throw new Error('Applied migration changed: ' + name);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
      applied.push(name);
    }
    return applied;
  });
}

export async function runMigrationCommand() {
  try {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
    const pool = createDatabase(process.env.DATABASE_URL, 'migration');
    try {
      const applied = await migrate(pool);
      console.log(applied.length ? applied.join('\n') : 'Service database is up to date.');
    } finally {
      await pool.end();
    }
  } catch {
    console.error('MIGRATION_FAILED. Check the database connection and installed migration checksums.');
    process.exitCode = 1;
  }
}
