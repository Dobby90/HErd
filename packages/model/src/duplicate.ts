import type { ErdDocument, SqlExpression } from './schema.js';

export function duplicateDocument(source: ErdDocument, id: string, name: string): ErdDocument {
  const document = structuredClone(source);
  const { catalog, relationships, views } = document;
  const ids = new Map<string, string>([[source.id, id]]);
  const objects = [
    ...Object.values(catalog).flat(), ...relationships, ...views,
    ...views.flatMap(view => [...view.instances, ...view.groups, ...view.notes]),
  ];
  for (const object of objects) ids.set(object.id, crypto.randomUUID());
  function remap(previous: string): string {
    const next = ids.get(previous);
    if (!next) throw new Error('Cannot duplicate broken document reference: ' + previous);
    return next;
  }
  function expression(value?: SqlExpression) {
    if (value?.references) value.references = value.references.map(remap);
  }

  document.id = id;
  document.name = name;
  for (const object of objects) object.id = remap(object.id);
  for (const object of [...catalog.tables, ...catalog.enums, ...catalog.sequences]) object.namespaceId = remap(object.namespaceId);
  for (const table of catalog.tables) table.columnIds = table.columnIds.map(remap);
  for (const column of catalog.columns) {
    column.tableId = remap(column.tableId);
    if (column.type.reference.kind === 'enum') column.type.reference.enumId = remap(column.type.reference.enumId);
    expression(column.default);
  }
  for (const constraint of catalog.constraints) {
    constraint.tableId = remap(constraint.tableId);
    if (constraint.kind === 'pk' || constraint.kind === 'unique') constraint.columnIds = constraint.columnIds.map(remap);
    if (constraint.kind === 'check') expression(constraint.expression);
    if (constraint.kind === 'fk') {
      constraint.targetTableId = remap(constraint.targetTableId);
      constraint.targetKey.id = remap(constraint.targetKey.id);
      for (const pair of constraint.pairs) {
        pair.sourceColumnId = remap(pair.sourceColumnId);
        pair.targetColumnId = remap(pair.targetColumnId);
      }
    }
  }
  for (const index of catalog.indexes) {
    index.tableId = remap(index.tableId);
    for (const key of index.keys) {
      if (key.kind === 'column') key.columnId = remap(key.columnId);
      else expression(key.expression);
    }
    expression(index.predicate);
  }
  for (const sequence of catalog.sequences) {
    if (sequence.ownedByColumnId) sequence.ownedByColumnId = remap(sequence.ownedByColumnId);
  }
  for (const relationship of relationships) {
    relationship.sourceTableId = remap(relationship.sourceTableId);
    relationship.targetTableId = remap(relationship.targetTableId);
  }
  for (const view of views) {
    for (const instance of view.instances) {
      instance.tableId = remap(instance.tableId);
      instance.visibleColumnIds = instance.visibleColumnIds?.map(remap);
    }
    for (const item of [...view.instances, ...view.notes]) {
      if (item.groupId) item.groupId = remap(item.groupId);
    }
  }
  return document;
}
