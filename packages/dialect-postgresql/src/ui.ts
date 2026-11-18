import type { DialectCapabilities, DialectMetadata } from '@erd/sql-contract';

export const postgresqlMetadata: DialectMetadata = {
  id: 'postgresql',
  name: 'PostgreSQL',
  adapterVersion: '0.1.0',
  profiles: [{ version: '17', status: 'certified' }],
};

const modeled = {
  model: 'supported', edit: 'not-implemented', import: 'not-implemented', export: 'not-implemented',
} as const;

export const postgresqlCapabilities = {
  namespace: modeled,
  table: modeled,
  column: modeled,
  primaryKey: modeled,
  unique: modeled,
  foreignKey: modeled,
  check: modeled,
  default: modeled,
  index: modeled,
  expressionIndex: modeled,
  enum: modeled,
  sequence: modeled,
  identity: modeled,
  array: modeled,
} satisfies DialectCapabilities;

export const postgresqlTypes = [
  'smallint', 'integer', 'bigint', 'numeric', 'boolean', 'text', 'varchar', 'date',
  'timestamp', 'timestamptz', 'uuid', 'jsonb', 'bytea',
] as const;
