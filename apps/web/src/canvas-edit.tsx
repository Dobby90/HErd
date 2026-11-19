import { createContext, useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useReactFlow } from '@xyflow/react';
import type { ResizeParams, XYPosition } from '@xyflow/react';
import type { DocumentCommand, ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { Icon } from './editor-controls.js';
import { annotationColor, AnnotationColorField, field, id, label, putView, sqlExpression } from './editor-fields.js';
import type { Column, Named, Table, View } from './editor-fields.js';
import { availableName, columnTypeLabel, putColumn, schemaRelationNames, validPhysicalName } from './schema-edits.js';

export const dragType = { newTable: 'application/x-herd-new-table', table: 'application/x-herd-table', column: 'application/x-herd-column' };
export type QuickRun = (command: DocumentCommand, report?: (message: string) => void) => boolean;
export type QuickEdit = {
  instanceId: string;
  field: 'table' | 'name' | 'type';
  columnId?: string;
};
export type QuickAnnotationEdit = { instanceId: string; field: 'group' | 'note'; screen: XYPosition };
export const CanvasEditing = createContext<{
  activeId?: string;
  edit?: QuickEdit;
  form?: ReactNode;
  change?(edit: QuickEdit): void;
  toggleColumns?(instanceId: string): void;
  changeAnnotation?(edit: QuickAnnotationEdit): void;
  resizeGroup?(id: string, bounds: ResizeParams): void;
  remove?(id: string): void;
  link?(instanceId: string): void;
  reorder?(instanceId: string, columnId: string, targetId: string, after: boolean): void;
}>({});

export function canvasFormPosition(bounds: DOMRectReadOnly, x: number, y: number): XYPosition {
  return { x: Math.min(Math.max(x - bounds.left, 8), Math.max(bounds.width - 258, 8)),
    y: Math.min(Math.max(y - bounds.top, 8), Math.max(bounds.height - 310, 8)) };
}

function QuickForm({ children, title, initialFocus = 'physicalName', cancel, submit }: {
  children: ReactNode; title: string; initialFocus?: string; cancel(): void;
  submit(form: FormData, report: (error: string) => void): void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const composing = useRef(false);
  const [error, setError] = useState('');
  const { getViewport, setViewport } = useReactFlow();
  useEffect(() => {
    const root = form.current;
    const previous = document.activeElement;
    const input = root?.querySelector<HTMLInputElement | HTMLTextAreaElement>(':is(input, textarea)[name="' + initialFocus + '"]');
    input?.focus({ preventScroll: true });
    input?.select();
    const frame = requestAnimationFrame(() => {
      const canvas = root?.closest('.canvas')?.getBoundingClientRect();
      const box = root?.getBoundingClientRect();
      if (!canvas || !box || !root?.closest('.canvas-table')) return;
      const shift = (start: number, end: number, min: number, max: number) =>
        start < min ? min - start : end > max ? Math.max(min - start, max - end) : 0;
      const x = shift(box.left, box.right, canvas.left + 8, canvas.right - 8);
      const y = shift(box.top, box.bottom, canvas.top + 8, canvas.bottom - 8);
      if (x || y) {
        const viewport = getViewport();
        void setViewport({ ...viewport, x: viewport.x + x, y: viewport.y + y });
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      if (previous instanceof HTMLElement && previous.isConnected &&
        (document.activeElement === document.body || root?.contains(document.activeElement))) previous.focus({ preventScroll: true });
    };
  }, [getViewport, initialFocus, setViewport]);
  return <form ref={form} className="quick-form nodrag nopan nowheel" aria-label={title}
    onClick={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}
    onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }}
    onKeyDown={event => {
      event.stopPropagation();
      if (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === 'Escape') { event.preventDefault(); cancel(); }
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey || (event.target instanceof HTMLInputElement &&
        (event.target.type === 'text' || event.target.type === 'checkbox')))) {
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

export function QuickAnnotationForm({ view, annotation, run, close }: {
  view: View; annotation: View['groups'][number] | View['notes'][number]; run: QuickRun; close(): void;
}) {
  const group = 'name' in annotation;
  const name = group ? 'name' : 'text';
  return <QuickForm title={group ? '그룹 편집' : '메모 편집'} initialFocus={name} cancel={close} submit={(form, report) => {
    const content = field(form, name);
    if (group && !content.trim()) return report('그룹 이름을 입력하세요.');
    if (content.includes('\0')) return report('텍스트에 NUL 문자를 사용할 수 없습니다.');
    const color = annotationColor(form);
    const next = group ? { ...view, groups: view.groups.map(item => item.id === annotation.id ? { ...item, name: content, color } : item) }
      : { ...view, notes: view.notes.map(item => item.id === annotation.id ? { ...item, text: content, color } : item) };
    if (run(putView(next), report)) close();
  }}>
    {group ? <label>그룹 이름<input name="name" defaultValue={annotation.name} required /></label>
      : <label>메모 텍스트<textarea name="text" defaultValue={annotation.text} rows={3} /></label>}
    <AnnotationColorField value={annotation.color} kind={group ? 'group' : 'note'} />
  </QuickForm>;
}

function CanvasNameFields({ value, mode }: { value?: Named; mode: View['nameDisplay'] }) {
  return <>
    {(!value || mode !== 'logical') && <label>물리명<input name="physicalName" defaultValue={value?.physicalName} required spellCheck={false} /></label>}
    {(mode === 'logical' || mode === 'both') && <label>논리명<input name="logicalName" defaultValue={value?.logicalName} /></label>}
  </>;
}

function canvasNames(form: FormData, previous?: Named): Named {
  const logicalName = field(form, 'logicalName');
  return {
    physicalName: form.has('physicalName') ? field(form, 'physicalName') : previous?.physicalName ?? '',
    logicalName: form.has('logicalName') ? logicalName.trim() ? logicalName : undefined : previous?.logicalName,
    description: field(form, 'description') || undefined,
  };
}

function CommentField({ value }: { value?: string }) {
  return <label>코멘트<textarea name="description" rows={2} defaultValue={value} /></label>;
}

function sameNames(previous: Named, next: Named) {
  return previous.physicalName === next.physicalName && previous.logicalName === next.logicalName && previous.description === next.description;
}

export function QuickTableForm({ document, table, mode, cancel, apply }: {
  document: ErdDocument; table?: Table; mode?: View['nameDisplay']; cancel(): void;
  apply(table: Table, report: (message: string) => void): void;
}) {
  const namespaces = document.catalog.namespaces;
  return <QuickForm title={table ? '테이블 이름 편집' : '새 테이블'} initialFocus={table && mode === 'logical' ? 'logicalName' : 'physicalName'}
    cancel={cancel} submit={(form, report) => {
    const names = canvasNames(form, table);
    const name = names.physicalName;
    const namespaceId = table?.namespaceId ?? (field(form, 'namespace') || namespaces[0]?.id);
    if (!namespaceId) return report('스키마를 먼저 추가하세요.');
    if (names.description?.includes('\0')) return report('코멘트에 NUL 문자를 사용할 수 없습니다.');
    if (name !== table?.physicalName) {
      if (!validPhysicalName(name)) return report('물리명은 UTF-8 기준 1~63바이트여야 합니다.');
      if (schemaRelationNames(document, namespaceId).has(name) ||
        document.catalog.enums.some(item => item.namespaceId === namespaceId && item.physicalName === name)) {
        return report('이 스키마에 이미 같은 이름의 객체가 있습니다.');
      }
    }
    if (table && sameNames(table, names)) cancel();
    else apply({ ...(table ?? { id: id(), namespaceId, columnIds: [] }), ...names }, report);
  }}>
    <CanvasNameFields value={table} mode={mode} />
    {!table && namespaces.length > 1 && <label>스키마<select name="namespace" defaultValue={namespaces.find(item => item.physicalName === 'public')?.id}>
      {namespaces.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
    </select></label>}
    <CommentField value={table?.description} />
  </QuickForm>;
}

export function QuickColumnForm({ document, table, column, dialect, mode, focus, run, view, instance, cancel, done }: {
  document: ErdDocument; table: Table; column?: Column; dialect: EditorDialect; mode?: View['nameDisplay']; focus: 'name' | 'type';
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
  const nameFocus = mode === 'logical' && column ? 'logicalName' : 'physicalName';
  return <QuickForm title={column ? '컬럼 편집' : '새 컬럼'} initialFocus={focus === 'type' && native ? 'type' : nameFocus}
    cancel={cancel} submit={(form, report) => {
      const names = canvasNames(form, column);
      const name = names.physicalName;
      if (name !== column?.physicalName) {
        if (!validPhysicalName(name)) return report('물리명은 UTF-8 기준 1~63바이트여야 합니다.');
        if (document.catalog.columns.some(item => item.tableId === table.id && item.id !== column?.id && item.physicalName === name)) {
          return report('이 테이블에 이미 같은 이름의 컬럼이 있습니다.');
        }
      }
      const defaultSql = field(form, 'default');
      if (names.description?.includes('\0') || defaultSql.includes('\0')) return report('코멘트와 기본값에 NUL 문자를 사용할 수 없습니다.');
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
        ...column, ...names, id: column?.id ?? id(), tableId: table.id, type: descriptor,
        nullable: primary ? column?.nullable ?? false : !addPrimary && nullable,
        default: column?.identity ? column.default : defaultSql.trim() ? sqlExpression(document, defaultSql, column?.default) : undefined,
      };
      const index = column ? table.columnIds.indexOf(column.id) : table.columnIds.length;
      if (column && !addPrimary && sameNames(column, next) && next.nullable === column.nullable && descriptor === type && next.default === column.default) {
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
    <CanvasNameFields value={column} mode={mode} />
    <label>자료형<input name="type" defaultValue={typeText} list={native ? list : undefined} readOnly={!native} required spellCheck={false} /></label>
    {native && <datalist id={list}>{choices.map(choice => <option key={choice} value={choice} />)}</datalist>}
    {!pk && <label className="checkbox"><input type="checkbox" checked={addPrimary}
      onChange={event => setAddPrimary(event.target.checked)} />기본키</label>}
    <label className="checkbox"><input type="checkbox" checked={!primary && !addPrimary && nullable}
      onChange={event => setNullable(event.target.checked)} disabled={primary || addPrimary} />NULL 허용</label>
    {!column?.identity && <label>기본값 (DEFAULT SQL)<textarea name="default" rows={2} defaultValue={column?.default?.sql}
      spellCheck={false} placeholder="예: 0, '대기', CURRENT_TIMESTAMP" /></label>}
    <CommentField value={column?.description} />
  </QuickForm>;
}
