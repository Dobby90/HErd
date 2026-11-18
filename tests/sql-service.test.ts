import { expect, it, vi } from 'vitest';
import { createApi } from '../apps/api/src/app.js';
import type { GenerateResult, ParseResult, SqlDialect } from '@erd/sql-contract';
import { DialectRegistry, SqlService } from '@erd/sql-service';
import { applyCommand, documentExpressions, validateDocumentStructure } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';

const target = sampleDocument.target;
const parseRequest = { target, sql: 'SELECT 1', defaultNamespace: 'public' };

it('distinguishes unregistered, uncertified and stage-one unavailable operations', async () => {
  const { api, sql } = createApi();
  try {
    expect(await sql.parse({ ...parseRequest, target: { ...target, dialectId: 'missing' } })).toMatchObject({
      status: 'blocked', diagnostics: [{ code: 'unregistered-dialect' }],
    });
    expect(await sql.parse({ ...parseRequest, target: { ...target, engineVersion: '99' } })).toMatchObject({
      status: 'blocked', diagnostics: [{ code: 'uncertified-engine-version' }],
    });
    expect(sql.capabilities(target)).toMatchObject({ table: { model: 'supported', import: 'not-implemented', export: 'not-implemented' } });
    expect(await sql.parse(parseRequest)).toMatchObject({ status: 'not-implemented' });
    expect(await sql.generate({ document: sampleDocument, target })).toMatchObject({ status: 'not-implemented' });
    const unsupported = { ...target, engineVersion: '99' };
    const unavailable = await sql.generate({ document: { ...sampleDocument, target: unsupported }, target: unsupported });
    expect(unavailable).toMatchObject({
      status: 'blocked', diagnostics: [{ code: 'uncertified-engine-version' }],
    });
    expect(unavailable).not.toHaveProperty('sql');

    const capabilities = sql.capabilities(target);
    expect(capabilities).not.toHaveProperty('diagnostics');
    for (const feature of Object.values(capabilities)) {
      expect(feature).toMatchObject({ model: 'supported', import: 'not-implemented', export: 'not-implemented' });
    }
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

it('delegates all operations to a second adapter through the registry', async () => {
  const other = { dialectId: 'other', engineVersion: '1' };
  const adapter: SqlDialect = {
    metadata: { id: 'other', name: 'Other', adapterVersion: '1', profiles: [{ version: '1', status: 'certified' }] },
    capabilities: vi.fn(() => ({})),
    validate: vi.fn(() => []),
    parse: vi.fn(async (): Promise<ParseResult> => ({ status: 'parsed', catalog: sampleDocument.catalog, statements: [], diagnostics: [], losses: [], profile: { version: '1', status: 'certified' } })),
    generate: vi.fn(async (): Promise<GenerateResult> => ({ status: 'generated', sql: 'CREATE TABLE example (id int);', dependencies: [], diagnostics: [] })),
  };
  const registry = new DialectRegistry();
  registry.register(adapter);
  const service = new SqlService(registry);
  const document = structuredClone(sampleDocument);
  document.target = other;
  for (const { expression } of documentExpressions(document)) {
    Object.assign(expression, other);
  }
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
    expect(sql.validate(document)).toEqual([expect.objectContaining({ code: 'postgresql-partial-reference-index', objectId: key.id })]);
  } finally {
    await api.close();
  }
});
