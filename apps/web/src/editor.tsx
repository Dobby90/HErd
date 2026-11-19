import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { XYPosition } from '@xyflow/react';
import { columnBadgesById, createDocument, deletionImpact, isIdentifyingForeignKey, primaryColumnsByTable, validateDocumentStructure, viewNameDisplaySchema } from '@erd/model';
import type { Catalog, DocumentCommand, ErdDocument, ModelDiagnostic, SqlTarget } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { postgresqlEditor } from '@erd/dialect-postgresql/ui';
import { EditorCanvas } from './editor-canvas.js';
import type { CanvasFocus, CanvasPosition, LayoutSizes } from './editor-canvas.js';
import { CanvasEditing, dragType, QuickColumnForm, QuickTableForm } from './canvas-edit.js';
import type { QuickEdit, QuickRun } from './canvas-edit.js';
import { ActionMenu, AppVersion, ColumnBadges, Icon } from './editor-controls.js';
import { ThemeToggle } from './theme.js';
import { columnsOf, duplicateView, EditorReadOnly, emptyView, field, Form, id, label, Modal, named, NameFields, placement, putView, ViewNameOptions } from './editor-fields.js';
import type { Table, View } from './editor-fields.js';
import { ImageExport } from './image-export.js';
import { ColumnForm, DeleteSchema, ForeignKeyForm, IndexForm, KeyForm } from './schema-inspector.js';
import type { FkDialog, PhysicalRelation } from './schema-inspector.js';
import { arrangeView } from './view-grid.js';

const dialects = new Map<string, EditorDialect>([[postgresqlEditor.metadata.id, postgresqlEditor]]);
export const editorTargets = [...dialects.values()].flatMap(dialect => dialect.metadata.profiles.filter(profile => profile.status === 'certified')
  .map(profile => ({ dialectId: dialect.metadata.id, engineVersion: profile.version, name: dialect.metadata.name + ' ' + profile.version })));
type Run = (command: DocumentCommand) => boolean;
const tableTabs = { columns: '컬럼', constraints: '제약', indexes: '인덱스', settings: '이름·배치' } as const;
type TableTab = keyof typeof tableTabs;
const tabOrder = Object.keys(tableTabs) as TableTab[];
const mobilePanes = { canvas: '다이어그램', schema: '스키마', properties: '속성' } as const;
type MobilePane = keyof typeof mobilePanes;
type LogicalSeed = Pick<ErdDocument['relationships'][number], 'sourceTableId' | 'targetTableId'>;
type CanvasTool = { kind: 'place'; at?: CanvasPosition } | {
  kind: 'relation'; mode: PhysicalRelation | 'logical'; origin?: View['instances'][number]; problem?: string;
};
type Inspector = (
  | { type: 'object'; id: string; tab?: TableTab }
  | { type: 'namespace' | 'table'; namespaceId?: string }
  | { type: 'column' | 'pk' | 'unique' | 'check' | 'index'; tableId: string; id?: string }
  | { type: 'relationship'; id?: string }
) & { instanceId?: string };

function TableDetails({ name, namespace, logicalName, initialTab, panels }: {
  name: string; namespace?: string; logicalName?: string; initialTab: TableTab; panels: Record<TableTab, ReactNode>;
}) {
  const [tab, setTab] = useState(initialTab);
  const tabsId = useId();
  return <div className="table-inspector">
    <div className="inspector-object">
      <span className="object-icon"><Icon name="table" /></span>
      <div>
        {namespace && <p className="object-namespace">{namespace}</p>}
        <h3>{name}</h3>
        {logicalName && logicalName !== name && <p className="muted">{logicalName}</p>}
      </div>
    </div>
    <div className="inspector-tabs" role="tablist" aria-label="테이블 속성" onKeyDown={event => {
      const index = tabOrder.indexOf(tab);
      const positions: Record<string, number> = { ArrowLeft: (index + tabOrder.length - 1) % tabOrder.length,
        ArrowRight: (index + 1) % tabOrder.length, Home: 0, End: tabOrder.length - 1 };
      const next = Object.hasOwn(positions, event.key) ? positions[event.key] : undefined;
      if (next === undefined) return;
      event.preventDefault();
      setTab(tabOrder[next]);
      event.currentTarget.querySelectorAll('button')[next]?.focus();
    }}>
      {tabOrder.map(key => <button key={key} type="button" role="tab" id={`${tabsId}-${key}`}
        aria-selected={key === tab} aria-controls={`${tabsId}-panel`} tabIndex={key === tab ? 0 : -1}
        onClick={() => setTab(key)}>{tableTabs[key]}</button>)}
    </div>
    <div className="inspector-tab-body" role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${tab}`} tabIndex={0}>{panels[tab]}</div>
  </div>;
}

function ViewSettings({ view, run, choose, close }: { view: View; run: Run; choose(id: string): void; close(): void }) {
  return <Modal title="뷰 설정" close={close}>
    <Form button="뷰 이름 적용" submit={form => { if (run(putView({ ...view, name: field(form, 'name') }))) close(); }}>
      <label>뷰 이름<input name="name" defaultValue={view.name} required /></label>
    </Form>
    <div className="actions">
      <button type="button" onClick={() => {
        const copy = duplicateView(view);
        if (run(putView(copy))) { choose(copy.id); close(); }
      }}>뷰 복제</button>
      <button type="button" className="danger" onClick={() => {
        if (window.confirm('이 뷰와 배치를 삭제하시겠습니까?') && run({ kind: 'remove-view', viewId: view.id })) {
          choose('');
          close();
        }
      }}>뷰 삭제</button>
    </div>
  </Modal>;
}

function DeleteViewObject({ view, object, run, close, removed }: {
  view: View; object: View['groups'][number] | View['notes'][number]; run: Run; close(): void; removed(): void;
}) {
  const group = 'name' in object ? object : undefined;
  const action = group ? '그룹 삭제' : '메모 삭제';
  return <Modal title={action} close={close}>
    <section className="deletion-preview">
      <p>{group ? `'${group.name}' 그룹을 삭제하면 포함된 테이블과 메모는 그룹에서 분리됩니다.` : '현재 뷰에서 이 메모를 삭제합니다.'}</p>
      <div className="actions">
        <button type="button" onClick={close}>취소</button>
        <button type="button" className="danger" onClick={() => {
          const next = group ? { ...view, groups: view.groups.filter(item => item.id !== group.id),
            instances: view.instances.map(item => item.groupId === group.id ? { ...item, groupId: undefined } : item),
            notes: view.notes.map(item => item.groupId === group.id ? { ...item, groupId: undefined } : item) }
            : { ...view, notes: view.notes.filter(item => item.id !== object.id) };
          if (run(putView(next))) { removed(); close(); }
        }}>{action}</button>
      </div>
    </section>
  </Modal>;
}

function GroupField({ view, groupId }: { view: View; groupId?: string }) {
  return <label>그룹<select name="group" defaultValue={groupId ?? ''}><option value="">그룹 없음</option>
    {view.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
  </select></label>;
}

function RelationshipForm({ document, relation, seed, run, close }: {
  document: ErdDocument; relation?: ErdDocument['relationships'][number]; seed?: LogicalSeed; run: Run; close(): void;
}) {
  const endpoints = relation ?? seed;
  const defaultName = seed && [seed.sourceTableId, seed.targetTableId].map(id =>
    label(document.catalog.tables.find(table => table.id === id) ?? { physicalName: '' })).join(' → ');
  return <Form button="논리 관계 적용" cancel={close} submit={form => {
    const cardinality = (['one-to-one', 'one-to-many', 'many-to-many'] as const).find(item => item === field(form, 'cardinality'));
    if (!cardinality) return;
    if (run({ kind: 'put-relationship', value: {
      id: relation?.id ?? id(), name: field(form, 'name'), description: field(form, 'description') || undefined,
      sourceTableId: field(form, 'source'), targetTableId: field(form, 'target'), cardinality,
    } })) close();
  }}>
    <label>관계 이름<input name="name" defaultValue={relation?.name ?? defaultName} required /></label>
    <label>설명<textarea name="description" defaultValue={relation?.description} /></label>
    {(['source', 'target'] as const).map(key => <label key={key}>{key === 'source' ? '원본 테이블' : '대상 테이블'}
      <select name={key} defaultValue={key === 'source' ? endpoints?.sourceTableId : endpoints?.targetTableId} required>
        {document.catalog.tables.map(table => <option key={table.id} value={table.id}>{label(table)}</option>)}
      </select>
    </label>)}
    <label>관계 차수<select name="cardinality" defaultValue={relation?.cardinality ?? 'one-to-many'}>
      <option value="one-to-one">1:1</option><option value="one-to-many">1:N</option><option value="many-to-many">N:M</option>
    </select></label>
    {relation && <button type="button" onClick={() => {
      if (run({ kind: 'remove-relationship', id: relation.id })) close();
    }}>논리 관계 삭제</button>}
  </Form>;
}

function Properties({ document, view, dialect, selection, run, inspect, fk, remove, readOnly }: {
  document: ErdDocument; view?: View; dialect?: EditorDialect; selection: Inspector | null; run: Run;
  inspect(value: Inspector | null): void; fk(value: FkDialog): void; remove(id: string): void; readOnly: boolean;
}) {
  const badges = useMemo(() => columnBadgesById(document), [document]);
  if (!selection) return <div className="inspector-empty"><span className="object-icon"><Icon name="table" /></span>
    <p>스키마 또는 캔버스에서 객체를 선택하세요.</p></div>;
  const { catalog } = document;
  const selectedId = 'id' in selection ? selection.id : undefined;
  const instance = view?.instances.find(item => item.id === (selection.instanceId ?? selectedId));
  const note = view?.notes.find(item => item.id === selectedId);
  const group = view?.groups.find(item => item.id === selectedId);
  const relationship = document.relationships.find(item => item.id === selectedId);
  const namespace = catalog.namespaces.find(item => item.id === selectedId);
  const column = catalog.columns.find(item => item.id === selectedId);
  const constraint = catalog.constraints.find(item => item.id === selectedId);
  const index = catalog.indexes.find(item => item.id === selectedId);
  const tableId = 'tableId' in selection ? selection.tableId : instance?.tableId ?? column?.tableId ?? constraint?.tableId ?? index?.tableId ?? selectedId;
  const table = catalog.tables.find(item => item.id === tableId);
  const tab: TableTab = index || selection.type === 'index' ? 'indexes'
    : constraint || selection.type === 'pk' || selection.type === 'unique' || selection.type === 'check' ? 'constraints' : 'columns';
  const close = () => inspect(table ? { type: 'object', id: instance?.id ?? table.id, tab } : null);
  const back = table && <button className="quiet inspector-back" type="button" onClick={close}>
    <Icon name="back" />{label(table)}</button>;
  const capability = dialect?.capabilities(document.target);
  const removeButton = !readOnly && selectedId && <button type="button" className="danger" onClick={() => remove(selectedId)}>스키마에서 실제 삭제</button>;

  if (note && view) return <>
    <h3>메모</h3>
    <Form key={JSON.stringify([note.id, note.text, note.groupId])} button="메모 적용" submit={form => run(putView({ ...view, notes: view.notes.map(item => item.id === note.id ?
      { ...item, text: field(form, 'text'), groupId: field(form, 'group') || undefined } : item) }))}>
      <label>메모 텍스트<textarea name="text" defaultValue={note.text} /></label><GroupField view={view} groupId={note.groupId} />
    </Form>
    {!readOnly && <button type="button" className="danger" onClick={() => remove(note.id)}><Icon name="trash" />메모 삭제</button>}
  </>;
  if (group && view) return <>
    <h3>그룹</h3>
    <Form key={JSON.stringify([group.id, group.name, group.size])} button="그룹 적용" submit={form => run(putView({ ...view, groups: view.groups.map(item => item.id === group.id ?
      { ...item, name: field(form, 'name'), size: { width: Number(field(form, 'width')), height: Number(field(form, 'height')) } } : item) }))}>
      <label>그룹 이름<input name="name" defaultValue={group.name} required /></label>
      <label>너비<input type="number" name="width" min="40" defaultValue={group.size?.width ?? 480} required /></label>
      <label>높이<input type="number" name="height" min="40" defaultValue={group.size?.height ?? 250} required /></label>
    </Form>
    {!readOnly && <button type="button" className="danger" onClick={() => remove(group.id)}><Icon name="trash" />그룹 삭제</button>}
  </>;
  if (relationship || selection.type === 'relationship') return <RelationshipForm key={JSON.stringify(relationship) ?? 'new'} document={document} relation={relationship} run={run} close={() => inspect(null)} />;
  if (namespace || selection.type === 'namespace') return <>
    <h3>{namespace ? '네임스페이스' : '새 네임스페이스'}</h3>
    <Form key={JSON.stringify(namespace) ?? 'new'} disabled={capability?.namespace.edit !== 'supported'}
      button={namespace ? '네임스페이스 적용' : '네임스페이스 만들기'} submit={form => {
        const value = { ...named(form), id: namespace?.id ?? id() };
        if (run({ kind: 'put-catalog', collection: 'namespaces', value })) inspect({ type: 'object', id: value.id });
      }}><NameFields value={namespace ?? { physicalName: '' }} /></Form>
    {namespace && removeButton}
  </>;
  if (table && dialect) {
    if (column || selection.type === 'column') return <>{back}<h3>{column ? '컬럼' : '새 컬럼'}</h3>
      <ColumnForm key={JSON.stringify([table, column])} document={document} table={table} column={column} dialect={dialect} run={run} close={close} />
      {column && removeButton}</>;
    if (constraint?.kind === 'fk') return <>{back}
      <h3>외래 키</h3><p>{label(constraint)}</p>
      <p className="muted">{isIdentifyingForeignKey(constraint, primaryColumnsByTable(document)) ? '식별 FK' : '비식별 FK'}</p>
      <p>{constraint.pairs.map(pair => {
        const source = catalog.columns.find(item => item.id === pair.sourceColumnId);
        const target = catalog.columns.find(item => item.id === pair.targetColumnId);
        return (source ? label(source) : pair.sourceColumnId) + ' → ' + (target ? label(target) : pair.targetColumnId);
      }).join(', ')}</p>
      <button type="button" disabled={readOnly} onClick={() => fk({
        tableId: table.id, targetTableId: constraint.targetTableId, existing: constraint,
      })}>외래 키 편집</button>{removeButton}</>;
    const keyKind = constraint?.kind ?? selection.type;
    if (keyKind === 'pk' || keyKind === 'unique' || keyKind === 'check') return <>{back}
      <h3>{keyKind.toUpperCase()} 제약</h3>
      <KeyForm key={JSON.stringify([table, constraint, keyKind])} document={document} table={table}
        kind={keyKind} existing={constraint} run={run} close={close} />{constraint && removeButton}</>;
    if (index || selection.type === 'index') return <>{back}<h3>인덱스</h3>
      <IndexForm key={JSON.stringify([table, index])} document={document} table={table} existing={index} run={run} close={close} />
      {index && removeButton}</>;
  }

  if (table || selection.type === 'table') {
    const settings = <Form key={JSON.stringify(table) ?? selection.type} button={table ? '테이블 적용' : '테이블 만들기'}
        cancel={table ? undefined : close}
        disabled={capability?.table.edit !== 'supported' || !catalog.namespaces.length} submit={form => {
          const value: Catalog['tables'][number] = {
            ...named(form), id: table?.id ?? id(), namespaceId: field(form, 'namespace'), columnIds: table?.columnIds ?? [],
          };
          const command: DocumentCommand = { kind: 'put-catalog', collection: 'tables', value };
          const actions: DocumentCommand[] = [command];
          if (view && !table) actions.push(putView({ ...view, instances: [...view.instances, placement(view, value.id)] }));
          if (run({ kind: 'batch', commands: actions })) inspect({ type: 'object', id: instance?.id ?? value.id,
            tab: table ? 'settings' : 'columns' });
        }}>
        <NameFields value={table ?? { physicalName: '' }} />
        <label>네임스페이스<select name="namespace" defaultValue={table?.namespaceId ?? (selection.type === 'table' ? selection.namespaceId : undefined)}>
          {catalog.namespaces.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
        </select></label>
      </Form>;
    if (!table) return <><h3>새 테이블</h3>{settings}</>;

    const columns = columnsOf(document, table.id);
    const constraints = catalog.constraints.filter(item => item.tableId === table.id);
    const indexes = catalog.indexes.filter(item => item.tableId === table.id);
    const open = (value: Inspector) => inspect({ ...value, instanceId: instance?.id });
    const openObject = (id: string) => open({ type: 'object', id });
    const namespaceName = catalog.namespaces.find(item => item.id === table.namespaceId)?.physicalName;
    return <TableDetails key={table.id} name={label(table)} namespace={namespaceName} logicalName={table.logicalName}
      initialTab={selection.type === 'object' ? selection.tab ?? 'columns' : 'columns'} panels={{
      columns: <>
        <div className="section-heading inspector-list-heading"><span className="muted">컬럼 {columns.length}개</span>
          {!readOnly && <button type="button" className="quiet accent" onClick={() => open({ type: 'column', tableId: table.id })}>
            <Icon name="plus" />컬럼 추가</button>}
        </div>
        {columns.length > 0 && <ul className="object-list inspector-list">{columns.map(item => {
          const reference = item.type.reference;
          const type = reference.kind === 'native' ? reference.name : catalog.enums.find(entry => entry.id === reference.enumId)?.physicalName ?? 'ENUM';
          const dimensions = item.type.arrayDimensions;
          const dataType = type + (dimensions === 0 ? '' : dimensions === 1 ? '[]' : `[] × ${dimensions}`);
          return <li key={item.id}><button type="button" aria-label={label(item)} aria-description={dataType} onClick={() => openObject(item.id)}>
            <Icon name="column" /><span className="inspector-item-name"><code>{label(item)}</code><small>{dataType}</small></span>
            <ColumnBadges values={badges.get(item.id) ?? []} /><Icon name="right" />
          </button></li>;
        })}</ul>}
      </>,
      constraints: <>
        {!readOnly && <div className="actions inspector-add-actions" role="group" aria-label="제약 추가">
          {(['pk', 'unique', 'check'] as const).map(type => <button key={type} type="button"
            onClick={() => open({ type, tableId: table.id })}>{type.toUpperCase()} 추가</button>)}
          <button type="button" disabled={!dialect} onClick={() => fk({ tableId: table.id })}>외래 키 추가</button>
        </div>}
        {constraints.length ? <ul className="object-list inspector-list">{constraints.map(item =>
          <li key={item.id}><button type="button" aria-label={`${item.kind.toUpperCase()} · ${label(item)}`} onClick={() => openObject(item.id)}>
            <span className="inspector-item-name"><code>{label(item)}</code><small>{item.kind.toUpperCase()}</small></span><Icon name="right" />
          </button></li>)}</ul> : <p className="muted">등록된 제약이 없습니다.</p>}
      </>,
      indexes: <>
        <div className="section-heading inspector-list-heading"><span className="muted">인덱스 {indexes.length}개</span>
          {!readOnly && <button type="button" className="quiet accent" onClick={() => open({ type: 'index', tableId: table.id })}>
            <Icon name="plus" />인덱스 추가</button>}
        </div>
        {indexes.length ? <ul className="object-list inspector-list">{indexes.map(item =>
          <li key={item.id}><button type="button" aria-label={`${item.unique ? 'UNIQUE INDEX' : 'INDEX'} · ${label(item)}`} onClick={() => openObject(item.id)}>
            <span className="inspector-item-name"><code>{label(item)}</code><small>{item.unique ? 'UNIQUE INDEX' : 'INDEX'}</small></span><Icon name="right" />
          </button></li>)}</ul> : <p className="muted">등록된 인덱스가 없습니다.</p>}
      </>,
      settings: <>
        <section className="inspector-section">
          <h4>테이블 정보</h4>
          {settings}
        </section>
        {!readOnly && view && instance && <section className="inspector-section">
          <h4>현재 뷰 배치</h4>
          <Form key={JSON.stringify(instance)} button="배치 적용" submit={form => run(putView({
            ...view, instances: view.instances.map(item => item.id === instance.id ? {
              ...item, groupId: field(form, 'group') || undefined, collapsed: form.has('collapsed'),
            } : item),
          }))}><GroupField view={view} groupId={instance.groupId} />
            <label className="checkbox"><input type="checkbox" name="collapsed" defaultChecked={instance.collapsed} />컬럼 접기</label>
          </Form>
          <button type="button" onClick={() => {
            run({ kind: 'remove-instance', viewId: view.id, instanceId: instance.id });
            inspect({ type: 'object', id: table.id, tab: 'settings' });
          }}>현재 뷰에서 제거</button>
        </section>}
        {!readOnly && view && !view.instances.some(item => item.tableId === table.id) && <button type="button" onClick={() => {
          const item = placement(view, table.id);
          if (run(putView({ ...view, instances: [...view.instances, item] }))) inspect({ type: 'object', id: item.id, tab: 'settings' });
        }}>현재 뷰에 배치</button>}
        {!readOnly && <section className="inspector-section">
          <button type="button" className="danger" onClick={() => remove(table.id)}><Icon name="trash" />스키마에서 테이블 삭제</button>
        </section>}
      </>,
    }} />;
  }
  return <p>선택한 객체를 사용할 수 없습니다.</p>;
}

type EditingSession = {
  document: ErdDocument;
  status: { text: string; error?: boolean };
  diagnostics: ModelDiagnostic[];
  canUndo: boolean;
  canRedo: boolean;
  run(command: DocumentCommand, guard?: (before: ErdDocument, after: ErdDocument) => ModelDiagnostic[]): boolean;
  step(direction: 'undo' | 'redo'): void;
};

export function createEditorDocument(name: string, target: SqlTarget) {
  return createDocument({
    id: id(), name, target, namespace: { id: id(), physicalName: 'public' },
    view: emptyView('기본 뷰'),
  }).document;
}

export function DocumentEditor({ session, readOnly = false, topActions, saveActions, exportAction, importAction, initialPlacement, verifyImage }: {
  session: EditingSession; readOnly?: boolean; topActions?: ReactNode; saveActions?: ReactNode; exportAction?(viewId: string | undefined): ReactNode;
  importAction?(viewId: string | undefined): ReactNode;
  initialPlacement?: CanvasFocus & { viewId: string };
  verifyImage?(): Promise<void>;
}) {
  const { document } = session;
  const [chosenView, chooseView] = useState(initialPlacement?.viewId ?? '');
  const [selection, inspect] = useState<Inspector | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('canvas');
  const [schemaCollapsed, setSchemaCollapsed] = useState(false);
  const mobileCanvasTab = useRef<HTMLButtonElement>(null);
  const mobilePanesId = useId();
  const [query, setQuery] = useState('');
  const [searchFocus, setSearchFocus] = useState<CanvasFocus | undefined>(initialPlacement);
  const [selectedInstances, setSelectedInstances] = useState<string[]>([]);
  const layoutSizes = useRef<LayoutSizes>(new Map());
  const [snap, setSnap] = useState(true);
  const [showMap, setShowMap] = useState(false);
  const mapId = useId();
  const [dialog, setDialog] = useState<'title' | 'view' | 'view-settings' | null>(null);
  const [fk, setFk] = useState<FkDialog | null>(null);
  const [logical, setLogical] = useState<LogicalSeed | ErdDocument['relationships'][number]>();
  const [tool, setTool] = useState<CanvasTool>();
  const [canvasMode, setCanvasMode] = useState<'select' | 'pan'>('select');
  const [quickEdit, setQuickEdit] = useState<QuickEdit>();
  const [deletion, setDeletion] = useState('');
  const registered = dialects.get(document.target.dialectId);
  const dialect = registered?.metadata.profiles.some(profile => profile.version === document.target.engineVersion &&
    profile.status === 'certified') ? registered : undefined;
  const run: QuickRun = (command, report) => !readOnly && session.run(command, (before, after) => {
    if (!dialect) return [];
    const issues = (document: ErdDocument) => {
      const foreignKeys = dialect.inspectForeignKeys?.(document);
      return document.catalog.constraints.flatMap(key => key.kind !== 'fk' ? []
        : foreignKeys ? foreignKeys.validate(key) : dialect.validateForeignKey(document, key));
    };
    const previous = new Set(issues(before).map(issue => issue.code + ':' + issue.objectId));
    const rejected = issues(after).filter(issue => !previous.has(issue.code + ':' + issue.objectId))
      .map((issue): ModelDiagnostic => ({ ...issue, severity: 'error' }));
    if (rejected.length) report?.(rejected[0].message);
    return rejected;
  });
  const capability = dialect?.capabilities(document.target);
  const view = document.views.find(item => item.id === chosenView) ?? document.views[0];
  const viewObjectToDelete = deletion ? view?.groups.find(item => item.id === deletion) ?? view?.notes.find(item => item.id === deletion) : undefined;
  const removed = () => { inspect(null); setQuickEdit(undefined); setSearchFocus(undefined); };
  const canEdit = !readOnly;
  const canEditCanvas = canEdit && canvasMode === 'select';
  const canPlace = canEdit && capability?.table.edit === 'supported' && document.catalog.namespaces.length > 0;
  const selectedId = selection && 'id' in selection ? selection.id : undefined;
  const selectedInstance = view?.instances.find(item => item.id === (selection?.instanceId ?? selectedId));
  const selectedRelation = document.relationships.find(item => item.id === selectedId) ??
    document.catalog.constraints.find(item => item.id === selectedId && item.kind === 'fk');
  const selectedTableId = selection && 'tableId' in selection ? selection.tableId : selectedInstance?.tableId ??
    document.catalog.tables.find(item => item.id === selectedId)?.id ??
    document.catalog.columns.find(item => item.id === selectedId)?.tableId ??
    document.catalog.constraints.find(item => item.id === selectedId)?.tableId ??
    document.catalog.indexes.find(item => item.id === selectedId)?.tableId;
  const structure = useMemo(() => validateDocumentStructure(document), [document]);
  const semantic = useMemo(() => dialect?.validate(document, { target: document.target }) ?? [], [dialect, document]);
  const issues = [...session.diagnostics.filter(issue => !semantic.some(item => item.code === issue.code && item.objectId === issue.objectId)), ...semantic];
  const search = query.toLocaleLowerCase().trim();
  const matches = (text: string) => text.toLocaleLowerCase().includes(search);
  const matchName = (item: { physicalName: string; logicalName?: string }) =>
    matches(label(item)) || Boolean(item.logicalName && matches(item.logicalName));
  const searchColumns = new Map<string, ReturnType<typeof columnsOf>>();
  if (search) for (const column of document.catalog.columns) {
    if (!matchName(column)) continue;
    const columns = searchColumns.get(column.tableId) ?? [];
    columns.push(column);
    searchColumns.set(column.tableId, columns);
  }
  const selectView = (id: string) => {
    chooseView(id);
    inspect(null);
    setSearchFocus(undefined);
    setSelectedInstances([]);
    setMobilePane('canvas');
    setTool(undefined);
    setQuickEdit(undefined);
  };
  const selectObject = (id: string) => inspect({ type: 'object', id });
  function openProperties(value: Inspector) {
    setQuickEdit(undefined);
    setTool(undefined);
    inspect(value);
    setMobilePane('properties');
  }

  function toggleSchema() {
    setSchemaCollapsed(!schemaCollapsed);
    if (!schemaCollapsed && window.matchMedia('(max-width: 520px)').matches) {
      setMobilePane('canvas');
      mobileCanvasTab.current?.focus();
    }
  }

  function chooseTool(next: CanvasTool) {
    setCanvasMode('select');
    setQuickEdit(undefined);
    setTool(next);
  }

  function changeCanvasMode(mode: 'select' | 'pan') {
    setCanvasMode(mode);
    setTool(undefined);
    setQuickEdit(undefined);
  }

  function chooseCanvasObject(instanceId: string) {
    if (!canEdit || tool?.kind !== 'relation') {
      selectObject(instanceId);
      if (quickEdit?.instanceId !== instanceId) setQuickEdit(undefined);
      return;
    }
    const instance = view?.instances.find(item => item.id === instanceId);
    if (!instance) return;
    const origin = view?.instances.find(item => item.id === tool.origin?.id);
    if (!origin) {
      if (tool.mode !== 'logical' && !dialect?.referenceKeys(document, instance.tableId).some(key => !key.unavailable)) {
        setTool({ ...tool, origin: undefined, problem: '선택한 부모 테이블에 참조 가능한 PK 또는 고유 키가 없습니다.' });
        return;
      }
      setTool({ ...tool, origin: instance, problem: undefined });
      return;
    }
    if (tool.mode === 'logical') setLogical({ sourceTableId: origin.tableId, targetTableId: instance.tableId });
    else setFk({ mode: tool.mode, tableId: instance.tableId, targetTableId: origin.tableId });
    setTool(undefined);
  }

  function placeTable(table: Table, point: XYPosition, create: boolean) {
    if (!view || !canEdit) return false;
    const instance = { ...placement(view, table.id), ...point };
    const commands: DocumentCommand[] = [putView({ ...view, instances: [...view.instances, instance] })];
    if (create) commands.unshift({ kind: 'put-catalog', collection: 'tables', value: table });
    if (!run({ kind: 'batch', commands })) return false;
    selectObject(instance.id);
    setTool(undefined);
    setQuickEdit(create ? { instanceId: instance.id, field: 'name' } : undefined);
    return true;
  }

  function reorderColumn(instanceId: string, columnId: string, targetId: string, after: boolean) {
    const instance = view?.instances.find(item => item.id === instanceId);
    const table = document.catalog.tables.find(item => item.id === instance?.tableId);
    if (!table || columnId === targetId || !table.columnIds.includes(columnId) || !table.columnIds.includes(targetId)) return;
    function move(ids: string[]) {
      if (!ids.includes(columnId) || !ids.includes(targetId)) return ids;
      const order = ids.filter(id => id !== columnId);
      order.splice(order.indexOf(targetId) + Number(after), 0, columnId);
      return order.every((id, index) => id === ids[index]) ? ids : order;
    }
    const columnIds = move(table.columnIds);
    const commands: DocumentCommand[] = [];
    if (columnIds !== table.columnIds) commands.push({ kind: 'put-catalog', collection: 'tables', value: { ...table, columnIds } });
    for (const view of document.views) {
      const instances = view.instances.map(item => {
        if (item.tableId !== table.id || !item.visibleColumnIds) return item;
        const visibleColumnIds = move(item.visibleColumnIds);
        return visibleColumnIds === item.visibleColumnIds ? item : { ...item, visibleColumnIds };
      });
      if (instances.some((item, index) => item !== view.instances[index])) commands.push(putView({ ...view, instances }));
    }
    if (commands.length) run({ kind: 'batch', commands });
  }

  function locate(tableId: string, columnId?: string) {
    const targetView = [view, ...document.views].find(item => item?.instances.some(instance => instance.tableId === tableId));
    const instance = targetView?.instances.find(item => item.tableId === tableId);
    if (targetView && instance) {
      if (targetView.id !== view?.id) setSelectedInstances([]);
      chooseView(targetView.id);
      setSearchFocus({ instanceId: instance.id, columnId });
    }
    selectObject(columnId ?? instance?.id ?? tableId);
    setMobilePane(instance ? 'canvas' : 'properties');
  }

  function namedResult(item: { physicalName: string; logicalName?: string }) {
    const name = matches(label(item)) || !item.logicalName ? label(item) : item.logicalName;
    return search && matches(name) ? <mark>{name}</mark> : name;
  }

  function keyboard(event: KeyboardEvent<HTMLElement>) {
    if (event.key === 'Escape' && !event.nativeEvent.isComposing && (tool || quickEdit)) {
      event.preventDefault();
      setTool(undefined);
      setQuickEdit(undefined);
      return;
    }
    const key = event.key.toLowerCase();
    if (event.defaultPrevented || event.nativeEvent.isComposing || !(event.target instanceof Element)) return;
    const interactive = event.target.closest('input, textarea, select, button, dialog, [contenteditable]:not([contenteditable="false"]), [role="textbox"]');
    if (view && (!interactive || event.target.closest('.canvas-modes, .canvas-text')) &&
      !event.ctrlKey && !event.metaKey && !event.altKey && (key === 'v' || key === 'h')) {
      event.preventDefault();
      changeCanvasMode(key === 'h' ? 'pan' : 'select');
      return;
    }
    if (interactive && !(key === 'delete' && selectedInstance && event.target.closest('.canvas-table-text'))) return;
    if (!canEdit) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      session.step(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    } else if (key === 'delete' && canvasMode === 'select' && selection?.type === 'object') {
      const target = view?.instances.find(instance => instance.id === selection.id)?.tableId ?? selection.id;
      if (deletionImpact(document, target)) {
        event.preventDefault();
        setDeletion(target);
      }
    }
  }

  function move(positions: Map<string, XYPosition>) {
    if (!view || !positions.size) return;
    const groupDeltas = new Map(view.groups.flatMap(group => {
      const position = positions.get(group.id);
      return position ? [[group.id, { x: position.x - group.x, y: position.y - group.y }] as const] : [];
    }));
    function moved<T extends { id: string; x: number; y: number; groupId?: string }>(item: T): T {
      const position = positions.get(item.id);
      const delta = item.groupId ? groupDeltas.get(item.groupId) : undefined;
      return position ? { ...item, ...position } : delta ? { ...item, x: item.x + delta.x, y: item.y + delta.y } : item;
    }
    run(putView({ ...view, instances: view.instances.map(moved), groups: view.groups.map(moved), notes: view.notes.map(moved) }));
  }

  const edited = view?.instances.find(item => item.id === quickEdit?.instanceId);
  const editedTable = document.catalog.tables.find(item => item.id === edited?.tableId);
  const editedColumn = document.catalog.columns.find(item => item.id === quickEdit?.columnId && item.tableId === editedTable?.id);
  const inline = canEdit && view && edited && editedTable && quickEdit && (!quickEdit.columnId || editedColumn) ? (
    quickEdit.field === 'table' ? <QuickTableForm key={edited.id + ':' + (view.nameDisplay ?? 'physical')} document={document} table={editedTable}
      mode={view.nameDisplay} cancel={() => setQuickEdit(undefined)} apply={(value, report) => {
        if (run({ kind: 'put-catalog', collection: 'tables', value }, report)) setQuickEdit(undefined);
      }} /> : dialect && <QuickColumnForm key={edited.id + ':' + (editedColumn?.id ?? 'new') + ':' + quickEdit.field}
      document={document} table={editedTable} column={editedColumn} dialect={dialect} mode={view.nameDisplay}
      focus={quickEdit.field} run={run} view={view} instance={edited}
      cancel={() => setQuickEdit(undefined)} done={() => setQuickEdit(undefined)} />
  ) : undefined;

  return <EditorReadOnly.Provider value={readOnly}><main className="editor" onKeyDown={keyboard}>
    <header className="topbar">
      <div className="brand-lockup"><span className="brand-mark"><Icon name="brand" /></span><AppVersion /></div>
      <div className="document-title">
        <h1 title={document.name}>{document.name}</h1>
        {!readOnly && <button className="icon-button quiet" type="button" aria-label="문서 제목 변경" title="문서 제목 변경"
          onClick={() => setDialog('title')}><Icon name="edit" /></button>}
      </div>
      <p className="save-state" role={session.status.error ? 'alert' : 'status'}><span className="status-dot" />{session.status.text}</p>
      <div className="actions document-actions">
        {!readOnly && <div className="history-actions" role="group" aria-label="편집 이력">
          <button className="icon-button quiet" type="button" aria-label="실행 취소" title="실행 취소" disabled={!session.canUndo}
            onClick={() => session.step('undo')}><Icon name="undo" /></button>
          <button className="icon-button quiet" type="button" aria-label="다시 실행" title="다시 실행" disabled={!session.canRedo}
            onClick={() => session.step('redo')}><Icon name="redo" /></button>
        </div>}
        <div className="actions secondary-actions">{topActions}</div>
        {importAction && <ActionMenu label="가져오기" icon="import">{importAction(view?.id)}</ActionMenu>}
        {(exportAction || view) && <ActionMenu label="내보내기" icon="export" primary>
          {exportAction?.(view?.id)}
          {view && <ImageExport document={document} view={view} selection={selectedInstances} verify={verifyImage} />}
        </ActionMenu>}
        <ThemeToggle />
      </div>
    </header>
    <div className="editor-feedback">
      {saveActions}
    </div>
    <div className="mobile-panes" role="group" aria-label="편집기 영역">
      {(Object.keys(mobilePanes) as MobilePane[]).map(pane => <button key={pane} ref={pane === 'canvas' ? mobileCanvasTab : undefined}
        type="button" aria-pressed={mobilePane === pane}
        aria-controls={`${mobilePanesId}-${pane}`} onClick={() => {
          if (pane === 'schema') setSchemaCollapsed(false);
          setMobilePane(pane);
        }}>{mobilePanes[pane]}</button>)}
    </div>
    <div className="editor-layout" data-mobile-pane={mobilePane} data-schema-collapsed={schemaCollapsed}>
      <aside className="navigator" id={`${mobilePanesId}-schema`} aria-label="문서 탐색">
        <div className="section-heading nav-heading navigator-header">
          {!schemaCollapsed && <h2>스키마</h2>}
          <div className="actions navigator-header-actions">
            {!schemaCollapsed && !readOnly && <button type="button" className="quiet icon-button"
              aria-label="네임스페이스 추가" title="네임스페이스 추가"
              onClick={() => openProperties({ type: 'namespace' })}><Icon name="plus" /></button>}
            <button type="button" className="quiet icon-button" aria-expanded={!schemaCollapsed} aria-controls={`${mobilePanesId}-schema`}
              aria-label={schemaCollapsed ? '스키마 펼치기' : '스키마 접기'} title={schemaCollapsed ? '스키마 펼치기' : '스키마 접기'}
              onClick={toggleSchema}><Icon name={schemaCollapsed ? 'right' : 'back'} /></button>
          </div>
        </div>
        <label className="schema-search"><Icon name="search" /><span className="sr-only">스키마 및 뷰 검색</span>
          <input type="search" placeholder="스키마 및 뷰 검색" value={query} onChange={event => {
            setQuery(event.target.value);
            setSearchFocus(undefined);
          }} />
        </label>
        {document.catalog.namespaces.map(namespace => {
          const tables = document.catalog.tables.filter(table => table.namespaceId === namespace.id &&
            (matchName(namespace) || matchName(table) || searchColumns.has(table.id)));
          if (!tables.length && !matchName(namespace)) return null;
          return <section key={namespace.id} className="schema-section">
            <button className="quiet schema-namespace" type="button" aria-current={selectedId === namespace.id ? 'true' : undefined}
              onClick={() => openProperties({ type: 'object', id: namespace.id })}><Icon name="schema" /><code>{label(namespace)}</code></button>
            <ul className="object-list">{tables.map(table => <li key={table.id}>
              <button type="button" aria-current={selectedTableId === table.id ? 'true' : undefined}
                draggable={canEditCanvas && Boolean(view)} onDragStart={event => {
                  if (!canEditCanvas || !view) return;
                  event.dataTransfer.setData(dragType.table, table.id);
                  event.dataTransfer.effectAllowed = 'copy';
                }}
                onClick={() => search ? locate(table.id) : openProperties({ type: 'object', id: view?.instances.find(item => item.tableId === table.id)?.id ?? table.id })}>
                <Icon name="table" /><code>{search ? namedResult(table) : label(table)}</code>
              </button>
              {searchColumns.has(table.id) && <ul className="object-list column-matches">{searchColumns.get(table.id)?.map(column =>
                <li key={column.id}><button type="button" onClick={() => locate(table.id, column.id)}>{namedResult(column)}</button></li>)}</ul>}
            </li>)}</ul>
            {!readOnly && <button className="quiet schema-add" type="button"
              onClick={() => openProperties({ type: 'table', namespaceId: namespace.id })}><Icon name="plus" />테이블 추가</button>}
          </section>;
        })}
        <div className="section-heading nav-heading section-separated"><h2>뷰</h2>{!readOnly && <button type="button" className="quiet icon-button"
          aria-label="뷰 추가" title="뷰 추가" onClick={() => setDialog('view')}><Icon name="plus" /></button>}</div>
        <ul className="object-list">{document.views.filter(item => matches(item.name)).map(item => <li key={item.id}>
          <button type="button" aria-pressed={view?.id === item.id} onClick={() => selectView(item.id)}><Icon name="view" /><span>{item.name}</span></button>
        </li>)}</ul>
        <div className="section-heading nav-heading section-separated"><h2>논리 관계</h2>
          {!readOnly && <button type="button" className="quiet icon-button" aria-label="관계 추가" title="관계 추가"
            disabled={!document.catalog.tables.length} onClick={() => openProperties({ type: 'relationship' })}><Icon name="plus" /></button>}</div>
        <ul className="object-list">{document.relationships.map(item => <li key={item.id}>
          <button type="button" onClick={() => openProperties({ type: 'object', id: item.id })}>{item.name}</button></li>)}</ul>
        <details className="sql-support">
          <summary>SQL 지원</summary>
          <ul className="support-list">
            <li>DDL 가져오기 · {capability?.table.import === 'supported' ? '지원' : '미구현'}</li>
            <li>DDL 내보내기 · {capability?.table.export === 'supported' ? '지원' : '미구현'}</li>
            {(['enum', 'sequence', 'identity'] as const).map(feature =>
              <li key={feature}>{feature.toUpperCase()} · {capability?.[feature].edit === 'supported' ? '편집 가능' : '보존 전용'}</li>)}
          </ul>
        </details>
        <p className="sql-target">{dialect?.metadata.name ?? document.target.dialectId} {document.target.engineVersion}</p>
      </aside>
      <section className="workspace" id={`${mobilePanesId}-canvas`} aria-label="다이어그램">
        {view ? <>
          <div className="canvas-toolbar">
            <Icon name="view" />
            <h2>{view.name}</h2>
            {!readOnly && <button type="button" className="quiet icon-button" title="뷰 설정" aria-label="뷰 설정"
              onClick={() => setDialog('view-settings')}><Icon name="settings" /></button>}
            <div className="canvas-tools">
              <div className="canvas-modes" role="group" aria-label="캔버스 모드">
                <button type="button" className="quiet icon-button" aria-label="선택 모드" title="선택 모드 (V)"
                  aria-pressed={canvasMode === 'select'} onClick={() => changeCanvasMode('select')}><Icon name="cursor" /></button>
                <button type="button" className="quiet icon-button" aria-label="이동 모드" title="이동 모드 (H)"
                  aria-pressed={canvasMode === 'pan'} onClick={() => changeCanvasMode('pan')}><Icon name="hand" /></button>
              </div>
              {canEdit && <>
                <button type="button" className="canvas-toolbar-primary" aria-label="캔버스에 테이블 추가" title="클릭하거나 캔버스로 드래그"
                  disabled={!canPlace} draggable={canPlace && canEditCanvas} aria-pressed={tool?.kind === 'place'} onDragStart={event => {
                    if (!canPlace || !canEditCanvas) return;
                    event.dataTransfer.setData(dragType.newTable, 'table');
                    event.dataTransfer.effectAllowed = 'copy';
                  }} onClick={() => chooseTool({ kind: 'place' })}><Icon name="plus" />테이블</button>
                <ActionMenu label="관계 연결" icon="link">
                  <button type="button" disabled={!dialect || !view.instances.length}
                    onClick={() => chooseTool({ kind: 'relation', mode: 'identifying' })}>식별 FK</button>
                  <button type="button" disabled={!dialect || !view.instances.length}
                    onClick={() => chooseTool({ kind: 'relation', mode: 'non-identifying' })}>비식별 FK</button>
                  <button type="button" disabled={!view.instances.length}
                    onClick={() => chooseTool({ kind: 'relation', mode: 'logical' })}>논리 관계</button>
                </ActionMenu>
              </>}
              <label><span className="sr-only">이름 표시</span><select disabled={readOnly} value={view.nameDisplay ?? 'physical'} onChange={event => {
                setQuickEdit(undefined);
                run(putView({ ...view, nameDisplay: viewNameDisplaySchema.parse(event.target.value) }));
              }}>
                <ViewNameOptions />
              </select></label>
              <label className="checkbox"><input type="checkbox" checked={snap} disabled={readOnly} onChange={event => setSnap(event.target.checked)} />그리드 맞춤</label>
              {!readOnly && <button type="button" className="quiet" disabled={!view.instances.length} aria-label="이름순 그리드 재배치"
                title="이름순 그리드 재배치"
                onClick={() => run(putView(arrangeView(document, view, layoutSizes.current)))}>
                그리드 정렬
              </button>}
              {!readOnly && <ActionMenu label="추가" icon="plus">
                <button type="button" onClick={() => {
                  const group = { id: id(), name: '새 그룹', x: 0, y: 0 };
                  if (run(putView({ ...view, groups: [...view.groups, group] }))) openProperties({ type: 'object', id: group.id });
                }}>그룹 추가</button>
                <button type="button" onClick={() => {
                  const note = { id: id(), text: '새 메모', x: 120, y: -100 };
                  if (run(putView({ ...view, notes: [...view.notes, note] }))) openProperties({ type: 'object', id: note.id });
                }}>메모 추가</button>
              </ActionMenu>}
            </div>
          </div>
          <CanvasEditing.Provider value={{
            activeId: selectedInstance?.id ?? selectedId, edit: inline ? quickEdit : undefined, form: inline,
            change: canEditCanvas && !tool && dialect ? edit => {
              selectObject(edit.instanceId);
              setQuickEdit(edit);
            } : undefined,
            remove: canEditCanvas && !tool && !inline ? id => setDeletion(id) : undefined,
            link: canEditCanvas && tool?.kind === 'relation' ? chooseCanvasObject : undefined,
            reorder: canEditCanvas && !tool && !inline ? reorderColumn : undefined,
          }}>
            <EditorCanvas key={document.id + view.id} document={document} view={view} dialect={dialect} select={chooseCanvasObject}
              clearSelection={() => { inspect(null); setQuickEdit(undefined); }} activeTableId={selectedTableId} activeRelationId={selectedRelation?.id}
              selectInstances={setSelectedInstances} focus={searchFocus} move={move} layoutSizes={layoutSizes.current} snap={snap} readOnly={readOnly}
              panMode={canvasMode === 'pan'}
              showMap={showMap} mapId={mapId} placing={canPlace && tool?.kind === 'place'}
              picking={canEdit && tool?.kind === 'relation'} pickId={canEdit && tool?.kind === 'relation' ? tool.origin?.id : undefined}
              editRelation={canEdit ? id => {
                const relation = document.relationships.find(item => item.id === id);
                const key = document.catalog.constraints.find(item => item.id === id);
                setQuickEdit(undefined);
                if (relation) setLogical(relation);
                if (key?.kind === 'fk' && dialect) {
                  setFk({ tableId: key.tableId, targetTableId: key.targetTableId, existing: key });
                }
              } : undefined}
              instruction={tool && canEdit && !(tool.kind === 'place' && tool.at) && <div className="canvas-instruction">
                <p role="status">{tool.kind === 'place' ? '새 테이블을 놓을 위치를 클릭하세요.' : tool.origin
                  ? (tool.mode === 'logical' ? '도착 테이블을 선택하세요.' : '자식 테이블을 선택하세요.')
                  : (tool.mode === 'logical' ? '출발 테이블을 선택하세요.' : '부모 테이블을 선택하세요.')}</p>
                {tool.kind === 'relation' && tool.problem && <p role="alert">{tool.problem}</p>}
                <button type="button" className="quiet" onClick={() => setTool(undefined)}>취소</button>
              </div>}
              place={canPlace ? at => chooseTool({ kind: 'place', at }) : undefined}
              placementForm={canPlace && tool?.kind === 'place' && tool.at ? {
                screen: tool.at.screen,
                content: <QuickTableForm key={tool.at.point.x + ':' + tool.at.point.y} document={document} mode={view.nameDisplay}
                  cancel={() => setTool(undefined)} apply={(table, report) => {
                    if (tool.at && !placeTable(table, tool.at.point, true)) report('현재 뷰에 테이블을 추가하지 못했습니다.');
                  }} />,
              } : undefined}
              dropTable={canEdit ? (tableId, point) => {
                const table = document.catalog.tables.find(item => item.id === tableId);
                if (!table) return;
                const instance = view.instances.find(item => item.tableId === table.id);
                if (instance) {
                  move(new Map([[instance.id, point]]));
                  selectObject(instance.id);
                  setTool(undefined);
                  setQuickEdit(undefined);
                } else if (!placeTable(table, point, false)) return;
                setMobilePane('canvas');
              } : undefined}
              connect={(sourceColumnId, targetColumnId) => {
                const source = document.catalog.columns.find(item => item.id === sourceColumnId);
                const target = document.catalog.columns.find(item => item.id === targetColumnId);
                if (canEdit && dialect && source && target) {
                  setQuickEdit(undefined);
                  setFk({ tableId: source.tableId, targetTableId: target.tableId, sourceColumnId, targetColumnId });
                }
              }} />
          </CanvasEditing.Provider>
          <div className="canvas-status">
            <span>테이블 {view.instances.length}개</span>
            <span className="edge-legend"><span aria-hidden="true" />식별 FK</span>
            <span className="edge-legend non-identifying"><span aria-hidden="true" />비식별 FK</span>
            <span className="edge-legend logical"><span aria-hidden="true" />논리 관계</span>
            <button type="button" className="quiet" aria-expanded={showMap} aria-controls={mapId} onClick={() => setShowMap(value => !value)}>
              <Icon name="map" />미니맵</button>
          </div>
        </> : <p className="empty-view">도면을 그리려면 뷰를 추가하세요.</p>}
      </section>
      <aside className="inspector" id={`${mobilePanesId}-properties`} aria-label="속성">
        <div className="pane-heading"><h2>속성</h2></div>
        <div className="inspector-body">
          <Properties document={document} view={view} dialect={dialect} selection={selection}
            run={run} inspect={inspect} fk={setFk} remove={setDeletion} readOnly={readOnly} />
        </div>
        <div className="inspector-diagnostics" aria-label="진단">
          <p role="status" className={structure.length ? 'error-text' : ''}>
            {!structure.length && <Icon name="check" />}{structure.length === 0 ? '구조 검증 통과' : '구조 오류 ' + structure.length + '건'}</p>
          {issues.length > 0 && <ul className="diagnostics">{issues.map((issue, index) => <li key={index}>
            {issue.objectId && <button type="button" onClick={() => selectObject(issue.objectId ?? '')}>{issue.objectId}</button>}
            <span>{issue.message}</span>
          </li>)}</ul>}
        </div>
      </aside>
    </div>
    {dialog === 'view' && <Modal title="새 뷰" close={() => setDialog(null)}>
      <Form button="뷰 만들기" cancel={() => setDialog(null)} submit={form => {
        const next = emptyView(field(form, 'name'));
        if (run(putView(next))) { selectView(next.id); setDialog(null); }
      }}><label>새 뷰 이름<input name="name" required /></label></Form>
    </Modal>}
    {dialog === 'title' && <Modal title="문서 제목 변경" close={() => setDialog(null)}>
      <Form button="제목 적용" cancel={() => setDialog(null)} submit={form => {
        if (run({ kind: 'title', name: field(form, 'documentName') })) setDialog(null);
      }}>
        <label>문서 제목<input name="documentName" defaultValue={document.name} maxLength={200} required /></label>
      </Form>
    </Modal>}
    {view && dialog === 'view-settings' && <ViewSettings key={view.id + view.name} view={view} run={run}
      choose={selectView} close={() => setDialog(null)} />}
    {canEdit && fk && dialect && <ForeignKeyForm document={document} dialect={dialect} seed={fk} run={run} close={() => setFk(null)} />}
    {canEdit && logical && <Modal title={'id' in logical ? '논리 관계 편집' : '논리 관계 연결'} close={() => setLogical(undefined)}>
      <RelationshipForm document={document} seed={logical} relation={'id' in logical ? logical : undefined}
        run={run} close={() => setLogical(undefined)} />
    </Modal>}
    {deletion && canEdit && (view && viewObjectToDelete
      ? <DeleteViewObject view={view} object={viewObjectToDelete} run={run} close={() => setDeletion('')} removed={removed} />
      : <DeleteSchema document={document} objectId={deletion} run={run} close={() => setDeletion('')} removed={removed} />)}
  </main></EditorReadOnly.Provider>;
}
