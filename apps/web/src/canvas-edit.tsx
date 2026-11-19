import { createContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DocumentCommand, ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { Icon } from './editor-controls.js';
import { field, id, label, putView } from './editor-fields.js';
import type { Column, Table, View } from './editor-fields.js';
import { availableName, columnTypeLabel, putColumn, schemaRelationNames, validPhysicalName } from './schema-edits.js';

export const dragType = { newTable: 'application/x-herd-new-table', table: 'application/x-herd-table', column: 'application/x-herd-column' };
export type QuickRun = (command: DocumentCommand, report?: (message: string) => void) => boolean;
export type QuickEdit = {
  instanceId: string;
  field: 'table' | 'name' | 'type';
  columnId?: string;
};
export const CanvasEditing = createContext<{
  activeId?: string;
  edit?: QuickEdit;
  form?: ReactNode;
  change?(edit: QuickEdit): void;
  attributes?(instanceId: string): void;
  link?(instanceId: string): void;
  reorder?(instanceId: string, columnId: string, targetId: string, after: boolean): void;
}>({});

function QuickForm({ children, title, initialFocus = 'name', cancel, submit }: {
  children: ReactNode; title: string; initialFocus?: string; cancel(): void;
  submit(form: FormData, report: (error: string) => void): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const root = form.current;
    const previous = document.activeElement;
    const input = root?.querySelector<HTMLInputElement>('input[name="' + initialFocus + '"]');
    input?.focus({ preventScroll: true });
    input?.select();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected &&
        (document.activeElement === document.body || root?.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [initialFocus]);
  return <form ref={form} className="quick-form nodrag nopan nowheel" aria-label={title}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement &&
        (event.target.type === 'text' || event.target.type === 'checkbox')) {
        event.preventDefault();
        event.currentTarget.requestSubmit();
      }
    }} onSubmit={event => {
      event.preventDefault();
      if (composing.current) return;
      setError('');
      submit(new FormData(event.currentTarget), setError);
    }}>
    <p className="quick-title">{title}</p>
    {children}
    {error && <p className="quick-error" role="alert">{error}</p>}
    <div className="actions">
      <button type="submit" className="primary"><Icon name="check" />적용</button>
      <button type="button" className="quiet" onClick={cancel}>취소</button>
    </div>
  </form>;
}

export function QuickTableForm({ document, table, logical, cancel, apply }: {
  document: ErdDocument; table?: Table; logical?: boolean; cancel(): void;
  apply(table: Table, report: (message: string) => void): void;
}) {
  const namespaces = document.catalog.namespaces;
  const nameField = logical ? 'logicalName' : 'physicalName';
  return <QuickForm title={table ? '테이블 이름 편집' : '새 테이블'} cancel={cancel} submit={(form, report) => {
    const name = field(form, 'name');
    const namespaceId = table?.namespaceId ?? (field(form, 'namespace') || namespaces[0]?.id);
    if (!namespaceId) return report('네임스페이스를 먼저 추가하세요.');
    if (!logical && !validPhysicalName(name)) return report('물리명은 UTF-8 기준 1~63바이트여야 합니다.');
    if (!logical && name !== table?.physicalName &&
      (schemaRelationNames(document, namespaceId).has(name) ||
       document.catalog.enums.some(item => item.namespaceId === namespaceId && item.physicalName === name))) {
      return report('이 스키마에 이미 같은 이름의 객체가 있습니다.');
    }
    const next = table ?? { id: id(), namespaceId, physicalName: '', columnIds: [] };
    const value = logical && !name.trim() ? undefined : name;
    if (table && value === table[nameField]) cancel();
    else apply({ ...next, [nameField]: value }, report);
  }}>
    <label>{logical ? '논리명' : '물리명'}<input name="name" defaultValue={table?.[nameField]} required={!logical} spellCheck={false} /></label>
    {!table && namespaces.length > 1 && <label>스키마<select name="namespace" defaultValue={namespaces.find(item => item.physicalName === 'public')?.id}>
      {namespaces.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
    </select></label>}
  </QuickForm>;
}

export function QuickColumnForm({ document, table, column, dialect, logical, focus, run, view, instance, cancel, done }: {
  document: ErdDocument; table: Table; column?: Column; dialect: EditorDialect; logical: boolean; focus: 'name' | 'type';
  view: View; instance: View['instances'][number];
  run: QuickRun; cancel(): void; done(columnId: string): void;
}) {
  const list = useId();
  const type = column?.type ?? dialect.defaultType;
  const enumNames = new Map(document.catalog.enums.map(item => [item.id, item.physicalName]));
  const typeText = columnTypeLabel(type, enumNames);
  const native = !column?.identity && type.reference.kind === 'native' && (!type.reference.namespace || type.reference.namespace === 'pg_catalog');
  const choices = dialect.types(document.target);
  const pk = document.catalog.constraints.find(key => key.kind === 'pk' && key.tableId === table.id);
  const primary = Boolean(column && pk?.kind === 'pk' && pk.columnIds.includes(column.id));
  const [addPrimary, setAddPrimary] = useState(false);
  const [nullable, setNullable] = useState(column?.nullable ?? true);
  const nameField = logical && column ? 'logicalName' : 'physicalName';
  return <QuickForm title={column ? '컬럼 편집' : '새 컬럼'} initialFocus={focus === 'type' && native ? 'type' : 'name'}
    cancel={cancel} submit={(form, report) => {
      const name = field(form, 'name');
      if (nameField === 'physicalName') {
        if (!validPhysicalName(name)) return report('물리명은 UTF-8 기준 1~63바이트여야 합니다.');
        if (document.catalog.columns.some(item => item.tableId === table.id && item.id !== column?.id && item.physicalName === name)) {
          return report('이 테이블에 이미 같은 이름의 컬럼이 있습니다.');
        }
      }
      const input = field(form, 'type').trim();
      let descriptor = type;
      if (native && input !== typeText) {
        const match = /^([a-z][a-z0-9 ]*)(?:\(\s*(-?\d+(?:\s*,\s*-?\d+)*)\s*\))?((?:\s*\[\])*)$/i.exec(input);
        const name = match?.[1].trim().replace(/\s+/g, ' ').toLowerCase();
        if (!match || !name || !choices.includes(name)) return report('PostgreSQL 자료형을 입력하세요. 예: varchar(255), numeric(12, 2), integer[]');
        descriptor = { reference: { kind: 'native', name }, arguments: match[2]?.split(',').map(Number) ?? [],
          arrayDimensions: (match[3].match(/\[\]/g) ?? []).length };
        const problem = dialect.typeProblem(descriptor);
        if (problem) return report(problem);
      }
      const next: Column = {
        ...column, id: column?.id ?? id(), tableId: table.id, type: descriptor,
        physicalName: column?.physicalName ?? name, nullable: primary ? column?.nullable ?? false : !addPrimary && nullable,
        [nameField]: nameField === 'logicalName' && !name.trim() ? undefined : name,
      };
      const index = column ? table.columnIds.indexOf(column.id) : table.columnIds.length;
      if (column && !addPrimary && next[nameField] === column[nameField] && next.nullable === column.nullable && descriptor === type) {
        done(column.id);
        return;
      }
      const commands = [putColumn(table, next, index)];
      if (!column && (instance.collapsed || instance.visibleColumnIds)) commands.push(putView({
        ...view, instances: view.instances.map(item => item.id !== instance.id ? item : {
          ...item, collapsed: false, visibleColumnIds: item.visibleColumnIds && [...item.visibleColumnIds, next.id],
        }),
      }));
      if (addPrimary && !pk) {
        const names = schemaRelationNames(document, table.namespaceId);
        for (const key of document.catalog.constraints) if (key.tableId === table.id) names.add(key.physicalName);
        commands.push({ kind: 'put-catalog', collection: 'constraints', value: {
          id: id(), kind: 'pk', tableId: table.id, columnIds: [next.id], physicalName: availableName(table.physicalName + '_pkey', names),
        } });
      }
      if (run({ kind: 'batch', commands }, report)) done(next.id);
    }}>
    <label>{nameField === 'logicalName' ? '논리명' : '물리명'}<input name="name" defaultValue={column?.[nameField]}
      required={nameField === 'physicalName'} spellCheck={false} /></label>
    <label>자료형<input name="type" defaultValue={typeText} list={native ? list : undefined} readOnly={!native} required spellCheck={false} /></label>
    {native && <datalist id={list}>{choices.map(choice => <option key={choice} value={choice} />)}</datalist>}
    {!pk && <label className="checkbox"><input type="checkbox" checked={addPrimary}
      onChange={event => setAddPrimary(event.target.checked)} />기본키</label>}
    <label className="checkbox"><input type="checkbox" checked={!primary && !addPrimary && nullable}
      onChange={event => setNullable(event.target.checked)} disabled={primary || addPrimary} />NULL 허용</label>
  </QuickForm>;
}
