import { expect, it } from 'vitest';
import { applyCommand, commitDocument, createDocument, deletionImpact, deserializeDocument, documentHistory,
  serializeDocument, stepHistory, validateDocumentStructure } from '@erd/model';
import type { ErdDocument, ForeignKey } from '@erd/model';
import { postgresqlEditor } from '@erd/dialect-postgresql/ui';
import { sampleDocument } from '@erd/test-fixtures';
import { createApi } from '../apps/api/src/app.js';

it('commits a table, columns, and its first placement as one undoable operation', () => {
  const created = createDocument({
    id: 'new', name: 'Fresh', target: sampleDocument.target,
    namespace: { id: 'ns', physicalName: 'public' },
    view: { id: 'diagram', name: 'Diagram', groups: [], instances: [], notes: [] },
  });
  if (!created.applied) throw new Error('Cannot create the editor document');
  const original = documentHistory(created.document);
  const { history } = commitDocument(original, { kind: 'batch', commands: [
    { kind: 'add-table', table: { id: 't', namespaceId: 'ns', physicalName: '', columnIds: ['c'] },
      columns: [{ id: 'c', tableId: 't', physicalName: '', nullable: true, type: postgresqlEditor.defaultType }] },
    { kind: 'put-view', view: { ...created.document.views[0], instances: [{ id: 'placement', tableId: 't', x: 0, y: 0 }] } },
  ] });
  expect(history.past).toEqual([created.document]);
  expect(history.present.views[0].instances[0].tableId).toBe('t');
  expect(deserializeDocument(serializeDocument(history.present))).toEqual(history.present);
  const undone = stepHistory(history, 'undo');
  expect(undone.present).toEqual(original.present);
  expect(stepHistory(undone, 'redo').present).toEqual(history.present);
  const failed = commitDocument(undone, { kind: 'remove-view', viewId: 'unknown' });
  expect(failed.history).toBe(undone);
  expect(failed.diagnostics).toMatchObject([{ code: 'missing-command-target' }]);
  expect(commitDocument(undone, { kind: 'title', name: 'Other' }).history.future).toEqual([]);
});

it('preserves legacy data and reports blank and duplicate names separately from structure', async () => {
  const legacy: ErdDocument = structuredClone(sampleDocument);
  legacy.catalog.enums.push({ id: 'status', physicalName: 'status', namespaceId: 'public-schema', values: ['new'] });
  legacy.catalog.sequences.push({ id: 'seq', physicalName: 'seq', namespaceId: 'public-schema', ownedByColumnId: 'user-id' });
  legacy.catalog.columns[0].identity = 'by-default';
  legacy.catalog.columns[1].type = {
    reference: { kind: 'enum', enumId: 'status' }, arguments: ['values'], arrayDimensions: 1,
    originalSql: '"public"."status"[]', attributes: [{ namespace: 'example', version: 1, data: { extra: true } }],
  };
  legacy.extensions.push({ namespace: 'example', version: 1, data: { keep: [1, 2] } });
  const result = applyCommand(legacy, { kind: 'batch', commands: [
    { kind: 'rename', objectId: 'users', physicalName: 'orders' },
    { kind: 'rename', objectId: 'product-name', physicalName: '' },
  ] });
  expect(result.applied).toBe(true);
  expect(validateDocumentStructure(result.document)).toEqual([]);
  const restored = deserializeDocument(serializeDocument(result.document));
  for (const collection of ['columns', 'enums', 'sequences'] as const) {
    if (collection === 'columns') expect(restored.catalog.columns.slice(0, 2)).toEqual(legacy.catalog.columns.slice(0, 2));
    else expect(restored.catalog[collection]).toEqual(legacy.catalog[collection]);
  }
  expect(restored.extensions).toEqual(legacy.extensions);
  expect(postgresqlEditor.validate(restored, { target: restored.target })).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'postgresql-empty-name', objectId: 'product-name' }),
    expect.objectContaining({ code: 'postgresql-duplicate-name', objectId: 'orders' }),
    expect.objectContaining({ code: 'postgresql-duplicate-name', objectId: 'users' }),
  ]));
  const { api, sql } = createApi();
  try {
    const draft = applyCommand(sampleDocument, { kind: 'rename', objectId: 'users', physicalName: '' });
    expect(await sql.generate({ document: draft.document, target: draft.document.target })).toMatchObject({
      status: 'blocked', diagnostics: [expect.objectContaining({ code: 'postgresql-empty-name', objectId: 'users' })],
    });
  } finally {
    await api.close();
  }
});

it('keeps composite FK mappings and derives optionality and uniqueness using dialect rules', () => {
  const document = structuredClone(sampleDocument);
  const key: ForeignKey = {
    id: 'self', physicalName: 'orders_self', kind: 'fk', tableId: 'orders', targetTableId: 'orders',
    targetKey: { kind: 'constraint', id: 'order-pk' },
    pairs: [
      { sourceColumnId: 'order-number', targetColumnId: 'order-user-id' },
      { sourceColumnId: 'order-user-id', targetColumnId: 'order-number' },
    ],
    onDelete: 'restrict', onUpdate: 'cascade',
  };
  const added = applyCommand(document, { kind: 'put-catalog', collection: 'constraints', value: key });
  expect(added.applied).toBe(true);
  expect(deserializeDocument(serializeDocument(added.document)).catalog.constraints.at(-1)).toEqual(key);
  expect(postgresqlEditor.validateForeignKey(added.document, key)).toEqual([]);
  expect(postgresqlEditor.cardinality(added.document, key)).toEqual({ parentOptional: false, childMax: 1 });

  const product = document.catalog.columns.find(column => column.id === 'item-product-id');
  const productReference = document.catalog.constraints.find(item => item.id === 'item-product');
  if (!product || productReference?.kind !== 'fk') throw new Error('Missing sample FK');
  product.nullable = true;
  expect(postgresqlEditor.cardinality(document, productReference)).toEqual({ parentOptional: false, childMax: 'many' });
  product.type.reference = { kind: 'native', name: 'uuid' };
  expect(postgresqlEditor.validateForeignKey(document, productReference)).toMatchObject([
    { code: 'postgresql-incompatible-foreign-key-types', objectId: productReference.id },
  ]);
  expect(postgresqlEditor.referenceKeys(document, 'products')).toContainEqual(expect.objectContaining({
    key: { id: 'product-name-index', kind: 'index' }, unavailable: expect.any(String),
  }));
});

it('previews and removes dependencies atomically while keeping unsafe expressions and references intact', () => {
  const document = structuredClone(sampleDocument);
  document.catalog.sequences.push({ id: 'seq', physicalName: 'owner_seq', namespaceId: 'public-schema', ownedByColumnId: 'user-id' });
  const impact = deletionImpact(document, 'users');
  expect(impact?.removed).toEqual(new Set(['users', 'user-id', 'user-pk', 'order-user', 'reporting', 'overview-users']));
  expect(impact?.views).toEqual(new Set(['overview']));
  expect(impact?.detachedSequences).toEqual(['seq']);
  const deleted = commitDocument(documentHistory(document), { kind: 'remove-schema-object', objectId: 'users' }).history;
  expect(validateDocumentStructure(deleted.present)).toEqual([]);
  expect(deleted.present.catalog.tables.some(table => table.id === 'users')).toBe(false);
  expect(deleted.present.catalog.sequences[0]).not.toHaveProperty('ownedByColumnId');
  expect(stepHistory(deleted, 'undo').present).toEqual(document);

  const protectedColumn = deletionImpact(document, 'product-name');
  expect(protectedColumn?.blockedBy).toEqual(['product-name-index']);
  const blocked = applyCommand(document, { kind: 'remove-schema-object', objectId: 'product-name' });
  expect(blocked.applied).toBe(false);
  expect(blocked.document).toBe(document);
  expect(blocked.diagnostics).toMatchObject([{ code: 'unsafe-expression-deletion' }]);

  const hide = applyCommand(document, { kind: 'remove-instance', viewId: 'overview', instanceId: 'overview-orders' });
  expect(hide.document.catalog).toEqual(document.catalog);
  expect(hide.document.views[1]).toEqual(document.views[1]);
});

it('leaves a pristine sample out of the undo and recovery workflow when its title is reapplied', () => {
  const history = documentHistory(sampleDocument);
  expect(commitDocument(history, { kind: 'title', name: sampleDocument.name }).history).toBe(history);
});
