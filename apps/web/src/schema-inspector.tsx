import { useState } from 'react';
import type { Catalog, DocumentCommand, ErdDocument, ForeignKey } from '@erd/model';
import { deletionImpact, documentExpressions, isIdentifyingForeignKey, primaryColumnsByTable } from '@erd/model';
import { Icon } from './editor-controls.js';
import type { EditorDialect } from '@erd/sql-contract';
import { columnsOf, field, Form, id, label, Modal, moveItem, named, NameFields, OrderedColumns, OrderedItems, sqlExpression } from './editor-fields.js';
import type { Column, Table } from './editor-fields.js';
import { availableName, putColumn, schemaRelationNames, validPhysicalName } from './schema-edits.js';
import type { QuickRun } from './canvas-edit.js';

type Constraint = Catalog['constraints'][number];
type Index = Catalog['indexes'][number];
type KeyPart = Index['keys'][number];
type Run = (command: DocumentCommand) => boolean;
export type PhysicalRelation = 'identifying' | 'non-identifying';
export type FkDialog = {
  tableId: string; targetTableId?: string; sourceColumnId?: string; targetColumnId?: string;
  existing?: ForeignKey; mode?: PhysicalRelation;
};

export function DeleteSchema({ document, objectId, run, close, removed }: {
  document: ErdDocument; objectId: string; run: Run; close(): void; removed(): void;
}) {
  const impact = deletionImpact(document, objectId);
  if (!impact) return null;
  const { catalog } = document;
  const names = new Map(catalog.namespaces.map(item => [item.id, label(item)]));
  for (const item of [...catalog.tables, ...catalog.enums, ...catalog.sequences]) {
    names.set(item.id, [names.get(item.namespaceId), label(item)].filter(Boolean).join('.'));
  }
  for (const item of [...catalog.columns, ...catalog.constraints, ...catalog.indexes]) {
    names.set(item.id, [names.get(item.tableId), label(item)].filter(Boolean).join('.'));
  }
  for (const item of document.relationships) names.set(item.id, item.name);
  const table = catalog.tables.find(item => item.id === objectId);
  const column = catalog.columns.find(item => item.id === objectId);
  const owner = table?.id ?? column?.tableId;
  const affected = (items: { id: string }[]) => items.filter(item => item.id !== objectId && impact.removed.has(item.id));
  const crossTable = affected(catalog.constraints.filter(key => key.kind === 'fk' && Boolean(owner) && key.tableId !== owner));
  const crossIds = new Set(crossTable.map(item => item.id));
  const groups = [
    { title: '다른 테이블의 외래 키', items: crossTable, open: true },
    { title: '컬럼', items: affected(catalog.columns) },
    { title: '키·제약', items: affected(catalog.constraints.filter(key => !crossIds.has(key.id))) },
    { title: '인덱스', items: affected(catalog.indexes) },
    { title: '논리 관계', items: affected(document.relationships) },
  ];
  const blocked = impact.blockedBy.length > 0;
  const expressions = documentExpressions(document);
  const dependencies = new Map<string, string>();
  if (blocked) {
    const ids = new Set(impact.blockedBy);
    for (const { ownerId, expression } of expressions) {
      if (!ids.has(ownerId)) continue;
      if (expression.references?.some(id => impact.removed.has(id))) dependencies.set(ownerId, 'SQL 식이 삭제 대상을 참조합니다.');
      else if (!dependencies.has(ownerId)) dependencies.set(ownerId, 'SQL 식의 참조 범위를 확인해야 합니다.');
    }
  }
  const affectedViews = document.views.filter(view => impact.views.has(view.id));
  return <Modal title="스키마 삭제 영향" close={close}>
    <section className="deletion-preview">
      <div className="deletion-target"><Icon name="trash" /><div>
        <h3>{names.get(objectId) ?? '선택한 스키마 객체'}</h3>
        <p>{table ? '테이블 정의와 모든 다이어그램의 배치를 삭제합니다.' : column ? '컬럼 정의와 연결된 스키마 객체를 삭제합니다.' : '선택한 스키마 객체를 삭제합니다.'}</p>
      </div></div>
      {blocked && <div className="deletion-blocked" role="alert">
        <h3>먼저 확인할 의존 항목 {impact.blockedBy.length}개</h3>
        <ul>{impact.blockedBy.map(id => <li key={id}>
          <strong>{names.get(id) ?? '스키마 객체'}</strong>
          <span>{dependencies.get(id) ?? '이 스키마에 속한 객체입니다.'}</span>
        </li>)}</ul>
      </div>}
      {affectedViews.length > 0 && <div className="deletion-views">
        <h3>영향받는 다이어그램 {affectedViews.length}개</h3>
        <ul>{affectedViews.map(view => {
          const count = view.instances.filter(item => impact.removed.has(item.id)).length;
          return <li key={view.id}>{view.name}{Boolean(count) && <span className="muted">배치 {count}개</span>}</li>;
        })}</ul>
      </div>}
      {groups.filter(group => group.items.length > 0).map(group => <details key={group.title} open={group.open}>
        <summary>{group.title} {group.items.length}개 삭제</summary>
        <ul>{group.items.map(item => <li key={item.id}>{names.get(item.id)}</li>)}</ul>
      </details>)}
      {impact.detachedSequences.length > 0 && <details>
        <summary>시퀀스 소유 연결 {impact.detachedSequences.length}개 해제</summary>
        <ul>{impact.detachedSequences.map(id => <li key={id}>{names.get(id)}</li>)}</ul>
      </details>}
      <div className="actions deletion-actions">
        <button type="button" autoFocus onClick={close}>취소</button>
        <button type="button" className="destructive" aria-label="실제 삭제 확인" disabled={blocked} onClick={() => {
          if (run({ kind: 'remove-schema-object', objectId })) { removed(); close(); }
        }}>삭제하기</button>
      </div>
    </section>
  </Modal>;
}

export function ColumnForm({ document, table, column, dialect, run, close }: {
  document: ErdDocument; table: Table; column?: Column; dialect: EditorDialect; run: Run; close(): void;
}) {
  const type = column?.type ?? dialect.defaultType;
  const native = type.reference.kind === 'native' ? type.reference.name : '';
  const types = dialect.types(document.target);
  const [error, setError] = useState('');
  return <Form cancel={close} button={column ? '컬럼 적용' : '컬럼 만들기'} submit={form => {
    const typeName = field(form, 'type');
    const argsText = field(form, 'arguments');
    const originalArgs = JSON.stringify(type.arguments);
    let args = type.arguments;
    if (argsText !== originalArgs) {
      try {
        const parsed: unknown = JSON.parse(argsText);
        if (!Array.isArray(parsed) || !parsed.every(item => typeof item === 'string' || typeof item === 'number')) throw new Error();
        args = parsed;
      } catch {
        setError('타입 인수를 숫자나 문자열의 JSON 배열로 입력하세요.');
        return;
      }
    }
    setError('');
    const dimensions = Number(field(form, 'dimensions') || type.arrayDimensions);
    const changed = typeName !== native || argsText !== originalArgs || dimensions !== type.arrayDimensions;
    const defaultSql = field(form, 'default');
    const next: Column = {
      ...column, ...named(form), id: column?.id ?? id(), tableId: table.id,
      type: changed ? {
        ...type, reference: typeName === native ? type.reference : { kind: 'native', name: typeName },
        arguments: args, arrayDimensions: dimensions, originalSql: undefined,
      } : type,
      nullable: form.has('nullable'),
      default: field(form, 'default').trim() ? sqlExpression(document, defaultSql, column?.default) : undefined,
    };
    const typeProblem = changed || !column ? dialect.typeProblem(next.type) : undefined;
    if (typeProblem) { setError(typeProblem); return; }
    if (run(putColumn(table, next, Number(field(form, 'order')) - 1))) close();
  }}>
    <NameFields value={column ?? { physicalName: '' }} />
    <label>자료형<select name="type" defaultValue={native} disabled={type.reference.kind === 'enum'}>
      {!types.includes(native) && <option value={native}>{native || 'ENUM · 보존 전용'}</option>}
      {types.map(type => <option key={type}>{type}</option>)}
    </select></label>
    {type.reference.kind === 'enum' && <input type="hidden" name="type" value="" />}
    <label>타입 인수 (JSON 배열)<input name="arguments" defaultValue={JSON.stringify(type.arguments)} /></label>
    <label>배열 차원<input type="number" min="0" step="1" name="dimensions" defaultValue={type.arrayDimensions} /></label>
    <label>컬럼 위치<input type="number" name="order" min="1" max={table.columnIds.length + (column ? 0 : 1)}
      defaultValue={column ? table.columnIds.indexOf(column.id) + 1 : table.columnIds.length + 1} required /></label>
    <label className="checkbox"><input type="checkbox" name="nullable" defaultChecked={column?.nullable ?? true} />NULL 허용</label>
    <label>DEFAULT SQL<textarea name="default" defaultValue={column?.default?.sql} /></label>
    {column?.identity && <p>IDENTITY · {column.identity} · 보존 전용</p>}
    {error && <p role="alert">{error}</p>}
  </Form>;
}

export function KeyForm({ document, table, existing, kind, run, close }: {
  document: ErdDocument; table: Table; existing?: Constraint; kind: 'pk' | 'unique' | 'check'; run: Run; close(): void;
}) {
  const [keys, setKeys] = useState(existing && (existing.kind === 'pk' || existing.kind === 'unique') ? existing.columnIds : []);
  const prior = existing?.kind === 'check' ? existing.expression : undefined;
  return <Form cancel={close} button={existing ? '제약 적용' : '제약 만들기'} submit={form => {
    const base = { ...named(form), id: existing?.id ?? id(), tableId: table.id };
    const value: Constraint = kind === 'check' ? { ...base, kind, expression: sqlExpression(document, field(form, 'sql'), prior) } :
      { ...base, kind, columnIds: keys };
    if (run({ kind: 'put-catalog', collection: 'constraints', value })) close();
  }}>
    <NameFields value={existing ?? { physicalName: '' }} />
    {kind === 'check' ? <label>CHECK SQL<textarea name="sql" defaultValue={prior?.sql} required /></label> :
      <OrderedColumns columns={columnsOf(document, table.id)} value={keys} set={setKeys} />}
  </Form>;
}

export function IndexForm({ document, table, existing, run, close }: {
  document: ErdDocument; table: Table; existing?: Index; run: Run; close(): void;
}) {
  const columns = columnsOf(document, table.id);
  const [parts, setParts] = useState(() => (existing?.keys ?? []).map(part => ({ id: id(), part })));
  const [adding, setAdding] = useState('');
  const add = (part: KeyPart) => setParts([...parts, { id: id(), part }]);
  return <Form cancel={close} button={existing ? '인덱스 적용' : '인덱스 만들기'} submit={form => {
    const keys: KeyPart[] = parts.map(({ id, part }) => part.kind === 'column' ? part : {
      kind: 'expression', expression: sqlExpression(document, field(form, id), part.expression),
    });
    const predicate = field(form, 'predicate');
    if (run({ kind: 'put-catalog', collection: 'indexes', value: {
      ...named(form), id: existing?.id ?? id(), tableId: table.id, unique: form.has('unique'), keys,
      predicate: predicate.trim() ? sqlExpression(document, predicate, existing?.predicate) : undefined,
    } })) close();
  }}>
    <NameFields value={existing ?? { physicalName: '' }} />
    <label className="checkbox"><input type="checkbox" name="unique" defaultChecked={existing?.unique} />고유 인덱스</label>
    <OrderedItems title="인덱스 키" items={parts.map(({ id, part }, index) => ({
      key: id,
      content: part.kind === 'column' ? label(columns.find(c => c.id === part.columnId) ?? { physicalName: part.columnId }) :
        <textarea name={id} aria-label={`인덱스 SQL 식 ${index + 1}`} defaultValue={part.expression.sql} required />,
    }))} change={(from, to) => setParts(to === null ? parts.filter((_, index) => index !== from) : moveItem(parts, from, to))} />
    <div className="actions">
      <label>인덱스 컬럼<select value={adding} onChange={event => setAdding(event.target.value)}>
        <option value="">컬럼 선택</option>
        {columns.map(column => <option key={column.id} value={column.id}>{label(column)}</option>)}
      </select></label>
      <button type="button" disabled={!adding} onClick={() => { add({ kind: 'column', columnId: adding }); setAdding(''); }}>인덱스 컬럼 추가</button>
      <button type="button" onClick={() => add({ kind: 'expression', expression: { ...document.target, sql: '' } })}>SQL 식 추가</button>
    </div>
    <label>부분 인덱스 조건 SQL<textarea name="predicate" defaultValue={existing?.predicate?.sql} /></label>
  </Form>;
}

function eligibleKeys(document: ErdDocument, dialect: EditorDialect, tableId: string, columnId?: string) {
  const primary = document.catalog.constraints.find(key => key.tableId === tableId && key.kind === 'pk');
  const eligible = dialect.referenceKeys(document, tableId).filter(item => !item.unavailable && (!columnId || item.columnIds.includes(columnId)));
  const first = eligible.findIndex(item => item.key.id === primary?.id && item.key.kind === 'constraint');
  if (first > 0) eligible.unshift(eligible.splice(first, 1)[0]);
  return eligible;
}

export function ForeignKeyForm({ document, dialect, seed, run, close }: {
  document: ErdDocument; dialect: EditorDialect; seed: FkDialog; run: QuickRun; close(): void;
}) {
  const [keyId] = useState(() => seed.existing?.id ?? id());
  const [target, setTarget] = useState(seed.targetTableId ?? '');
  const [mode, setMode] = useState<PhysicalRelation | ''>(seed.mode ?? '');
  const [error, setError] = useState('');
  const candidates = dialect.referenceKeys(document, target);
  const eligible = eligibleKeys(document, dialect, target, seed.targetColumnId);
  const [chosen, setChosen] = useState(seed.existing?.targetKey.id ?? eligible[0]?.key.id ?? '');
  const [pairs, setPairs] = useState<Record<string, string>>(() => Object.fromEntries(seed.existing?.pairs.map(pair =>
    [pair.targetColumnId, pair.sourceColumnId]) ?? (seed.targetColumnId && seed.sourceColumnId ? [[seed.targetColumnId, seed.sourceColumnId]] : [])));
  const candidate = eligible.find(item => item.key.id === chosen);
  const table = document.catalog.tables.find(item => item.id === seed.tableId);
  const parent = document.catalog.tables.find(item => item.id === target);
  const sourceColumns = columnsOf(document, seed.tableId);
  const targetColumns = new Map(columnsOf(document, target).map(column => [column.id, column]));
  const originalOrder = seed.existing?.targetKey.id === candidate?.key.id ? seed.existing?.pairs.map(pair => pair.targetColumnId) : undefined;
  const targetOrder = originalOrder ?? candidate?.columnIds ?? [];
  const newColumnChoice = keyId + ':new';
  const defaultMapping = seed.mode ? newColumnChoice : '';
  const usedNames = new Set(sourceColumns.map(column => column.physicalName));
  const added: Column[] = [];
  const options = targetOrder.flatMap(targetColumnId => {
    const column = targetColumns.get(targetColumnId);
    if (!column || !parent || !table) return [];
    const name = availableName(parent.physicalName + '_' + column.physicalName, usedNames);
    const value = pairs[targetColumnId] ?? defaultMapping;
    const sourceColumnId = value === newColumnChoice ? keyId + ':column:' + targetColumnId : value;
    if (value === newColumnChoice) added.push({ id: sourceColumnId, tableId: table.id, physicalName: name,
      type: column.type, nullable: false });
    return [{ column, value, name, mapping: { targetColumnId, sourceColumnId } }];
  });
  const mapping = options.map(option => option.mapping);
  const key: ForeignKey | undefined = table && candidate && mapping.length > 0 && mapping.length === targetOrder.length &&
    mapping.every(pair => pair.sourceColumnId) ? {
      id: keyId, kind: 'fk', tableId: table.id, physicalName: '', targetTableId: target, targetKey: candidate.key, pairs: mapping,
    } : undefined;
  const primary = primaryColumnsByTable(document);
  const sameMapping = key && document.catalog.constraints.some(item => item.kind === 'fk' && item.id !== key.id &&
    item.tableId === key.tableId && item.targetTableId === key.targetTableId && item.pairs.length === mapping.length &&
    item.pairs.every(pair => mapping.some(value => value.sourceColumnId === pair.sourceColumnId && value.targetColumnId === pair.targetColumnId)));
  const augmented = added.length ? { ...document, catalog: { ...document.catalog, columns: [...document.catalog.columns, ...added] } } : document;
  const validation = key ? dialect.validateForeignKey(augmented, key) : [];
  const modeProblem = key && mode === 'non-identifying' && isIdentifyingForeignKey(key, primary)
    ? '비식별 관계에는 자식 기본키에 포함되지 않은 컬럼이 하나 이상 필요합니다.' : '';
  const existingKeyNames = new Set(document.catalog.constraints.filter(item => item.tableId === seed.tableId).map(item => item.physicalName));
  const suggestedName = availableName([table?.physicalName, parent?.physicalName, 'fk'].filter(Boolean).join('_'), existingKeyNames);
  if (!table) return null;
  const namespaces = new Map(document.catalog.namespaces.map(namespace => [namespace.id, label(namespace)]));
  const seenNames = new Set<string>();
  const duplicateNames = new Set<string>();
  for (const item of document.catalog.tables) {
    const name = label(item);
    if (seenNames.has(name)) duplicateNames.add(name);
    seenNames.add(name);
  }
  const tableLabel = (item: Table) => duplicateNames.has(label(item))
    ? [namespaces.get(item.namespaceId), label(item)].filter(Boolean).join('.') : label(item);

  return <Modal title="외래 키 설정" close={close}>
    {seed.mode && parent && <p className="fk-summary"><strong>{tableLabel(parent)}</strong><Icon name="right" /><strong>{tableLabel(table)}</strong>
      <span className="muted">부모 → 자식</span></p>}
    <Form cancel={close} button="외래 키 적용" submit={form => {
      if (!key || validation.length || modeProblem || sameMapping) {
        setError('후보키와 컬럼 매핑을 확인하세요.');
        return;
      }
      const names = named(form);
      const onDelete = dialect.actions.find(action => action === field(form, 'onDelete'));
      const onUpdate = dialect.actions.find(action => action === field(form, 'onUpdate'));
      const commands: DocumentCommand[] = [];
      if (mode && (!validPhysicalName(names.physicalName) ||
        document.catalog.constraints.some(item => item.id !== key.id && item.tableId === table.id && item.physicalName === names.physicalName))) {
        setError('테이블 내에서 중복되지 않는 FK 물리명을 UTF-8 기준 1~63바이트로 입력하세요.');
        return;
      }
      const useNull = onDelete === 'set-null' || onUpdate === 'set-null';
      if (mode === 'identifying' && useNull) {
        setError('식별 관계의 자식 컬럼은 NULL을 허용하지 않습니다. 다른 참조 동작을 선택하세요.');
        return;
      }
      if (mode === 'non-identifying' && useNull && sourceColumns.some(column =>
        mapping.some(pair => pair.sourceColumnId === column.id) && (!column.nullable || primary.get(table.id)?.has(column.id)))) {
        setError('SET NULL을 사용하려면 매핑한 자식 컬럼에서 NULL을 허용해야 합니다.');
        return;
      }
      for (const value of added) commands.push({ kind: 'put-catalog', collection: 'columns', value: { ...value, nullable: useNull } });
      if (added.length) commands.push({ kind: 'put-catalog', collection: 'tables', value: {
        ...table, columnIds: [...table.columnIds, ...added.map(column => column.id)],
      } });
      if (mode === 'identifying') {
        const pk = document.catalog.constraints.find(item => item.kind === 'pk' && item.tableId === table.id);
        const columnIds = [...new Set([...(pk?.kind === 'pk' ? pk.columnIds : []), ...mapping.map(pair => pair.sourceColumnId)])];
        if (pk?.kind === 'pk' && columnIds.length !== pk.columnIds.length && (document.catalog.constraints.some(item =>
          item.kind === 'fk' && item.targetKey.kind === 'constraint' && item.targetKey.id === pk.id) ||
          document.catalog.indexes.some(item => item.tableId === table.id && item.physicalName === pk.physicalName))) {
          setError('자식 기본키를 참조하는 FK 또는 같은 이름의 인덱스가 있습니다. 기존 기본키 컬럼에 매핑하거나 비식별 관계를 선택하세요.');
          return;
        }
        const pkNames = schemaRelationNames(document, table.namespaceId);
        for (const name of existingKeyNames) pkNames.add(name);
        pkNames.add(names.physicalName);
        commands.push({ kind: 'put-catalog', collection: 'constraints', value: {
          ...pk, id: pk?.id ?? id(), tableId: table.id, kind: 'pk',
          physicalName: pk?.physicalName ?? availableName(table.physicalName + '_pkey', pkNames), columnIds,
        } });
        for (const column of sourceColumns) {
          if (column.nullable && mapping.some(pair => pair.sourceColumnId === column.id)) {
            commands.push({ kind: 'put-catalog', collection: 'columns', value: { ...column, nullable: false } });
          }
        }
      }
      commands.push({ kind: 'put-catalog', collection: 'constraints', value: { ...seed.existing, ...key, ...names, onDelete, onUpdate } });
      setError('');
      if (run({ kind: 'batch', commands }, setError)) close();
    }}>
      <label>관계 유형<select value={mode} onChange={event => {
        setMode(event.target.value === 'identifying' ? 'identifying' : event.target.value === 'non-identifying' ? 'non-identifying' : '');
        setError('');
      }}>
        <option value="">기존 기본키 구성 사용</option>
        <option value="identifying">식별 관계</option>
        <option value="non-identifying">비식별 관계</option>
      </select></label>
      {mode === 'identifying' && <p className="muted">매핑한 자식 컬럼을 기본키에 포함하고 NULL을 허용하지 않습니다.</p>}
      <NameFields value={seed.existing ?? { physicalName: seed.mode ? suggestedName : '' }} />
      <label>참조 테이블<select value={target} onChange={event => {
        const next = event.target.value;
        setTarget(next);
        setChosen(eligibleKeys(document, dialect, next)[0]?.key.id ?? '');
        setPairs({});
        setError('');
      }} disabled={Boolean(seed.targetColumnId || seed.mode)}>
        <option value="">테이블 선택</option>
        {document.catalog.tables.map(table => <option key={table.id} value={table.id}>{tableLabel(table)}</option>)}
      </select></label>
      <label>참조 후보키<select value={chosen} onChange={event => { setChosen(event.target.value); setError(''); }} required>
        <option value="">후보키 선택</option>
        {eligible.map(item => <option key={item.key.id} value={item.key.id}>{item.name || '(이름 없음)'}</option>)}
      </select></label>
      {candidates.filter(item => item.unavailable).map(item => <p key={item.key.id}>{item.name} · {item.unavailable}</p>)}
      {target && !eligible.length && <p role="alert">참조할 수 있는 후보키가 없습니다.</p>}
      {options.map(({ column, value, name }, index) => <label key={column.id}>
        {index + 1}. {label(column)}에 대응할 원본 컬럼
        <select required value={value} onChange={event => { setPairs({ ...pairs, [column.id]: event.target.value }); setError(''); }}>
          <option value="">컬럼 선택</option>
          <option value={newColumnChoice}>새 컬럼 · {name}</option>
          {sourceColumns.map(column => <option key={column.id} value={column.id}>{label(column)}</option>)}
        </select>
      </label>)}
      {(['onDelete', 'onUpdate'] as const).map(action => <label key={action}>{action === 'onDelete' ? 'ON DELETE' : 'ON UPDATE'}
        <select name={action} defaultValue={seed.existing?.[action] ?? ''}>
          <option value="">기본 동작</option>
          {dialect.actions.map(item => <option key={item} value={item}>{item.toUpperCase().replace('-', ' ')}</option>)}
        </select>
      </label>)}
      {validation.map(item => <p key={item.code} role="alert">{item.message}</p>)}
      {sameMapping && <p role="alert">같은 컬럼 매핑으로 연결된 FK가 있습니다.</p>}
      {modeProblem && <p role="alert">{modeProblem}</p>}
      {error && <p role="alert">{error}</p>}
    </Form>
  </Modal>;
}
