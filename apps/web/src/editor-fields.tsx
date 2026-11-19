import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Catalog, ErdDocument, SqlExpression } from '@erd/model';

export type Column = Catalog['columns'][number];
export type Table = Catalog['tables'][number];
export type View = ErdDocument['views'][number];
export type Named = { physicalName: string; logicalName?: string; description?: string };
export const id = () => crypto.randomUUID();
export const label = (value: Named) => value.physicalName || '(이름 없음)';
export const field = (form: FormData, key: string) => String(form.get(key) ?? '');
export const secondaryName = (value: Named, mode: View['nameDisplay']) =>
  mode === 'both' && value.logicalName !== value.physicalName ? value.logicalName : undefined;
export function viewLabel(value: Named, mode: View['nameDisplay']) {
  const secondary = secondaryName(value, mode);
  if (secondary) return label(value) + ' · ' + secondary;
  return (mode === 'logical' && value.logicalName) || label(value);
}

export function ViewNameOptions() {
  return <><option value="both">전체 보기</option><option value="logical">논리명</option><option value="physical">물리명</option></>;
}
export const viewColumnIds = (table: Table, instance: View['instances'][number]) =>
  instance.collapsed ? [] : instance.visibleColumnIds ?? table.columnIds;

export function named(form: FormData): Named {
  return { physicalName: field(form, 'physicalName'), logicalName: field(form, 'logicalName') || undefined,
    description: field(form, 'description') || undefined };
}

export function NameFields({ value }: { value: Named }) {
  return <>
    <label>물리명<input name="physicalName" defaultValue={value.physicalName} /></label>
    <label>논리명<input name="logicalName" defaultValue={value.logicalName} /></label>
    <label>설명<textarea name="description" defaultValue={value.description} /></label>
  </>;
}

export const EditorReadOnly = createContext(false);

export function Form({ children, submit, button = '적용', disabled = false, cancel }: {
  children: ReactNode; submit(form: FormData): void; button?: string; disabled?: boolean; cancel?(): void;
}) {
  const readOnly = useContext(EditorReadOnly);
  const handle = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!readOnly && !disabled) submit(new FormData(event.currentTarget));
  };
  return <form onSubmit={handle}>
    <fieldset disabled={disabled || readOnly}>{children}
      <div className="actions"><button type="submit">{button}</button><button type={cancel ? "button" : "reset"} onClick={cancel}>입력 취소</button></div>
    </fieldset>
  </form>;
}

export function Modal({ children, title, close, className }: { children: ReactNode; title: string; close(): void; className?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    const previous = document.activeElement;
    element?.showModal();
    return () => {
      element?.close();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);
  return createPortal(<dialog ref={dialog} aria-label={title} className={className} onCancel={event => { event.preventDefault(); close(); }}>
    <header><h2>{title}</h2><button type="button" aria-label="닫기" onClick={close}>×</button></header>
    {children}
  </dialog>, document.body);
}

export function columnsOf(document: ErdDocument, tableId: string) {
  const table = document.catalog.tables.find(item => item.id === tableId);
  const columns = new Map(document.catalog.columns.map(column => [column.id, column]));
  return (table?.columnIds ?? []).flatMap(id => {
    const column = columns.get(id);
    return column ? [column] : [];
  });
}

export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const result = [...items];
  const [item] = result.splice(from, 1);
  result.splice(to, 0, item);
  return result;
}

export function OrderedItems({ title, items, change }: {
  title: string; items: Array<{ key: string; content: ReactNode }>;
  change(from: number, to: number | null): void;
}) {
  return <ol aria-label={title} className="ordered">
    {items.map(({ key, content }, index) => <li key={key}>
      {content}
      <div className="actions">
        <button type="button" aria-label={`${title} ${index + 1} 위로`} disabled={index === 0} onClick={() => change(index, index - 1)}>↑</button>
        <button type="button" aria-label={`${title} ${index + 1} 아래로`} disabled={index === items.length - 1} onClick={() => change(index, index + 1)}>↓</button>
        <button type="button" aria-label={`${title} ${index + 1} 제거`} onClick={() => change(index, null)}>×</button>
      </div>
    </li>)}
  </ol>;
}

export function OrderedColumns({ columns, value, set }: { columns: Column[]; value: string[]; set(value: string[]): void }) {
  const [adding, setAdding] = useState('');
  return <>
    <OrderedItems title="키 컬럼" items={value.map(id => ({ key: id, content: label(columns.find(item => item.id === id) ?? { physicalName: id }) }))}
      change={(from, to) => set(to === null ? value.filter((_, index) => index !== from) : moveItem(value, from, to))} />
    <div className="actions">
      <label>추가할 키 컬럼<select value={adding} onChange={event => setAdding(event.target.value)}>
        <option value="">컬럼 선택</option>
        {columns.filter(column => !value.includes(column.id)).map(column => <option key={column.id} value={column.id}>{label(column)}</option>)}
      </select></label>
      <button type="button" disabled={!adding} onClick={() => { set([...value, adding]); setAdding(''); }}>키 컬럼 추가</button>
    </div>
  </>;
}

export function sqlExpression(document: ErdDocument, sql: string, previous?: SqlExpression): SqlExpression {
  // Textareas normalize line endings even if the user leaves the field untouched.
  if (previous && previous.sql.replace(/\r\n?/g, '\n') === sql.replace(/\r\n?/g, '\n')) return previous;
  return { ...document.target, sql };
}

export function putView(view: View) {
  return { kind: 'put-view', view } as const;
}

export function emptyView(name: string): View {
  return { id: id(), name, instances: [], groups: [], notes: [] };
}

export function duplicateView(view: View): View {
  const groupIds = new Map(view.groups.map(group => [group.id, id()]));
  const groupFor = (groupId?: string) => groupId ? groupIds.get(groupId) : undefined;
  return {
    ...view, id: id(), name: view.name + ' 복제',
    instances: view.instances.map(item => ({ ...item, id: id(), groupId: groupFor(item.groupId) })),
    groups: view.groups.map(group => ({ ...group, id: groupIds.get(group.id) ?? id() })),
    notes: view.notes.map(item => ({ ...item, id: id(), groupId: groupFor(item.groupId) })),
  };
}

export function placement(view: View, tableId: string) {
  const n = view.instances.length;
  return { id: id(), tableId, x: (n % 4) * 240, y: Math.floor(n / 4) * 260 };
}
