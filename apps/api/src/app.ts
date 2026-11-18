import Fastify from 'fastify';
import { postgresqlDialect } from '@erd/dialect-postgresql';
import { DialectRegistry, SqlService } from '@erd/sql-service';
import type { Pool } from 'pg';
import { configureErrors } from './api-error.js';
import { defaultDocumentLimits, readConfig } from './config.js';
import type { AuthSettings, DocumentLimits } from './config.js';
import { createDatabase } from './database.js';
import { registerProjects } from './projects.js';

function configuredPersistence() {
  const config = readConfig(process.env);
  return config && { pool: createDatabase(config.databaseUrl), auth: config.auth, limits: config.limits };
}

export function createApi(persistence: { pool: Pool; auth: AuthSettings; limits?: DocumentLimits } | undefined = configuredPersistence()) {
  const registry = new DialectRegistry();
  registry.register(postgresqlDialect);
  const sql = new SqlService(registry);
  const limits = persistence?.limits ?? defaultDocumentLimits;
  const api = Fastify({
    bodyLimit: limits.bytes + 4096, logger: Boolean(persistence) && process.env.NODE_ENV === 'production',
    disableRequestLogging: true,
  });
  configureErrors(api);
  api.get('/api/health', async () => ({ status: 'ok' }));
  if (persistence) {
    const { pool, auth } = persistence;
    pool.on('error', () => api.log.error('Idle database connection closed.'));
    api.addHook('onClose', () => pool.end());
    void api.register(async routes => registerProjects(routes, pool, auth, sql, limits));
  } else {
    api.get('/api/me', async (_request, reply) => {
      return reply.header('Cache-Control', 'no-store').send({ user: null, csrfToken: null, auth: { oidc: false, development: false } });
    });
  }
  return { api, sql };
}
