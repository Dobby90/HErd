import { expect, it, vi } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import type { GenerateResult, ParseResult, SqlDialect } from '@erd/sql-contract';
import { DialectRegistry, SqlService } from '@erd/sql-service';
import { applyCommand, documentExpressions, validateDocumentStructure } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';
import type { ErdDocument } from '@erd/model';

const target = sampleDocument.target;
const parseRequest = { target, sql: 'SELECT 1', defaultNamespace: 'public' };

it('distinguishes certified editing from unregistered, uncertified and unavailable DDL operations', async () => {
  const { api, sql } = createApi();
  try {
    expect(await sql.parse({ ...parseRequest, target: { ...target, dialectId: 'missing' } })).toMatchObject({
      status: 'blocked', diagnostics: [{ code: 'unregistered-dialect' }],
    });
    expect(await sql.parse({ ...parseRequest, target: { ...target, engineVersion: '99' } })).toMatchObject({
      status: 'blocked', diagnostics: [{ code: 'uncertified-engine-version' }],
    });
    expect(sql.capabilities(target)).toMatchObject({ table: { model: 'supported', edit: 'supported', import: 'supported', export: 'supported' } });
    expect(await sql.parse({ ...parseRequest, sql: 'CREATE TABLE example (id integer)' })).toMatchObject({
      status: 'parsed', catalog: { tables: [{ physicalName: 'example' }] },
    });
    expect(await sql.generate({ document: sampleDocument, target, tableIds: ['users'] })).toMatchObject({ status: 'generated' });
    expect(await sql.generate({ document: sampleDocument, target })).toMatchObject({
      status: 'blocked', diagnostics: [expect.objectContaining({ code: 'postgresql-unsupported-index' })],
    });
    const unsupported = { ...target, engineVersion: '99' };
    const unavailable = await sql.generate({ document: { ...sampleDocument, target: unsupported }, target: unsupported });
    expect(unavailable).toMatchObject({
      status: 'blocked', diagnostics: [{ code: 'uncertified-engine-version' }],
    });
    expect(unavailable).not.toHaveProperty('sql');

    const capabilities = sql.capabilities(target);
    expect(capabilities).not.toHaveProperty('diagnostics');
    expect(capabilities).toMatchObject({ enum: { edit: 'not-implemented' }, sequence: { edit: 'not-implemented' }, identity: { edit: 'not-implemented' } });
    expect(capabilities).toMatchObject({
      namespace: { import: 'supported' }, expressionIndex: { import: 'unsupported' }, partialIndex: { import: 'unsupported' },
    });
    const draft = structuredClone(sampleDocument);
    const column = draft.catalog.columns[0];
    column.type.attributes = [{ namespace: 'postgresql', version: 99, data: {} }];
    const blockedAttributes = await sql.generate({ document: draft, target });
    expect(blockedAttributes).toMatchObject({
      status: 'blocked', diagnostics: [expect.objectContaining({ code: 'unknown-extension', objectId: column.id })],
    });
    expect(blockedAttributes).not.toHaveProperty('sql');
    const unknown = structuredClone(sampleDocument);
    unknown.extensions.push({ namespace: 'postgresql', version: 99, data: {} });
    const blocked = await sql.generate({ document: unknown, target });
    expect(blocked).toMatchObject({ status: 'blocked', diagnostics: [expect.objectContaining({ code: 'unknown-extension' })] });
    expect(blocked).not.toHaveProperty('sql');
    const renamed = applyCommand(sampleDocument, { kind: 'rename', objectId: 'item-quantity', physicalName: 'amount' });
    expect(await sql.generate({ document: renamed.document, target })).toMatchObject({
      status: 'blocked', diagnostics: [expect.objectContaining({ code: 'invalidated-expression' })],
    });
  } finally {
    await api.close();
  }
});

const other = { dialectId: 'other', engineVersion: '1' };
const candidate = { ...other, engineVersion: '2' };

function createOtherService() {
  const adapter: SqlDialect = {
    metadata: {
      id: other.dialectId, name: 'Other', adapterVersion: '1',
      profiles: [{ version: other.engineVersion, status: 'certified' }, { version: candidate.engineVersion, status: 'candidate' }],
    },
    capabilities: vi.fn(() => ({})),
    validate: vi.fn(() => []),
    parse: vi.fn(async (): Promise<ParseResult> => ({ status: 'parsed', catalog: sampleDocument.catalog, statements: [], diagnostics: [], losses: [], profile: { version: '1', status: 'certified' } })),
    generate: vi.fn(async (): Promise<GenerateResult> => ({ status: 'generated', sql: 'CREATE TABLE example (id int);', dependencies: [], diagnostics: [] })),
  };
  const registry = new DialectRegistry();
  registry.register(adapter);
  return { adapter, service: new SqlService(registry) };
}

function otherDocument(engine = other): ErdDocument {
  const document = structuredClone(sampleDocument);
  document.target = engine;
  for (const { expression } of documentExpressions(document)) {
    Object.assign(expression, engine);
  }
  return document;
}

it('delegates all operations to a second adapter through the registry', async () => {
  const { adapter, service } = createOtherService();
  const document = otherDocument();
  const input = { ...parseRequest, target: other };
  const output = { document, target: other };
  expect(service.capabilities(other)).toEqual({});
  expect(service.validate(document)).toEqual([]);
  expect(await service.parse(input)).toMatchObject({ status: 'parsed' });
  expect(await service.generate(output)).toMatchObject({ status: 'generated' });
  expect(adapter.capabilities).toHaveBeenCalledWith(other);
  expect(adapter.validate).toHaveBeenCalledWith(document, { target: other });
  expect(adapter.parse).toHaveBeenCalledWith(input);
  expect(adapter.generate).toHaveBeenCalledWith(output);

  vi.mocked(adapter.generate).mockResolvedValueOnce({
    status: 'generated', sql: 'CREATE TABLE example (id int);', dependencies: [],
    diagnostics: [{ code: 'cannot-preserve-feature', severity: 'error', message: 'Cannot preserve feature.' }],
  });
  const rejected = await service.generate(output);
  expect(rejected).toMatchObject({
    status: 'blocked', diagnostics: [expect.objectContaining({ code: 'cannot-preserve-feature' })],
  });
  expect(rejected).not.toHaveProperty('sql');

  const advisory = { code: 'advisory', severity: 'warning', message: 'Review the selection.' } as const;
  const diagnostic = { code: 'unavailable', severity: 'error', message: 'Generation is unavailable.' } as const;
  const dependencies = [{ kind: 'tables', objectId: 'products' }] as const;
  vi.mocked(adapter.validate).mockReturnValue([advisory]);
  for (const status of ['blocked', 'not-implemented'] as const) {
    const mixedResult: unknown = { status, dependencies, diagnostics: [diagnostic], sql: 'leaked SQL' };
    vi.mocked(adapter.generate).mockResolvedValueOnce(mixedResult as GenerateResult);
    expect(await service.generate(output)).toStrictEqual({ status, dependencies, diagnostics: [advisory, diagnostic] });
  }
});

it('rejects a registered candidate profile before calling any adapter operation', async () => {
  const { adapter, service } = createOtherService();
  vi.mocked(adapter.capabilities).mockReturnValue({
    table: { model: 'supported', edit: 'unsupported', import: 'not-implemented', export: 'not-implemented' },
  });
  const diagnostic = expect.objectContaining({ code: 'uncertified-engine-version', severity: 'error' });
  const document = otherDocument(candidate);
  expect(service.capabilities(candidate)).toEqual({ diagnostics: [diagnostic] });
  expect(service.validate(document)).toEqual([diagnostic]);
  expect(await service.parse({ ...parseRequest, target: candidate })).toMatchObject({ status: 'blocked', diagnostics: [diagnostic] });
  expect(await service.generate({ document, target: candidate })).toMatchObject({ status: 'blocked', diagnostics: [diagnostic] });
  for (const method of [adapter.capabilities, adapter.validate, adapter.parse, adapter.generate]) {
    expect(method).not.toHaveBeenCalled();
  }
});

it('validates selected tables and dependent objects while checking the whole document structure', async () => {
  const { adapter, service } = createOtherService();
  const renamed = applyCommand(otherDocument(), { kind: 'rename', objectId: 'item-quantity', physicalName: 'amount' });
  expect(renamed.applied).toBe(true);
  const { document } = renamed;
  document.catalog.columns[0].type.attributes = [{ namespace: 'other', version: 99, data: {} }];
  const productName = document.catalog.columns.find(column => column.id === 'product-name');
  if (!productName) throw new Error('Expected a product name column');
  const auxiliaryNamespace = { id: 'aux', physicalName: 'auxiliary' };
  document.catalog.namespaces.push(auxiliaryNamespace);
  const productType = { id: 'product-name-type', namespaceId: 'aux', physicalName: 'product_name', values: ['name'] };
  document.catalog.enums.push(productType);
  productName.type.reference = { kind: 'enum', enumId: productType.id };
  const productSequence = { id: 'product-sequence', namespaceId: 'aux', physicalName: 'product_number' };
  const ownedSequence = { id: 'owned-sequence', namespaceId: 'aux', physicalName: 'owned_number', ownedByColumnId: 'product-id' };
  document.catalog.sequences.push(productSequence, ownedSequence, { id: 'unrelated-sequence', namespaceId: 'aux', physicalName: 'unrelated' });
  const productId = document.catalog.columns.find(column => column.id === 'product-id');
  if (!productId) throw new Error('Expected a product ID column');
  productId.default = { ...other, sql: "nextval('auxiliary.product_number')", references: [productSequence.id], referencesComplete: true };

  const selected = { document, target: other, tableIds: ['products'] };
  expect(await service.generate(selected)).toMatchObject({ status: 'generated' });
  expect(adapter.generate).toHaveBeenCalledExactlyOnceWith(selected);
  const validatedDocument = vi.mocked(adapter.validate).mock.calls[0][0];
  expect(validateDocumentStructure(validatedDocument)).toEqual([]);
  expect(validatedDocument.catalog.tables.map(table => table.id)).toEqual(['products']);
  expect(validatedDocument.catalog.namespaces).toContainEqual(auxiliaryNamespace);
  expect(validatedDocument.catalog.enums).toEqual([productType]);
  expect(validatedDocument.catalog.sequences).toEqual([productSequence, ownedSequence]);
  expect(await service.generate({ ...selected, tableIds: ['items'] })).toMatchObject({
    status: 'blocked', diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'unknown-extension', objectId: 'user-id' }),
      expect.objectContaining({ code: 'invalidated-expression', objectId: 'item-quantity-check' }),
    ]),
  });
  expect(adapter.generate).toHaveBeenCalledTimes(1);

  document.catalog.tables[0].columnIds.push('missing-column');
  expect(await service.generate(selected)).toMatchObject({
    status: 'blocked', diagnostics: [expect.objectContaining({ code: 'invalid-column-reference', objectId: 'users' })],
  });
  expect(adapter.generate).toHaveBeenCalledTimes(1);
});

it('blocks generation after renaming the namespace of a referenced sequence', async () => {
  const document = otherDocument();
  const namespace = { id: 'stage1', physicalName: 'stage1' };
  document.catalog.namespaces.push(namespace);
  document.catalog.sequences.push({ id: 'external-numbers', namespaceId: namespace.id, physicalName: 'ExternalNumbers' });
  const defaultExpression = {
    ...other, sql: `nextval('stage1."ExternalNumbers"')`, references: ['external-numbers'], referencesComplete: true,
  };
  document.catalog.columns[0].default = defaultExpression;
  expect(validateDocumentStructure(document)).toEqual([]);
  const renamed = applyCommand(document, { kind: 'rename', objectId: namespace.id, physicalName: 'release' });
  expect(renamed).toMatchObject({ applied: true, diagnostics: [{ code: 'invalidated-expression', objectId: 'user-id' }] });
  expect(renamed.document.catalog.columns[0].default).toEqual({ ...defaultExpression, invalidated: true });
  const { adapter, service } = createOtherService();
  expect(await service.generate({ document: renamed.document, target: other, tableIds: ['users'] })).toMatchObject({
    status: 'blocked', diagnostics: [{ code: 'invalidated-expression', objectId: 'user-id' }],
  });
  expect(adapter.generate).not.toHaveBeenCalled();
});

it('keeps PostgreSQL semantic validation separate from structural candidate-key checks', async () => {
  const document = structuredClone(sampleDocument);
  const key = document.catalog.constraints.find(constraint => constraint.id === 'item-order');
  if (key?.kind !== 'fk') throw new Error('Expected the composite foreign key');
  const index = {
    id: 'orders-key-index', physicalName: 'orders_key_idx', tableId: 'orders', unique: true,
    keys: [{ kind: 'column' as const, columnId: 'order-user-id' }, { kind: 'column' as const, columnId: 'order-number' }],
    predicate: { ...target, sql: 'number > 0', references: ['order-number'] },
  };
  document.catalog.indexes.push(index);
  key.targetKey = { kind: 'index', id: index.id };
  expect(validateDocumentStructure(document)).toEqual([]);
  const { api, sql } = createApi();
  try {
    const invalidReference = expect.objectContaining({ code: 'postgresql-partial-reference-index', objectId: key.id });
    expect(sql.validate(document)).toEqual([invalidReference]);
    expect(await sql.generate({ document, target, tableIds: ['users'] })).toMatchObject({ status: 'generated' });
    expect(await sql.generate({ document, target, tableIds: ['items'] })).toMatchObject({
      status: 'blocked', diagnostics: expect.arrayContaining([invalidReference]),
    });
  } finally {
    await api.close();
  }
});
