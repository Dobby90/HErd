import { expect, it } from 'vitest';
import { applyCommand, createDocument, deserializeDocument, MigrationRegistry, serializeDocument } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';

it('round-trips stable identifiers, ordered keys, views, and unknown extension data', () => {
  const document = structuredClone(sampleDocument);
  document.extensions.push({ namespace: 'postgresql', version: 99, data: { flags: [1, null] } });
  expect(deserializeDocument(serializeDocument(document))).toEqual(document);
  expect(() => deserializeDocument(JSON.stringify({ ...document, formatVersion: 2 }))).toThrow(/future/i);
  expect(() => deserializeDocument(JSON.stringify({ ...document, formatVersion: 0 }))).toThrow(/migration/i);
  const registry = new MigrationRegistry();
  registry.register(0, value => ({ ...value, formatVersion: 1 }));
  expect(deserializeDocument(JSON.stringify({ ...document, formatVersion: 0 }), registry)).toEqual(document);
});

it('creates valid documents, removes only the view instance, and supports undo', () => {
  expect(createDocument({ id: 'new', name: 'New document', target: sampleDocument.target })).toMatchObject({
    applied: true, undo: { previous: null }, document: { formatVersion: 1 },
  });
  const result = applyCommand(sampleDocument, { kind: 'remove-instance', viewId: 'overview', instanceId: 'overview-orders' });
  expect(result.applied).toBe(true);
  expect(result.document.views[0].instances.map(instance => instance.id)).not.toContain('overview-orders');
  expect(result.document.catalog.tables).toEqual(sampleDocument.catalog.tables);
  expect(result.undo?.previous).toEqual(sampleDocument);
});

it('preserves renamed expressions and rejects a command with broken references', () => {
  const renamed = applyCommand(sampleDocument, { kind: 'rename', objectId: 'item-quantity', physicalName: 'amount' });
  expect(renamed.applied).toBe(true);
  expect(renamed.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'invalidated-expression' })]));
  expect(serializeDocument(renamed.document)).toContain('quantity > 0');
  const rejected = applyCommand(sampleDocument, { kind: 'add-table', table: {
    id: 'broken', namespaceId: 'missing', physicalName: 'broken', columnIds: [],
  } });
  expect(rejected).toMatchObject({ applied: false, document: sampleDocument, undo: null });
  expect(rejected.diagnostics).toEqual([
    expect.objectContaining({ code: 'missing-namespace', severity: 'error', objectId: 'broken' }),
  ]);
});

it('round-trips enum and sequence references with typed column attributes', () => {
  const document = structuredClone(sampleDocument);
  document.catalog.enums.push({
    id: 'order-status', namespaceId: 'public-schema', physicalName: 'OrderStatus',
    values: ['pending', 'shipped'],
  });
  document.catalog.sequences.push({
    id: 'order-sequence', namespaceId: 'public-schema', physicalName: 'OrderNumber',
    start: '9007199254740993', increment: '2', ownedByColumnId: 'order-number',
  });
  document.catalog.columns[1].type = {
    reference: { kind: 'enum', enumId: 'order-status' },
    arguments: [],
    arrayDimensions: 2,
    originalSql: '"OrderStatus"[][]',
    attributes: [{ namespace: 'postgresql', version: 99, data: { labels: ['pending'] } }],
  };
  expect(deserializeDocument(serializeDocument(document))).toEqual(document);
});

it('rejects a migration that skips the next document format version', () => {
  const registry = new MigrationRegistry();
  registry.register(0, value => ({ ...value, formatVersion: 2 }));
  expect(() => deserializeDocument(JSON.stringify({ ...sampleDocument, formatVersion: 0 }), registry))
    .toThrow(/advance exactly one version/i);
});

it('invalidates an affected index expression and retains a proven independent default', () => {
  const renamed = applyCommand(sampleDocument, { kind: 'rename', objectId: 'product-name', physicalName: 'label' });
  expect(renamed.applied).toBe(true);
  expect(renamed.document.catalog.columns.find(column => column.id === 'product-name')?.physicalName).toBe('label');
  expect(renamed.document.catalog.indexes[0].keys[0]).toMatchObject({
    kind: 'expression', expression: { sql: 'lower(name)', references: ['product-name'], invalidated: true },
  });
  expect(renamed.diagnostics).toEqual([
    expect.objectContaining({ code: 'invalidated-expression', severity: 'error', objectId: 'product-name-index' }),
  ]);
  expect(renamed.document.catalog.columns.find(column => column.id === 'item-quantity')?.default).toEqual({
    ...sampleDocument.target, sql: '1', references: [], referencesComplete: true,
  });
  expect(renamed.undo?.previous?.catalog.columns.find(column => column.id === 'product-name')?.physicalName).toBe('name');
});

it('invalidates expressions that reference a column through a renamed table', () => {
  const document = structuredClone(sampleDocument);
  const check = document.catalog.constraints.find(constraint => constraint.id === 'item-quantity-check');
  if (check?.kind !== 'check') throw new Error('Expected the order quantity CHECK');
  check.expression.sql = 'order_items.quantity > 0';
  const renamed = applyCommand(document, { kind: 'rename', objectId: 'items', physicalName: 'line_items' });
  expect(renamed).toMatchObject({ applied: true, diagnostics: [{ code: 'invalidated-expression', objectId: check.id }] });
  expect(renamed.document.catalog.constraints.find(constraint => constraint.id === check.id)).toMatchObject({
    expression: { ...check.expression, invalidated: true },
  });
  expect(renamed.undo?.previous).toEqual(document);
});
