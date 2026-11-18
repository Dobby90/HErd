import { documentExpressions } from '@erd/model';
import type { ErdDocument } from '@erd/model';

export function documentForSelection(document: ErdDocument, tableIds: readonly string[]): ErdDocument {
  const { catalog } = document;
  const dependencies = new Map<string, string[]>();
  const requireObject = (ownerId: string, dependencyId: string) => {
    const required = dependencies.get(ownerId);
    if (required) required.push(dependencyId);
    else dependencies.set(ownerId, [dependencyId]);
  };

  for (const object of [...catalog.tables, ...catalog.enums, ...catalog.sequences]) {
    requireObject(object.id, object.namespaceId);
  }
  // A table includes all its members and a reference to a member requires its table.
  for (const member of [...catalog.columns, ...catalog.constraints, ...catalog.indexes]) {
    requireObject(member.tableId, member.id);
    requireObject(member.id, member.tableId);
  }
  for (const column of catalog.columns) {
    if (column.type.reference.kind === 'enum') requireObject(column.id, column.type.reference.enumId);
  }
  for (const constraint of catalog.constraints) {
    if (constraint.kind === 'fk') requireObject(constraint.id, constraint.targetTableId);
  }
  for (const sequence of catalog.sequences) {
    if (sequence.ownedByColumnId) {
      requireObject(sequence.id, sequence.ownedByColumnId);
      requireObject(sequence.ownedByColumnId, sequence.id);
    }
  }
  for (const { ownerId, expression } of documentExpressions(document)) {
    for (const referenceId of expression.references ?? []) requireObject(ownerId, referenceId);
  }

  // Insertion during Set iteration visits each new dependency once, including cycles.
  const included = new Set(tableIds);
  for (const objectId of included) {
    for (const dependencyId of dependencies.get(objectId) ?? []) included.add(dependencyId);
  }
  const inScope = ({ id }: { id: string }) => included.has(id);
  return {
    ...document,
    catalog: {
      namespaces: catalog.namespaces.filter(inScope),
      tables: catalog.tables.filter(inScope),
      columns: catalog.columns.filter(inScope),
      constraints: catalog.constraints.filter(inScope),
      indexes: catalog.indexes.filter(inScope),
      enums: catalog.enums.filter(inScope),
      sequences: catalog.sequences.filter(inScope),
    },
    relationships: [],
    views: [],
  };
}
