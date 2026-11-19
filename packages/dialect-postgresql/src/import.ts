import { randomUUID } from 'node:crypto';
import { erdDocumentSchema, validateDocumentStructure } from '@erd/model';
import type { Catalog, ErdDocument, ForeignKey, SqlExpression, SqlTarget } from '@erd/model';
import type { Diagnostic, ParseRequest, ParseResult, StatementResult } from '@erd/sql-contract';
import { preparePostgresqlExport } from './export.js';
import { compileAstExpression } from './expressions.js';
import { ast, columnType, names, need, nodes, only, optionList, rangeName, requireOption, sequenceSettings, text, UnsupportedDdl } from './import-ast.js';
import type { Ast } from './import-ast.js';
import { characterOffset, preprocessSql, sourceLocations, statementRanges, textOffsets } from './import-source.js';
import type { Location } from './import-source.js';
import { literal, qualified, validText } from './render-sql.js';
import { canonicalType, postgresqlEditor, postgresqlMetadata, postgresqlTypes } from './ui.js';

interface Entry {
  kind: string;
  body: Ast;
  location: Location;
  path: string[];
  creation: string;
  result?: Omit<StatementResult, 'ordinal'>;
}
type Conversion = string | { skipped: string } | undefined;
type OmittedForeignKey = { message: string; byteOffset?: number; fallback: Location };
type Table = Catalog['tables'][number];
type Column = Catalog['columns'][number];
type Sequence = Catalog['sequences'][number];
const systemSchemas = new Set(['pg_catalog', 'pg_temp', 'information_schema']);
const implicitKeys = new Map([['CONSTR_PRIMARY', 'pkey'], ['CONSTR_UNIQUE', 'key'], ['CONSTR_FOREIGN', 'fkey'], ['CONSTR_CHECK', 'check']]);
const actions = new Map<string, NonNullable<ForeignKey['onDelete']>>([
  ['a', 'no-action'], ['r', 'restrict'], ['c', 'cascade'], ['n', 'set-null'], ['d', 'set-default'],
]);
const dumpSettings = new Set([
  'statement_timeout', 'lock_timeout', 'idle_in_transaction_session_timeout', 'transaction_timeout',
  'check_function_bodies', 'xmloption', 'client_min_messages', 'row_security',
]);
const executable = new Set(['CopyStmt', 'DoStmt', 'CallStmt', 'ExecuteStmt', 'PrepareStmt', 'InsertStmt',
  'UpdateStmt', 'DeleteStmt', 'MergeStmt', 'SelectStmt']);
const indexKind = 'B-tree의 기본 컬럼 키 인덱스만 가져올 수 있습니다.';
const scalar = (value: Ast) => ast(ast(value.A_Const).sval).sval;
const settingsError = '정적으로 이름을 해석할 수 있는 search_path에 문서 내 스키마를 지정하세요.';
const relationKey = (schema: string, name: string) => JSON.stringify([schema, name]);
const profile = postgresqlMetadata.profiles[0];
const blankCatalog = (): Catalog => ({ namespaces: [], tables: [], columns: [], constraints: [], indexes: [], enums: [], sequences: [] });

function settingPath(value: string) {
  if (!value.trim()) return [];
  const part = /\s*("(?:""|[^"])*"|[a-zA-Z_\u0080-\uFFFF][\w$\u0080-\uFFFF]*)\s*(,|$)/y;
  const result: string[] = [];
  let offset = 0;
  while (offset < value.length) {
    part.lastIndex = offset;
    const match = part.exec(value);
    if (!match || (match[2] === ',' && part.lastIndex === value.length)) throw new Error(settingsError);
    const name = match[1];
    result.push(name.startsWith('"') ? name.slice(1, -1).replaceAll('""', '"') : name.replace(/[A-Z]/g, value => value.toLowerCase()));
    offset = part.lastIndex;
  }
  return result;
}

function objectName(prefix: string, column: string | undefined, suffix: string, occupied: (name: string) => boolean) {
  const bytes = (value: string) => Buffer.byteLength(value);
  for (let i = 0; ; i += 1) {
    const tail = '_' + suffix + (i || '');
    const left = [...prefix];
    const right = column ? [...column] : [];
    while (bytes(left.join('') + (column ? '_' + right.join('') : '') + tail) > 63) {
      if (bytes(left.join('')) >= bytes(right.join(''))) left.pop();
      else right.pop();
    }
    const candidate = left.join('') + (column ? '_' + right.join('') : '') + tail;
    if (!occupied(candidate)) return candidate;
  }
}

function plainConstraint(constraint: Ast) {
  const type = text(constraint.contype);
  const known = implicitKeys.has(type) || ['CONSTR_NOTNULL', 'CONSTR_NULL', 'CONSTR_DEFAULT', 'CONSTR_IDENTITY'].includes(type);
  requireOption(known, '지원 범위를 벗어난 인라인 컬럼 또는 테이블 제약입니다 (' + type + ').');
  requireOption(only(constraint, 'contype conname location initially_valid indexname raw_expr fk_upd_action fk_del_action fk_matchtype pktable fk_attrs pk_attrs keys generated_when options') &&
    (!constraint.indexname || type === 'CONSTR_PRIMARY' || type === 'CONSTR_UNIQUE') &&
    (!constraint.fk_matchtype || constraint.fk_matchtype === 's') &&
    (type === 'CONSTR_IDENTITY' || !constraint.options),
  '지원 범위를 벗어난 제약 옵션입니다. DEFERRABLE, NOT VALID, MATCH FULL과 NULLS NOT DISTINCT는 제외됩니다.');
  if (type === 'CONSTR_IDENTITY') {
    const opts = optionList(constraint.options);
    requireOption([...opts.keys()].every(key => ['sequence_name', 'increment', 'start', 'minvalue', 'maxvalue', 'cache', 'cycle'].includes(key)),
      '지원 범위를 벗어난 IDENTITY 시퀀스 옵션입니다.');
  }
}

function importIndex(entry: Entry) {
  const node = entry.body;
  const keys = nodes(node.indexParams).map(value => ast(value.IndexElem));
  requireOption(only(node, 'idxname relation accessMethod indexParams unique if_not_exists') && (!node.accessMethod || node.accessMethod === 'btree') &&
    keys.length > 0 && keys.every(key => only(key, 'name ordering nulls_ordering') && key.name &&
      key.ordering === 'SORTBY_DEFAULT' && key.nulls_ordering === 'SORTBY_NULLS_DEFAULT'), indexKind);
  return keys.map(key => text(key.name));
}

class ImportCatalog {
  readonly catalog: Catalog;
  readonly schemas = new Map<string, Catalog['namespaces'][number]>();
  readonly schemaNames = new Map<string, string>();
  readonly tables = new Map<string, Table>();
  readonly columns = new Map<string, Map<string, Column>>();
  readonly enums = new Map<string, Catalog['enums'][number]>();
  readonly sequences = new Map<string, Sequence>();
  readonly indexes = new Map<string, Catalog['indexes'][number]>();
  readonly entries = new Map<string, Entry>();
  readonly defaults = new Map<string, { table: Table; column: Column; value: unknown; entry: Entry }>();
  readonly checks = new Map<string, { table: Table; constraint: Extract<Catalog['constraints'][number], { kind: 'check' }>; value: unknown; entry: Entry }>();
  readonly keys: { table: Table; ast: Ast; entry: Entry; inline?: Column }[] = [];
  readonly owners: { sequence: Sequence; names: string[]; entry: Entry }[] = [];
  private number = 0;
  private readonly omitted = new Set<string>();
  private readonly views = new Set<string>();
  private readonly omittedForeignKeys = new Set<string>();
  private readonly baseConstraintIndexes = new Set<string>();
  private readonly extensionScopes = new Set<string>();
  private readonly originalIds: Set<string>;
  private readonly ambiguous = new WeakMap<object, Set<string>>();
  private readonly skippedBaseTables = new Set<string>();

  constructor(readonly target: SqlTarget, readonly defaultNamespace: string, private readonly base?: Catalog) {
    this.catalog = base ? structuredClone(base) : blankCatalog();
    this.originalIds = new Set(Object.values(this.catalog).flat().map(item => item.id));
    for (const schema of this.catalog.namespaces) {
      this.registerBase(this.schemas, schema.physicalName, schema);
      this.schemaNames.set(schema.id, schema.physicalName);
    }
    const schemaByTable = new Map<string, string>();
    for (const table of this.catalog.tables) {
      const schema = this.schemaNames.get(table.namespaceId)!;
      schemaByTable.set(table.id, schema);
      this.registerBase(this.tables, relationKey(schema, table.physicalName), table);
      this.columns.set(table.id, new Map());
    }
    for (const column of this.catalog.columns) this.registerBase(this.columns.get(column.tableId)!, column.physicalName, column);
    for (const item of this.catalog.enums) this.registerBase(this.enums, relationKey(this.schemaNames.get(item.namespaceId)!, item.physicalName), item);
    for (const item of this.catalog.sequences) this.registerBase(this.sequences, relationKey(this.schemaNames.get(item.namespaceId)!, item.physicalName), item);
    for (const item of this.catalog.indexes) this.registerBase(this.indexes, relationKey(schemaByTable.get(item.tableId)!, item.physicalName), item);
    for (const item of this.catalog.constraints) {
      if (item.kind === 'pk' || item.kind === 'unique') {
        this.baseConstraintIndexes.add(relationKey(schemaByTable.get(item.tableId)!, item.physicalName));
      }
    }
  }

  private registerBase<T>(items: Map<string, T>, key: string, item: T) {
    if (items.has(key)) {
      const duplicates = this.ambiguous.get(items) ?? new Set<string>();
      duplicates.add(key);
      this.ambiguous.set(items, duplicates);
    }
    items.set(key, item);
  }

  private unique<T>(items: Map<string, T>, key: string, label: string) {
    if (this.ambiguous.get(items)?.has(key)) throw new Error('기존 모델에서 참조 이름이 중복됩니다 (' + label + ').');
    return items.get(key);
  }

  isNew(id: string) {
    return !this.originalIds.has(id);
  }

  additions(): Catalog {
    const added = <T extends { id: string }>(items: T[]) => items.filter(item => this.isNew(item.id));
    const { namespaces, tables, columns, constraints, indexes, enums, sequences } = this.catalog;
    return { namespaces: added(namespaces), tables: added(tables), columns: added(columns), constraints: added(constraints),
      indexes: added(indexes), enums: added(enums), sequences: added(sequences) };
  }

  requireNew(item: { id: string; physicalName: string }) {
    if (!this.isNew(item.id)) throw new Error('테이블 추가에서는 기존 객체를 변경할 수 없습니다 (' + item.physicalName + ').');
  }

  id(entry: Entry) {
    const id = this.base ? randomUUID() : 'import-' + ++this.number;
    this.entries.set(id, entry);
    return id;
  }

  schema(name: string, entry: Entry) {
    if (systemSchemas.has(name) || name.startsWith('pg_')) throw new Error('시스템 스키마에는 모델 객체를 만들 수 없습니다 (' + name + ').');
    let item = this.unique(this.schemas, name, name);
    if (!item) {
      if (name !== this.defaultNamespace && name !== 'public' && entry.kind !== 'CreateSchemaStmt') {
        throw new Error('선언된 스키마를 찾을 수 없습니다 (' + name + ').');
      }
      item = { id: this.id(entry), physicalName: name };
      this.schemas.set(name, item);
      this.schemaNames.set(item.id, name);
      this.catalog.namespaces.push(item);
    }
    return item;
  }

  find<T>(objects: Map<string, T>, path: string[], entry: Entry) {
    if (!path.length || path.length > 2 || !path.at(-1)) return;
    const name = path.at(-1)!;
    for (const namespace of path.length === 2 ? [path[0]] : entry.path) {
      const found = this.unique(objects, relationKey(namespace, name), namespace + '.' + name);
      if (found !== undefined) return found;
    }
  }

  address(path: string[], entry: Entry) {
    if (!path.length || path.length > 2 || !path.at(-1)) throw new Error('유효한 스키마와 객체 이름을 지정하세요.');
    if (path.length === 1 && !entry.creation) throw new Error('현재 search_path에 생성 스키마가 없습니다. 스키마를 명시하세요.');
    return { schema: this.schema(path.length === 2 ? path[0] : entry.creation, entry), name: path.at(-1)! };
  }

  table(path: string[], entry: Entry) {
    return need(this.find(this.tables, path, entry), '테이블을 찾을 수 없습니다 (' + path.join('.') + ').');
  }

  column(table: Table, name: string) {
    return need(this.unique(this.columns.get(table.id)!, name, table.physicalName + '.' + name),
      '컬럼을 찾을 수 없습니다 (' + table.physicalName + '.' + name + ').');
  }

  enumType(path: string[], entry: Entry) {
    if (path.length === 1 && (postgresqlTypes as readonly string[]).includes(canonicalType(path[0]))) {
      const builtins = entry.path.indexOf('pg_catalog');
      if (builtins < 0) return undefined;
      return this.find(this.enums, path, { ...entry, path: entry.path.slice(0, builtins) })?.id;
    }
    return this.find(this.enums, path, entry)?.id;
  }

  captureOmittedDefinition(entry: Entry) {
    const { kind, body, creation } = entry;
    let symbol: 'type' | 'function' | 'operator' = 'type';
    let path: string[];
    switch (kind) {
      case 'ViewStmt': {
        const [schema, name] = rangeName(body.view);
        this.views.add(name === undefined ? relationKey(creation, schema) : relationKey(schema, name));
        return;
      }
      case 'CreateFunctionStmt': symbol = 'function'; path = names(body.funcname); break;
      case 'CreateDomainStmt': path = names(body.domainname); break;
      case 'CreateRangeStmt': path = names(body.typeName); break;
      case 'CompositeTypeStmt': path = rangeName(body.typevar); break;
      case 'DefineStmt':
        if (body.kind !== 'OBJECT_TYPE' && body.kind !== 'OBJECT_OPERATOR') return;
        if (body.kind === 'OBJECT_OPERATOR') symbol = 'operator';
        path = names(body.defnames);
        break;
      case 'CreateExtensionStmt': {
        const option = nodes(body.options).map(item => ast(item.DefElem)).find(item => item.defname === 'schema');
        this.extensionScopes.add(text(ast(ast(option?.arg).String).sval) || creation);
        return;
      }
      default: return;
    }
    if (path.length === 1) path = [creation, path[0]];
    if (path.length === 2) this.omitted.add(JSON.stringify([symbol, ...path]));
  }

  checkReference(kind: 'type' | 'function' | 'operator', path: string[], entry: Entry) {
    const name = path.at(-1);
    const builtin = entry.path.indexOf('pg_catalog');
    const namespaces = path.length === 2 ? [path[0]] :
      kind === 'type' && (postgresqlTypes as readonly string[]).includes(canonicalType(name ?? ''))
        ? (builtin < 0 ? [] : entry.path.slice(0, builtin)) : entry.path;
    if (namespaces.some(namespace => this.omitted.has(JSON.stringify([kind, namespace, name]))) ||
        (path.length === 1 && builtin >= 0 && entry.path.slice(0, builtin).some(namespace => this.extensionScopes.has(namespace)))) {
      throw new Error('제외된 객체에 의존하거나 참조 대상을 확정할 수 없습니다 (' + path.join('.') + ').');
    }
  }

  createEnum(entry: Entry) {
    const { schema, name } = this.address(names(entry.body.typeName), entry);
    const key = relationKey(schema.physicalName, name);
    if (this.enums.has(key)) throw new Error('ENUM 정의가 중복됩니다 (' + name + ').');
    const item = { id: this.id(entry), namespaceId: schema.id, physicalName: name, values: names(entry.body.vals) };
    this.enums.set(key, item);
    this.catalog.enums.push(item);
    return item.id;
  }

  createSequence(entry: Entry) {
    const node = entry.body;
    requireOption(only(node, 'sequence options') && ast(node.sequence).relpersistence === 'p', '임시·비로그·조건부 시퀀스는 지원하지 않습니다.');
    const options = optionList(node.options);
    requireOption([...options.keys()].every(key => ['as', 'increment', 'start', 'minvalue', 'maxvalue', 'cache', 'cycle', 'owned_by'].includes(key)),
      '지원 범위를 벗어난 시퀀스 옵션입니다.');
    const as = options.get('as');
    const type = as ? columnType(as.TypeName, () => undefined).descriptor.reference : { kind: 'native', name: 'bigint' };
    if (type.kind !== 'native' || (type.name !== 'smallint' && type.name !== 'integer' && type.name !== 'bigint')) {
      throw new Error('시퀀스 타입은 smallint·integer·bigint 중 하나여야 합니다.');
    }
    const path = rangeName(node.sequence);
    const { schema, name } = this.address(path, entry);
    const key = relationKey(schema.physicalName, name);
    if (this.sequences.has(key)) throw new Error('시퀀스 정의가 중복됩니다 (' + name + ').');
    const item: Sequence = { id: this.id(entry), namespaceId: schema.id, physicalName: name, dataType: type.name,
      ...sequenceSettings(options) };
    this.sequences.set(key, item);
    this.catalog.sequences.push(item);
    const owner = options.get('owned_by');
    if (owner) this.owners.push({ sequence: item, names: names(ast(owner.List).items), entry });
    return item.id;
  }

  identity(column: Column, table: Table, constraint: Ast) {
    if (column.identity || this.defaults.has(column.id) || column.default) throw new Error('동일 컬럼에 여러 DEFAULT 또는 IDENTITY 정의가 있습니다.');
    const options = optionList(constraint.options);
    const sequence = names(ast(options.get('sequence_name')?.List).items);
    if (sequence.length > 2 || (sequence.length === 2 && sequence[0] !== this.schemaNames.get(table.namespaceId))) {
      throw new Error('IDENTITY 시퀀스는 소유 컬럼과 같은 스키마에 있어야 합니다.');
    }
    column.identity = constraint.generated_when === 'a' ? 'always' : 'by-default';
    column.nullable = false;
    if (options.size) column.identitySequence = { ...sequenceSettings(options), physicalName: sequence.at(-1) };
  }

  setDefault(table: Table, column: Column, value: unknown, entry: Entry) {
    if (column.identity || column.default || this.defaults.has(column.id)) throw new Error('동일 컬럼에 여러 DEFAULT 또는 IDENTITY 정의가 있습니다.');
    if (value === undefined) throw new UnsupportedDdl('DEFAULT 제거 마이그레이션은 지원하지 않습니다.');
    this.defaults.set(column.id, { table, column, value, entry });
  }

  createTable(entry: Entry) {
    const node = entry.body;
    requireOption(only(node, 'relation tableElts oncommit accessMethod if_not_exists') && ast(node.relation).relpersistence === 'p' &&
      (!node.accessMethod || node.accessMethod === 'heap') && node.oncommit === 'ONCOMMIT_NOOP',
    '임시·비로그·상속·분할 테이블과 추가 테이블 옵션은 지원하지 않습니다.');
    const path = rangeName(node.relation);
    const namespace = path.length === 2 ? path[0] : entry.creation;
    const name = path.at(-1)!;
    const key = relationKey(namespace, name);
    if (node.if_not_exists) {
      const existing = this.unique(this.tables, key, namespace + '.' + name);
      if (existing) {
        if (!this.isNew(existing.id)) this.skippedBaseTables.add(existing.id);
        return { skipped: namespace + '.' + name + ' 테이블이 이미 있습니다.' };
      }
    }
    const elements = nodes(node.tableElts);
    for (const item of elements) {
      if (item.Constraint) { plainConstraint(ast(item.Constraint)); continue; }
      const column = ast(item.ColumnDef);
      requireOption(column.colname && only(column, 'colname typeName is_local is_not_null constraints location'),
        'LIKE, COLLATE 및 추가 컬럼 옵션은 지원하지 않습니다.');
      for (const definition of nodes(column.constraints)) plainConstraint(ast(definition.Constraint));
    }
    const { schema } = this.address(path, entry);
    if (this.tables.has(key)) throw new Error('테이블 정의가 중복됩니다 (' + name + ').');
    const table: Table = { id: this.id(entry), namespaceId: schema.id, physicalName: name, columnIds: [] };
    this.catalog.tables.push(table);
    this.tables.set(key, table);
    const byName = new Map<string, Column>();
    this.columns.set(table.id, byName);
    for (const item of elements) {
      if (item.Constraint) {
        this.keys.push({ table, ast: ast(item.Constraint), entry });
        continue;
      }
      const definition = ast(item.ColumnDef);
      const name = text(definition.colname);
      if (byName.has(name)) throw new Error('컬럼 정의가 중복됩니다 (' + name + ').');
      this.checkReference('type', names(ast(definition.typeName).names), entry);
      const { descriptor, serialType } = columnType(definition.typeName, path => this.enumType(path, entry));
      const column: Column = { id: this.id(entry), physicalName: name, tableId: table.id, type: descriptor,
        nullable: !definition.is_not_null && !serialType };
      byName.set(name, column);
      this.catalog.columns.push(column);
      table.columnIds.push(column.id);
      if (serialType) {
        const generated = objectName(table.physicalName, name, 'seq', candidate => {
          const key = relationKey(schema.physicalName, candidate);
          return this.sequences.has(key) || this.tables.has(key);
        });
        const dataType = serialType as Sequence['dataType'];
        const sequence: Sequence = { id: this.id(entry), namespaceId: table.namespaceId, physicalName: generated, ownedByColumnId: column.id, dataType };
        this.sequences.set(relationKey(schema.physicalName, generated), sequence);
        this.catalog.sequences.push(sequence);
        column.default = this.expression('pg_catalog.nextval(' + literal(qualified(schema.physicalName, generated)) + '::pg_catalog.regclass)', [sequence.id]);
      }
      let nullMode: 'null' | 'not-null' | undefined;
      for (const wrapper of nodes(definition.constraints)) {
        const rule = ast(wrapper.Constraint);
        switch (rule.contype) {
          case 'CONSTR_NULL':
          case 'CONSTR_NOTNULL': {
            const mode = rule.contype === 'CONSTR_NULL' ? 'null' : 'not-null';
            if (nullMode && nullMode !== mode) throw new Error('NULL과 NOT NULL 정의가 충돌합니다.');
            nullMode = mode;
            if (mode === 'null' && (column.identity || serialType)) throw new Error('자동 번호 컬럼에는 명시적 NULL을 지정할 수 없습니다.');
            column.nullable = mode === 'null';
            break;
          }
          case 'CONSTR_DEFAULT': this.setDefault(table, column, rule.raw_expr, entry); break;
          case 'CONSTR_IDENTITY':
            if (nullMode === 'null') throw new Error('IDENTITY와 명시적 NULL 정의가 충돌합니다.');
            this.identity(column, table, rule);
            break;
          default: this.keys.push({ table, ast: rule, entry, inline: column });
        }
      }
    }
    return table.id;
  }

  defineIndex(entry: Entry) {
    const columns = importIndex(entry);
    const table = this.table(rangeName(entry.body.relation), entry);
    const schema = this.schemaNames.get(table.namespaceId)!;
    const unique = Boolean(entry.body.unique);
    const name = text(entry.body.idxname) || objectName(table.physicalName, columns.join('_'), 'idx',
      test => this.indexes.has(relationKey(schema, test)));
    const lookup = relationKey(schema, name);
    if (entry.body.if_not_exists && (
      this.unique(this.indexes, lookup, schema + '.' + name) || this.tables.has(lookup) || this.sequences.has(lookup) ||
      this.baseConstraintIndexes.has(lookup) || this.keys.some(key => {
        const primary = key.ast.contype === 'CONSTR_PRIMARY';
        if ((!primary && key.ast.contype !== 'CONSTR_UNIQUE') || this.schemaNames.get(key.table.namespaceId) !== schema ||
          key.entry.location.offset! >= entry.location.offset!) return false;
        const columns = key.inline?.physicalName ?? names(key.ast.keys).join('_');
        const index = text(key.ast.conname) || objectName(key.table.physicalName, primary ? undefined : columns, primary ? 'pkey' : 'key', () => false);
        return index === name;
      })
    )) return { skipped: schema + '.' + name + ' 이름의 객체가 이미 있어 인덱스 생성을 건너뜁니다.' };
    this.requireNew(table);
    const ids = columns.map(name => this.column(table, name).id);
    if (this.indexes.has(lookup)) throw new Error('인덱스 이름이 중복됩니다 (' + name + ').');
    const item: Catalog['indexes'][number] = { id: this.id(entry), tableId: table.id, physicalName: name, unique,
      keys: ids.map(columnId => ({ kind: 'column', columnId })) };
    this.catalog.indexes.push(item);
    this.indexes.set(lookup, item);
    return item.id;
  }

  alterTable(entry: Entry) {
    const node = entry.body;
    const commands = nodes(node.cmds).map(wrapper => ast(wrapper.AlterTableCmd));
    if (commands.length && commands.every(command => command.subtype === 'AT_ChangeOwner')) return 'owner';
    requireOption(node.objtype === 'OBJECT_TABLE' && !node.missing_ok && commands.length > 0, '지원 범위를 벗어난 ALTER TABLE입니다.');
    for (const command of commands) {
      requireOption(['AT_AddConstraint', 'AT_ColumnDefault', 'AT_SetNotNull', 'AT_AddIdentity', 'AT_SetIdentity'].includes(text(command.subtype)),
        '지원 범위를 벗어난 ALTER TABLE 문입니다 (' + text(command.subtype) + ').');
      if (command.subtype === 'AT_AddConstraint' || command.subtype === 'AT_AddIdentity') plainConstraint(ast(ast(command.def).Constraint));
      if (command.subtype === 'AT_ColumnDefault') requireOption(command.def, 'DEFAULT 제거 마이그레이션은 지원하지 않습니다.');
      if (command.subtype === 'AT_SetIdentity') {
        const options = optionList(ast(ast(command.def).List).items);
        requireOption(options.size === 1 && options.has('generated'), 'ALTER IDENTITY는 SET GENERATED 모드 변경을 지원합니다.');
      }
    }
    const table = this.table(rangeName(node.relation), entry);
    this.requireNew(table);
    for (const command of commands) {
      if (command.subtype === 'AT_AddConstraint') {
        this.keys.push({ table, ast: ast(ast(command.def).Constraint), entry });
        continue;
      }
      const column = this.column(table, text(command.name));
      if (command.subtype === 'AT_ColumnDefault') this.setDefault(table, column, command.def, entry);
      if (command.subtype === 'AT_SetNotNull') column.nullable = false;
      if (command.subtype === 'AT_AddIdentity') this.identity(column, table, ast(ast(command.def).Constraint));
      if (command.subtype === 'AT_SetIdentity') {
        if (!column.identity) throw new Error('기존 IDENTITY 컬럼의 생성 모드를 변경하세요.');
        const mode = ast(optionList(ast(ast(command.def).List).items).get('generated')?.Integer).ival;
        if (mode !== 97 && mode !== 100) throw new Error('IDENTITY 생성 모드를 확인하세요.');
        column.identity = mode === 97 ? 'always' : 'by-default';
      }
    }
    return table.id;
  }

  alterSequence(entry: Entry) {
    const node = entry.body;
    const options = optionList(node.options);
    requireOption(only(node, 'sequence options') && options.size === 1 && options.has('owned_by'),
      'ALTER SEQUENCE는 OWNED BY 설정을 지원합니다.');
    const path = rangeName(node.sequence);
    const sequence = need(this.find(this.sequences, path, entry), '소유권을 설정할 시퀀스를 찾을 수 없습니다 (' + path.join('.') + ').');
    this.requireNew(sequence);
    this.owners.push({ sequence, names: names(ast(options.get('owned_by')?.List).items), entry });
    return sequence.id;
  }

  setOwner(owner: ImportCatalog['owners'][number]) {
    const { names, sequence, entry } = owner;
    if (names.length === 1 && names[0] === 'none') { sequence.ownedByColumnId = undefined; return; }
    const table = this.table(names.slice(0, -1), entry);
    this.requireNew(table);
    const column = this.column(table, names.at(-1) ?? '');
    if (table.namespaceId !== sequence.namespaceId || column.identity) throw new Error('OWNED BY에는 같은 스키마의 IDENTITY가 아닌 컬럼을 지정하세요.');
    if (sequence.ownedByColumnId && sequence.ownedByColumnId !== column.id) throw new Error('시퀀스 소유권 정의가 충돌합니다.');
    sequence.ownedByColumnId = column.id;
  }

  key(definition: ImportCatalog['keys'][number]): OmittedForeignKey | undefined {
    const { table, ast: node, entry, inline } = definition;
    const kind = text(node.contype);
    const byNames = (list: unknown, inline?: Column) => list ? names(list).map(name => this.column(table, name)) : inline ? [inline] : [];
    let columns = kind === 'CONSTR_FOREIGN' ? byNames(node.fk_attrs, inline) : byNames(node.keys, inline);
    const schema = this.schemaNames.get(table.namespaceId)!;
    const adoptedName = text(node.indexname);
    let adopted: Catalog['indexes'][number] | undefined;
    if (adoptedName) {
      adopted = this.indexes.get(relationKey(schema, adoptedName));
      if (!adopted || adopted.tableId !== table.id || !adopted.unique) {
        throw new Error('USING INDEX에는 같은 테이블의 고유 B-tree 인덱스가 필요합니다 (' + adoptedName + ').');
      }
      const byId = new Map([...this.columns.get(table.id)!.values()].map(column => [column.id, column]));
      columns = adopted.keys.map(key => {
        if (key.kind !== 'column') throw new Error('USING INDEX에서 식 인덱스를 사용할 수 없습니다.');
        return need(byId.get(key.columnId), 'USING INDEX의 컬럼을 찾을 수 없습니다.');
      });
    }
    const suffix = need(implicitKeys.get(kind), '지원할 수 없는 제약 종류입니다.');
    const keyColumns = kind === 'CONSTR_CHECK' ? inline?.physicalName : columns.map(column => column.physicalName).join('_');
    const name = text(node.conname) || adoptedName || objectName(table.physicalName, kind === 'CONSTR_PRIMARY' ? undefined : keyColumns, suffix, candidate =>
      this.omittedForeignKeys.has(relationKey(table.id, candidate)) ||
      this.catalog.constraints.some(key => key.tableId === table.id && key.physicalName === candidate) ||
      this.indexes.has(relationKey(schema, candidate)));
    const constraintKey = relationKey(table.id, name);
    if (this.omittedForeignKeys.has(constraintKey) ||
      this.catalog.constraints.some(key => key.tableId === table.id && key.physicalName === name)) throw new Error('제약 이름이 중복됩니다 (' + name + ').');
    const indexWithName = this.indexes.get(relationKey(schema, name));
    if ((kind === 'CONSTR_PRIMARY' || kind === 'CONSTR_UNIQUE') && indexWithName && indexWithName !== adopted) {
      throw new Error('제약의 backing index와 기존 인덱스 이름이 중복됩니다 (' + name + ').');
    }
    if (adopted) {
      this.indexes.delete(relationKey(schema, adoptedName));
      this.catalog.indexes = this.catalog.indexes.filter(item => item.id !== adopted!.id);
    }
    const base = { id: this.id(entry), tableId: table.id, physicalName: name };
    if (kind === 'CONSTR_CHECK') {
      const constraint = { ...base, kind: 'check' as const, expression: this.expression('TRUE', []) };
      this.catalog.constraints.push(constraint);
      this.checks.set(constraint.id, { table, constraint, value: node.raw_expr, entry });
    } else if (kind === 'CONSTR_PRIMARY' || kind === 'CONSTR_UNIQUE') {
      if (!columns.length) throw new Error('키에 컬럼이 필요합니다.');
      if (kind === 'CONSTR_PRIMARY') for (const column of columns) column.nullable = false;
      this.catalog.constraints.push({ ...base, kind: kind === 'CONSTR_PRIMARY' ? 'pk' : 'unique', columnIds: columns.map(column => column.id) });
    } else {
      const path = rangeName(node.pktable);
      const target = path.join('.');
      const referenced = this.find(this.tables, path, entry);
      if (!referenced) {
        if (!columns.length || new Set(columns.map(column => column.id)).size !== columns.length ||
          (node.pk_attrs && names(node.pk_attrs).length !== columns.length)) {
          throw new Error('외래 키의 원본·대상 컬럼 대응을 확인하세요.');
        }
        const scopes = path.length === 2 ? [path[0]] : entry.path;
        if (scopes.some(scope => {
          const key = relationKey(scope, path.at(-1)!);
          return this.views.has(key) || this.sequences.has(key) || this.indexes.has(key);
        })) throw new Error('외래 키의 참조 대상이 테이블이 아닙니다 (' + target + ').');
        this.omittedForeignKeys.add(constraintKey);
        const offset = ast(node.pktable).location;
        return { fallback: entry.location, byteOffset: typeof offset === 'number' && offset >= 0 ? offset : undefined,
          message: `외래 키 ${name} (${schema}.${table.physicalName}) · 참조 테이블 ${target}을 찾을 수 없습니다.` };
      }
      const pk = this.catalog.constraints.find(key => key.tableId === referenced.id && key.kind === 'pk');
      const targetColumns = node.pk_attrs ? names(node.pk_attrs).map(name => this.column(referenced, name).id) :
        pk?.kind === 'pk' ? pk.columnIds : [];
      if (!targetColumns.length || columns.length !== targetColumns.length) throw new Error('외래 키의 원본·대상 컬럼 대응을 확인하세요.');
      const candidate = postgresqlEditor.referenceKeys({ catalog: this.catalog } as ErdDocument, referenced.id)
        .find(key => !key.unavailable && key.columnIds.length === targetColumns.length && key.columnIds.every(id => targetColumns.includes(id)));
      if (!candidate) throw new Error('외래 키가 참조하는 PK, UNIQUE 또는 고유 인덱스를 찾을 수 없습니다.');
      this.catalog.constraints.push({ ...base, kind: 'fk', targetTableId: referenced.id, targetKey: candidate.key,
        pairs: columns.map((column, i) => ({ sourceColumnId: column.id, targetColumnId: targetColumns[i] })),
        onDelete: actions.get(text(node.fk_del_action)) ?? 'no-action', onUpdate: actions.get(text(node.fk_upd_action)) ?? 'no-action' });
    }
  }

  comment(entry: Entry) {
    const node = entry.body;
    const object = ast(node.object);
    const path = names(ast(object.List).items);
    const tail = path.at(-1) ?? '';
    const value = text(node.comment) || undefined;
    let item;
    switch (node.objtype) {
      case 'OBJECT_SCHEMA': item = this.schema(text(ast(object.String).sval), entry); break;
      case 'OBJECT_TABLE':
      case 'OBJECT_COLUMN':
      case 'OBJECT_TABCONSTRAINT': {
        const table = this.table(node.objtype === 'OBJECT_TABLE' ? path : path.slice(0, -1), entry);
        if (this.skippedBaseTables.has(table.id)) {
          const schema = this.schemaNames.get(table.namespaceId);
          return { skipped: `${schema}.${table.physicalName}의 기존 코멘트를 유지합니다.` };
        }
        if (node.objtype === 'OBJECT_TABLE') item = table;
        else if (node.objtype === 'OBJECT_COLUMN') item = this.column(table, tail);
        else {
          if (this.omittedForeignKeys.has(relationKey(table.id, tail))) {
            throw new UnsupportedDdl('제외되는 외래 키 ' + tail + '의 코멘트입니다.');
          }
          item = this.catalog.constraints.find(key => key.tableId === table.id && key.physicalName === tail);
        }
        break;
      }
      case 'OBJECT_TYPE': item = this.find(this.enums, names(ast(object.TypeName).names), entry); break;
      case 'OBJECT_SEQUENCE': item = this.find(this.sequences, path, entry); break;
      case 'OBJECT_INDEX': {
        item = this.find(this.indexes, path, entry);
        if (!item) {
          // A constraint's implicit index can have its own description.
          const scopes = path.length === 2 ? [path[0]] : entry.path;
          const match = this.catalog.constraints.find(key => (key.kind === 'pk' || key.kind === 'unique') &&
            key.physicalName === tail && scopes.includes(this.schemaNames.get(this.catalog.tables.find(table => table.id === key.tableId)!.namespaceId)!));
          if (match?.kind === 'pk' || match?.kind === 'unique') {
            const table = this.catalog.tables.find(table => table.id === match.tableId)!;
            this.requireNew(table);
            const index: Catalog['indexes'][number] = { id: this.id(entry), tableId: table.id, physicalName: tail, unique: true,
              keys: match.columnIds.map(columnId => ({ kind: 'column' as const, columnId })) };
            this.catalog.indexes.push(index);
            this.indexes.set(relationKey(this.schemaNames.get(table.namespaceId)!, tail), index);
            item = index;
          }
        }
        break;
      }
      default: throw new UnsupportedDdl('이 종류의 COMMENT 대상은 모델에서 지원하지 않습니다.');
    }
    if (!item) throw new Error('COMMENT의 대상 객체를 찾을 수 없습니다.');
    this.requireNew(item);
    item.description = value;
    return item.id;
  }

  expression(sql: string, references: string[]): SqlExpression {
    return { ...this.target, sql, references, referencesComplete: true };
  }

  compile(value: unknown, mode: 'default' | 'check', table: Table, entry: Entry) {
    const result = compileAstExpression(value, { mode, table, catalog: this.catalog, schema: this.schemaNames, searchPath: entry.path,
      checkReference: (kind, path) => this.checkReference(kind, path, entry) });
    return this.expression(result.sql, result.references);
  }
}

export async function importPostgresql(request: ParseRequest): Promise<ParseResult> {
  const { sql, target, defaultNamespace, signal, baseCatalog } = request;
  const issue = (code: string, message: string, location?: Location): Diagnostic => ({ code, message, severity: 'error', location });
  if (target.dialectId !== 'postgresql' || target.engineVersion !== profile.version) {
    return { status: 'blocked', diagnostics: [issue('uncertified-engine-version', '인증된 PostgreSQL 17을 선택하세요.')] };
  }
  if (Buffer.byteLength(sql) > (request.limits?.maxBytes ?? 5 * 1024 * 1024)) {
    return { status: 'blocked', profile, diagnostics: [issue('sql-byte-limit', 'SQL 입력 크기 한도를 초과했습니다.')] };
  }
  if (!validText(sql) || sql.startsWith('PGDMP')) {
    return { status: 'blocked', profile, diagnostics: [issue('unsupported-sql-file', 'UTF-8 텍스트 PostgreSQL DDL을 입력하세요.')] };
  }
  if (!defaultNamespace.trim() || !validText(defaultNamespace) || Buffer.byteLength(defaultNamespace) > 63 ||
      defaultNamespace.startsWith('pg_') || defaultNamespace === 'information_schema') {
    return { status: 'blocked', profile, diagnostics: [issue('invalid-default-namespace', '기본 스키마의 물리명을 확인하세요.')] };
  }
  signal?.throwIfAborted();
  const prepared = preprocessSql(sql);
  const locate = sourceLocations(sql);
  const controls = prepared.entries.map(({ offset, length, ...item }) => ({ ...item, location: locate(offset, length) }));
  const diagnostics: Diagnostic[] = controls.filter(item => item.status === 'error')
    .map(item => issue('blocked-psql-command', item.message, item.location));
  const withOrdinals = (records: Omit<StatementResult, 'ordinal'>[]) => records
    .sort((a, b) => (a.location?.offset ?? 0) - (b.location?.offset ?? 0))
    .map((item, index) => ({ ...item, ordinal: index + 1 }));
  if (diagnostics.length) return { status: 'blocked', profile, statements: withOrdinals(controls), diagnostics, losses: [] };
  const { parse } = await import('pgsql-parser');
  let tree: Awaited<ReturnType<typeof parse>>;
  try {
    tree = await parse(prepared.sql);
  } catch (error) {
    const cursor = Number(ast(ast(error).sqlDetails).cursorPosition ?? 0);
    const location = locate(characterOffset(prepared.sql, Math.max(0, cursor)), 1);
    diagnostics.push(issue('postgresql-syntax-error', 'PostgreSQL 문법 오류입니다. 표시된 위치를 확인하세요.', location));
    return { status: 'blocked', profile, statements: withOrdinals([...controls, { kind: 'SQL', status: 'error', location,
      message: diagnostics.at(-1)!.message }]), diagnostics, losses: [] };
  }
  if (Math.floor(tree.version / 10000) !== Number(profile.version)) {
    return { status: 'blocked', profile, diagnostics: [issue('unexpected-parser-version', 'PostgreSQL 파서 버전을 확인하세요.')] };
  }
  if (tree.stmts.length + controls.length > (request.limits?.maxStatements ?? 10_000)) {
    return { status: 'blocked', profile, diagnostics: [issue('sql-statement-limit', 'SQL 문장 수 한도를 초과했습니다.')] };
  }
  const range = statementRanges(prepared.sql);
  const entries: Entry[] = tree.stmts.map((raw: { stmt: unknown; stmt_location?: number; stmt_len?: number }) => {
    const [kind] = Object.keys(raw.stmt ?? {});
    const { offset, length } = range(raw.stmt_location ?? 0, raw.stmt_len ?? 0);
    return { kind, body: ast(ast(raw.stmt)[kind]), location: locate(offset, length), path: [defaultNamespace], creation: defaultNamespace };
  });
  const model = new ImportCatalog(target, defaultNamespace, baseCatalog);
  const losses: Diagnostic[] = [];
  function record(entry: Entry, status: StatementResult['status'], message?: string, objectId?: string) {
    entry.result = { kind: entry.kind, location: entry.location, status, message, objectId };
    if (status === 'unsupported') losses.push({ code: 'unsupported-statement', severity: 'warning',
      feature: entry.kind, message: message ?? '지원하는 구조 변환 범위 밖의 문장입니다.', location: entry.location, objectId });
  }
  function reject(entry: Entry, error: unknown) {
    const message = error instanceof Error ? error.message : 'DDL 정의를 검증하지 못했습니다.';
    if (error instanceof UnsupportedDdl) record(entry, 'unsupported', message);
    else {
      record(entry, 'error', message);
      diagnostics.push(issue('invalid-ddl-definition', message, entry.location));
    }
  }
  function run(entry: Entry, convert: () => Conversion) {
    try {
      signal?.throwIfAborted();
      const result = convert();
      if (typeof result === 'object') {
        record(entry, 'skipped-existing', result.skipped);
        if (entry.kind === 'CreateStmt' || entry.kind === 'IndexStmt') diagnostics.push({
          code: entry.kind === 'CreateStmt' ? 'existing-table-skipped' : 'existing-index-skipped',
          severity: 'info', message: result.skipped, location: entry.location,
        });
      } else if (result === 'owner') record(entry, 'ignored-nonstructural', '소유자 설정은 ERD 구조에 영향을 주지 않습니다.');
      else record(entry, 'converted', undefined, result);
    } catch (error) {
      signal?.throwIfAborted();
      reject(entry, error);
    }
  }

  const declared = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== 'CreateSchemaStmt') continue;
    run(entry, () => {
      requireOption(only(entry.body, 'schemaname') && entry.body.schemaname, '복합 CREATE SCHEMA 옵션은 지원하지 않습니다.');
      const name = text(entry.body.schemaname);
      if (declared.has(name)) throw new Error('스키마 정의가 중복됩니다 (' + name + ').');
      declared.add(name);
      return model.schema(name, entry).id;
    });
  }
  let persistent = [defaultNamespace];
  let path = persistent;
  let transaction = false;
  function assignPath(values: string[], local: boolean) {
    if (local && !transaction) throw new Error('SET LOCAL search_path를 사용하려면 BEGIN이 필요합니다.');
    if (values.some(value => value === '$user' || (!systemSchemas.has(value) && value !== 'public' &&
        value !== defaultNamespace && !declared.has(value) && !model.schemas.has(value)))) throw new Error(settingsError);
    path = values;
    if (!local) persistent = values;
  }

  for (const entry of entries) {
    const node = entry.body;
    entry.path = path;
    entry.creation = path.find(name => !systemSchemas.has(name)) ?? '';
    if (entry.result) continue;
    try {
      switch (entry.kind) {
        case 'TransactionStmt':
          if (node.kind === 'TRANS_STMT_BEGIN' && !transaction && !node.options) transaction = true;
          else if (node.kind === 'TRANS_STMT_COMMIT' && transaction && !node.chain) { transaction = false; path = persistent; }
          else throw new Error('BEGIN과 COMMIT으로 둘러싼 생성 DDL을 사용하세요.');
          record(entry, 'ignored-nonstructural', '명시적 트랜잭션 경계를 기록했습니다.');
          break;
        case 'VariableSetStmt': {
          const name = text(node.name);
          const args = nodes(node.args);
          if (name === 'search_path') {
            const values = args.map(scalar);
            if (node.kind !== 'VAR_SET_VALUE' || values.some(value => typeof value !== 'string')) throw new Error(settingsError);
            assignPath(values.map(value => String(value)), Boolean(node.is_local));
          } else if (!dumpSettings.has(name)) {
            const value = scalar(args[0] ?? {});
            const accepted = (name === 'standard_conforming_strings' && typeof value === 'string' && ['on', 'true'].includes(value.toLowerCase())) ||
              (name === 'client_encoding' && typeof value === 'string' && value.toUpperCase() === 'UTF8') ||
              (name === 'default_tablespace' && value === '') ||
              (name === 'default_table_access_method' && value === 'heap');
            if (node.kind !== 'VAR_SET_VALUE' || !accepted) throw new Error('지원하는 고정 덤프 세션 설정만 사용할 수 있습니다 (' + name + ').');
          }
          record(entry, 'ignored-nonstructural', name === 'search_path' ? '이후 문장의 이름 해석에 사용합니다.' : '덤프 세션 설정을 기록했습니다.');
          break;
        }
        case 'SelectStmt': {
          const targets = nodes(node.targetList);
          const target = ast(targets[0]?.ResTarget);
          const call = ast(ast(target.val).FuncCall);
          const args = nodes(call.args);
          const value = scalar(args[1] ?? {});
          const local = ast(args[2]?.A_Const).boolval;
          if (targets.length !== 1 || !only(node, 'targetList limitOption op') || node.op !== 'SETOP_NONE' ||
              !only(target, 'val location') || !only(call, 'funcname args funcformat location') ||
              names(call.funcname).join('.') !== 'pg_catalog.set_config' || args.length !== 3 ||
              scalar(args[0]) !== 'search_path' || typeof value !== 'string' || !local) {
            throw new Error('DDL 이외의 실행 문장은 분석에 사용할 수 없습니다.');
          }
          assignPath(settingPath(value), Boolean(ast(local).boolval));
          record(entry, 'ignored-nonstructural', 'pg_dump가 지정한 search_path를 이름 해석에 사용합니다.');
          break;
        }
        case 'AlterOwnerStmt':
          record(entry, 'ignored-nonstructural', '소유자 설정은 ERD 구조에 영향을 주지 않습니다.');
          break;
        default:
          if (executable.has(entry.kind)) throw new Error('DDL 이외의 실행 문장은 분석에 사용할 수 없습니다.');
      }
    } catch (error) { reject(entry, error); }
  }
  if (transaction && entries.length) {
    reject(entries.at(-1)!, new Error('BEGIN의 COMMIT 짝을 찾을 수 없습니다.'));
  }
  for (const entry of entries) {
    if (!entry.result) {
      try { model.captureOmittedDefinition(entry); } catch (error) { reject(entry, error); }
    }
  }
  const phases: Record<string, (entry: Entry) => Conversion> = {
    CreateEnumStmt: entry => model.createEnum(entry),
    CreateSeqStmt: entry => model.createSequence(entry),
    CreateStmt: entry => model.createTable(entry),
    IndexStmt: entry => model.defineIndex(entry),
    AlterTableStmt: entry => model.alterTable(entry),
    AlterSeqStmt: entry => model.alterSequence(entry),
  };
  for (const [kind, convert] of Object.entries(phases)) {
    for (const entry of entries) if (entry.kind === kind && !entry.result) run(entry, () => convert(entry));
  }
  const omittedKeys: OmittedForeignKey[] = [];
  for (const foreign of [false, true]) {
    for (const key of model.keys) {
      if ((key.ast.contype === 'CONSTR_FOREIGN') !== foreign || key.entry.result?.status !== 'converted') continue;
      try {
        const omitted = model.key(key);
        if (omitted) omittedKeys.push(omitted);
      } catch (error) { reject(key.entry, error); }
    }
  }
  if (omittedKeys.length) {
    const offset = textOffsets(prepared.sql);
    omittedKeys.sort((a, b) => (a.byteOffset ?? Infinity) - (b.byteOffset ?? Infinity));
    for (const { byteOffset, fallback, message } of omittedKeys) losses.push({
      code: 'missing-foreign-key-table', severity: 'warning', feature: 'foreign-key', message,
      location: byteOffset === undefined ? fallback : locate(offset(byteOffset)),
    });
  }
  for (const owner of model.owners) {
    try { model.setOwner(owner); } catch (error) { reject(owner.entry, error); }
  }
  for (const item of model.defaults.values()) {
    try { item.column.default = model.compile(item.value, 'default', item.table, item.entry); }
    catch (error) { reject(item.entry, error); }
  }
  for (const item of model.checks.values()) {
    try { item.constraint.expression = model.compile(item.value, 'check', item.table, item.entry); }
    catch (error) { reject(item.entry, error); }
  }
  for (const entry of entries) {
    if (entry.result) continue;
    if (entry.kind === 'CommentStmt') run(entry, () => model.comment(entry));
    else record(entry, 'unsupported', ['GrantStmt', 'GrantRoleStmt'].includes(entry.kind)
      ? '권한 문은 ERD에 적용되지 않습니다.' : '지원하는 테이블 중심 DDL 범위 밖의 객체 또는 변경입니다 (' + entry.kind + ').');
  }
  const catalog = model.catalog;
  const output = baseCatalog ? model.additions() : catalog;
  if (baseCatalog && !output.tables.length && !diagnostics.some(item => item.severity === 'error')) {
    diagnostics.push(issue('no-new-tables', diagnostics.some(item => item.code === 'existing-table-skipped')
      ? '현재 다이어그램에 추가할 새 테이블이 없습니다.' : '현재 다이어그램에 추가할 CREATE TABLE 정의가 필요합니다.'));
  } else if (!baseCatalog && !catalog.tables.length && !catalog.sequences.length && !catalog.enums.length && !catalog.namespaces.length) {
    diagnostics.push(issue('no-importable-objects', '변환할 스키마 또는 테이블 관련 객체가 없습니다.'));
  }
  if (!diagnostics.some(item => item.severity === 'error')) {
    const validation = erdDocumentSchema.safeParse({ id: 'analysis', name: 'DDL', formatVersion: 1,
      target, catalog, relationships: [], views: [], extensions: [] });
    if (!validation.success) diagnostics.push(issue('invalid-import-model', '변환한 구조가 ERD 모델 형식에 맞지 않습니다.'));
    else {
      const structure = validateDocumentStructure(validation.data);
      const issues: Diagnostic[] = structure.length ? structure : [
        ...postgresqlEditor.validate(validation.data, { target }),
        ...(await preparePostgresqlExport({ document: validation.data, target,
          tableIds: baseCatalog ? output.tables.map(table => table.id) : undefined })).diagnostics,
      ];
      for (const problem of issues) {
        if (baseCatalog && !structure.length && problem.objectId && !model.isNew(problem.objectId)) continue;
        const entry = problem.objectId && model.entries.get(problem.objectId);
        if (entry && problem.severity === 'error') record(entry, 'error', problem.message, problem.objectId);
        diagnostics.push({ ...problem, location: entry ? entry.location : undefined });
      }
    }
  }
  const statements = withOrdinals([...controls, ...entries.flatMap(entry => entry.result ? [entry.result] : [])]);
  losses.sort((a, b) => (a.location?.offset ?? 0) - (b.location?.offset ?? 0));
  if (diagnostics.some(item => item.severity === 'error')) return { status: 'blocked', profile, statements, diagnostics, losses };
  return { status: 'parsed', profile, catalog: output, statements, diagnostics, losses };
}
