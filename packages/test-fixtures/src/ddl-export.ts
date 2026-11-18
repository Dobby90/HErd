import type { Catalog, ErdDocument, ForeignKey } from '@erd/model';

export const exportTarget = { dialectId: 'postgresql', engineVersion: '17' };
const column = (id: string, tableId: string, physicalName: string, type: string,
  settings: Partial<Catalog['columns'][number]> = {}): Catalog['columns'][number] => ({
  id, tableId, physicalName, nullable: false,
  type: { reference: { kind: 'native', name: type }, arguments: [], arrayDimensions: 0 },
  ...settings,
});
const expression = (sql: string) => ({ ...exportTarget, sql });
const pair = (sourceColumnId: string, targetColumnId: string) => ({ sourceColumnId, targetColumnId });
const fk = (id: string, physicalName: string, tableId: string, targetTableId: string,
  targetKey: ForeignKey['targetKey'], pairs: ForeignKey['pairs']): ForeignKey => (
  { id, physicalName, tableId, targetTableId, targetKey, pairs, kind: 'fk', onDelete: 'cascade', onUpdate: 'restrict' }
);
const indexColumn = (columnId: string) => ({ kind: 'column' as const, columnId });

export const exportDescription = "배송 담당 O'Brien\n다음 줄 \\ 보존";
export const exportDefault = "Dianne's 물품\n다음 줄 \\ 보존";

export function exportDocument(id = 'ddl-fixture'): ErdDocument {
  return {
    id, name: 'DDL 검증', formatVersion: 1, target: exportTarget, extensions: [], relationships: [],
    catalog: {
      namespaces: [
        { id: 'sales', physicalName: '업무"영역' }, { id: 'reports', physicalName: '세일즈' },
        { id: 'types', physicalName: '타입' }, { id: 'public', physicalName: 'public' },
      ],
      tables: [
        { id: 'a', namespaceId: 'sales', physicalName: 'select', logicalName: '출고', description: exportDescription,
          columnIds: ['a-region', 'a-id', 'a-peer', 'a-self-region', 'a-self-id', 'a-tax', 'a-note', 'a-uuid', 'a-json', 'a-array',
            'a-state', 'a-counter', 'a-global', 'a-date', 'a-time'] },
        { id: 'b', namespaceId: 'reports', physicalName: 'select',
          columnIds: ['b-key', 'b-identity', 'b-parent-id', 'b-parent-region'] },
        { id: 'unused', namespaceId: 'public', physicalName: 'unused', columnIds: [] },
      ],
      columns: [
        column('a-region', 'a', 'Region', 'smallint'),
        column('a-id', 'a', 'id', 'integer', { identity: 'always' }),
        column('a-peer', 'a', 'peer', 'integer', { nullable: true }),
        column('a-self-region', 'a', '부모 지역', 'smallint', { nullable: true }),
        column('a-self-id', 'a', 'parent_id', 'integer', { nullable: true }),
        column('a-tax', 'a', 'rate', 'numeric', {
          type: { reference: { kind: 'native', name: 'numeric', namespace: 'pg_catalog' }, arguments: [8, 2], arrayDimensions: 0 },
          default: expression('0.00'),
        }),
        column('a-note', 'a', '메"모', 'varchar', { description: exportDescription,
          type: { reference: { kind: 'native', name: 'varchar' }, arguments: [80], arrayDimensions: 0 },
          default: expression('$note$' + exportDefault + '$note$'),
        }),
        column('a-uuid', 'a', 'token', 'uuid', { default: expression('gen_random_uuid()') }),
        column('a-json', 'a', 'payload', 'jsonb', { default: expression("'{}'::jsonb") }),
        column('a-array', 'a', '태그', 'text', {
          type: { reference: { kind: 'native', name: 'text' }, arguments: [], arrayDimensions: 1 },
          default: expression("ARRAY['A', '한글']::text[]"),
        }),
        column('a-state', 'a', 'state', 'text', {
          type: { reference: { kind: 'enum', enumId: 'state' }, arguments: [], arrayDimensions: 0 },
          default: expression("'대기'::\"타입\".\"상태\""),
        }),
        column('a-counter', 'a', 'counter', 'bigint', { default: expression(`nextval('"업무""영역"."발번""순서"'::regclass)`) }),
        column('a-global', 'a', 'global', 'integer', { default: expression(`nextval('"타입".global_id')`) }),
        column('a-date', 'a', 'created', 'date', { default: expression('CURRENT_DATE') }),
        column('a-time', 'a', 'created_time', 'timestamptz', { default: expression('CURRENT_TIMESTAMP(0)') }),
        column('b-key', 'b', 'key', 'integer'),
        column('b-identity', 'b', 'ticket', 'bigint', { identity: 'by-default' }),
        column('b-parent-id', 'b', 'parent_id', 'integer'),
        column('b-parent-region', 'b', 'parent_region', 'smallint'),
      ],
      constraints: [
        { id: 'a-pk', tableId: 'a', physicalName: '선택 PK', kind: 'pk', columnIds: ['a-region', 'a-id'] },
        { id: 'a-unique', tableId: 'a', physicalName: '토큰 uniqueness', kind: 'unique', columnIds: ['a-uuid'] },
        { id: 'a-check', tableId: 'a', physicalName: '양수 확인', kind: 'check',
          expression: expression('rate >= 0 AND ("Region" BETWEEN 1 AND 10)') },
        fk('a-self', 'self fk', 'a', 'a', { kind: 'constraint', id: 'a-pk' }, [pair('a-self-region', 'a-region'), pair('a-self-id', 'a-id')]),
        fk('a-b', 'a to b', 'a', 'b', { kind: 'index', id: 'b-key-index' }, [pair('a-peer', 'b-key')]),
        fk('b-a', 'b to a', 'b', 'a', { kind: 'constraint', id: 'a-pk' }, [pair('b-parent-id', 'a-id'), pair('b-parent-region', 'a-region')]),
      ],
      indexes: [
        { id: 'backing', physicalName: '토큰 uniqueness', tableId: 'a', unique: true, keys: [indexColumn('a-uuid')] },
        { id: 'ab-index', physicalName: 'select_id_seq', tableId: 'a', unique: false, keys: [indexColumn('a-region'), indexColumn('a-tax')] },
        { id: 'b-key-index', physicalName: '참조 키', tableId: 'b', unique: true, keys: [indexColumn('b-key')] },
      ],
      enums: [{ id: 'state', physicalName: '상태', namespaceId: 'types', values: ['대기', "O'Brien", '닫힘'] }],
      sequences: [
        { id: 'counter', physicalName: '발번"순서', namespaceId: 'sales', dataType: 'bigint', ownedByColumnId: 'a-counter',
          start: '9007199254740993', increment: '3', min: '1', max: '9007199254741999', cache: '5', cycle: false },
        { id: 'global', physicalName: 'global_id', namespaceId: 'types', dataType: 'integer', start: '-10',
          increment: '-2', min: '-100', max: '-1', cache: '2', cycle: true },
        { id: 'unused-seq', physicalName: 'unused_seq', namespaceId: 'public' },
      ],
    },
    views: [{ id: 'view', name: '출고만', groups: [], notes: [],
      instances: [{ id: 'a-placement', tableId: 'a', x: 0, y: 0, visibleColumnIds: ['a-region'] }] }],
  };
}
