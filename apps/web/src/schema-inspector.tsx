import { useState } from 'react';
import type { Catalog, DocumentCommand, ErdDocument } from '@erd/model';
import { deletionImpact, documentExpressions } from '@erd/model';
import { Icon } from './editor-controls.js';
import type { EditorDialect } from '@erd/sql-contract';
import { columnsOf, field, Form, id, label, Modal, moveItem, named, NameFields, OrderedColumns, OrderedItems, sqlExpression } from './editor-fields.js';
import { indexExpressionLabel } from './editor-diagnostics.js';
import type { Column, Table } from './editor-fields.js';
import { putColumn } from './schema-edits.js';

type Constraint = Catalog['constraints'][number];
type Index = Catalog['indexes'][number];
type KeyPart = Index['keys'][number];
type Run = (command: DocumentCommand) => boolean;
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
  const foreignKey = catalog.constraints.some(item => item.id === objectId && item.kind === 'fk');
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
        <p>{table ? '테이블 정의와 모든 다이어그램의 배치를 삭제합니다.' : column ? '컬럼 정의와 연결된 스키마 객체를 삭제합니다.'
          : foreignKey ? '외래 키 제약을 삭제합니다. 연결한 컬럼은 보존됩니다.' : '선택한 스키마 객체를 삭제합니다.'}</p>
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
    <label>DEFAULT SQL<textarea name="default" data-diagnostic-field="DEFAULT SQL" defaultValue={column?.default?.sql} /></label>
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
    {kind === 'check' ? <label>CHECK SQL<textarea name="sql" data-diagnostic-field="CHECK SQL" defaultValue={prior?.sql} required /></label> :
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
        <textarea name={id} aria-label={indexExpressionLabel(index)} data-diagnostic-field={indexExpressionLabel(index)}
          defaultValue={part.expression.sql} required />,
    }))} change={(from, to) => setParts(to === null ? parts.filter((_, index) => index !== from) : moveItem(parts, from, to))} />
    <div className="actions">
      <label>인덱스 컬럼<select value={adding} onChange={event => setAdding(event.target.value)}>
        <option value="">컬럼 선택</option>
        {columns.map(column => <option key={column.id} value={column.id}>{label(column)}</option>)}
      </select></label>
      <button type="button" disabled={!adding} onClick={() => { add({ kind: 'column', columnId: adding }); setAdding(''); }}>인덱스 컬럼 추가</button>
      <button type="button" onClick={() => add({ kind: 'expression', expression: { ...document.target, sql: '' } })}>SQL 식 추가</button>
    </div>
    <label>부분 인덱스 조건 SQL<textarea name="predicate" data-diagnostic-field="부분 인덱스 조건 SQL" defaultValue={existing?.predicate?.sql} /></label>
  </Form>;
}
