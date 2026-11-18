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
});
