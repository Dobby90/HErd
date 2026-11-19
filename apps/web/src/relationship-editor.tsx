import { useState } from 'react';
import type { DocumentCommand, ErdDocument, ForeignKey } from '@erd/model';
import type { EditorDialect, ReferenceKey } from '@erd/sql-contract';
import type { QuickRun } from './canvas-edit.js';
import { Icon } from './editor-controls.js';
import { columnsOf, field, Form, id, label, Modal, named, NameFields, placement, putView } from './editor-fields.js';
import type { Column, Table, View } from './editor-fields.js';
import { availableName, columnTypeLabel, schemaRelationNames, validPhysicalName } from './schema-edits.js';

export type RelationshipSize = '1:N' | '1:1' | 'N:N';
export type FkDialog = {
  tableId: string; targetTableId?: string; sourceColumnId?: string; targetColumnId?: string;
  existing?: ForeignKey; size?: RelationshipSize;
};
const sizes: RelationshipSize[] = ['1:N', '1:1', 'N:N'];

function eligibleKeys(document: ErdDocument, dialect: EditorDialect, tableId: string, columnId?: string) {
  const primary = document.catalog.constraints.find(key => key.tableId === tableId && key.kind === 'pk');
  const keys = dialect.referenceKeys(document, tableId).filter(key => !key.unavailable && (!columnId || key.columnIds.includes(columnId)));
  const index = keys.findIndex(key => key.key.kind === 'constraint' && key.key.id === primary?.id);
  if (index > 0) keys.unshift(keys.splice(index, 1)[0]);
  return keys;
}

function KeySelect({ label: caption, keys, columns, selected, select }: {
  label: string; keys: ReferenceKey[]; columns: ReadonlyMap<string, Column>; selected: string; select(value: string): void;
}) {
  if (keys.length <= 1) return null;
  return <label>{caption}<select value={selected} onChange={event => select(event.target.value)}>
    {keys.map(item => <option key={item.key.id} value={item.key.id}>{item.name || '(이름 없음)'} · {
      item.columnIds.map(id => columns.get(id)?.physicalName).join(', ')}</option>)}
  </select></label>;
}

function childColumnName(parent: Table, column: Column) {
  return column.physicalName.startsWith(parent.physicalName + '_') ? column.physicalName : parent.physicalName + '_' + column.physicalName;
}

export function RelationshipEditor({ document, view, dialect, seed, run, close }: {
  document: ErdDocument; view?: View; dialect: EditorDialect; seed: FkDialog; run: QuickRun; close(): void;
}) {
  const [direction, setDirection] = useState(seed);
  const [size, setSize] = useState<RelationshipSize>(seed.size ?? (
    seed.existing && dialect.cardinality(document, seed.existing)?.childMax === 1 ? '1:1' : '1:N'));
  const table = document.catalog.tables.find(item => item.id === direction.tableId);
  const parent = document.catalog.tables.find(item => item.id === direction.targetTableId);
  const namespaces = new Map(document.catalog.namespaces.map(item => [item.id, label(item)]));
  const names = document.catalog.tables.map(label);
  const tableLabel = (item: Table) => names.indexOf(label(item)) !== names.lastIndexOf(label(item))
    ? [namespaces.get(item.namespaceId), label(item)].filter(Boolean).join('.') : label(item);
  if (!table) return null;

  return <Modal title="관계 설정" close={close}>
    <section className="relationship-settings">
      <label>관계 유형<select value={size} onChange={event => setSize(event.target.value as RelationshipSize)}>
        {sizes.filter(item => !seed.existing || item !== 'N:N').map(item => <option key={item}>{item}</option>)}
      </select></label>
      <label>{size === 'N:N' ? '첫 번째 참조 테이블' : '참조 테이블'}<select value={parent?.id ?? ''}
        onChange={event => setDirection({ ...direction, targetTableId: event.target.value, targetColumnId: undefined, sourceColumnId: undefined })}>
        <option value="">테이블 선택</option>
        {document.catalog.tables.map(item => <option key={item.id} value={item.id}>{tableLabel(item)}</option>)}
      </select></label>
      <div className="fk-summary">
        <strong>{parent ? tableLabel(parent) : '참조 테이블'}</strong>
        <span>{size === 'N:N' ? 'N ↔ N' : size === '1:1' ? '1 → 1' : '1 → N'}</span>
        <strong>{tableLabel(table)}</strong>
        {parent && !seed.existing && size !== 'N:N' && <button type="button" className="quiet" onClick={() => setDirection({
          tableId: parent.id, targetTableId: table.id, sourceColumnId: direction.targetColumnId, targetColumnId: direction.sourceColumnId,
        })}>방향 바꾸기</button>}
      </div>
      {parent && (size === 'N:N' ? <JoinTableForm key={parent.id + ':' + table.id} document={document} view={view} dialect={dialect}
        left={parent} right={table} run={run} close={close} /> :
        <ForeignKeyFields key={JSON.stringify(direction)} document={document} dialect={dialect} seed={direction} table={table}
          parent={parent} size={size} run={run} close={close} />)}
    </section>
  </Modal>;
}

function ForeignKeyFields({ document, dialect, seed, table, parent, size, run, close }: {
  document: ErdDocument; dialect: EditorDialect; seed: FkDialog; table: Table; parent: Table;
  size: '1:1' | '1:N'; run: QuickRun; close(): void;
}) {
  const keys = eligibleKeys(document, dialect, parent.id, seed.targetColumnId);
  const [chosen, setChosen] = useState(seed.existing?.targetKey.id ?? keys[0]?.key.id ?? '');
  const [keyId] = useState(() => seed.existing?.id ?? id());
  const newColumnChoice = keyId + ':new';
  const [identify, setIdentify] = useState(false);
  const [error, setError] = useState('');
  const [pairs, setPairs] = useState<Record<string, string>>(() => Object.fromEntries(seed.existing?.pairs.map(pair =>
    [pair.targetColumnId, pair.sourceColumnId]) ?? (seed.targetColumnId && seed.sourceColumnId ? [[seed.targetColumnId, seed.sourceColumnId]] : [])));
  const parentColumns = new Map(columnsOf(document, parent.id).map(column => [column.id, column]));
  const childColumns = columnsOf(document, table.id);
  const candidate = keys.find(item => item.key.id === chosen);
  const order = seed.existing?.targetKey.id === candidate?.key.id
    ? seed.existing?.pairs.map(pair => pair.targetColumnId) : candidate?.columnIds;
  const usedNames = new Set(childColumns.map(column => column.physicalName));
  const selected = new Set(Object.values(pairs));
  const added: Column[] = [];
  const options = (order ?? []).flatMap(targetColumnId => {
    const column = parentColumns.get(targetColumnId);
    if (!column) return [];
    const baseName = childColumnName(parent, column);
    const name = availableName(baseName, usedNames);
    const matching = childColumns.filter(item => !selected.has(item.id) &&
      (item.physicalName === baseName || (column.physicalName !== 'id' && item.physicalName === column.physicalName)) &&
      dialect.compatibleForeignKeyTypes(item.type, column.type));
    const value = pairs[targetColumnId] ?? (matching.length === 1 ? matching[0].id : matching.length ? '' : newColumnChoice);
    selected.add(value);
    const sourceColumnId = value === newColumnChoice ? keyId + ':column:' + targetColumnId : value;
    if (value === newColumnChoice) added.push({ id: sourceColumnId, tableId: table.id, physicalName: name, type: column.type, nullable: false });
    return [{ column, name, value, mapping: { sourceColumnId, targetColumnId } }];
  });
  const mapping = options.map(option => option.mapping);
  const key: ForeignKey | undefined = candidate && mapping.length > 0 && mapping.length === order?.length &&
    mapping.every(pair => pair.sourceColumnId) ? {
      id: keyId, kind: 'fk', tableId: table.id, physicalName: '', targetTableId: parent.id, targetKey: candidate.key, pairs: mapping,
    } : undefined;
  const sourceIds = new Set(mapping.map(pair => pair.sourceColumnId));
  const unique = Boolean(key && eligibleKeys(document, dialect, table.id).some(item => item.columnIds.every(id => sourceIds.has(id))));
  const pk = document.catalog.constraints.find(item => item.kind === 'pk' && item.tableId === table.id);
  const pkColumns = pk?.kind === 'pk' ? pk.columnIds : [];
  const nextPk = [...new Set([...pkColumns, ...sourceIds])];
  const pkChanges = identify && nextPk.length !== pkColumns.length;
  const introducesUnique = pkChanges && nextPk.every(id => sourceIds.has(id));
  const needsUnique = Boolean(key && size === '1:1' && !unique && !introducesUnique);
  const duplicate = key && document.catalog.constraints.some(item => item.kind === 'fk' && item.id !== key.id &&
    item.tableId === table.id && item.targetTableId === parent.id && item.pairs.length === mapping.length &&
    item.pairs.every(pair => mapping.some(value => value.sourceColumnId === pair.sourceColumnId && value.targetColumnId === pair.targetColumnId)));
  const augmented = added.length ? { ...document, catalog: { ...document.catalog, columns: [...document.catalog.columns, ...added] } } : document;
  const validation = key ? dialect.validateForeignKey(augmented, key) : [];
  const sizeProblem = key && size === '1:N' && (unique || introducesUnique);
  const namesOnTable = new Set(document.catalog.constraints.filter(item => item.tableId === table.id && item.id !== keyId).map(item => item.physicalName));
  const suggestedName = availableName(table.physicalName + '_' + parent.physicalName + '_fk', new Set(namesOnTable));
  const enums = new Map(document.catalog.enums.map(item => [item.id, item.physicalName]));
  if (!keys.length) return <p role="alert">{seed.targetColumnId ? '선택한 부모 컬럼에 PK 또는 UNIQUE가 필요합니다.' :
    '참조 테이블에서 사용할 수 있는 PK 또는 UNIQUE 키가 없습니다.'}</p>;

  return <Form cancel={close} button="관계 적용" submit={form => {
    if (!key || duplicate || validation.length || sizeProblem) {
      setError('참조 키와 자식 컬럼을 확인하세요.');
      return;
    }
    const names = named(form);
    names.physicalName = names.physicalName || seed.existing?.physicalName || suggestedName;
    if (!validPhysicalName(names.physicalName) || namesOnTable.has(names.physicalName)) {
      setError('자식 테이블에서 중복되지 않는 FK 물리명을 UTF-8 기준 1~63바이트로 입력하세요.');
      return;
    }
    const onDelete = dialect.actions.find(action => action === field(form, 'onDelete'));
    const onUpdate = dialect.actions.find(action => action === field(form, 'onUpdate'));
    const useNull = onDelete === 'set-null' || onUpdate === 'set-null';
    if (useNull && (identify || childColumns.some(column => sourceIds.has(column.id) && (!column.nullable || pkColumns.includes(column.id))))) {
      setError('SET NULL을 사용하려면 모든 자식 FK 컬럼에서 NULL을 허용해야 합니다.');
      return;
    }
    if (pkChanges && pk && (document.catalog.constraints.some(item => item.kind === 'fk' &&
      item.targetKey.kind === 'constraint' && item.targetKey.id === pk.id) ||
      document.catalog.indexes.some(item => item.tableId === table.id && item.physicalName === pk.physicalName))) {
      setError('기존 자식 기본키를 사용하는 외래 키나 인덱스가 있어 확장할 수 없습니다.');
      return;
    }
    const commands: DocumentCommand[] = added.map(value => ({ kind: 'put-catalog', collection: 'columns', value: { ...value, nullable: useNull } }));
    if (added.length) commands.push({ kind: 'put-catalog', collection: 'tables', value: { ...table,
      columnIds: [...table.columnIds, ...added.map(column => column.id)] } });
    const keyNames = schemaRelationNames(document, table.namespaceId);
    for (const name of namesOnTable) keyNames.add(name);
    keyNames.add(names.physicalName);
    if (pkChanges) commands.push({ kind: 'put-catalog', collection: 'constraints', value: {
      ...pk, id: pk?.id ?? id(), tableId: table.id, kind: 'pk', physicalName: pk?.physicalName ?? availableName(table.physicalName + '_pkey', keyNames),
      columnIds: nextPk,
    } });
    if (identify) for (const column of childColumns) {
      if (column.nullable && sourceIds.has(column.id)) commands.push({ kind: 'put-catalog', collection: 'columns', value: { ...column, nullable: false } });
    }
    if (needsUnique) commands.push({ kind: 'put-catalog', collection: 'constraints', value: {
      id: id(), tableId: table.id, kind: 'unique', physicalName: availableName(names.physicalName + '_unique', keyNames), columnIds: [...sourceIds],
    } });
    commands.push({ kind: 'put-catalog', collection: 'constraints', value: { ...seed.existing, ...key, ...names, onDelete, onUpdate } });
    setError('');
    if (run({ kind: 'batch', commands }, setError)) close();
  }}>
    <KeySelect label="참조 후보키" keys={keys} columns={parentColumns} selected={chosen} select={value => { setChosen(value); setError(''); }} />
    {options.map(({ column, value, name, mapping: pair }, index) => <label key={column.id}>
      {index + 1}. {label(column)}에 대응할 자식 컬럼
      <select required value={value} onChange={event => { setPairs({ ...pairs, [column.id]: event.target.value }); setError(''); }}>
        <option value="">컬럼 선택</option>
        <option value={newColumnChoice}>새 컬럼 · {name}</option>
        {childColumns.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
      </select>
      {value && <small className="muted">{value === newColumnChoice ? '생성 · ' + columnTypeLabel(column.type, enums) : '기존 컬럼 사용'}
        {value !== newColumnChoice && !childColumns.some(item => item.id === pair.sourceColumnId) && ' · 컬럼을 다시 선택하세요'}</small>}
    </label>)}
    {key && <p className="relationship-changes">{[added.length && '새 컬럼 ' + added.length + '개', !seed.existing && '외래 키 1개',
      needsUnique && 'UNIQUE 1개', pkChanges && '자식 기본키 변경'].filter(Boolean).join(' · ') || '외래 키 설정 변경'}</p>}
    <details className="relationship-details"><summary>상세 설정</summary>
      <NameFields value={seed.existing ?? { physicalName: suggestedName }} />
      <label className="checkbox"><input type="checkbox" checked={identify} onChange={event => { setIdentify(event.target.checked); setError(''); }} />
        자식 기본키에 포함</label>
      {(['onDelete', 'onUpdate'] as const).map(action => <label key={action}>{action === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'}
        <select name={action} defaultValue={seed.existing?.[action] ?? ''}>
          <option value="">기본 동작</option>
          {dialect.actions.map(item => <option key={item} value={item}>{item.toUpperCase().replace('-', ' ')}</option>)}
        </select>
      </label>)}
    </details>
    {validation.map((item, index) => <p key={item.code + index} role="alert">{item.message}</p>)}
    {duplicate && <p role="alert">같은 컬럼을 연결한 외래 키가 이미 있습니다.</p>}
    {sizeProblem && <p role="alert">선택한 자식 컬럼은 값이 고유합니다. 1:1을 선택하거나 다른 자식 컬럼에 연결하세요.</p>}
    {error && <p role="alert">{error}</p>}
  </Form>;
}

function JoinTableForm({ document, view, dialect, left, right, run, close }: {
  document: ErdDocument; view?: View; dialect: EditorDialect; left: Table; right: Table; run: QuickRun; close(): void;
}) {
  const sides = [left, right];
  const eligible = sides.map(side => eligibleKeys(document, dialect, side.id));
  const [chosen, setChosen] = useState(() => eligible.map(keys => keys[0]?.key.id ?? ''));
  const [tableId] = useState(id);
  const [error, setError] = useState('');
  const tableNames = schemaRelationNames(document, left.namespaceId);
  for (const item of document.catalog.enums) if (item.namespaceId === left.namespaceId) tableNames.add(item.physicalName);
  const [name, setName] = useState(() => availableName(left.physicalName + '_' + right.physicalName, new Set(tableNames)));
  const usedColumns = new Set<string>();
  const plans = sides.flatMap((side, index) => {
    const columns = new Map(columnsOf(document, side.id).map(column => [column.id, column]));
    const key = eligible[index].find(item => item.key.id === chosen[index]);
    if (!key || key.columnIds.some(id => !columns.has(id))) return [];
    const mapped = key.columnIds.flatMap(targetColumnId => {
      const column = columns.get(targetColumnId);
      return column ? [{ targetColumnId, column: { id: tableId + ':' + index + ':' + targetColumnId, tableId,
        physicalName: availableName(childColumnName(side, column), usedColumns), type: column.type, nullable: false } }] : [];
    });
    return [{ side, index, key, columns, mapped }];
  });
  if (plans.length !== 2) return <p role="alert">N:N 연결에는 두 테이블 모두 참조할 수 있는 PK 또는 UNIQUE 키가 필요합니다.</p>;
  const columns = plans.flatMap(plan => plan.mapped.map(item => item.column));
  const enums = new Map(document.catalog.enums.map(item => [item.id, item.physicalName]));
  return <Form cancel={close} button="관계 적용" submit={() => {
    if (!validPhysicalName(name) || tableNames.has(name)) {
      setError('스키마에서 중복되지 않는 연결 테이블 이름을 UTF-8 기준 1~63바이트로 입력하세요.');
      return;
    }
    const table: Table = { id: tableId, namespaceId: left.namespaceId, physicalName: name, columnIds: columns.map(column => column.id) };
    const keyNames = new Set([...tableNames, name]);
    const commands: DocumentCommand[] = [
      { kind: 'put-catalog', collection: 'tables', value: table },
      ...columns.map(value => ({ kind: 'put-catalog', collection: 'columns', value } as const)),
      { kind: 'put-catalog', collection: 'constraints', value: {
        id: id(), tableId, physicalName: availableName(name + '_pkey', keyNames), kind: 'pk', columnIds: table.columnIds,
      } },
    ];
    for (const plan of plans) commands.push({ kind: 'put-catalog', collection: 'constraints', value: {
      id: id(), tableId, physicalName: availableName(name + '_' + plan.side.physicalName + '_fk', keyNames), kind: 'fk',
      targetTableId: plan.side.id, targetKey: plan.key.key,
      pairs: plan.mapped.map(item => ({ targetColumnId: item.targetColumnId, sourceColumnId: item.column.id })),
    } });
    if (view) commands.push(putView({ ...view, instances: [...view.instances, placement(view, tableId)] }));
    if (run({ kind: 'batch', commands }, setError)) close();
  }}>
    {plans.map(({ side, index, key, columns, mapped }) => <div key={index} className="relationship-join-side">
      <KeySelect label={index === 0 ? '첫 번째 참조 키' : '두 번째 참조 키'} keys={eligible[index]} columns={columns} selected={key.key.id}
        select={value => { setChosen(current => current.map((item, i) => i === index ? value : item)); setError(''); }} />
      <p><Icon name="link" /> {side.physicalName}</p>
      <ul>{mapped.map(item => <li key={item.column.id}>{item.column.physicalName} · {columnTypeLabel(item.column.type, enums)}
        {' → '}{columns.get(item.targetColumnId)?.physicalName}</li>)}</ul>
    </div>)}
    <label>연결 테이블 이름<input value={name} onChange={event => { setName(event.target.value); setError(''); }} required /></label>
    <p className="relationship-changes">연결 테이블 1개 · 외래 키 2개 · 연결 컬럼으로 구성한 복합 기본키</p>
    {error && <p role="alert">{error}</p>}
  </Form>;
}
