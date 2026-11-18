import type { Catalog } from '@erd/model';
import { canonicalType, postgresqlEditor, postgresqlTypes } from './ui.js';

export const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';
export const qualified = (...names: string[]) => names.map(identifier).join('.');
export const validText = (value: string) => !value.includes('\0') && new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(value)) === value;

export function literal(value: string) {
  if (!validText(value)) throw new Error('문자열은 유효한 UTF-8이어야 하며 NUL을 포함할 수 없습니다.');
  return "E'" + value.replaceAll('\\', '\\\\').replaceAll("'", "''").replaceAll('\r', '\\r').replaceAll('\n', '\\n') + "'";
}

type Type = Catalog['columns'][number]['type'];
const systemNames = new Map([
  ['smallint', 'int2'], ['integer', 'int4'], ['bigint', 'int8'], ['boolean', 'bool'],
]);

export function builtinType(name: string, args: Type['arguments'], dimensions: number, namespace?: string) {
  const canonical = canonicalType(name);
  if ((namespace && namespace !== 'pg_catalog') || !(postgresqlTypes as readonly string[]).includes(canonical)) {
    throw new Error('지원하는 PostgreSQL 내장 타입이나 문서의 ENUM을 지정하세요.');
  }
  if (dimensions > 6) throw new Error('PostgreSQL 배열 차원은 최대 6입니다.');
  const invalid = postgresqlEditor.typeProblem({ reference: { kind: 'native', name: canonical }, arguments: args, arrayDimensions: dimensions });
  if (invalid) throw new Error(invalid);
  const size = args.length ? '(' + args.join(', ') + ')' : '';
  return qualified('pg_catalog', systemNames.get(canonical) ?? canonical) + size + '[]'.repeat(dimensions);
}
