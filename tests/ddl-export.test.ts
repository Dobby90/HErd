import { expect, it } from 'vitest';
import { applyCommand, deserializeDocument, erdDocumentSchema, serializeDocument } from '@erd/model';
import { SqlService } from '@erd/sql-service';
import { createSqlRegistry } from '../apps/api/src/sql-registry.js';
import { exportDocument, exportTarget } from '../packages/test-fixtures/src/ddl-export.js';

const service = new SqlService(createSqlRegistry());

it('blocks unsupported options, types, indexes, and unverified selections without returning SQL', async () => {
  const document = exportDocument();
  const unknownField = structuredClone(document);
  Object.assign(unknownField.catalog.constraints[3], { deferrable: true });
  expect(erdDocumentSchema.safeParse(unknownField).success).toBe(false);
  const native = document.catalog.columns[0].type;
  native.reference = { kind: 'native', namespace: 'custom', name: 'custom_domain' };
  document.catalog.constraints[3].extensions = [{ namespace: 'postgresql', version: 1, data: { deferrable: true, notValid: true } }];
  const serialized = deserializeDocument(serializeDocument(document));
  expect(serialized.catalog.constraints[3].extensions).toEqual(document.catalog.constraints[3].extensions);
  expect(await service.generate({ document: serialized, target: exportTarget })).toMatchObject({
    status: 'blocked', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'unknown-extension', objectId: 'a-self' })]),
  });
  serialized.catalog.constraints[3].extensions = undefined;
  serialized.catalog.indexes[1].keys = [{ kind: 'expression', expression: { ...exportTarget, sql: '1' } }];
  const blocked = await service.generate({ document: serialized, target: exportTarget, tableIds: ['b'] });
  expect(blocked).not.toHaveProperty('sql');
  expect(blocked).toMatchObject({ status: 'blocked', diagnostics: expect.arrayContaining([
    expect.objectContaining({ code: 'postgresql-unsupported-type', objectId: 'a-region' }),
    expect.objectContaining({ code: 'postgresql-unsupported-index', objectId: 'ab-index' }),
  ]) });
  for (const target of [{ ...exportTarget, engineVersion: '18' }, { ...exportTarget, dialectId: 'unregistered' }]) {
    const result = await service.generate({ document, target });
    expect(result.status).toBe('blocked');
    expect(result).not.toHaveProperty('sql');
  }
  for (const tableIds of [[], ['missing']]) {
    expect(await service.generate({ document, target: exportTarget, tableIds })).toMatchObject({ status: 'blocked' });
  }
});

it('compiles one expression per DEFAULT or CHECK, blocks missing dependencies, and honors rename review', async () => {
  for (const source of ["1); SELECT (2", "1) FROM pg_catalog.pg_class --", '("Region")', 'lower((SELECT name FROM another_table))',
    "nextval('missing.seq')", "pg_catalog.setval('something', 1)", "E'invalid\\000'"]) {
    const document = exportDocument();
    document.catalog.columns.find(column => column.id === 'a-counter')!.default = { ...exportTarget, sql: source };
    const result = await service.generate({ document, target: exportTarget, tableIds: ['a'] });
    expect(result, source).toMatchObject({
      status: 'blocked', diagnostics: [expect.objectContaining({ code: 'postgresql-invalid-expression', objectId: 'a-counter' })],
    });
    expect(result).not.toHaveProperty('sql');
  }
  const document = exportDocument();
  const check = document.catalog.constraints.find(item => item.kind === 'check')!;
  if (check.kind !== 'check') throw new Error('Missing CHECK');
  check.expression.sql = '42';
  expect(await service.generate({ document, target: exportTarget })).toMatchObject({
    status: 'blocked', diagnostics: [expect.objectContaining({ code: 'postgresql-invalid-expression', objectId: 'a-check' })],
  });
  const renamed = applyCommand(exportDocument(), { kind: 'rename', objectId: 'a-region', physicalName: 'area' });
  expect(await service.generate({ document: renamed.document, target: exportTarget })).toMatchObject({
    status: 'blocked', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'invalidated-expression', objectId: 'a-check' })]),
  });
  const differentVersion = exportDocument();
  differentVersion.catalog.columns.find(column => column.id === 'a-counter')!.default!.engineVersion = '18';
  expect(await service.generate({ document: differentVersion, target: exportTarget })).toMatchObject({
    status: 'blocked', diagnostics: [{ code: 'expression-target-mismatch', objectId: 'a-counter' }],
  });
});
