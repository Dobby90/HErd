import { createDatabase, migrate } from '../apps/api/src/database.ts';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
const pool = createDatabase(process.env.DATABASE_URL);
try {
  const applied = await migrate(pool);
  console.log(applied.length ? applied.join('\n') : 'Service database is up to date.');
} finally {
  await pool.end();
}
