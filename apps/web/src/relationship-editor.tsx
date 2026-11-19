import { useState } from 'react';
import type { DocumentCommand, ErdDocument, ForeignKey } from '@erd/model';
import type { EditorDialect, ReferenceKey } from '@erd/sql-contract';
import type { QuickRun } from './canvas-edit.js';
import { Icon } from './editor-controls.js';
import { columnsOf, field, Form, id, label, Modal, named, NameFields, placement, putView } from './editor-fields.js';
import type { Column, Table, View } from './editor-fields.js';
import { availableName, columnTypeLabel, schemaRelationNames, validPhysicalName } from './schema-edits.js';

export type RelationshipSize = '1:N' | '1:1' | 'N:N';
type LogicalRelationship = ErdDocument['relationships'][number];
type RelationshipMode = 'foreign-key' | 'line';
export type RelationshipDraft = {
  childTableId: string; parentTableId?: string; childColumnId?: string; parentColumnId?: string;
  existing?: ForeignKey | LogicalRelationship; size?: RelationshipSize;
};
const cardinalities = { '1:N': 'one-to-many', '1:1': 'one-to-one', 'N:N': 'many-to-many' } as const;
const sizes = ['1:N', '1:1', 'N:N'] as const;

export function relationshipDraft(existing: ForeignKey | LogicalRelationship): RelationshipDraft {
  return 'kind' in existing
    ? { childTableId: existing.tableId, parentTableId: existing.targetTableId, existing }
    : { childTableId: existing.targetTableId, parentTableId: existing.sourceTableId, existing,
      size: sizes.find(size => cardinalities[size] === existing.cardinality) };
}

export function relationshipTableName(document: ErdDocument, table: Table) {
  return document.catalog.tables.some(item => item.id !== table.id && label(item) === label(table))
    ? [document.catalog.namespaces.find(item => item.id === table.namespaceId)?.physicalName, label(table)].filter(Boolean).join('.')
    : label(table);
}

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
  document: ErdDocument; view?: View; dialect: EditorDialect; seed: RelationshipDraft; run: QuickRun; close(): void;
}) {
  const existing = seed.existing;
  const foreignKey = existing && 'kind' in existing ? existing : undefined;
  const line = existing && !('kind' in existing) ? existing : undefined;
  const [direction, setDirection] = useState(seed);
  const [mode, setMode] = useState<RelationshipMode>(line ? 'line' : 'foreign-key');
  const [size, setSize] = useState<RelationshipSize>(seed.size ?? (
    foreignKey && dialect.cardinality(document, foreignKey)?.childMax === 1 ? '1:1' : '1:N'));
  const [lineError, setLineError] = useState('');
  const table = document.catalog.tables.find(item => item.id === direction.childTableId);
  const parent = document.catalog.tables.find(item => item.id === direction.parentTableId);
  const tableLabel = (item: Table) => relationshipTableName(document, item);
  if (!table) return null;
  const endpoints = JSON.stringify([parent?.id, table.id, direction.parentColumnId, direction.childColumnId]);
  const lineName = parent ? tableLabel(parent) + (size === 'N:N' ? ' ↔ ' : ' → ') + tableLabel(table) : '';

  return <Modal title="관계 설정" close={close} className="relationship-dialog">
    <section className="relationship-settings">
      <div className="relationship-endpoints">
        <label>{size === 'N:N' ? '첫 번째 테이블' : '부모 테이블'}<select value={parent?.id ?? ''}
          onChange={event => {
            setLineError('');
            setDirection({ ...direction, parentTableId: event.target.value, parentColumnId: undefined, childColumnId: undefined });
          }}>
          <option value="">테이블 선택</option>
          {document.catalog.tables.map(item => <option key={item.id} value={item.id}>{tableLabel(item)}</option>)}
        </select></label>
        <span aria-hidden="true">{size === 'N:N' ? '↔' : '→'}</span>
        <div><small>{size === 'N:N' ? '두 번째 테이블' : '자식 테이블'}</small><strong title={tableLabel(table)}>{tableLabel(table)}</strong></div>
      </div>
      {parent && !foreignKey && size !== 'N:N' && <button type="button" className="quiet relationship-swap" onClick={() => {
        setLineError('');
        setDirection({ childTableId: parent.id, parentTableId: table.id,
          childColumnId: direction.parentColumnId, parentColumnId: direction.childColumnId });
      }}>방향 바꾸기</button>}
      <fieldset className="relationship-options">
        <legend>카디널리티</legend>
        <div>{sizes.filter(item => !foreignKey || item !== 'N:N').map(item => <label key={item}>
          <input type="radio" name="relationship-size" checked={size === item} onChange={() => { setSize(item); setLineError(''); }} />{item}
        </label>)}</div>
      </fieldset>
      <fieldset className="relationship-options" disabled={Boolean(existing)}>
        <legend>적용 방식</legend>
        <div>
          <label><input type="radio" name="relationship-mode" checked={mode === 'foreign-key'} onChange={() => setMode('foreign-key')} />외래 키 생성</label>
          <label><input type="radio" name="relationship-mode" checked={mode === 'line'} onChange={() => { setMode('line'); setLineError(''); }} />관계선만 표시</label>
        </div>
      </fieldset>
      {!parent && <p className="muted">{size === 'N:N' ? '첫 번째 테이블을 선택하세요.' : '부모 테이블을 선택하세요.'}</p>}
      {parent && (mode === 'line' ? <Form key={endpoints} cancel={close} button={line ? '관계선 저장' : '관계선 추가'} submit={form => {
        const next = { id: line?.id ?? id(), name: field(form, 'name').trim() || lineName,
          sourceTableId: parent.id, targetTableId: table.id, cardinality: cardinalities[size],
          description: field(form, 'description').trim() || undefined };
        if (run({ kind: 'put-relationship', value: next }, setLineError)) close();
      }}>
        <section className="relationship-preview" aria-label="적용 미리보기">
          <strong>적용 미리보기</strong>
          <p>{lineName} · {size}</p>
          <small>테이블 사이에 관계선을 표시합니다. DDL에 포함하지 않습니다.</small>
        </section>
        <details className="relationship-details"><summary>고급 설정</summary>
          <label>관계선 이름<input name="name" defaultValue={line?.name} placeholder={lineName} /></label>
          <label>설명<textarea name="description" defaultValue={line?.description} /></label>
        </details>
        {lineError && <p role="alert">{lineError}</p>}
      </Form> : size === 'N:N'
        ? <JoinTableForm key={endpoints} document={document} view={view} dialect={dialect} left={parent} right={table}
          leftColumnId={direction.parentColumnId} rightColumnId={direction.childColumnId} run={run} close={close} />
        : <ForeignKeyFields key={endpoints} document={document} dialect={dialect} seed={direction} existing={foreignKey}
          table={table} parent={parent} size={size} run={run} close={close} />)}
    </section>
  </Modal>;
}

function ForeignKeyFields({ document, dialect, seed, existing, table, parent, size, run, close }: {
  document: ErdDocument; dialect: EditorDialect; seed: RelationshipDraft; existing?: ForeignKey; table: Table; parent: Table;
  size: '1:1' | '1:N'; run: QuickRun; close(): void;
}) {
  const keys = eligibleKeys(document, dialect, parent.id, seed.parentColumnId);
  const [chosen, setChosen] = useState(() => keys.find(key => key.key.id === existing?.targetKey.id)?.key.id ?? keys[0]?.key.id ?? '');
  const [keyId] = useState(() => existing?.id ?? id());
  const newColumnChoice = keyId + ':new';
  const [identify, setIdentify] = useState(false);
  const [error, setError] = useState('');
  const [pairs, setPairs] = useState<Record<string, string>>(() => Object.fromEntries(
    existing?.targetTableId === parent.id ? existing.pairs.map(pair => [pair.targetColumnId, pair.sourceColumnId]) :
      seed.parentColumnId && seed.childColumnId ? [[seed.parentColumnId, seed.childColumnId]] : []));
  const parentColumns = new Map(columnsOf(document, parent.id).map(column => [column.id, column]));
  const childColumns = columnsOf(document, table.id);
  const candidate = keys.find(item => item.key.id === chosen);
  const order = existing && existing.targetKey.id === candidate?.key.id
    ? existing.pairs.map(pair => pair.targetColumnId) : candidate?.columnIds;
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
  const includedInPk = Boolean(key && mapping.every(pair => pkColumns.includes(pair.sourceColumnId)));
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
  const parentColumn = seed.parentColumnId ? parentColumns.get(seed.parentColumnId) : undefined;
  const parentName = relationshipTableName(document, parent);
  if (!keys.length) return <p role="alert">{parentColumn
    ? `${parentName}.${parentColumn.physicalName} 컬럼에 PK 또는 UNIQUE가 필요합니다.`
    : `${parentName} 테이블에 참조할 수 있는 PK 또는 UNIQUE가 필요합니다.`}</p>;

  return <Form cancel={close} button={existing ? '외래 키 저장' : '외래 키 생성'} submit={form => {
    if (!key || duplicate || validation.length || sizeProblem) {
      setError('참조 키와 자식 컬럼을 확인하세요.');
      return;
    }
    const names = named(form);
    names.physicalName = names.physicalName || existing?.physicalName || suggestedName;
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
    commands.push({ kind: 'put-catalog', collection: 'constraints', value: { ...existing, ...key, ...names, onDelete, onUpdate } });
    setError('');
    if (run({ kind: 'batch', commands }, setError)) close();
  }}>
    <KeySelect label="참조 후보키" keys={keys} columns={parentColumns} selected={chosen} select={value => { setChosen(value); setError(''); }} />
    <section className="relationship-preview" aria-label="적용 미리보기">
      <strong>적용 미리보기</strong>
      {options.map(({ column, value, name }) => <label key={column.id}>
        <span><code>{label(column)}</code> → 자식 컬럼</span>
        <select required value={value} onChange={event => { setPairs({ ...pairs, [column.id]: event.target.value }); setError(''); }}>
          <option value="">컬럼 선택</option>
          <option value={newColumnChoice}>새 컬럼 · {name}</option>
          {childColumns.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
        </select>
        {value && <small className="muted">{value === newColumnChoice ? '생성 · ' + columnTypeLabel(column.type, enums) : '기존 컬럼 사용'}</small>}
      </label>)}
      {key && <p>{[added.length && '새 컬럼 ' + added.length + '개', !existing && '외래 키 1개',
        needsUnique && 'UNIQUE 1개', pkChanges && '자식 기본키 변경'].filter(Boolean).join(' · ') || '외래 키 설정 변경'}</p>}
    </section>
    <details className="relationship-details"><summary>고급 설정</summary>
      <NameFields value={existing ?? { physicalName: suggestedName }} />
      <label className="checkbox"><input type="checkbox" checked={identify || includedInPk} disabled={includedInPk}
        onChange={event => { setIdentify(event.target.checked); setError(''); }} />
        자식 기본키에 포함</label>
      {(['onDelete', 'onUpdate'] as const).map(action => <label key={action}>{action === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'}
        <select name={action} defaultValue={existing?.[action] ?? ''}>
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

function JoinTableForm({ document, view, dialect, left, right, leftColumnId, rightColumnId, run, close }: {
  document: ErdDocument; view?: View; dialect: EditorDialect; left: Table; right: Table; run: QuickRun; close(): void;
  leftColumnId?: string; rightColumnId?: string;
}) {
  const sides = [left, right];
  const anchors = [leftColumnId, rightColumnId];
  const eligible = sides.map((side, index) => eligibleKeys(document, dialect, side.id, anchors[index]));
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
  if (plans.length !== 2) return <>{sides.map((side, index) => {
    if (eligible[index].length) return null;
    const column = document.catalog.columns.find(item => item.id === anchors[index]);
    const name = relationshipTableName(document, side);
    return <p key={index} role="alert">{column ? `${name}.${column.physicalName} 컬럼` : `${name} 테이블`}에 참조할 수 있는 PK 또는 UNIQUE가 필요합니다.</p>;
  })}</>;
  const columns = plans.flatMap(plan => plan.mapped.map(item => item.column));
  const enums = new Map(document.catalog.enums.map(item => [item.id, item.physicalName]));
  return <Form cancel={close} button="연결 테이블 생성" submit={() => {
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
    <label>연결 테이블 이름<input value={name} onChange={event => { setName(event.target.value); setError(''); }} required /></label>
    <section className="relationship-preview" aria-label="적용 미리보기">
      <strong>적용 미리보기</strong>
      {plans.map(({ side, index, key, columns, mapped }) => <div key={index} className="relationship-join-side">
        <KeySelect label={index === 0 ? '첫 번째 참조 키' : '두 번째 참조 키'} keys={eligible[index]} columns={columns} selected={key.key.id}
          select={value => { setChosen(current => current.map((item, i) => i === index ? value : item)); setError(''); }} />
        <p><Icon name="link" /> {relationshipTableName(document, side)}</p>
        <ul>{mapped.map(item => <li key={item.column.id}>{columns.get(item.targetColumnId)?.physicalName}
          {' → '}{item.column.physicalName} · {columnTypeLabel(item.column.type, enums)}</li>)}</ul>
      </div>)}
      <p>연결 테이블 1개 · 외래 키 2개 · 연결 컬럼으로 구성한 복합 기본키</p>
    </section>
    {error && <p role="alert">{error}</p>}
  </Form>;
}
