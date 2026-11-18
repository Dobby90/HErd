import type { Catalog } from '@erd/model';
import { builtinType } from './render-sql.js';
import { canonicalType, postgresqlEditor } from './ui.js';

export type Ast = Record<string, unknown>;
export const ast = (input: unknown): Ast => input && typeof input === 'object' && !Array.isArray(input) ? input as Ast : {};
export const nodes = (input: unknown): Ast[] => Array.isArray(input) ? input.map(ast) : [];
export const text = (value: unknown) => typeof value === 'string' ? value : '';
export const names = (input: unknown) => nodes(input).map(part => text(ast(part.String).sval));
export const only = (object: Ast, keys: string) => Object.keys(object).every(key => keys.split(' ').includes(key));

export class UnsupportedDdl extends Error {}
export function requireOption(condition: unknown, message: string): asserts condition {
  if (!condition) throw new UnsupportedDdl(message);
}
export function need<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

export function rangeName(value: unknown) {
  const item = ast(value);
  if (item.catalogname) throw new Error('다른 데이터베이스의 객체는 참조할 수 없습니다.');
  const name = text(item.relname);
  if (!name) throw new Error('객체 이름을 확인하세요.');
  const schema = text(item.schemaname);
  return schema ? [schema, name] : [name];
}

export function optionList(input: unknown) {
  const result = new Map<string, Ast>();
  for (const element of nodes(input)) {
    const option = ast(element.DefElem);
    const name = text(option.defname);
    if (result.has(name)) throw new Error('중복된 옵션입니다 (' + name + ').');
    result.set(name, ast(option.arg));
  }
  return result;
}

type Sequence = Catalog['sequences'][number];
export type SequenceSettings = Pick<Sequence, 'start' | 'increment' | 'min' | 'max' | 'cache' | 'cycle'>;
export function sequenceSettings(options: ReadonlyMap<string, Ast>): SequenceSettings {
  const result: SequenceSettings = {};
  const fields = { start: 'start', increment: 'increment', minvalue: 'min', maxvalue: 'max', cache: 'cache' } as const;
  for (const [option, field] of Object.entries(fields)) {
    const value = options.get(option);
    if (!value || !Object.keys(value).length) continue; // NO MINVALUE / NO MAXVALUE
    const integer = value.Integer ? String(ast(value.Integer).ival ?? 0) : text(ast(value.Float).fval);
    if (!/^[+-]?\d{1,19}$/.test(integer)) throw new Error('시퀀스 옵션의 정수 값을 확인하세요 (' + option + ').');
    result[field] = BigInt(integer).toString();
  }
  const cycle = options.get('cycle');
  if (cycle) result.cycle = Boolean(ast(cycle.Boolean).boolval);
  return result;
}

const serial = new Map([
  ['serial', 'integer'], ['serial4', 'integer'], ['smallserial', 'smallint'], ['serial2', 'smallint'],
  ['bigserial', 'bigint'], ['serial8', 'bigint'],
]);

export function columnType(input: unknown, enumFor: (path: string[]) => string | undefined) {
  const type = ast(input);
  const path = names(type.names);
  const name = path.at(-1) ?? '';
  if (!name || path.length > 2 || type.pct_type || type.setof) throw new Error('지원하는 PostgreSQL 타입을 지정하세요.');
  const namespace = path.length === 2 ? path[0] : undefined;
  const serialType = !namespace ? serial.get(name) : undefined;
  const dimensions = nodes(type.arrayBounds).length;
  const args = nodes(type.typmods).map(item => {
    const value = ast(item.A_Const).ival;
    if (!value) throw new Error('타입 인수는 정수여야 합니다.');
    return Number(ast(value).ival ?? 0);
  });
  if (serialType && (args.length || dimensions)) throw new Error('SERIAL 타입의 배열 또는 인수는 지원하지 않습니다.');
  if (!serialType && !namespace) {
    const enumId = enumFor(path);
    if (enumId && !args.length && dimensions <= 6) {
      return { descriptor: { reference: { kind: 'enum', enumId }, arguments: args, arrayDimensions: dimensions } satisfies Catalog['columns'][number]['type'] };
    }
  }
  const canonical = serialType ?? canonicalType(name);
  if (!namespace || namespace === 'pg_catalog') {
    try {
      builtinType(canonical, args, dimensions, namespace);
      const descriptor = { reference: { kind: 'native', name: canonical }, arguments: args, arrayDimensions: dimensions } as const;
      return { descriptor: { ...descriptor }, serialType };
    } catch (error) {
      const problem = postgresqlEditor.typeProblem({ reference: { kind: 'native', name: canonical }, arguments: args, arrayDimensions: dimensions });
      if (problem) throw error;
    }
  }
  const enumId = enumFor(path);
  if (enumId && !args.length && dimensions <= 6) {
    return { descriptor: { reference: { kind: 'enum', enumId }, arguments: args, arrayDimensions: dimensions } satisfies Catalog['columns'][number]['type'] };
  }
  throw new Error('지원하거나 문서에 정의된 타입을 찾을 수 없습니다 (' + path.join('.') + ').');
}
