import type { ErdDocument } from './schema.js';
import { documentExpressions } from './structure.js';

export function deletionImpact(document: ErdDocument, objectId: string) {
  const { catalog } = document;
  const table = catalog.tables.find(item => item.id === objectId);
  const column = catalog.columns.find(item => item.id === objectId);
  const key = [...catalog.constraints, ...catalog.indexes].find(item => item.id === objectId);
  const namespace = catalog.namespaces.find(item => item.id === objectId);
  if (!table && !column && !key && !namespace) return;

  const removed = new Set([objectId, ...(table?.columnIds ?? [])]);
  const columns = new Set(table?.columnIds ?? (column ? [column.id] : []));
  const views = new Set<string>();
  const detachedSequences = catalog.sequences.filter(item => item.ownedByColumnId && columns.has(item.ownedByColumnId));
  for (const constraint of catalog.constraints) {
    if (constraint.tableId === table?.id ||
        ((constraint.kind === 'pk' || constraint.kind === 'unique') && constraint.columnIds.some(id => columns.has(id)))) {
      removed.add(constraint.id);
    }
  }
  for (const index of catalog.indexes) {
    if (index.tableId === table?.id || index.keys.some(part => part.kind === 'column' && columns.has(part.columnId))) {
      removed.add(index.id);
    }
  }
  for (const constraint of catalog.constraints) {
    if (constraint.kind === 'fk' && (constraint.targetTableId === table?.id ||
        removed.has(constraint.targetKey.id) || constraint.pairs.some(pair =>
          columns.has(pair.sourceColumnId) || columns.has(pair.targetColumnId)))) removed.add(constraint.id);
  }
  for (const relation of document.relationships) {
    if (relation.sourceTableId === table?.id || relation.targetTableId === table?.id) removed.add(relation.id);
  }
  for (const view of document.views) {
    for (const instance of view.instances) {
      if (instance.tableId === table?.id) {
        removed.add(instance.id);
        views.add(view.id);
      } else if (column && instance.tableId === column.tableId &&
          (!instance.visibleColumnIds || instance.visibleColumnIds.includes(column.id))) views.add(view.id);
    }
  }
  const blockedBy = new Set<string>();
  if (namespace) {
    for (const item of [...catalog.tables, ...catalog.enums, ...catalog.sequences]) {
      if (item.namespaceId === namespace.id) blockedBy.add(item.id);
    }
  }
  for (const { ownerId, expression } of documentExpressions(document)) {
    if (removed.has(ownerId)) continue;
    if (!expression.referencesComplete || !expression.references || expression.references.some(id => removed.has(id))) blockedBy.add(ownerId);
  }
  return { removed, views, columns, detachedSequences: detachedSequences.map(item => item.id), blockedBy: [...blockedBy] };
}

export function removeSchemaObject(document: ErdDocument, impact: NonNullable<ReturnType<typeof deletionImpact>>) {
  const retain = <T extends { id: string }>(item: T) => !impact.removed.has(item.id);
  const { catalog } = document;
  catalog.namespaces = catalog.namespaces.filter(retain);
  catalog.tables = catalog.tables.filter(retain);
  catalog.columns = catalog.columns.filter(retain);
  catalog.constraints = catalog.constraints.filter(retain);
  catalog.indexes = catalog.indexes.filter(retain);
  document.relationships = document.relationships.filter(retain);
  for (const table of catalog.tables) table.columnIds = table.columnIds.filter(id => !impact.columns.has(id));
  for (const sequence of catalog.sequences) {
    if (sequence.ownedByColumnId && impact.columns.has(sequence.ownedByColumnId)) delete sequence.ownedByColumnId;
  }
  for (const view of document.views) {
    view.instances = view.instances.filter(retain);
    for (const instance of view.instances) {
      if (instance.visibleColumnIds) instance.visibleColumnIds = instance.visibleColumnIds.filter(id => !impact.columns.has(id));
    }
  }
}
