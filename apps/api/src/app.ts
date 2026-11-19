import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { SqlService } from '@erd/sql-service';
import type { Pool } from 'pg';
import { registerAdminUsers } from './admin-users.js';
import { ApiError, configureErrors } from './api-error.js';
import { registerAuth } from './auth.js';
import { defaultCheckpointSettings, defaultDocumentLimits, defaultSqlInputBytes, defaultSqlJobSettings, readConfig } from './config.js';
import type { AuthSettings, CheckpointSettings, DocumentLimits, SqlJobSettings } from './config.js';
import { createDatabase, migrationManifest } from './database.js';
import { registerProjects } from './projects.js';
import { registerProjectMembers } from './project-members.js';
import { registerRevisions } from './revisions.js';
import { registerSqlImportApply } from './sql-import-apply.js';
import { registerSqlJobs } from './sql-jobs.js';
import { SqlQueue } from './sql-queue.js';
import { createSqlRegistry } from './sql-registry.js';
import { registerUserDirectory } from './user-directory.js';

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
    logController: new LogController({ disableRequestLogging: true }),
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  configureErrors(api);
  api.addHook('onResponse', async (request, reply) => {
    if (request.routeOptions.url === '/api/health' || request.routeOptions.url === '/api/ready') return;
    request.log.info({
      requestId: request.id, route: request.routeOptions.url ?? 'unmatched', method: request.method,
      status: reply.statusCode, durationMs: Math.round(reply.elapsedTime),
    }, 'HTTP request completed');
  });
  api.addHook('onRequest', async (_request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
  });
  api.get('/api/health', async () => ({ status: 'ok' }));
  const manifest = persistence ? migrationManifest().catch(() => undefined) : undefined;
  const queue = persistence && new SqlQueue(persistence.pool, persistence.jobs ?? defaultSqlJobSettings,
    () => api.log.error({ code: 'SQL_QUEUE_MAINTENANCE' }, 'SQL queue operation failed'),
    event => api.log.info(event, 'SQL job completed'));
  api.get('/api/ready', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!persistence || !queue) throw new ApiError(503, 'PERSISTENCE_UNAVAILABLE', '서비스 데이터베이스 설정을 확인해 주세요.');
    try {
      const expected = await manifest;
      const { rows } = await persistence.pool.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations ORDER BY name COLLATE "C"');
      if (!expected || rows.length !== expected.length ||
          rows.some((row, index) => row.name !== expected[index].name || row.checksum !== expected[index].checksum)) {
        throw new Error('Database schema mismatch.');
      }
      await queue.ready();
      return { status: 'ready' };
    } catch {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', '서비스 데이터베이스와 마이그레이션을 확인해 주세요.');
    }
  });
  api.get('/api/sql/dialects', async () => registry.profiles().map(profile => ({
    ...profile, maxInputBytes: persistence?.jobs?.maxInputBytes ?? defaultSqlInputBytes,
  })));
  if (persistence && queue) {
    const { pool, auth } = persistence;
    pool.on('error', () => api.log.error('Idle database connection closed.'));
    api.addHook('onListen', async () => { void queue.ready().catch(() => undefined); });
    api.addHook('onClose', async () => { await queue.close(); await pool.end(); });
    void api.register(async routes => {
      const authenticate = await registerAuth(routes, pool, auth);
      registerUserDirectory(routes, pool, authenticate);
      registerAdminUsers(routes, pool, authenticate);
      registerProjects(routes, pool, authenticate, sql, limits, persistence.checkpoints ?? defaultCheckpointSettings);
      registerProjectMembers(routes, pool, authenticate);
      registerRevisions(routes, pool, authenticate, limits);
      registerSqlJobs(routes, pool, authenticate, registry, queue, limits);
      registerSqlImportApply(routes, pool, authenticate, limits);
    });
  } else {
    api.get('/api/me', async (_request, reply) => {
      return reply.header('Cache-Control', 'no-store').send({ user: null, csrfToken: null, auth: { oidc: false, development: false, local: false } });
    });
  }
  return { api, sql };
}
