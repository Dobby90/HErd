import { erdDocumentSchema } from './schema.js';
import type { Catalog, ErdDocument, SqlTarget } from './schema.js';
import { documentExpressions, validateDocumentStructure } from './structure.js';
import type { ModelDiagnostic } from './structure.js';

const currentVersion = 1;
type VersionedRecord = Record<string, unknown> & { formatVersion: number };
type Migration = (value: Readonly<VersionedRecord>) => unknown;

function readVersion(value: unknown): VersionedRecord {
  if (typeof value === 'object' && value !== null && 'formatVersion' in value &&
      typeof value.formatVersion === 'number' && Number.isSafeInteger(value.formatVersion) && value.formatVersion >= 0) {
    return value as VersionedRecord;
  }
  throw new Error('Invalid document format version.');
}

export class MigrationRegistry {
  readonly #steps = new Map<number, Migration>();

  register(from: number, migration: Migration) {
    if (!Number.isSafeInteger(from) || from < 0 || this.#steps.has(from)) {
      throw new Error('Invalid or duplicate migration source version: ' + from);
    }
    this.#steps.set(from, migration);
  }

  migrate(value: unknown): VersionedRecord {
    let current = readVersion(value);
    if (current.formatVersion > currentVersion) throw new Error('Future document format version: ' + current.formatVersion);
    while (current.formatVersion < currentVersion) {
      const version = current.formatVersion;
      const migration = this.#steps.get(version);
      if (!migration) throw new Error('Missing migration from document format version ' + version);
      current = readVersion(migration(current));
      if (current.formatVersion !== version + 1) throw new Error('A migration must advance exactly one version.');
    }
    return current;
  }
}

function assertStructure(document: ErdDocument): ErdDocument {
  const issues = validateDocumentStructure(document);
  if (issues.length > 0) throw new Error('Invalid document structure: ' + issues.map(issue => issue.code + ' (' + issue.objectId + ')').join(', '));
  return document;
}

export function deserializeDocument(serialized: string, registry = new MigrationRegistry()): ErdDocument {
  return assertStructure(erdDocumentSchema.parse(registry.migrate(JSON.parse(serialized))));
}

export function serializeDocument(document: ErdDocument): string {
  return JSON.stringify(assertStructure(erdDocumentSchema.parse(document)));
}

export type DocumentCommand =
  | { kind: 'rename'; objectId: string; physicalName: string }
  | { kind: 'remove-instance'; viewId: string; instanceId: string }
  | { kind: 'add-table'; table: Catalog['tables'][number]; columns?: Catalog['columns'] };

export type CommandResult =
  | { applied: true; document: ErdDocument; diagnostics: ModelDiagnostic[]; undo: { previous: ErdDocument | null } }
  | { applied: false; document: ErdDocument; diagnostics: ModelDiagnostic[]; undo: null };
export type CreateDocumentResult =
  | { applied: true; document: ErdDocument; diagnostics: []; undo: { previous: null } }
  | { applied: false; document: null; diagnostics: ModelDiagnostic[]; undo: null };

function checkShape(value: unknown) {
  const parsed = erdDocumentSchema.safeParse(value);
  if (parsed.success) return { document: parsed.data, diagnostics: validateDocumentStructure(parsed.data) };
  return {
    document: null,
    diagnostics: parsed.error.issues.map(issue => ({
      code: 'invalid-document-shape', severity: 'error' as const, message: issue.path.join('.') + ': ' + issue.message,
    })),
  };
}

export function createDocument(input: { id: string; name: string; target: SqlTarget }): CreateDocumentResult {
  const { document, diagnostics } = checkShape({
    ...input,
    formatVersion: currentVersion,
    catalog: { namespaces: [], tables: [], columns: [], constraints: [], indexes: [], enums: [], sequences: [] },
    relationships: [], views: [], extensions: [],
  });
  if (!document || diagnostics.length) return { applied: false, document: null, undo: null, diagnostics };
  return { applied: true, document, diagnostics: [], undo: { previous: null } };
}

export function applyCommand(previous: ErdDocument, command: DocumentCommand): CommandResult {
  const document = structuredClone(previous);
  const diagnostics: ModelDiagnostic[] = [];
  const missing = (objectId: string): CommandResult => ({
    applied: false, document: previous, undo: null,
    diagnostics: [{ code: 'missing-command-target', severity: 'error', objectId, message: 'Command target was not found.' }],
  });
  switch (command.kind) {
    case 'add-table':
      document.catalog.tables.push(command.table);
      document.catalog.columns.push(...(command.columns ?? []));
      break;
    case 'remove-instance': {
      const view = document.views.find(candidate => candidate.id === command.viewId);
      if (!view) return missing(command.viewId);
      const index = view.instances.findIndex(instance => instance.id === command.instanceId);
      if (index === -1) return missing(command.instanceId);
      view.instances.splice(index, 1);
      break;
    }
    case 'rename': {
      const object = Object.values(document.catalog).flat().find(candidate => candidate.id === command.objectId);
      if (!object) return missing(command.objectId);
      if (object.physicalName === command.physicalName) break;
      object.physicalName = command.physicalName;
      const { tables, enums, sequences, columns, constraints, indexes } = document.catalog;
      // A reference to a nested object may use its owning table or namespace as a qualifier.
      const affectedIds = new Set([object.id]);
      for (const child of [...tables, ...enums, ...sequences]) {
        if (child.namespaceId === object.id) affectedIds.add(child.id);
      }
      for (const child of [...columns, ...constraints, ...indexes]) {
        if (affectedIds.has(child.tableId)) affectedIds.add(child.id);
      }
      for (const { ownerId, expression } of documentExpressions(document)) {
        const unaffected = expression.referencesComplete &&
          expression.references?.every(id => !affectedIds.has(id));
        if (unaffected || expression.invalidated) continue;
        expression.invalidated = true;
        diagnostics.push({
          code: 'invalidated-expression', severity: 'error', objectId: ownerId,
          message: 'Review the preserved SQL expression after renaming ' + command.objectId + '.',
        });
      }
      break;
    }
  }
  const checked = checkShape(document);
  if (!checked.document || checked.diagnostics.length) {
    return { applied: false, document: previous, undo: null, diagnostics: checked.diagnostics };
  }
  return { applied: true, document: checked.document, undo: { previous }, diagnostics };
}
