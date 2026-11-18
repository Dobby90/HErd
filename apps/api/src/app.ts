import Fastify from 'fastify';
import { postgresqlDialect } from '@erd/dialect-postgresql';
import { DialectRegistry, SqlService } from '@erd/sql-service';

export function createApi() {
  const registry = new DialectRegistry();
  registry.register(postgresqlDialect);

  const api = Fastify();
  api.get('/api/health', async () => ({ status: 'ok' }));
  return { api, sql: new SqlService(registry) };
}
