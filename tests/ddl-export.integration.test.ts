import { expect, it } from 'vitest';
import { SqlService } from '@erd/sql-service';
import { createSqlRegistry } from '../apps/api/src/sql-registry.js';
import { exportDefault, exportDescription, exportDocument, exportTarget } from '../packages/test-fixtures/src/ddl-export.js';
import { withPostgres } from './support/postgres.js';

const table = '"업무""영역"."select"';
const peer = '"세일즈"."select"';
const counter = '"업무""영역"."발번""순서"';
const global = '"타입"."global_id"';

it('executes complete and dependency-selected DDL on PostgreSQL 17 and verifies catalog and insert semantics', async () => {
  const document = exportDocument();
  const service = new SqlService(createSqlRegistry());
  const request = { document, target: exportTarget };
  const full = await service.generate(request);
  expect(full.status, JSON.stringify(full.diagnostics)).toBe('generated');
  if (full.status !== 'generated') return;
  expect(await service.generate(request)).toEqual(full);
  expect(full.dependencies).toEqual([]);
  expect(full.sql).not.toMatch(/\b(?:DROP|IF NOT EXISTS)\b/i);
  expect(full.sql).not.toContain('출고');
  expect(full.sql).not.toContain('CREATE UNIQUE INDEX "토큰 uniqueness"');
  const partial = await service.generate({ ...request, tableIds: ['a'], options: { includeComments: false } });
  expect(partial.status, JSON.stringify(partial.diagnostics)).toBe('generated');
  if (partial.status !== 'generated') return;
  expect(partial.dependencies).toEqual([
    { kind: 'namespaces', objectId: 'sales' }, { kind: 'namespaces', objectId: 'reports' },
    { kind: 'namespaces', objectId: 'types' }, { kind: 'tables', objectId: 'b' }, { kind: 'enums', objectId: 'state' },
    { kind: 'sequences', objectId: 'counter' }, { kind: 'sequences', objectId: 'global' },
  ]);
  expect(partial.sql).not.toContain('COMMENT ON');

  await withPostgres(async cluster => {
    expect(cluster.query('SHOW server_version_num')).toMatch(/^17\d{4}$/);
    cluster.query('CREATE DATABASE selected');
    cluster.query(full.sql);
    cluster.query(partial.sql, 'selected');
    const selection = `SELECT n.nspname, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'S') AND n.nspname IN ('업무"영역', '세일즈', '타입', 'public') ORDER BY n.nspname, c.relname`;
    const actual = cluster.query(selection, 'selected').split('\n');
    expect(actual).toHaveLength(6);
    expect(actual).toEqual(expect.arrayContaining(['업무"영역|select', '세일즈|select', '업무"영역|발번"순서', '타입|global_id']));
    expect(actual.join('\n')).not.toContain('unused');
    expect(cluster.query(selection).split('\n')).toEqual(expect.arrayContaining([...actual, 'public|unused', 'public|unused_seq']));
    const relation = `'${table}'::regclass`;
    const attributes = JSON.parse(cluster.query(`SELECT json_agg(json_build_array(attname, format_type(atttypid, atttypmod), attndims, attnotnull, attidentity)
      ORDER BY attnum) FROM pg_attribute WHERE attrelid = ${relation} AND attnum > 0`));
    expect(attributes.map((attribute: string[]) => attribute[0])).toEqual(document.catalog.tables[0].columnIds
      .map(id => document.catalog.columns.find(column => column.id === id)!.physicalName));
    expect(attributes).toEqual(expect.arrayContaining([
      ['Region', 'smallint', 0, true, ''], ['id', 'integer', 0, true, 'a'], ['peer', 'integer', 0, false, ''],
      ['rate', 'numeric(8,2)', 0, true, ''], ['메"모', 'character varying(80)', 0, true, ''], ['token', 'uuid', 0, true, ''],
      ['payload', 'jsonb', 0, true, ''], ['태그', 'text[]', 1, true, ''], ['state', '"타입"."상태"', 0, true, ''],
    ]));
    expect(cluster.query(`SELECT pg_get_expr(d.adbin, d.adrelid) FROM pg_attrdef d JOIN pg_attribute a
      ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = ${relation} AND a.attname = 'created_time'`))
      .toContain('CURRENT_TIMESTAMP(0)');
    expect(cluster.query(`SELECT attidentity FROM pg_attribute WHERE attrelid = '${peer}'::regclass AND attname = 'ticket'`)).toBe('d');
    const constraints = JSON.parse(cluster.query(`SELECT json_object_agg(conname, json_build_array(contype, conkey, confkey, confdeltype, confupdtype))
      FROM pg_constraint WHERE conrelid IN (${relation}, '${peer}'::regclass)`));
    expect(constraints).toMatchObject({
      '선택 PK': ['p', [1, 2], null, ' ', ' '],
      '토큰 uniqueness': ['u', [8], null, ' ', ' '],
      '양수 확인': ['c', [6, 1], null, ' ', ' '],
      'self fk': ['f', [4, 5], [1, 2], 'c', 'r'],
      'a to b': ['f', [3], [1], 'c', 'r'],
      'b to a': ['f', [3, 4], [2, 1], 'c', 'r'],
    });
    const indexes = cluster.query(`SELECT c.relname, i.indisunique, am.amname, i.indkey FROM pg_index i
      JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am am ON am.oid = c.relam
      WHERE i.indrelid IN (${relation}, '${peer}'::regclass)`).split('\n');
    expect(indexes.sort()).toEqual(['선택 PK|t|btree|1 2', '토큰 uniqueness|t|btree|8', 'select_id_seq|f|btree|1 6', '참조 키|t|btree|1'].sort());
    expect(JSON.parse(cluster.query(`SELECT json_build_array(obj_description(${relation}, 'pg_class'), col_description(${relation}, 7))`)))
      .toEqual([exportDescription, exportDescription]);
    expect(cluster.query(`SELECT obj_description(${relation}, 'pg_class') IS NULL`, 'selected')).toBe('t');
    expect(JSON.parse(cluster.query(`SELECT json_agg(enumlabel ORDER BY enumsortorder) FROM pg_enum WHERE enumtypid = '"타입"."상태"'::regtype`)))
      .toEqual(['대기', "O'Brien", '닫힘']);
    expect(cluster.query(`SELECT seqtypid::regtype, seqstart, seqincrement, seqmin, seqmax, seqcache, seqcycle
      FROM pg_sequence WHERE seqrelid = '${counter}'::regclass`)).toBe('bigint|9007199254740993|3|1|9007199254741999|5|f');
    expect(cluster.query(`SELECT seqtypid::regtype, seqstart, seqincrement, seqmin, seqmax, seqcache, seqcycle
      FROM pg_sequence WHERE seqrelid = '${global}'::regclass`)).toBe('integer|-10|-2|-100|-1|2|t');
    expect(cluster.query(`SELECT string_agg(d.deptype::text || ':' || a.attname, ',' ORDER BY a.attname)
      FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
      WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass AND d.refobjid = ${relation}`)).toBe('a:counter,i:id');
    expect(cluster.query(`SELECT pg_get_serial_sequence('${table}', 'counter')::regclass = '${counter}'::regclass,
      pg_get_serial_sequence('${table}', 'id')::regclass <> '"업무""영역"."select_id_seq"'::regclass`)).toBe('t|t');
    const inserted = JSON.parse(cluster.query(`INSERT INTO ${table} ("Region") VALUES (1)
      RETURNING json_build_object('id', id, 'note', "메""모", 'uuid', token IS NOT NULL, 'payload', payload, 'tags', "태그",
        'state', state, 'counter', counter::text, 'global', global, 'date', created = current_date)`, 'selected').split('\n')[0]);
    expect(inserted).toEqual({ id: 1, note: exportDefault, uuid: true, payload: {}, tags: ['A', '한글'],
      state: '대기', counter: '9007199254740993', global: -10, date: true });
    expect(cluster.query(`INSERT INTO ${peer} (key, parent_id, parent_region) VALUES (100, 1, 1) RETURNING ticket`, 'selected').split('\n')[0]).toBe('1');
    expect(() => cluster.query(`INSERT INTO ${table} ("Region") VALUES (0)`, 'selected')).toThrow(/23514/);
    cluster.query(`UPDATE ${table} SET peer = 100 WHERE id = 1; DELETE FROM ${peer} WHERE key = 100;`, 'selected');
    expect(cluster.query(`SELECT count(*) FROM ${table}`, 'selected')).toBe('0');
  });
}, 90_000);
