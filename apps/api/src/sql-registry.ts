import { postgresqlDialect } from '@erd/dialect-postgresql';
import { DialectRegistry } from '@erd/sql-service';

export function createSqlRegistry() {
  const registry = new DialectRegistry();
  registry.register(postgresqlDialect);
  return registry;
}
