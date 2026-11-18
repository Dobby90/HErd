import { expect, it } from 'vitest';
import { inspectPostgresql } from '../packages/dialect-postgresql/src/parser.js';
import { schemaDdl } from '../packages/test-fixtures/src/postgresql.js';

it('parses the controlled PostgreSQL 17 DDL in a worker and terminates it', async () => {
  const result = await inspectPostgresql(schemaDdl);
  expect(result.workerExitCode).toBeTypeOf('number');
  expect(result.version).toBeGreaterThanOrEqual(170000);
  expect(result.version).toBeLessThan(180000);
  expect(result.statementKinds).toEqual(expect.arrayContaining(['CreateStmt', 'CreateEnumStmt', 'CreateSeqStmt', 'IndexStmt']));
  expect(result.typeNames).toEqual(expect.arrayContaining(['int4', 'jsonb', 'uuid', 'text', 'OrderStatus']));
  expect(result.columns).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Tags', array: true })]));
  expect(result.constraintKinds).toEqual(expect.arrayContaining(['CONSTR_PRIMARY', 'CONSTR_UNIQUE', 'CONSTR_FOREIGN', 'CONSTR_CHECK', 'CONSTR_DEFAULT', 'CONSTR_IDENTITY']));
  expect(result.tables).toContain('OrderItems');
  expect(result.compositeKeys).toEqual(expect.arrayContaining([
    { columns: ['TenantId', 'OrderNumber'], referencedColumns: [] },
    { columns: ['TenantId', 'OrderNumber'], referencedColumns: ['TenantId', 'OrderNumber'] },
  ]));
});

it('propagates syntax errors and cancels or bounds parser operations', async () => {
  await expect(inspectPostgresql('CREATE TABLE )')).rejects.toThrow(/syntax error/i);
  await expect(inspectPostgresql('SELECT 1', { maxBytes: 2 })).rejects.toThrow(/byte limit/i);
  await expect(inspectPostgresql('SELECT 1; SELECT 2;', { maxStatements: 1 })).rejects.toThrow(/statement limit/i);
  const controller = new AbortController();
  const pending = inspectPostgresql(schemaDdl, { signal: controller.signal });
  controller.abort(new Error('cancelled by test'));
  await expect(pending).rejects.toThrow(/cancelled by test/i);
  await expect(inspectPostgresql(schemaDdl, { timeoutMs: 0 })).rejects.toThrow(/deadline/i);
  await expect(inspectPostgresql('SELECT 1')).resolves.toMatchObject({ statementKinds: ['SelectStmt'] });
});
