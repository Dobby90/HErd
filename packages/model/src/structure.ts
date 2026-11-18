import type { ErdDocument, ForeignKey, SqlExpression } from './schema.js';

export interface ModelDiagnostic {
  code: string;
  severity: 'error';
  message: string;
  objectId?: string;
}

export function* documentExpressions(document: ErdDocument): Generator<{ ownerId: string; expression: SqlExpression }> {
  for (const column of document.catalog.columns) {
    if (column.default) yield { ownerId: column.id, expression: column.default };
  }
  for (const constraint of document.catalog.constraints) {
    if (constraint.kind === 'check') yield { ownerId: constraint.id, expression: constraint.expression };
  }
  for (const index of document.catalog.indexes) {
    for (const key of index.keys) {
      if (key.kind === 'expression') yield { ownerId: index.id, expression: key.expression };
    }
    if (index.predicate) yield { ownerId: index.id, expression: index.predicate };
  }
}

function byId<T extends { id: string }>(objects: T[]) {
  return new Map(objects.map(object => [object.id, object]));
}

export function validateDocumentStructure(document: ErdDocument): ModelDiagnostic[] {
  const diagnostics: ModelDiagnostic[] = [];
  const report = (code: string, objectId: string, message: string) => {
    diagnostics.push({ code, severity: 'error', objectId, message });
  };
  const { catalog, views, relationships } = document;
  const namespaces = byId(catalog.namespaces);
  const tables = byId(catalog.tables);
  const columns = byId(catalog.columns);
  const constraints = byId(catalog.constraints);
  const indexes = byId(catalog.indexes);
  const enums = byId(catalog.enums);
  const ids = new Set<string>();
  const catalogIds = new Set(Object.values(catalog).flatMap(objects => objects.map(object => object.id)));
  const objects = [
    document, ...Object.values(catalog).flat(), ...relationships, ...views,
    ...views.flatMap(view => [...view.instances, ...view.groups, ...view.notes]),
  ];
  for (const object of objects) {
    if (ids.has(object.id)) report('duplicate-id', object.id, 'Object IDs must be unique in the document.');
    ids.add(object.id);
  }

  const requireTable = (tableId: string, ownerId: string) => {
    if (!tables.has(tableId)) report('missing-table', ownerId, 'Unknown table: ' + tableId);
  };
  const requireColumns = (columnIds: string[], tableId: string, ownerId: string) => {
    for (const columnId of columnIds) {
      if (columns.get(columnId)?.tableId !== tableId) {
        report('invalid-column-reference', ownerId, 'Column does not belong to table ' + tableId + ': ' + columnId);
      }
    }
    if (new Set(columnIds).size !== columnIds.length) {
      report('duplicate-column-reference', ownerId, 'A column appears multiple times in this list.');
    }
  };
  for (const object of [...catalog.tables, ...catalog.enums, ...catalog.sequences]) {
    if (!namespaces.has(object.namespaceId)) report('missing-namespace', object.id, 'Unknown namespace: ' + object.namespaceId);
  }
  const orderedColumns = new Map(catalog.tables.map(table => [table.id, new Set(table.columnIds)]));
  for (const table of catalog.tables) requireColumns(table.columnIds, table.id, table.id);
  for (const column of catalog.columns) {
    requireTable(column.tableId, column.id);
    if (!orderedColumns.get(column.tableId)?.has(column.id)) {
      report('invalid-column-owner', column.id, 'Column must appear in the owning table order.');
    }
    if (column.type.reference.kind === 'enum' && !enums.has(column.type.reference.enumId)) {
      report('missing-enum', column.id, 'Unknown enum: ' + column.type.reference.enumId);
    }
  }
  for (const sequence of catalog.sequences) {
    if (sequence.ownedByColumnId && !columns.has(sequence.ownedByColumnId)) {
      report('invalid-column-reference', sequence.id, 'Unknown sequence owner column: ' + sequence.ownedByColumnId);
    }
  }
  for (const index of catalog.indexes) {
    requireTable(index.tableId, index.id);
    for (const key of index.keys) {
      if (key.kind === 'column') requireColumns([key.columnId], index.tableId, index.id);
    }
  }
  for (const key of catalog.constraints) {
    requireTable(key.tableId, key.id);
    if (key.kind === 'pk' || key.kind === 'unique') requireColumns(key.columnIds, key.tableId, key.id);
    if (key.kind !== 'fk') continue;

    requireTable(key.targetTableId, key.id);
    const source = key.pairs.map(pair => pair.sourceColumnId);
    const target = key.pairs.map(pair => pair.targetColumnId);
    requireColumns(source, key.tableId, key.id);
    requireColumns(target, key.targetTableId, key.id);
    const targetColumns = new Set(target);
    const candidate = key.targetKey.kind === 'constraint'
      ? constraints.get(key.targetKey.id)
      : indexes.get(key.targetKey.id);
    const candidateColumns = candidate?.tableId === key.targetTableId
      ? ('kind' in candidate
        ? (candidate.kind === 'pk' || candidate.kind === 'unique' ? candidate.columnIds : undefined)
        : (candidate.unique && candidate.keys.every(indexKey => indexKey.kind === 'column')
          ? candidate.keys.flatMap(indexKey => indexKey.kind === 'column' ? [indexKey.columnId] : [])
          : undefined))
      : undefined;
    if (!candidateColumns || candidateColumns.length !== target.length ||
        new Set(candidateColumns).size !== target.length ||
        candidateColumns.some(columnId => !targetColumns.has(columnId)) ||
        new Set(source).size !== source.length || targetColumns.size !== target.length) {
      report('invalid-foreign-key', key.id, 'Foreign key pairs must map distinct source columns to all columns of a candidate key.');
    }
  }
  for (const relation of relationships) {
    requireTable(relation.sourceTableId, relation.id);
    requireTable(relation.targetTableId, relation.id);
  }
  for (const view of views) {
    const groupIds = new Set(view.groups.map(group => group.id));
    for (const instance of view.instances) {
      requireTable(instance.tableId, instance.id);
      if (instance.visibleColumnIds) requireColumns(instance.visibleColumnIds, instance.tableId, instance.id);
    }
    for (const item of [...view.instances, ...view.notes]) {
      if (item.groupId && !groupIds.has(item.groupId)) report('missing-group', item.id, 'Group must belong to the same view.');
    }
  }
  for (const { ownerId, expression } of documentExpressions(document)) {
    for (const reference of expression.references ?? []) {
      if (!catalogIds.has(reference)) report('invalid-expression-reference', ownerId, 'Unknown expression reference: ' + reference);
    }
  }
  return diagnostics;
}

export function physicalRelationships(document: ErdDocument): ForeignKey[] {
  return document.catalog.constraints.filter(constraint => constraint.kind === 'fk');
}

export function columnBadges(document: ErdDocument, columnId: string): Array<'pk' | 'unique' | 'fk'> {
  const badges = new Set<'pk' | 'unique' | 'fk'>();
  for (const key of document.catalog.constraints) {
    if ((key.kind === 'pk' || key.kind === 'unique') && key.columnIds.includes(columnId)) badges.add(key.kind);
    if (key.kind === 'fk' && key.pairs.some(pair => pair.sourceColumnId === columnId)) badges.add('fk');
  }
  return [...badges];
}
