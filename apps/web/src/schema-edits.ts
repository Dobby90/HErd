import type { DocumentCommand, ErdDocument } from '@erd/model';
import type { Column, Table } from './editor-fields.js';

export function putColumn(table: Table, column: Column, index = table.columnIds.length): DocumentCommand {
  if (table.columnIds[index] === column.id) return { kind: 'put-catalog', collection: 'columns', value: column };
  const columnIds = table.columnIds.filter(id => id !== column.id);
  columnIds.splice(index, 0, column.id);
  return { kind: 'batch', commands: [
    { kind: 'put-catalog', collection: 'columns', value: column },
    { kind: 'put-catalog', collection: 'tables', value: { ...table, columnIds } },
  ] };
}

export function columnTypeLabel(type: Column['type'], enums: ReadonlyMap<string, string>) {
  const ref = type.reference;
  const name = ref.kind === 'enum' ? enums.get(ref.enumId) || 'ENUM' :
    ref.namespace && ref.namespace !== 'pg_catalog' ? ref.namespace + '.' + ref.name : ref.name;
  return name + (type.arguments.length ? '(' + type.arguments.join(', ') + ')' : '') +
    '[]'.repeat(Math.min(type.arrayDimensions, 12));
}

const encoder = new TextEncoder();
export function validPhysicalName(name: string) {
  return Boolean(name.trim()) && !name.includes('\0') && encoder.encode(name).length <= 63;
}

export function availableName(base: string, used: Set<string>) {
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? '' : '_' + index;
    let name = '';
    for (const char of base.replaceAll('\0', '')) {
      if (encoder.encode(name + char + suffix).length > 63) break;
      name += char;
    }
    name = (name.trim() || 'new_object') + suffix;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
}

export function schemaRelationNames(document: ErdDocument, namespaceId: string) {
  const { catalog } = document;
  const tables = catalog.tables.filter(item => item.namespaceId === namespaceId);
  const tableIds = new Set(tables.map(item => item.id));
  return new Set([
    ...tables.map(item => item.physicalName),
    ...catalog.sequences.filter(item => item.namespaceId === namespaceId).map(item => item.physicalName),
    ...catalog.indexes.filter(item => tableIds.has(item.tableId)).map(item => item.physicalName),
    ...catalog.constraints.filter(item => tableIds.has(item.tableId) && (item.kind === 'pk' || item.kind === 'unique')).map(item => item.physicalName),
    ...catalog.columns.filter(item => tableIds.has(item.tableId)).flatMap(item => item.identitySequence?.physicalName ?? []),
  ]);
}
