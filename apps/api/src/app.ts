import Fastify from 'fastify';
import { SqlService } from '@erd/sql-service';
import type { Pool } from 'pg';
import { configureErrors } from './api-error.js';
import { registerAuth } from './auth.js';
import { defaultCheckpointSettings, defaultDocumentLimits, defaultSqlInputBytes, defaultSqlJobSettings, readConfig } from './config.js';
import type { AuthSettings, CheckpointSettings, DocumentLimits, SqlJobSettings } from './config.js';
import { createDatabase } from './database.js';
import { registerProjects } from './projects.js';
import { registerProjectMembers } from './project-members.js';
import { registerRevisions } from './revisions.js';
import { registerSqlImportApply } from './sql-import-apply.js';
import { registerSqlJobs } from './sql-jobs.js';
import { SqlQueue } from './sql-queue.js';
import { createSqlRegistry } from './sql-registry.js';

function configuredPersistence() {
  const config = readConfig(process.env);
  return config && { pool: createDatabase(config.databaseUrl), ...config };
}

export function createApi(persistence: {
  pool: Pool; auth: AuthSettings; limits?: DocumentLimits; jobs?: SqlJobSettings; checkpoints?: CheckpointSettings;
} | undefined = configuredPersistence()) {
  const registry = createSqlRegistry();
  const sql = new SqlService(registry);
  const limits = persistence?.limits ?? defaultDocumentLimits;
  const api = Fastify({
    bodyLimit: Math.min(2_147_483_647, Math.max(limits.bytes, (persistence?.jobs?.maxInputBytes ?? defaultSqlInputBytes) * 6) + 4096),
    logger: Boolean(persistence) && process.env.NODE_ENV === 'production',
    disableRequestLogging: true,
  });
  configureErrors(api);
  api.get('/api/health', async () => ({ status: 'ok' }));
  api.get('/api/sql/dialects', async () => registry.profiles().map(profile => ({
    ...profile, maxInputBytes: persistence?.jobs?.maxInputBytes ?? defaultSqlInputBytes,
  })));
  if (persistence) {
    const { pool, auth } = persistence;
    pool.on('error', () => api.log.error('Idle database connection closed.'));
    const queue = new SqlQueue(pool, persistence.jobs ?? defaultSqlJobSettings, () => api.log.error('SQL job maintenance failed.'));
    api.addHook('onReady', async () => { await queue.ready().catch(() => undefined); });
    api.addHook('onClose', async () => { await queue.close(); await pool.end(); });
    void api.register(async routes => {
      const authenticate = await registerAuth(routes, pool, auth);
      registerProjects(routes, pool, authenticate, sql, limits, persistence.checkpoints ?? defaultCheckpointSettings);
      registerProjectMembers(routes, pool, authenticate);
      registerRevisions(routes, pool, authenticate, limits);
      registerSqlJobs(routes, pool, authenticate, registry, queue, limits);
      registerSqlImportApply(routes, pool, authenticate, limits);
    });
  } else {
    api.get('/api/me', async (_request, reply) => {
      return reply.header('Cache-Control', 'no-store').send({ user: null, csrfToken: null, auth: { oidc: false, development: false } });
    });
  }
  return { api, sql };
}
