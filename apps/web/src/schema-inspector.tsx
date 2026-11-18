import { useState } from 'react';
import type { Catalog, DocumentCommand, ErdDocument, ForeignKey } from '@erd/model';
import { deletionImpact } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { columnsOf, field, Form, id, label, Modal, moveItem, named, NameFields, OrderedColumns, OrderedItems, sqlExpression } from './editor-fields.js';
import type { Column, Table } from './editor-fields.js';

type Constraint = Catalog['constraints'][number];
type Index = Catalog['indexes'][number];
type KeyPart = Index['keys'][number];
type Run = (command: DocumentCommand) => boolean;
export type FkDialog = { tableId: string; targetTableId?: string; sourceColumnId?: string; targetColumnId?: string; existing?: ForeignKey };

export function DeleteSchema({ document, objectId, run, close }: { document: ErdDocument; objectId: string; run: Run; close(): void }) {
  const impact = deletionImpact(document, objectId);
  if (!impact) return null;
  const objects = new Map(Object.values(document.catalog).flat().map(item => [item.id, label(item)]));
  for (const item of document.relationships) objects.set(item.id, item.name);
  const names = (ids: Iterable<string>) => [...ids].map(id => (objects.get(id) ? objects.get(id) + ' (' + id + ')' : id)).join(', ');
  const viewNames = document.views.filter(view => impact.views.has(view.id)).map(view => view.name).join(', ');
  return <Modal title="스키마 삭제 영향" close={close}>
    <dl>
      <dt>삭제되는 객체 및 배치</dt><dd>{names(impact.removed)}</dd>
      {viewNames && <><dt>영향받는 뷰</dt><dd>{viewNames}</dd></>}
      {impact.detachedSequences.length > 0 && <><dt>소유 참조를 해제할 시퀀스</dt><dd>{names(impact.detachedSequences)}</dd></>}
      {impact.blockedBy.length > 0 && <><dt>먼저 확인할 종속 객체 또는 SQL 식</dt><dd role="alert">{names(impact.blockedBy)}</dd></>}
    </dl>
    <button type="button" disabled={impact.blockedBy.length > 0} onClick={() => {
      if (run({ kind: 'remove-schema-object', objectId })) close();
    }}>실제 삭제 확인</button>
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
    const order = table.columnIds.filter(id => id !== next.id);
    order.splice(Number(field(form, 'order')) - 1, 0, next.id);
    if (run({ kind: 'batch', commands: [
      { kind: 'put-catalog', collection: 'columns', value: next },
      { kind: 'put-catalog', collection: 'tables', value: { ...table, columnIds: order } },
    ] })) close();
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
        <input name={id} aria-label={`인덱스 SQL 식 ${index + 1}`} defaultValue={part.expression.sql} required />,
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

export function ForeignKeyForm({ document, dialect, seed, run, close }: {
  document: ErdDocument; dialect: EditorDialect; seed: FkDialog; run: Run; close(): void;
}) {
  const [keyId] = useState(() => seed.existing?.id ?? id());
  const [target, setTarget] = useState(seed.targetTableId ?? '');
  const candidates = dialect.referenceKeys(document, target);
  const eligible = candidates.filter(item => !item.unavailable && (!seed.targetColumnId || item.columnIds.includes(seed.targetColumnId)));
  const [chosen, setChosen] = useState(seed.existing?.targetKey.id ?? eligible[0]?.key.id ?? '');
  const [pairs, setPairs] = useState<Record<string, string>>(() => Object.fromEntries(seed.existing?.pairs.map(pair =>
    [pair.targetColumnId, pair.sourceColumnId]) ?? (seed.targetColumnId && seed.sourceColumnId ? [[seed.targetColumnId, seed.sourceColumnId]] : [])));
  const candidate = eligible.find(item => item.key.id === chosen);
  const sourceColumns = columnsOf(document, seed.tableId);
  const targetColumns = columnsOf(document, target);
  const originalOrder = seed.existing?.targetKey.id === candidate?.key.id ? seed.existing?.pairs.map(pair => pair.targetColumnId) : undefined;
  const targetOrder = originalOrder ?? candidate?.columnIds ?? [];
  const mapping = targetOrder.map(targetColumnId => ({ targetColumnId, sourceColumnId: pairs[targetColumnId] ?? '' }));
  const complete = mapping.length > 0 && mapping.every(pair => pair.sourceColumnId);
  const validation = complete && candidate ? dialect.validateForeignKey(document, {
    id: keyId, kind: 'fk', physicalName: '', tableId: seed.tableId, targetTableId: target, targetKey: candidate.key, pairs: mapping,
  }) : [];
  return <Modal title="외래 키 설정" close={close}>
    <Form cancel={close} button="외래 키 적용" submit={form => {
      if (!candidate || !complete || validation.length) return;
      if (run({ kind: 'put-catalog', collection: 'constraints', value: {
        ...named(form), id: keyId, kind: 'fk', tableId: seed.tableId, targetTableId: target, targetKey: candidate.key,
        pairs: mapping, onDelete: dialect.actions.find(action => action === field(form, 'onDelete')),
        onUpdate: dialect.actions.find(action => action === field(form, 'onUpdate')),
      } })) close();
    }}>
      <NameFields value={seed.existing ?? { physicalName: '' }} />
      <label>참조 테이블<select value={target} onChange={event => {
        const target = event.target.value;
        setTarget(target);
        setChosen(dialect.referenceKeys(document, target).find(key => !key.unavailable)?.key.id ?? '');
        setPairs({});
      }} disabled={Boolean(seed.targetColumnId)}>
        <option value="">테이블 선택</option>
        {document.catalog.tables.map(table => <option key={table.id} value={table.id}>{label(table)}</option>)}
      </select></label>
      <label>참조 후보키<select value={chosen} onChange={event => setChosen(event.target.value)} required>
        <option value="">후보키 선택</option>
        {eligible.map(item => <option key={item.key.id} value={item.key.id}>{item.name || '(이름 없음)'}</option>)}
      </select></label>
      {candidates.filter(item => item.unavailable).map(item => <p key={item.key.id}>{item.name} · {item.unavailable}</p>)}
      {target && !eligible.length && <p role="alert">참조할 수 있는 후보키가 없습니다.</p>}
      {targetOrder.map((targetColumnId, index) => <label key={targetColumnId}>
        {index + 1}. {label(targetColumns.find(item => item.id === targetColumnId) ?? { physicalName: targetColumnId })}에 대응할 원본 컬럼
        <select required value={pairs[targetColumnId] ?? ''} onChange={event => setPairs({ ...pairs, [targetColumnId]: event.target.value })}>
          <option value="">컬럼 선택</option>
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
    </Form>
  </Modal>;
}
