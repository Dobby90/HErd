import { documentExpressions } from '@erd/model';
import type { Catalog, ErdDocument, ForeignKey } from '@erd/model';
import type { Diagnostic, DialectCapabilities, DialectMetadata, EditorDialect, ReferenceKey } from '@erd/sql-contract';

export const postgresqlMetadata: DialectMetadata = {
  id: 'postgresql',
  name: 'PostgreSQL',
  adapterVersion: '0.2.0',
  profiles: [{ version: '17', status: 'certified' }],
};

const modeled = {
  model: 'supported', edit: 'not-implemented', import: 'not-implemented', export: 'supported',
} as const;
const editable = { ...modeled, edit: 'supported' } as const;

export const postgresqlCapabilities = {
  namespace: editable,
  table: editable,
  column: editable,
  primaryKey: editable,
  unique: editable,
  foreignKey: editable,
  check: editable,
  default: editable,
  index: editable,
  expressionIndex: { ...editable, export: 'unsupported' },
  partialIndex: { ...editable, export: 'unsupported' },
  comment: editable,
  enum: modeled,
  sequence: modeled,
  identity: modeled,
  array: editable,
} satisfies DialectCapabilities;

export const postgresqlTypes = [
  'smallint', 'integer', 'bigint', 'numeric', 'boolean', 'text', 'varchar', 'date',
  'timestamp', 'timestamptz', 'uuid', 'jsonb', 'bytea',
] as const;

function referenceKeys(document: ErdDocument, tableId: string): ReferenceKey[] {
  const keys: ReferenceKey[] = [];
  for (const item of document.catalog.constraints) {
    if (item.tableId === tableId && (item.kind === 'pk' || item.kind === 'unique')) {
      keys.push({ key: { kind: 'constraint', id: item.id }, name: item.physicalName, columnIds: item.columnIds });
    }
  }
  for (const item of document.catalog.indexes) {
    if (item.tableId !== tableId) continue;
    const columnIds = item.keys.flatMap(key => key.kind === 'column' ? [key.columnId] : []);
    const unavailable = !item.unique ? '고유 인덱스가 아닙니다.' : item.predicate ? '부분 인덱스입니다.' :
      columnIds.length !== item.keys.length ? 'SQL 식을 포함한 인덱스입니다.' :
      new Set(columnIds).size !== columnIds.length ? '같은 컬럼이 반복됩니다.' : undefined;
    keys.push({ key: { kind: 'index', id: item.id }, name: item.physicalName, columnIds, unavailable });
  }
  return keys;
}

type ColumnType = Catalog['columns'][number]['type'];

const aliases = new Map(Object.entries({
  int: 'integer', int2: 'smallint', int4: 'integer', int8: 'bigint', decimal: 'numeric',
  bool: 'boolean', 'character varying': 'varchar', 'timestamp without time zone': 'timestamp',
  'timestamp with time zone': 'timestamptz',
}));
export const canonicalType = (name: string) => aliases.get(name) ?? name;
const integer = new Set(['smallint', 'integer', 'bigint']);
const text = new Set(['text', 'varchar']);
const datetime = new Set(['date', 'timestamp', 'timestamptz']);

function compatible(source: ColumnType, target: ColumnType): boolean {
  const a = source.reference;
  const b = target.reference;
  if (Boolean(source.arrayDimensions) !== Boolean(target.arrayDimensions)) return false;
  if (a.kind === 'enum' || b.kind === 'enum') return a.kind === 'enum' && b.kind === 'enum' && a.enumId === b.enumId;
  const aNamespace = a.namespace ?? 'pg_catalog';
  const bNamespace = b.namespace ?? 'pg_catalog';
  if (aNamespace !== bNamespace) return false;
  if (aNamespace !== 'pg_catalog') return a.name === b.name;

  const sourceName = canonicalType(a.name);
  const targetName = canonicalType(b.name);
  if (sourceName === targetName) return true;
  if (source.arrayDimensions) return false;

  // PostgreSQL uses equality in the referenced key's operator family, or
  // implicitly casts the source to the key's comparison type.
  return (integer.has(sourceName) && (integer.has(targetName) || targetName === 'numeric')) ||
    (text.has(sourceName) && text.has(targetName)) ||
    (datetime.has(sourceName) && datetime.has(targetName));
}

function validateForeignKey(document: ErdDocument, key: ForeignKey): Diagnostic[] {
  const candidate = referenceKeys(document, key.targetTableId)
    .find(item => item.key.kind === key.targetKey.kind && item.key.id === key.targetKey.id);
  const error = (code: string, message: string): Diagnostic[] => [{ code, severity: 'error', objectId: key.id, message }];
  if (!candidate || candidate.unavailable) {
    const index = document.catalog.indexes.find(item => key.targetKey.kind === 'index' && item.id === key.targetKey.id);
    if (index?.predicate) return error('postgresql-partial-reference-index', '부분 고유 인덱스는 FK에서 참조할 수 없습니다.');
    return error('postgresql-invalid-reference-key', candidate?.unavailable ?? '참조할 후보키가 없습니다.');
  }
  const sources = new Set(key.pairs.map(pair => pair.sourceColumnId));
  const targets = new Set(key.pairs.map(pair => pair.targetColumnId));
  if (sources.size !== key.pairs.length || targets.size !== candidate.columnIds.length ||
      targets.size !== key.pairs.length || candidate.columnIds.some(id => !targets.has(id))) {
    return error('postgresql-invalid-column-mapping', '후보키의 각 컬럼에 서로 다른 원본 컬럼을 지정하세요.');
  }
  for (const pair of key.pairs) {
    const source = document.catalog.columns.find(column => column.id === pair.sourceColumnId && column.tableId === key.tableId);
    const target = document.catalog.columns.find(column => column.id === pair.targetColumnId && column.tableId === key.targetTableId);
    if (!source || !target || !compatible(source.type, target.type)) {
      return error('postgresql-incompatible-foreign-key-types', `FK 자료형이 호환되지 않습니다 (${source?.physicalName || pair.sourceColumnId} → ${target?.physicalName || pair.targetColumnId}).`);
    }
  }
  return [];
}

export const postgresqlEditor: EditorDialect = {
  metadata: postgresqlMetadata,
  capabilities: target => target.engineVersion === '17' ? postgresqlCapabilities : {},
  types: target => target.engineVersion === '17' ? postgresqlTypes : [],
  defaultType: { reference: { kind: 'native', name: 'integer' }, arguments: [], arrayDimensions: 0 },
  typeProblem(type) {
    const reference = type.reference;
    if (reference.kind !== 'native' || (reference.namespace && reference.namespace !== 'pg_catalog')) return;
    const name = canonicalType(reference.name);
    if (!(postgresqlTypes as readonly string[]).includes(name) || !type.arguments.length) return;
    const [first, second] = type.arguments;
    const between = (value: number | string, low: number, high: number) =>
      typeof value === 'number' && Number.isInteger(value) && value >= low && value <= high;
    const count = type.arguments.length;
    if (name === 'numeric') {
      if (count <= 2 && between(first, 1, 1000) && (second === undefined || between(second, -1000, 1000))) return;
      return 'NUMERIC은 정밀도(1~1000)와 선택적 스케일(-1000~1000)을 받습니다.';
    }
    if (name === 'varchar') {
      if (count === 1 && between(first, 1, 10485760)) return;
      return 'VARCHAR는 길이 1~10485760을 받습니다.';
    }
    if (name === 'timestamp' || name === 'timestamptz') {
      if (count === 1 && between(first, 0, 6)) return;
      return 'TIMESTAMP 정밀도는 0~6입니다.';
    }
    return '선택한 PostgreSQL 타입에는 인수를 지정할 수 없습니다.';
  },
  actions: ['no-action', 'restrict', 'cascade', 'set-null', 'set-default'],
  referenceKeys,
  validateForeignKey,
  cardinality(document, key) {
    if (validateForeignKey(document, key).length) return;
    const sources = new Set(key.pairs.map(pair => pair.sourceColumnId));
    const keys = referenceKeys(document, key.tableId).filter(item => !item.unavailable);
    const primary = document.catalog.constraints.find(item => item.kind === 'pk' && item.tableId === key.tableId);
    return {
      parentOptional: document.catalog.columns.some(column => sources.has(column.id) && column.nullable &&
        !(primary?.kind === 'pk' && primary.columnIds.includes(column.id))),
      childMax: keys.some(item => item.columnIds.every(id => sources.has(id))) ? 1 : 'many',
    };
  },
  validate(document) {
    const diagnostics: Diagnostic[] = [];
    const { catalog } = document;
    const report = (code: string, objectId: string, message: string) => {
      diagnostics.push({ code, objectId, message, severity: 'error' });
    };
    const scopes = new Map<string, Array<{ id: string; physicalName: string }>>();
    const add = (scope: string[], item: { id: string; physicalName: string }) => {
      const key = JSON.stringify([...scope, item.physicalName]);
      const matches = scopes.get(key) ?? [];
      matches.push(item);
      scopes.set(key, matches);
    };
    const tableNamespaces = new Map(catalog.tables.map(table => [table.id, table.namespaceId]));
    for (const item of catalog.namespaces) add(['schema'], item);
    for (const item of [...catalog.tables, ...catalog.sequences]) add(['relation', item.namespaceId], item);
    for (const item of [...catalog.tables, ...catalog.enums]) add(['type', item.namespaceId], item);
    for (const item of catalog.columns) {
      add(['column', item.tableId], item);
      const problem = postgresqlEditor.typeProblem(item.type);
      if (problem) report('postgresql-invalid-type-arguments', item.id, problem);
    }
    const backingIndexes = constraintBackingIndexes(catalog);
    for (const item of catalog.indexes) if (!backingIndexes.has(item.id)) {
      add(['relation', tableNamespaces.get(item.tableId) ?? ''], item);
    }

    const primaryTables = new Set<string>();
    for (const item of catalog.constraints) {
      add(['constraint', item.tableId], item);
      if (item.kind === 'pk' || item.kind === 'unique') add(['relation', tableNamespaces.get(item.tableId) ?? ''], item);
      if (item.kind === 'pk') {
        if (primaryTables.has(item.tableId)) report('postgresql-multiple-primary-keys', item.id, '테이블당 기본키는 하나만 지정할 수 있습니다.');
        primaryTables.add(item.tableId);
      }
      if (item.kind === 'fk') diagnostics.push(...validateForeignKey(document, item));
    }
    for (const item of Object.values(catalog).flat()) {
      if (!item.physicalName.trim()) report('postgresql-empty-name', item.id, '물리명을 입력하세요.');
      else if (new TextEncoder().encode(item.physicalName).length > 63 || item.physicalName.includes('\0')) {
        report('postgresql-invalid-name', item.id, '물리명은 UTF-8 기준 63바이트 이내이며 NUL을 포함할 수 없습니다.');
      }
    }
    const duplicateIds = new Set<string>();
    for (const matches of scopes.values()) {
      if (matches.length > 1) for (const item of matches) duplicateIds.add(item.id);
    }
    for (const id of duplicateIds) report('postgresql-duplicate-name', id, '같은 PostgreSQL 명명 범위에 동일한 물리명이 있습니다.');
    for (const { ownerId, expression } of documentExpressions(document)) {
      if (expression.invalidated) report('invalidated-expression', ownerId, '보존된 SQL 식을 검토하세요.');
    }
    return diagnostics;
  },
};


export function constraintBackingIndexes(catalog: Catalog) {
  const keys = new Map(catalog.constraints.flatMap(item => item.kind === 'pk' || item.kind === 'unique'
    ? [[JSON.stringify([item.tableId, item.physicalName]), item.columnIds] as const] : []));
  const backing = new Set<string>();
  for (const index of catalog.indexes) {
    const columns = keys.get(JSON.stringify([index.tableId, index.physicalName]));
    if (index.unique && !index.predicate && !index.extensions?.length && columns?.length === index.keys.length &&
        index.keys.every((key, i) => key.kind === 'column' && key.columnId === columns[i])) {
      const signature = JSON.stringify([index.tableId, index.physicalName]);
      // A second modeled copy is a name conflict.
      if (keys.delete(signature)) backing.add(index.id);
    }
  }
  return backing;
}
