import type { Catalog } from '@erd/model';
import { builtinType, identifier, literal, qualified, validText } from './render-sql.js';
import { canonicalType, postgresqlTypes } from './ui.js';

type Node = Record<string, unknown>;
type Item = Catalog['enums'][number] | Catalog['sequences'][number];
type Value = { sql: string; truth: boolean | 'unknown' };
type Context = { mode: 'default' | 'check'; table: Catalog['tables'][number]; catalog: Catalog; schema: Map<string, string>; searchPath?: readonly string[];
  checkReference?(kind: 'type' | 'function' | 'operator', path: string[]): void;
};

const node = (value: unknown): Node => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PostgreSQL 식의 구조를 해석하지 못했습니다.');
  return value as Node;
};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const names = (value: unknown): string[] => list(value).map(part => {
  const name = node(node(part).String).sval;
  if (typeof name !== 'string') throw new Error('식별자가 필요한 SQL 식입니다.');
  return name;
});
const hasOnly = (value: Node, fields: string[]) => Object.keys(value).every(key => fields.includes(key));
const value = (sql: string, truth: Value['truth'] = 'unknown'): Value => ({ sql, truth });
const allowedOps = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '^', '||', '->', '->>', '#>', '#>>', '@>', '<@', '?', '?|', '?&', '~~', '!~~', '~~*', '!~~*']);
const comparisons = new Set(['=', '<>', '!=', '<', '>', '<=', '>=', '@>', '<@', '?', '?|', '?&', '~~', '!~~', '~~*', '!~~*']);
const keywordOps = new Map([['~~', 'LIKE'], ['!~~', 'NOT LIKE'], ['~~*', 'ILIKE'], ['!~~*', 'NOT ILIKE']]);
const functions = new Map([
  ['gen_random_uuid', [0]], ['now', [0]], ['transaction_timestamp', [0]], ['statement_timestamp', [0]],
  ['clock_timestamp', [0]], ['lower', [1]], ['upper', [1]], ['length', [1]], ['abs', [1]], ['round', [1, 2]],
  ['btrim', [1, 2]], ['jsonb_build_object', null], ['jsonb_build_array', null],
] as const);
const clock = new Map([
  ['SVFOP_CURRENT_DATE', 'CURRENT_DATE'], ['SVFOP_CURRENT_TIME', 'CURRENT_TIME'], ['SVFOP_CURRENT_TIME_N', 'CURRENT_TIME'],
  ['SVFOP_CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP'], ['SVFOP_CURRENT_TIMESTAMP_N', 'CURRENT_TIMESTAMP'],
  ['SVFOP_LOCALTIME', 'LOCALTIME'], ['SVFOP_LOCALTIME_N', 'LOCALTIME'],
  ['SVFOP_LOCALTIMESTAMP', 'LOCALTIMESTAMP'], ['SVFOP_LOCALTIMESTAMP_N', 'LOCALTIMESTAMP'],
]);
const unsupported = () => new Error('지원하는 DEFAULT·CHECK 식 문법을 사용하세요.');
const requireTruth = (item: Value) => {
  if (item.truth === false) throw new Error('CHECK 조건에는 불리언 식이 필요합니다.');
  return item.sql;
};

function regclassNames(text: string) {
  const part = '("(?:""|[^"])*"|[a-zA-Z_\\u0080-\\u{10ffff}][a-zA-Z_0-9$\\u0080-\\u{10ffff}]*)';
  const match = new RegExp('^\\s*' + part + '(?:\\s*\\.\\s*' + part + ')?\\s*$', 'u').exec(text);
  if (!match) throw new Error('nextval에 문서 내 시퀀스 이름을 문자열로 지정하세요.');
  return match.slice(1).filter(Boolean).map(name => name.startsWith('"')
    ? name.slice(1, -1).replaceAll('""', '"') : name.replace(/[A-Z]/g, letter => letter.toLowerCase()));
}

export async function compileExpression(sql: string, context: Context) {
  if (!validText(sql)) throw new Error('유효한 UTF-8 SQL 식을 입력하세요.');
  const { parse } = await import('pgsql-parser');
  const parsed = await parse('SELECT (\n' + sql + '\n);').catch(() => {
    throw new Error('한 개의 올바른 PostgreSQL SQL 식을 입력하세요.');
  });
  const select = node(node(parsed.stmts[0]?.stmt).SelectStmt);
  const targets = list(select.targetList);
  if (parsed.stmts.length !== 1 || targets.length !== 1 || select.op !== 'SETOP_NONE' ||
      select.limitOption !== 'LIMIT_OPTION_DEFAULT' || !hasOnly(select, ['targetList', 'limitOption', 'op'])) throw unsupported();
  const target = node(node(targets[0]).ResTarget);
  if (!hasOnly(target, ['val', 'location'])) throw unsupported();

  return compileAstExpression(target.val, context);
}

export function compileAstExpression(input: unknown, context: Context) {
  const references = new Set<string>();
  const { catalog, table, schema, mode, searchPath } = context;
  const lookup = (items: Item[], path: string[]) => {
    const scopes = path.length === 1 ? (searchPath ?? [schema.get(table.namespaceId)!]) : path.slice(0, -1);
    for (const scope of scopes) {
      const found = path.length <= 2 && items.find(item => schema.get(item.namespaceId) === scope && item.physicalName === path.at(-1));
      if (found) return found;
    }
  };
  const findNamed = (items: Item[], path: string[], feature: string) => {
    const item = lookup(items, path);
    if (!item) throw new Error('문서에서 ' + feature + ' 참조를 해결할 수 없습니다.');
    references.add(item.id);
    return qualified(schema.get(item.namespaceId)!, item.physicalName);
  };

  function render(input: unknown, depth: number): Value {
    if (depth > 128) throw new Error('SQL 식의 중첩 깊이가 너무 큽니다.');
    const expression = node(input);
    const child = (input: unknown) => render(input, depth + 1);
    const children = (input: unknown) => list(input).map(child);
    const kinds = Object.keys(expression);
    if (kinds.length !== 1) throw unsupported();
    const kind = kinds[0];
    const part = node(expression[kind]);
    switch (kind) {
      case 'A_Const': {
        if (part.isnull) return value('NULL');
        if (part.sval) return value(literal(String(node(part.sval).sval ?? '')));
        if (part.boolval) return value(node(part.boolval).boolval ? 'TRUE' : 'FALSE', true);
        if (part.ival) return value(String(node(part.ival).ival ?? 0), false);
        if (part.fval) {
          const decimal = String(node(part.fval).fval);
          if (!/^[+-]?(?:(?:[0-9]+(?:\.[0-9]*)?)|(?:\.[0-9]+))(?:[eE][+-]?[0-9]+)?$/.test(decimal)) throw unsupported();
          return value(decimal, false);
        }
        throw unsupported();
      }
      case 'ColumnRef': {
        const fields = names(part.fields);
        const prefix = fields.slice(0, -1);
        const column = catalog.columns.find(column => column.tableId === table.id && column.physicalName === fields.at(-1));
        if (mode !== 'check' || !column || (prefix.length && prefix.at(-1) !== table.physicalName) ||
            prefix.length > 2 || (prefix.length === 2 && prefix[0] !== schema.get(table.namespaceId))) {
          throw new Error('CHECK에서는 같은 테이블의 컬럼을 참조하세요. DEFAULT에는 컬럼 참조를 사용할 수 없습니다.');
        }
        references.add(column.id);
        const type = column.type.reference;
        return value(identifier(column.physicalName), type.kind === 'native' && ['bool', 'boolean'].includes(type.name) && !column.type.arrayDimensions);
      }
      case 'A_ArrayExpr':
        return value('ARRAY[' + children(part.elements).map(item => item.sql).join(', ') + ']', false);
      case 'TypeCast': {
        const type = node(part.typeName);
        const path = names(type.names);
        context.checkReference?.('type', path);
        const args = list(type.typmods).map(item => {
          const term = node(node(node(item).A_Const).ival);
          return Number(term.ival ?? 0);
        });
        const dimensions = list(type.arrayBounds).length;
        if (type.setof || type.pct_type || dimensions > 6 || path.length < 1 || path.length > 2) throw unsupported();
        const schemaName = path.length === 2 ? path[0] : undefined;
        const name = path.at(-1)!;
        const modeled = lookup(catalog.enums, path);
        const native = (!schemaName || schemaName === 'pg_catalog') && (postgresqlTypes as readonly string[]).includes(canonicalType(name));
        const builtinPosition = searchPath?.indexOf('pg_catalog') ?? -1;
        const enumPrecedesBuiltin = modeled && !schemaName && builtinPosition >= 0 &&
          searchPath!.slice(0, builtinPosition).includes(schema.get(modeled.namespaceId)!);
        if (modeled && (!native || enumPrecedesBuiltin) && !args.length) return value('CAST(' + child(part.arg).sql + ' AS ' + findNamed(catalog.enums, path, 'ENUM') + '[]'.repeat(dimensions) + ')', false);
        return value('CAST(' + child(part.arg).sql + ' AS ' + builtinType(name, args, dimensions, schemaName) + ')',
          ['bool', 'boolean'].includes(name) && !dimensions);
      }
      case 'FuncCall': {
        if (!hasOnly(part, ['funcname', 'args', 'funcformat', 'location']) || part.funcformat !== 'COERCE_EXPLICIT_CALL') throw unsupported();
        const path = names(part.funcname);
        context.checkReference?.('function', path);
        const name = path.at(-1)!;
        if (!(path.length === 1 || (path.length === 2 && path[0] === 'pg_catalog'))) throw unsupported();
        const args = list(part.args);
        if (mode === 'default' && name === 'nextval' && args.length === 1) {
          let arg = node(args[0]);
          if (arg.TypeCast) {
            const cast = node(arg.TypeCast);
            const type = node(cast.typeName);
            const path = names(type.names).join('.');
            if (!['regclass', 'pg_catalog.regclass'].includes(path) || type.arrayBounds || type.typmods) throw unsupported();
            arg = node(cast.arg);
          }
          const text = node(node(node(arg.A_Const).sval)).sval;
          if (typeof text !== 'string') throw unsupported();
          const sequence = findNamed(catalog.sequences, regclassNames(text), '시퀀스');
          return value('pg_catalog.nextval(' + literal(sequence) + '::pg_catalog.regclass)', false);
        }
        const arity = functions.get(name as Parameters<typeof functions.get>[0]);
        if (arity === undefined || (arity && !(arity as readonly number[]).includes(args.length)) ||
            (name === 'jsonb_build_object' && args.length % 2 !== 0)) throw unsupported();
        return value(qualified('pg_catalog', name) + '(' + args.map(item => child(item).sql).join(', ') + ')', false);
      }
      case 'SQLValueFunction': {
        const keyword = clock.get(String(part.op));
        const precision = part.op && String(part.op).endsWith('_N') ? Number(part.typmod ?? 0) : -1;
        if (!keyword || precision > 6) throw unsupported();
        return value(keyword + (precision >= 0 ? '(' + precision + ')' : ''), false);
      }
      case 'BoolExpr': {
        const args = children(part.args).map(requireTruth);
        if (part.boolop === 'NOT_EXPR' && args.length === 1) return value('(NOT ' + args[0] + ')', true);
        if (!['AND_EXPR', 'OR_EXPR'].includes(String(part.boolop)) || args.length < 2) throw unsupported();
        return value('(' + args.join(part.boolop === 'AND_EXPR' ? ' AND ' : ' OR ') + ')', true);
      }
      case 'NullTest': {
        if (part.argisrow || !['IS_NULL', 'IS_NOT_NULL'].includes(String(part.nulltesttype))) throw unsupported();
        return value('(' + child(part.arg).sql + (part.nulltesttype === 'IS_NULL' ? ' IS NULL)' : ' IS NOT NULL)'), true);
      }
      case 'BooleanTest': {
        const tests = new Map([['IS_TRUE', 'TRUE'], ['IS_NOT_TRUE', 'NOT TRUE'], ['IS_FALSE', 'FALSE'], ['IS_NOT_FALSE', 'NOT FALSE'],
          ['IS_UNKNOWN', 'UNKNOWN'], ['IS_NOT_UNKNOWN', 'NOT UNKNOWN']]);
        const test = tests.get(String(part.booltesttype));
        if (!test) throw unsupported();
        return value('(' + requireTruth(child(part.arg)) + ' IS ' + test + ')', true);
      }
      case 'CoalesceExpr': {
        const args = children(part.args);
        return value('COALESCE(' + args.map(item => item.sql).join(', ') + ')', args.some(item => item.truth === false) ? false : 'unknown');
      }
      case 'A_Expr': {
        const [operator, extra] = names(part.name);
        if (extra) throw unsupported();
        if (allowedOps.has(operator)) context.checkReference?.('operator', [operator]);
        if (part.kind === 'AEXPR_OP' && allowedOps.has(operator)) {
          const right = child(part.rexpr).sql;
          if (!part.lexpr && ['+', '-'].includes(operator)) return value('(' + operator + ' ' + right + ')', false);
          return value('(' + child(part.lexpr).sql + ' ' + (keywordOps.get(operator) ?? operator) + ' ' + right + ')', comparisons.has(operator));
        }
        const left = child(part.lexpr).sql;
        if (part.kind === 'AEXPR_LIKE' || part.kind === 'AEXPR_ILIKE') {
          const keyword = keywordOps.get(operator);
          if (!keyword) throw unsupported();
          return value('(' + left + ' ' + keyword + ' ' + child(part.rexpr).sql + ')', true);
        }
        if ((part.kind === 'AEXPR_OP_ANY' || part.kind === 'AEXPR_OP_ALL') && comparisons.has(operator) && !keywordOps.has(operator)) {
          return value('(' + left + ' ' + operator + (part.kind === 'AEXPR_OP_ANY' ? ' ANY (' : ' ALL (') + child(part.rexpr).sql + '))', true);
        }
        if (part.kind === 'AEXPR_DISTINCT' || part.kind === 'AEXPR_NOT_DISTINCT') {
          return value('(' + left + (part.kind === 'AEXPR_DISTINCT' ? ' IS DISTINCT FROM ' : ' IS NOT DISTINCT FROM ') + child(part.rexpr).sql + ')', true);
        }
        if (part.kind === 'AEXPR_IN' && ['=', '<>'].includes(operator)) {
          const args = children(node(node(part.rexpr).List).items);
          return value('(' + left + (operator === '=' ? ' IN (' : ' NOT IN (') + args.map(item => item.sql).join(', ') + '))', true);
        }
        if (['AEXPR_BETWEEN', 'AEXPR_NOT_BETWEEN'].includes(String(part.kind))) {
          const args = children(node(node(part.rexpr).List).items);
          return value('(' + left + (part.kind === 'AEXPR_BETWEEN' ? ' BETWEEN ' : ' NOT BETWEEN ') + args.map(item => item.sql).join(' AND ') + ')', true);
        }
        throw unsupported();
      }
      default:
        throw unsupported();
    }
  }

  const rendered = render(input, 0);
  return { sql: mode === 'check' ? requireTruth(rendered) : rendered.sql, references: [...references] };
}
