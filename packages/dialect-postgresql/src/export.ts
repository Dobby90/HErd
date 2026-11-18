import { createHash } from 'node:crypto';
import { documentForSelection } from '@erd/model';
import type { Catalog, ErdDocument, SqlExpression } from '@erd/model';
import type { Dependency, Diagnostic, GenerateRequest, PreparedGeneration } from '@erd/sql-contract';
import { compileExpression } from './expressions.js';
import { builtinType, identifier, literal, qualified, validText } from './render-sql.js';
import { canonicalType, constraintBackingIndexes } from './ui.js';

const bounds = new Map([
  ['smallint', [-32768n, 32767n]], ['integer', [-2147483648n, 2147483647n]],
  ['bigint', [-9223372036854775808n, 9223372036854775807n]],
]);
const systemColumns = new Set(['ctid', 'xmin', 'cmin', 'xmax', 'cmax', 'tableoid']);
const foreignActions = { 'no-action': 'NO ACTION', restrict: 'RESTRICT', cascade: 'CASCADE', 'set-null': 'SET NULL', 'set-default': 'SET DEFAULT' };
type Table = Catalog['tables'][number];
type Column = Catalog['columns'][number];
type Sequence = Catalog['sequences'][number];

function sequenceOptions(sequence: Sequence) {
  const type = sequence.dataType ?? 'bigint';
  const [minType, maxType] = bounds.get(type)!;
  const [minInt, maxInt] = bounds.get('bigint')!;
  function option(input: string | undefined, low: bigint, high: bigint) {
    if (input === undefined) return undefined;
    if (!/^[+-]?\d{1,19}$/.test(input)) throw new Error('시퀀스 설정에는 범위 내 정수를 입력하세요.');
    const number = BigInt(input);
    if (number < low || number > high) throw new Error('시퀀스 설정이 정수 범위를 벗어납니다.');
    return number;
  }
  const increment = option(sequence.increment, minInt, maxInt);
  const cache = option(sequence.cache, 1n, maxInt);
  const ascending = (increment ?? 1n) > 0n;
  const minimum = option(sequence.min, minType, maxType);
  const maximum = option(sequence.max, minType, maxType);
  const low = minimum ?? (ascending ? 1n : minType);
  const high = maximum ?? (ascending ? maxType : -1n);
  if (increment === 0n || low >= high) throw new Error('시퀀스의 증가량과 최솟값·최댓값을 확인하세요.');
  const start = option(sequence.start, low, high);
  return [
    'AS ' + type,
    increment === undefined ? '' : 'INCREMENT BY ' + increment,
    minimum === undefined ? '' : 'MINVALUE ' + minimum,
    maximum === undefined ? '' : 'MAXVALUE ' + maximum,
    start === undefined ? '' : 'START WITH ' + start,
    cache === undefined ? '' : 'CACHE ' + cache,
    sequence.cycle === undefined ? '' : sequence.cycle ? 'CYCLE' : 'NO CYCLE',
  ].filter(Boolean).join(' ');
}

function dependenciesFor(document: ErdDocument, tableIds?: readonly string[]): Dependency[] {
  if (tableIds === undefined) return [];
  const selected = new Set(tableIds);
  const { namespaces, tables, enums, sequences } = document.catalog;
  return [
    ...namespaces.map(item => ({ kind: 'namespaces' as const, objectId: item.id })),
    ...tables.filter(item => !selected.has(item.id)).map(item => ({ kind: 'tables' as const, objectId: item.id })),
    ...enums.map(item => ({ kind: 'enums' as const, objectId: item.id })),
    ...sequences.map(item => ({ kind: 'sequences' as const, objectId: item.id })),
  ];
}

export async function preparePostgresqlExport(request: GenerateRequest): Promise<PreparedGeneration> {
  const original = structuredClone(request.document);
  const schema = new Map(original.catalog.namespaces.map(item => [item.id, item.physicalName]));
  const tables = new Map(original.catalog.tables.map(item => [item.id, item]));
  const diagnostics: Diagnostic[] = [];
  const issue = (code: string, id: string, message: string) => diagnostics.push({ code, objectId: id, message, severity: 'error' });
  const scoped = () => request.tableIds === undefined ? original : documentForSelection(original, request.tableIds);
  const expressions = new Map<string, string>();
  const checked = new Set<string>();

  async function analyze(ownerId: string, table: Table, expression: SqlExpression, mode: 'default' | 'check') {
    checked.add(ownerId);
    if (expression.invalidated || expression.engineVersion !== request.target.engineVersion ||
        expression.dialectId !== request.target.dialectId) return;
    try {
      const compiled = await compileExpression(expression.sql, { table, catalog: original.catalog, schema, mode });
      expressions.set(ownerId, compiled.sql);
      expression.references = [...new Set([...(expression.references ?? []), ...compiled.references])];
    } catch (error) {
      issue('postgresql-invalid-expression', ownerId, error instanceof Error ? error.message : 'SQL 식을 확인하세요.');
    }
  }

  let document = scoped();
  while (true) {
    const before = checked.size;
    for (const column of document.catalog.columns) {
      if (column.default && !checked.has(column.id)) await analyze(column.id, tables.get(column.tableId)!, column.default, 'default');
    }
    for (const constraint of document.catalog.constraints) {
      if (constraint.kind === 'check' && !checked.has(constraint.id)) {
        await analyze(constraint.id, tables.get(constraint.tableId)!, constraint.expression, 'check');
      }
    }
    if (checked.size === before) break;
    document = scoped();
  }

  const { catalog } = document;
  const dependencies = dependenciesFor(document, request.tableIds);
  const columns = new Map(catalog.columns.map(item => [item.id, item]));
  const enums = new Map(catalog.enums.map(item => [item.id, item]));
  const tableName = (id: string) => objectName(tables.get(id)!);
  const columnName = (id: string) => identifier(columns.get(id)!.physicalName);
  const objectName = (item: { namespaceId: string; physicalName: string }) => qualified(schema.get(item.namespaceId)!, item.physicalName);
  const backing = constraintBackingIndexes(catalog);
  const columnTypes = new Map<string, string>();
  const sequenceParameters = new Map<string, string>();
  const identityNames = new Map<string, string>();
  const relationNames = new Map<string, Set<string>>();
  const reserve = (namespaceId: string, name: string) => {
    if (!relationNames.has(namespaceId)) relationNames.set(namespaceId, new Set());
    relationNames.get(namespaceId)!.add(name);
  };
  for (const item of [...catalog.tables, ...catalog.sequences]) reserve(item.namespaceId, item.physicalName);
  for (const item of [...catalog.indexes, ...catalog.constraints.filter(item => item.kind === 'pk' || item.kind === 'unique')]) {
    reserve(tables.get(item.tableId)!.namespaceId, item.physicalName);
  }

  function renderType(column: Column) {
    const { reference, arguments: args, arrayDimensions } = column.type;
    if (reference.kind === 'native') return builtinType(reference.name, args, arrayDimensions, reference.namespace);
    const defined = enums.get(reference.enumId);
    if (!defined || args.length || arrayDimensions > 6) throw new Error('문서에서 정의한 ENUM을 인수 없이 사용하세요.');
    return objectName(defined) + '[]'.repeat(arrayDimensions);
  }

  for (const item of catalog.namespaces) {
    if (item.physicalName.startsWith('pg_') || item.physicalName === 'information_schema') {
      issue('postgresql-reserved-schema', item.id, 'PostgreSQL 시스템 스키마에는 객체를 생성할 수 없습니다.');
    }
  }
  for (const item of Object.values(catalog).flat()) {
    if (!validText(item.physicalName) || (request.options?.includeComments !== false && item.description !== undefined && !validText(item.description))) {
      issue('postgresql-invalid-text', item.id, '이름과 설명은 유효한 UTF-8이어야 하며 NUL을 포함할 수 없습니다.');
    }
  }
  for (const item of catalog.enums) {
    if (new Set(item.values).size !== item.values.length ||
        item.values.some(label => !validText(label) || Buffer.byteLength(label) > 63)) {
      issue('postgresql-invalid-enum', item.id, 'ENUM 레이블은 중복 없이 UTF-8 63바이트 이내여야 합니다.');
    }
  }
  for (const table of catalog.tables) {
    if (table.columnIds.length > 1600) issue('postgresql-table-column-limit', table.id, 'PostgreSQL 테이블의 컬럼은 최대 1600개입니다.');
  }
  for (const column of catalog.columns) {
    try {
      columnTypes.set(column.id, renderType(column));
    } catch (error) {
      issue('postgresql-unsupported-type', column.id, (error as Error).message);
    }
    if (systemColumns.has(column.physicalName)) issue('postgresql-system-column-name', column.id, 'PostgreSQL 시스템 컬럼명과 충돌합니다.');
    if (!column.identity) continue;
    const type = column.type.reference;
    if (type.kind !== 'native' || !bounds.has(canonicalType(type.name)) || column.type.arrayDimensions || column.default) {
      issue('postgresql-invalid-identity', column.id, 'IDENTITY는 DEFAULT가 없는 smallint·integer·bigint 컬럼에 지정하세요.');
    }
    const parent = tables.get(column.tableId)!;
    const used = relationNames.get(parent.namespaceId)!;
    const preferred = parent.physicalName + '_' + column.physicalName + '_seq';
    let name = preferred;
    if (Buffer.byteLength(preferred) > 63 || used.has(preferred)) {
      const suffix = createHash('sha256').update(JSON.stringify([parent.physicalName, column.physicalName])).digest('hex').slice(0, 24);
      name = 'erd_identity_' + suffix + '_seq';
      while (used.has(name)) name += '_';
      // The loop above can grow past PostgreSQL's identifier limit if modeled names are adversarial.
      if (Buffer.byteLength(name) > 63) {
        issue('postgresql-identity-name-conflict', column.id, 'IDENTITY 시퀀스에 사용할 이름을 확보할 수 없습니다.');
        continue;
      }
    }
    reserve(parent.namespaceId, name);
    identityNames.set(column.id, qualified(schema.get(parent.namespaceId)!, name));
  }
  for (const item of catalog.sequences) {
    try {
      sequenceParameters.set(item.id, sequenceOptions(item));
      if (item.ownedByColumnId) {
        const owner = columns.get(item.ownedByColumnId)!;
        if (owner.identity || tables.get(owner.tableId)?.namespaceId !== item.namespaceId) {
          throw new Error('OWNED BY는 같은 스키마의 IDENTITY가 아닌 컬럼을 지정하세요.');
        }
      }
    } catch (error) {
      issue('postgresql-invalid-sequence', item.id, (error as Error).message);
    }
  }
  for (const item of catalog.indexes) {
    if (item.predicate || item.keys.some(key => key.kind !== 'column')) {
      issue('postgresql-unsupported-index', item.id, '부분 인덱스와 식 인덱스의 DDL 내보내기는 지원하지 않습니다.');
    }
    if (item.keys.length > 32) issue('postgresql-index-key-limit', item.id, '인덱스 키는 최대 32개입니다.');
  }
  for (const item of catalog.constraints) {
    if ((item.kind === 'pk' || item.kind === 'unique') && item.columnIds.length > 32) {
      issue('postgresql-index-key-limit', item.id, 'PK·UNIQUE 키는 최대 32개입니다.');
    }
  }

  return { document, dependencies, diagnostics, generate() {
    const lines = ['BEGIN;', 'SET LOCAL search_path = pg_catalog, pg_temp;'];
    const add = (sql: string) => lines.push(sql + ';');
    for (const item of catalog.namespaces) {
      if (item.physicalName !== 'public') add('CREATE SCHEMA ' + identifier(item.physicalName));
    }
    for (const item of catalog.enums) add('CREATE TYPE ' + objectName(item) + ' AS ENUM (' + item.values.map(literal).join(', ') + ')');
    for (const item of catalog.sequences) add('CREATE SEQUENCE ' + objectName(item) + ' ' + sequenceParameters.get(item.id));
    for (const item of catalog.tables) {
      const declarations = item.columnIds.map(id => {
        const column = columns.get(id)!;
        const mode = column.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT';
        const extras = [
          !column.nullable ? 'NOT NULL' : '',
          column.identity ? 'GENERATED ' + mode + ' AS IDENTITY (SEQUENCE NAME ' + identityNames.get(id) + ')' : '',
          column.default ? 'DEFAULT (' + expressions.get(id) + ')' : '',
        ].filter(Boolean);
        return ['  ' + columnName(id), columnTypes.get(id), ...extras].join(' ');
      });
      add('CREATE TABLE ' + objectName(item) + ' (' + (declarations.length ? '\n' + declarations.join(',\n') + '\n' : '') + ')');
    }
    for (const item of catalog.constraints) {
      const prefix = 'ALTER TABLE ' + tableName(item.tableId) + ' ADD CONSTRAINT ' + identifier(item.physicalName);
      if (item.kind === 'pk' || item.kind === 'unique') {
        add(prefix + (item.kind === 'pk' ? ' PRIMARY KEY' : ' UNIQUE') + ' (' + item.columnIds.map(columnName).join(', ') + ')');
      }
      if (item.kind === 'check') add(prefix + ' CHECK (' + expressions.get(item.id) + ')');
    }
    const requiredIndexes = new Set(catalog.constraints.flatMap(item => item.kind === 'fk' && item.targetKey.kind === 'index' ? [item.targetKey.id] : []));
    function createIndex(item: Catalog['indexes'][number]) {
      if (backing.has(item.id)) return;
      const keys = item.keys.flatMap(key => key.kind === 'column' ? [columnName(key.columnId)] : []);
      add('CREATE ' + (item.unique ? 'UNIQUE ' : '') + 'INDEX ' + identifier(item.physicalName) +
        ' ON ' + tableName(item.tableId) + ' USING btree (' + keys.join(', ') + ')');
    }
    for (const item of catalog.indexes) if (requiredIndexes.has(item.id)) createIndex(item);
    for (const item of catalog.constraints) {
      if (item.kind !== 'fk') continue;
      add('ALTER TABLE ' + tableName(item.tableId) + ' ADD CONSTRAINT ' + identifier(item.physicalName) +
        ' FOREIGN KEY (' + item.pairs.map(pair => columnName(pair.sourceColumnId)).join(', ') + ')' +
        ' REFERENCES ' + tableName(item.targetTableId) + ' (' + item.pairs.map(pair => columnName(pair.targetColumnId)).join(', ') + ')' +
        (item.onDelete ? ' ON DELETE ' + foreignActions[item.onDelete] : '') +
        (item.onUpdate ? ' ON UPDATE ' + foreignActions[item.onUpdate] : ''));
    }
    for (const item of catalog.indexes) if (!requiredIndexes.has(item.id)) createIndex(item);
    for (const item of catalog.sequences) {
      if (!item.ownedByColumnId) continue;
      const owner = columns.get(item.ownedByColumnId)!;
      add('ALTER SEQUENCE ' + objectName(item) + ' OWNED BY ' + tableName(owner.tableId) + '.' + columnName(owner.id));
    }
    if (request.options?.includeComments !== false) {
      function comment(subject: string, text?: string) {
        if (text !== undefined) add('COMMENT ON ' + subject + ' IS ' + literal(text));
      }
      for (const item of catalog.namespaces) comment('SCHEMA ' + identifier(item.physicalName), item.description);
      for (const item of catalog.enums) comment('TYPE ' + objectName(item), item.description);
      for (const item of catalog.sequences) comment('SEQUENCE ' + objectName(item), item.description);
      for (const item of catalog.tables) comment('TABLE ' + objectName(item), item.description);
      for (const item of catalog.columns) comment('COLUMN ' + tableName(item.tableId) + '.' + columnName(item.id), item.description);
      for (const item of catalog.constraints) {
        comment('CONSTRAINT ' + identifier(item.physicalName) + ' ON ' + tableName(item.tableId), item.description);
      }
      for (const item of catalog.indexes) {
        comment('INDEX ' + objectName({ namespaceId: tables.get(item.tableId)!.namespaceId, physicalName: item.physicalName }), item.description);
      }
    }
    add('COMMIT');
    return { status: 'generated', sql: lines.join('\n\n') + '\n', dependencies, diagnostics: [] };
  } };
}
