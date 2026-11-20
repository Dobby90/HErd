import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { SqlService } from '@erd/sql-service';
import { createSqlRegistry } from '../apps/api/src/sql-registry.js';
import { exportTarget } from '../packages/test-fixtures/src/ddl-export.js';
import { withPostgres } from './support/postgres.js';

it('recreates floating-point columns, expanded checks, and partial unique indexes with their predicates', async () => {
  const service = new SqlService(createSqlRegistry());
  const sql = `CREATE TABLE reading (
    amount double precision CHECK (amount > '-Infinity'::float8),
    time timestamp CHECK (time = date_trunc('minute', time)),
    sources integer[] CHECK (cardinality(sources) < 10),
    details jsonb,
    enabled boolean,
    CHECK (CASE WHEN enabled THEN num_nonnulls(amount, details) = 2 AND jsonb_typeof(details) = 'object' ELSE true END)
  );
  CREATE UNIQUE INDEX reading_amount_uq ON reading (amount) WHERE enabled;`;
  const result = await service.parse({ sql, target: exportTarget, defaultNamespace: 'public' });
  if (result.status !== 'parsed') throw new Error(JSON.stringify(result.diagnostics));
  expect(result.losses).toEqual([]);
  expect(result.catalog.indexes[0].predicate?.references).toEqual([result.catalog.columns[4].id]);
  const native = result.catalog.columns[0].type.reference;
  expect(native).toMatchObject({ kind: 'native', name: 'double precision' });
  const document = { id: 'reading', name: 'Reading', formatVersion: 1 as const, target: exportTarget,
    catalog: result.catalog, views: [], relationships: [], extensions: [] };
  const generated = await service.generate({ document, target: exportTarget });
  if (generated.status !== 'generated') throw new Error(JSON.stringify(generated.diagnostics));
  await withPostgres(async cluster => {
    cluster.query(generated.sql);
    expect(cluster.query("SELECT pg_get_expr(indpred, indrelid) FROM pg_index WHERE indexrelid = 'reading_amount_uq'::regclass")).toBe('enabled');
    expect(cluster.query(`INSERT INTO reading(amount,enabled) VALUES (1,false),(1,false);
      INSERT INTO reading(amount,details,enabled) VALUES (1,'{}',true);
      SELECT count(*) FROM reading;`)).toMatch(/3$/);
    expect(() => cluster.query("INSERT INTO reading(amount,details,enabled) VALUES (1,'{}',true)")).toThrow(/duplicate key/);
    expect(() => cluster.query("INSERT INTO reading(amount,details,enabled) VALUES (2,'[]',true)")).toThrow(/check constraint/);
  });
});

it('imports the archived and freshly generated PostgreSQL 17 dumps and recreates the fixture schema', async () => {
  const service = new SqlService(createSqlRegistry());
  const parse = async (sql: string) => {
    const result = await service.parse({ sql, target: exportTarget, defaultNamespace: 'public' });
    if (result.status !== 'parsed') throw new Error(JSON.stringify(result.diagnostics));
    expect(result.losses).toEqual([]);
    return result;
  };
  const source = await readFile('packages/test-fixtures/sql/postgresql-import-source.sql', 'utf8');
  const stored = await readFile('packages/test-fixtures/sql/postgresql-17-schema.sql', 'utf8');
  expect(stored).toMatch(/Dumped from database version 17\./);
  const captured = await parse(stored);
  expect(captured.statements.filter(item => item.kind === 'psql')).toHaveLength(2);
  expect(captured.statements.filter(item => item.status === 'ignored-nonstructural').length).toBeGreaterThan(5);
  const columns = captured.catalog.columns;
  const identity = columns.find(item => item.identity);
  const sequence = captured.catalog.sequences[0];
  expect(identity).toMatchObject({ physicalName: 'number', identity: 'always',
    identitySequence: { physicalName: 'dispatch_ticket', start: '7', increment: '2' }, description: '식별 번호' });
  expect(sequence).toMatchObject({ physicalName: 'Peer_id_seq', dataType: 'integer' });
  expect(columns.find(item => item.id === sequence.ownedByColumnId)?.default?.references).toEqual([sequence.id]);
  expect(captured.catalog.constraints.filter(item => item.kind === 'fk')).toHaveLength(3);
  expect(captured.catalog.enums[0]).toMatchObject({ values: ['open', 'closed', "owner's"], description: '처리 상태' });

  await withPostgres(async cluster => {
    expect(cluster.query('SHOW server_version_num')).toMatch(/^17\d{4}$/);
    cluster.query(source);
    const live = await parse(cluster.dump('import_lab'));
    expect(live.catalog).toEqual(captured.catalog);
    const regenerated = await service.generate({ document: { id: 'captured', name: 'Captured dump', formatVersion: 1,
      target: exportTarget, catalog: live.catalog, relationships: [], views: [], extensions: [] }, target: exportTarget });
    if (regenerated.status !== 'generated') throw new Error(JSON.stringify(regenerated.diagnostics));
    cluster.query('CREATE DATABASE fixture_recreated');
    cluster.query(regenerated.sql, 'fixture_recreated');
    const describe = `SELECT
      (SELECT json_agg(json_build_array(c.relname, a.attname, format_type(a.atttypid, a.atttypmod), a.attidentity, a.attnotnull,
          pg_get_expr(ad.adbin, ad.adrelid), col_description(c.oid, a.attnum)) ORDER BY c.relname, a.attnum)
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
        LEFT JOIN pg_attrdef ad ON ad.adrelid = c.oid AND ad.adnum = a.attnum
        WHERE n.nspname = 'import_lab' AND c.relkind = 'r' AND a.attnum > 0),
      (SELECT json_agg(json_build_array(conname, pg_get_constraintdef(oid)) ORDER BY conname)
        FROM pg_constraint WHERE connamespace = 'import_lab'::regnamespace),
      (SELECT json_agg(json_build_array(sequencename, start_value, min_value, max_value, increment_by, cycle, cache_size) ORDER BY sequencename)
        FROM pg_sequences WHERE schemaname = 'import_lab'),
      (SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = 'import_lab.status'::regtype),
      obj_description('import_lab."Dispatch"'::regclass, 'pg_class'),
      pg_get_serial_sequence('import_lab."Peer"', 'id'),
      pg_get_serial_sequence('import_lab."Dispatch"', 'number')`;
    expect(cluster.query(describe, 'fixture_recreated')).toBe(cluster.query(describe));
  });
}, 90_000);
