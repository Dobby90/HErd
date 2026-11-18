import { erdDocumentSchema } from './schema.js';
import type { Catalog, ErdDocument, SqlTarget } from './schema.js';
import { documentExpressions, validateDocumentStructure } from './structure.js';
import { deletionImpact, removeSchemaObject } from './deletion.js';
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

const documentMigrations = new MigrationRegistry();
documentMigrations.register(0, value => ({
  ...value, formatVersion: 1, extensions: value.extensions === undefined ? [] : value.extensions,
}));

export function deserializeDocument(serialized: string, registry = documentMigrations): ErdDocument {
  return assertStructure(erdDocumentSchema.parse(registry.migrate(JSON.parse(serialized))));
}

export function serializeDocument(document: ErdDocument): string {
  return JSON.stringify(assertStructure(erdDocumentSchema.parse(document)));
}

type CatalogEdit = { [K in keyof Catalog]: { kind: 'put-catalog'; collection: K; value: Catalog[K][number] } }[keyof Catalog];

export type DocumentCommand =
  | CatalogEdit
  | { kind: 'batch'; commands: DocumentCommand[] }
  | { kind: 'title'; name: string }
  | { kind: 'put-view'; view: ErdDocument['views'][number] }
  | { kind: 'remove-view'; viewId: string }
  | { kind: 'put-relationship'; value: ErdDocument['relationships'][number] }
  | { kind: 'remove-relationship'; id: string }
  | { kind: 'remove-schema-object'; objectId: string }
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

export function createDocument(input: { id: string; name: string; target: SqlTarget; namespace?: Catalog['namespaces'][number]; view?: ErdDocument['views'][number] }): CreateDocumentResult {
  const { document, diagnostics } = checkShape({
    id: input.id, name: input.name, target: input.target,
    formatVersion: currentVersion,
    catalog: { namespaces: input.namespace ? [input.namespace] : [], tables: [], columns: [], constraints: [], indexes: [], enums: [], sequences: [] },
    relationships: [], views: input.view ? [input.view] : [], extensions: [],
  });
  if (!document || diagnostics.length) return { applied: false, document: null, undo: null, diagnostics };
  return { applied: true, document, diagnostics: [], undo: { previous: null } };
}

function put<T extends { id: string }>(list: T[], value: T) {
  const index = list.findIndex(item => item.id === value.id);
  if (index < 0) list.push(structuredClone(value));
  else list[index] = structuredClone(value);
}

export function applyCommand(previous: ErdDocument, command: DocumentCommand): CommandResult {
  const document = structuredClone(previous);
  const diagnostics: ModelDiagnostic[] = [];
  const missing = (objectId: string): ModelDiagnostic => ({
    code: 'missing-command-target', severity: 'error', objectId, message: 'Command target was not found.',
  });
  function invalidate(objectId: string) {
    const { tables, enums, sequences, columns, constraints, indexes } = document.catalog;
    const affectedIds = new Set([objectId]);
    for (const child of [...tables, ...enums, ...sequences]) {
      if (child.namespaceId === objectId) affectedIds.add(child.id);
    }
    for (const child of [...columns, ...constraints, ...indexes]) {
      if (affectedIds.has(child.tableId)) affectedIds.add(child.id);
    }
    for (const { ownerId, expression } of documentExpressions(document)) {
      if (expression.invalidated || (expression.referencesComplete &&
          expression.references?.every(id => !affectedIds.has(id)))) continue;
      expression.invalidated = true;
      diagnostics.push({
        code: 'invalidated-expression', severity: 'error', objectId: ownerId,
        message: 'Review the preserved SQL expression after renaming or moving ' + objectId + '.',
      });
    }
  }

  const last = (id: string, removed: boolean) => removed ? undefined : missing(id);
  function execute(edit: DocumentCommand): ModelDiagnostic | undefined {
    switch (edit.kind) {
      case 'batch':
        for (const item of edit.commands) {
          const failure = execute(item);
          if (failure) return failure;
        }
        break;
      case 'title':
        document.name = edit.name;
        break;
      case 'put-view':
        put(document.views, edit.view);
        break;
      case 'remove-view': {
        const length = document.views.length;
        document.views = document.views.filter(view => view.id !== edit.viewId);
        return last(edit.viewId, length !== document.views.length);
      }
      case 'put-relationship':
        put(document.relationships, edit.value);
        break;
      case 'remove-relationship': {
        const length = document.relationships.length;
        document.relationships = document.relationships.filter(relation => relation.id !== edit.id);
        return last(edit.id, length !== document.relationships.length);
      }
      case 'put-catalog': {
        const list: Array<Catalog[keyof Catalog][number]> = document.catalog[edit.collection];
        const previousValue = list.find(item => item.id === edit.value.id);
        put(list, edit.value);
        if (previousValue && (previousValue.physicalName !== edit.value.physicalName ||
            ('namespaceId' in previousValue && 'namespaceId' in edit.value &&
              previousValue.namespaceId !== edit.value.namespaceId))) invalidate(edit.value.id);
        break;
      }
      case 'remove-schema-object': {
        const impact = deletionImpact(document, edit.objectId);
        if (!impact) return missing(edit.objectId);
        if (impact.blockedBy.length) return {
          code: 'unsafe-expression-deletion', severity: 'error', objectId: edit.objectId,
          message: 'Review dependent SQL expressions first: ' + impact.blockedBy.join(', '),
        };
        removeSchemaObject(document, impact);
        break;
      }
      case 'add-table':
        document.catalog.tables.push(structuredClone(edit.table));
        document.catalog.columns.push(...structuredClone(edit.columns ?? []));
        break;
      case 'remove-instance': {
        const view = document.views.find(candidate => candidate.id === edit.viewId);
        if (!view) return missing(edit.viewId);
        const index = view.instances.findIndex(instance => instance.id === edit.instanceId);
        if (index === -1) return missing(edit.instanceId);
        view.instances.splice(index, 1);
        break;
      }
      case 'rename': {
        const object = Object.values(document.catalog).flat().find(candidate => candidate.id === edit.objectId);
        if (!object) return missing(edit.objectId);
        if (object.physicalName !== edit.physicalName) {
          object.physicalName = edit.physicalName;
          invalidate(object.id);
        }
        break;
      }
    }
  }

  const failure = execute(command);
  if (failure) return { applied: false, document: previous, undo: null, diagnostics: [failure] };
  const checked = checkShape(document);
  if (!checked.document || checked.diagnostics.length) {
    return { applied: false, document: previous, undo: null, diagnostics: checked.diagnostics };
  }
  return { applied: true, document: checked.document, undo: { previous }, diagnostics };
}
