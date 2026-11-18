import { expect, it } from 'vitest';
import { inspectPostgresql } from '@erd/dialect-postgresql/parser';
import { postgresqlMetadata } from '@erd/dialect-postgresql/ui';
import { schemaDdl } from '../packages/test-fixtures/src/postgresql.js';

import { withPostgres } from './support/postgres.js';

it('executes fixture DDL on PostgreSQL 17 and inspects its actual schema-only dump', async () => {
  await withPostgres(async ({ query, dump: schemaDump }) => {
    const serverVersion = query('SHOW server_version_num');
    expect(serverVersion).toMatch(/^17\d{4}$/);
    const serverMajor = Math.floor(Number(serverVersion) / 10_000);
    expect(postgresqlMetadata.profiles).toContainEqual({ version: String(serverMajor), status: 'certified' });
    query(schemaDdl);
    expect(query("SELECT count(*) FROM pg_tables WHERE schemaname = 'stage1'")).toBe('3');
    expect(query("SELECT count(*) FROM pg_constraint WHERE connamespace = 'stage1'::regnamespace AND contype = 'f'")).toBe('1');
    expect(query("SELECT count(*) FROM pg_sequences WHERE schemaname = 'stage1'")).toBe('2');
    expect(query("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stage1' AND is_identity = 'YES'")).toBe('1');
    expect(query("SELECT count(*) FROM information_schema.columns WHERE table_schema = 'stage1' AND data_type IN ('jsonb', 'uuid', 'ARRAY')")).toBe('3');
    query(`
      CREATE TEMP TABLE fk_numeric_parent (id numeric PRIMARY KEY);
      CREATE TEMP TABLE fk_integer_child (id integer REFERENCES fk_numeric_parent);
      INSERT INTO fk_numeric_parent VALUES (42);
      INSERT INTO fk_integer_child VALUES (42);
      CREATE TEMP TABLE fk_date_parent (id date PRIMARY KEY);
      CREATE TEMP TABLE fk_datetime_child (id timestamptz REFERENCES fk_date_parent);
    `);
    expect(() => query(`
      CREATE TEMP TABLE fk_integer_parent (id integer PRIMARY KEY);
      CREATE TEMP TABLE fk_numeric_child (id numeric REFERENCES fk_integer_parent);
    `)).toThrow(/42804:.*foreign key constraint .* cannot be implemented/i);
    const dump = schemaDump('stage1');
    const lines = dump.split(/\r?\n/);
    const meta = lines.filter(line => line.startsWith('\\'));
    expect(meta.map(line => line.split(/\s/, 1)[0])).toEqual(['\\restrict', '\\unrestrict']);
    await expect(inspectPostgresql(dump)).rejects.toThrow(/syntax error/i);
    const sqlOnly = lines.filter(line => !/^\\(?:un)?restrict\s/.test(line)).join('\n');
    const result = await inspectPostgresql(sqlOnly);
    expect(Math.floor(result.version / 10_000)).toBe(serverMajor);
    expect(result.tables).toEqual(expect.arrayContaining(['Users', 'Orders', 'OrderItems']));
    expect(result.statementKinds).toEqual(expect.arrayContaining(['VariableSetStmt', 'AlterTableStmt', 'CreateEnumStmt', 'CreateSeqStmt', 'IndexStmt']));
  });
});
