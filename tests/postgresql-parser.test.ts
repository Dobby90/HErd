import { expect, it } from 'vitest';
import { inspectPostgresql } from '@erd/dialect-postgresql/parser';
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
  expect(result.constraintExpressions).toEqual(expect.arrayContaining([
    { kind: 'default', expression: { kind: 'function', name: ['gen_random_uuid'], arguments: [] } },
    { kind: 'default', expression: {
      kind: 'function', name: ['nextval'], arguments: [{ kind: 'literal', value: 'stage1."ExternalNumbers"' }],
    } },
    { kind: 'default', expression: {
      kind: 'cast', type: expect.arrayContaining(['jsonb']), arrayDimensions: 0, operand: { kind: 'literal', value: '{}' },
    } },
    { kind: 'default', expression: {
      kind: 'cast', type: expect.arrayContaining(['text']), arrayDimensions: 1, operand: { kind: 'array', elements: [] },
    } },
    { kind: 'check', expression: {
      kind: 'operator', name: ['>'], left: { kind: 'column', name: ['Line'] }, right: { kind: 'literal', value: 0 },
    } },
  ]));
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
