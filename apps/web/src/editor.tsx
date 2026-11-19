import { useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { XYPosition } from '@xyflow/react';
import { columnBadgesById, createDocument, deletionImpact, validateDocumentStructure } from '@erd/model';
import type { Catalog, DocumentCommand, ErdDocument, ModelDiagnostic, SqlTarget } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { postgresqlEditor } from '@erd/dialect-postgresql/ui';
import { EditorCanvas } from './editor-canvas.js';
import type { CanvasFocus, LayoutSizes } from './editor-canvas.js';
import { ActionMenu, ColumnBadges, Icon } from './editor-controls.js';
import { columnsOf, duplicateView, EditorReadOnly, emptyView, field, Form, id, label, Modal, named, NameFields, placement, putView } from './editor-fields.js';
import type { View } from './editor-fields.js';
import { useEditorSession } from './editor-session.js';
import { ImageExport } from './image-export.js';
import { ColumnForm, DeleteSchema, ForeignKeyForm, IndexForm, KeyForm } from './schema-inspector.js';
import type { FkDialog } from './schema-inspector.js';
import { arrangeView } from './view-grid.js';

const dialects = new Map<string, EditorDialect>([[postgresqlEditor.metadata.id, postgresqlEditor]]);
export const editorTargets = [...dialects.values()].flatMap(dialect => dialect.metadata.profiles.filter(profile => profile.status === 'certified')
  .map(profile => ({ dialectId: dialect.metadata.id, engineVersion: profile.version, name: dialect.metadata.name + ' ' + profile.version })));
type Run = (command: DocumentCommand) => boolean;
const tableTabs = { columns: '컬럼', constraints: '제약', indexes: '인덱스', settings: '설정' } as const;
type TableTab = keyof typeof tableTabs;
const tabOrder = Object.keys(tableTabs) as TableTab[];
const mobilePanes = { canvas: '다이어그램', schema: '스키마', properties: '속성' } as const;
type MobilePane = keyof typeof mobilePanes;
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

function GroupField({ view, groupId }: { view: View; groupId?: string }) {
  return <label>그룹<select name="group" defaultValue={groupId ?? ''}><option value="">그룹 없음</option>
    {view.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
  </select></label>;
}

function RelationshipForm({ document, relation, run, close }: {
  document: ErdDocument; relation?: ErdDocument['relationships'][number]; run: Run; close(): void;
}) {
  return <Form button="논리 관계 적용" cancel={close} submit={form => {
    const cardinality = (['one-to-one', 'one-to-many', 'many-to-many'] as const).find(item => item === field(form, 'cardinality'));
    if (!cardinality) return;
    if (run({ kind: 'put-relationship', value: {
      id: relation?.id ?? id(), name: field(form, 'name'), description: field(form, 'description') || undefined,
      sourceTableId: field(form, 'source'), targetTableId: field(form, 'target'), cardinality,
    } })) close();
  }}>
    <label>관계 이름<input name="name" defaultValue={relation?.name} required /></label>
    <label>설명<textarea name="description" defaultValue={relation?.description} /></label>
    {(['source', 'target'] as const).map(key => <label key={key}>{key === 'source' ? '원본 테이블' : '대상 테이블'}
      <select name={key} defaultValue={key === 'source' ? relation?.sourceTableId : relation?.targetTableId} required>
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
    <button type="button" disabled={readOnly} onClick={() => { run(putView({ ...view, notes: view.notes.filter(item => item.id !== note.id) })); inspect(null); }}>메모 삭제</button>
  </>;
  if (group && view) return <>
    <h3>그룹</h3>
    <Form key={JSON.stringify([group.id, group.name, group.size])} button="그룹 적용" submit={form => run(putView({ ...view, groups: view.groups.map(item => item.id === group.id ?
      { ...item, name: field(form, 'name'), size: { width: Number(field(form, 'width')), height: Number(field(form, 'height')) } } : item) }))}>
      <label>그룹 이름<input name="name" defaultValue={group.name} required /></label>
      <label>너비<input type="number" name="width" min="40" defaultValue={group.size?.width ?? 480} required /></label>
      <label>높이<input type="number" name="height" min="40" defaultValue={group.size?.height ?? 250} required /></label>
    </Form>
    <button type="button" disabled={readOnly} onClick={() => {
      run(putView({ ...view, groups: view.groups.filter(item => item.id !== group.id),
        instances: view.instances.map(item => item.groupId === group.id ? { ...item, groupId: undefined } : item),
        notes: view.notes.map(item => item.groupId === group.id ? { ...item, groupId: undefined } : item) }));
      inspect(null);
    }}>그룹 삭제</button>
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
        <div className="section-heading"><span className="muted">컬럼 {columns.length}개</span>
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
        {constraints.length ? <ul className="object-list inspector-list">{constraints.map(item =>
          <li key={item.id}><button type="button" aria-label={`${item.kind.toUpperCase()} · ${label(item)}`} onClick={() => openObject(item.id)}>
            <span className="inspector-item-name"><code>{label(item)}</code><small>{item.kind.toUpperCase()}</small></span><Icon name="right" />
          </button></li>)}</ul> : <p className="muted">등록된 제약이 없습니다.</p>}
        {!readOnly && <div className="actions inspector-add-actions">
          {(['pk', 'unique', 'check'] as const).map(type => <button key={type} type="button"
            onClick={() => open({ type, tableId: table.id })}>{type.toUpperCase()} 추가</button>)}
          <button type="button" disabled={!dialect} onClick={() => fk({ tableId: table.id })}>외래 키 추가</button>
        </div>}
      </>,
      indexes: <>
        {indexes.length ? <ul className="object-list inspector-list">{indexes.map(item =>
          <li key={item.id}><button type="button" aria-label={`${item.unique ? 'UNIQUE INDEX' : 'INDEX'} · ${label(item)}`} onClick={() => openObject(item.id)}>
            <span className="inspector-item-name"><code>{label(item)}</code><small>{item.unique ? 'UNIQUE INDEX' : 'INDEX'}</small></span><Icon name="right" />
          </button></li>)}</ul> : <p className="muted">등록된 인덱스가 없습니다.</p>}
        {!readOnly && <button type="button" onClick={() => open({ type: 'index', tableId: table.id })}>INDEX 추가</button>}
      </>,
      settings: <>
        {settings}
        {!readOnly && view && instance && <div className="inspector-section">
          <h4>뷰 배치</h4>
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
          }}>이 뷰에서 숨기기</button>
        </div>}
        {!readOnly && view && !view.instances.some(item => item.tableId === table.id) && <button type="button" onClick={() => {
          const item = placement(view, table.id);
          if (run(putView({ ...view, instances: [...view.instances, item] }))) inspect({ type: 'object', id: item.id, tab: 'settings' });
        }}>현재 뷰에 배치</button>}
        {!readOnly && <button type="button" className="danger" onClick={() => remove(table.id)}>스키마에서 실제 삭제</button>}
      </>,
    }} />;
  }
  return <p>선택한 객체를 사용할 수 없습니다.</p>;
}

type LocalSession = ReturnType<typeof useEditorSession>;
type EditingSession = Pick<LocalSession, 'document' | 'loading' | 'status' | 'diagnostics' | 'canUndo' | 'canRedo' | 'run' | 'step'>;

export function createEditorDocument(name: string, target: SqlTarget) {
  return createDocument({
    id: id(), name, target, namespace: { id: id(), physicalName: 'public' },
    view: emptyView('기본 뷰'),
  }).document;
}

export function Editor({ topActions }: { topActions?: ReactNode } = {}) {
  const local = useEditorSession();
  return <DocumentEditor session={local} local={local} topActions={topActions} />;
}

export function DocumentEditor({ session, local, readOnly = false, topActions, saveActions, exportAction, verifyImage }: {
  session: EditingSession; local?: LocalSession; readOnly?: boolean; topActions?: ReactNode; saveActions?: ReactNode; exportAction?(viewId: string | undefined): ReactNode;
  verifyImage?(): Promise<void>;
}) {
  const { document } = session;
  const [chosenView, chooseView] = useState('');
  const [selection, inspect] = useState<Inspector | null>(null);
  const [mobilePane, setMobilePane] = useState<MobilePane>('canvas');
  const mobilePanesId = useId();
  const [query, setQuery] = useState('');
  const [searchFocus, setSearchFocus] = useState<CanvasFocus>();
  const [selectedInstances, setSelectedInstances] = useState<string[]>([]);
  const layoutSizes = useRef<LayoutSizes>(new Map());
  const [snap, setSnap] = useState(true);
  const [showMap, setShowMap] = useState(false);
  const mapId = useId();
  const [dialog, setDialog] = useState<'document' | 'title' | 'view' | 'view-settings' | null>(null);
  const [fk, setFk] = useState<FkDialog | null>(null);
  const [deletion, setDeletion] = useState('');
  const registered = dialects.get(document.target.dialectId);
  const dialect = registered?.metadata.profiles.some(profile => profile.version === document.target.engineVersion &&
    profile.status === 'certified') ? registered : undefined;
  const run: Run = command => !readOnly && !session.loading && session.run(command, (before, after) => {
    if (!dialect) return [];
    const issues = (document: ErdDocument) => {
      const foreignKeys = dialect.inspectForeignKeys?.(document);
      return document.catalog.constraints.flatMap(key => key.kind !== 'fk' ? []
        : foreignKeys ? foreignKeys.validate(key) : dialect.validateForeignKey(document, key));
    };
    const previous = new Set(issues(before).map(issue => issue.code + ':' + issue.objectId));
    return issues(after).filter(issue => !previous.has(issue.code + ':' + issue.objectId))
      .map((issue): ModelDiagnostic => ({ ...issue, severity: 'error' }));
  });
  const capability = dialect?.capabilities(document.target);
  const view = document.views.find(item => item.id === chosenView) ?? document.views[0];
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
  };
  const selectObject = (id: string) => inspect({ type: 'object', id });
  function openProperties(value: Inspector) {
    inspect(value);
    setMobilePane('properties');
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
    if (readOnly || session.loading || event.defaultPrevented || event.nativeEvent.isComposing ||
      !(event.target instanceof Element) ||
      event.target.closest('input, textarea, select, button, dialog, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && !event.altKey && (key === 'z' || key === 'y')) {
      event.preventDefault();
      session.step(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    } else if (key === 'delete' && selection?.type === 'object') {
      const target = view?.instances.find(instance => instance.id === selection.id)?.tableId ?? selection.id;
      if (deletionImpact(document, target)) {
        event.preventDefault();
        setDeletion(target);
      }
    }
  }

  async function openRecovery(key?: string) {
    if (local && await (key ? local.restore(key) : local.retry())) selectView('');
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

  return <EditorReadOnly.Provider value={readOnly}><main className="editor" onKeyDown={keyboard}>
    <header className="topbar">
      <span className="brand-mark"><Icon name="brand" /></span>
      <div className="document-title">
        <h1 title={document.name}>{document.name}</h1>
        {!readOnly && <button className="icon-button quiet" type="button" aria-label="문서 제목 변경" title="문서 제목 변경"
          disabled={session.loading} onClick={() => setDialog('title')}><Icon name="edit" /></button>}
      </div>
      <p className="save-state" role={session.status.error ? 'alert' : 'status'}><span className="status-dot" />{session.status.text}</p>
      <div className="actions document-actions">
        {!readOnly && <div className="history-actions" role="group" aria-label="편집 이력">
          <button className="icon-button quiet" type="button" aria-label="실행 취소" title="실행 취소" disabled={!session.canUndo}
            onClick={() => session.step('undo')}><Icon name="undo" /></button>
          <button className="icon-button quiet" type="button" aria-label="다시 실행" title="다시 실행" disabled={!session.canRedo}
            onClick={() => session.step('redo')}><Icon name="redo" /></button>
        </div>}
        {local && <button type="button" className="quiet" disabled={local.loading || local.unsaved} onClick={() => setDialog('document')}>새 문서</button>}
        <div className="actions secondary-actions">{topActions}</div>
        {(exportAction || view) && <ActionMenu label="내보내기" icon="export" primary>
          {exportAction?.(view?.id)}
          {view && <ImageExport document={document} view={view} selection={selectedInstances} verify={verifyImage} />}
        </ActionMenu>}
      </div>
    </header>
    <div className="editor-feedback">
      {local?.status.retry && <button type="button" onClick={() => void openRecovery()}>다시 시도</button>}
      {saveActions}
      {local?.otherTab && <p role="status">다른 탭에서 이 문서를 열었습니다.</p>}
    </div>
    <div className="mobile-panes" role="group" aria-label="편집기 영역">
      {(Object.keys(mobilePanes) as MobilePane[]).map(pane => <button key={pane} type="button" aria-pressed={mobilePane === pane}
        aria-controls={`${mobilePanesId}-${pane}`} onClick={() => setMobilePane(pane)}>{mobilePanes[pane]}</button>)}
    </div>
    <div className="editor-layout" data-mobile-pane={mobilePane}>
      <aside className="navigator" id={`${mobilePanesId}-schema`} aria-label="문서 탐색">
        <div className="section-heading nav-heading"><h2>스키마</h2>{!readOnly && <button type="button" className="quiet icon-button"
          aria-label="네임스페이스 추가" title="네임스페이스 추가" disabled={session.loading}
          onClick={() => openProperties({ type: 'namespace' })}><Icon name="plus" /></button>}</div>
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
                onClick={() => search ? locate(table.id) : openProperties({ type: 'object', id: view?.instances.find(item => item.tableId === table.id)?.id ?? table.id })}>
                <Icon name="table" /><code>{search ? namedResult(table) : label(table)}</code>
              </button>
              {searchColumns.has(table.id) && <ul className="object-list column-matches">{searchColumns.get(table.id)?.map(column =>
                <li key={column.id}><button type="button" onClick={() => locate(table.id, column.id)}>{namedResult(column)}</button></li>)}</ul>}
            </li>)}</ul>
            {!readOnly && <button className="quiet schema-add" type="button" disabled={session.loading}
              onClick={() => openProperties({ type: 'table', namespaceId: namespace.id })}><Icon name="plus" />테이블 추가</button>}
          </section>;
        })}
        <div className="section-heading nav-heading section-separated"><h2>뷰</h2>{!readOnly && <button type="button" className="quiet icon-button"
          aria-label="뷰 추가" title="뷰 추가" disabled={session.loading} onClick={() => setDialog('view')}><Icon name="plus" /></button>}</div>
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
            <li>DDL 가져오기 · {capability?.table.import === 'supported' ? (local ? '서버 문서에서 지원' : '지원') : '미구현'}</li>
            <li>DDL 내보내기 · {capability?.table.export === 'supported' ? (local ? '서버 문서에서 지원' : '지원') : '미구현'}</li>
            {(['enum', 'sequence', 'identity'] as const).map(feature =>
              <li key={feature}>{feature.toUpperCase()} · {capability?.[feature].edit === 'supported' ? '편집 가능' : '보존 전용'}</li>)}
          </ul>
        </details>
        <p className="sql-target">{dialect?.metadata.name ?? document.target.dialectId} {document.target.engineVersion}</p>
        {local && local.drafts.length > 0 && <><h2>브라우저 복구본</h2><ul className="object-list">
          {local.drafts.map(draft => <li key={draft.key}><button type="button" disabled={local.unsaved} onClick={() => void openRecovery(draft.key)}>
            {'invalid' in draft ? '손상된 복구본' :
              `${draft.tabId ? '탭 충돌 복구본' : '저장된 복구본'} · ${draft.updatedAt} · ${draft.documentId}`}
          </button></li>)}
        </ul></>}
      </aside>
      <section className="workspace" id={`${mobilePanesId}-canvas`} aria-label="다이어그램">
        {view ? <>
          <div className="canvas-toolbar">
            <Icon name="view" />
            <h2>{view.name}</h2>
            {!readOnly && <button type="button" className="quiet icon-button" title="뷰 설정" aria-label="뷰 설정"
              onClick={() => setDialog('view-settings')}><Icon name="settings" /></button>}
            <div className="canvas-tools">
              <label><span className="sr-only">이름 표시</span><select disabled={readOnly} value={view.nameDisplay ?? 'physical'} onChange={event =>
                run(putView({ ...view, nameDisplay: event.target.value === 'logical' ? 'logical' : 'physical' }))}>
                <option value="physical">물리명</option><option value="logical">논리명</option>
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
          <EditorCanvas key={document.id + view.id} document={document} view={view} dialect={dialect} select={selectObject}
            clearSelection={() => inspect(null)} activeTableId={selectedTableId} activeRelationId={selectedRelation?.id}
            selectInstances={setSelectedInstances} focus={searchFocus} move={move} layoutSizes={layoutSizes.current} snap={snap} readOnly={readOnly}
            showMap={showMap} mapId={mapId}
            connect={(sourceColumnId, targetColumnId) => {
              const source = document.catalog.columns.find(item => item.id === sourceColumnId);
              const target = document.catalog.columns.find(item => item.id === targetColumnId);
              if (dialect && source && target) setFk({ tableId: source.tableId, targetTableId: target.tableId, sourceColumnId, targetColumnId });
            }} />
          <div className="canvas-status">
            <span>테이블 {view.instances.length}개</span>
            <span className="edge-legend"><span aria-hidden="true" />외래 키</span>
            <span className="edge-legend logical"><span aria-hidden="true" />논리 관계</span>
            <button type="button" className="quiet" aria-expanded={showMap} aria-controls={mapId} onClick={() => setShowMap(value => !value)}>
              <Icon name="map" />미니맵</button>
          </div>
        </> : <p className="empty-view">도면을 그리려면 뷰를 추가하세요.</p>}
      </section>
      <aside className="inspector" id={`${mobilePanesId}-properties`} aria-label="속성">
        <div className="pane-heading"><h2>속성</h2></div>
        <div className="inspector-body">
          {!session.loading && <Properties document={document} view={view} dialect={dialect} selection={selection}
            run={run} inspect={inspect} fk={setFk} remove={setDeletion} readOnly={readOnly} />}
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
    {local && dialog === 'document' && <Modal title="새 ERD 문서" close={() => setDialog(null)}>
      <Form button="문서 만들기" cancel={() => setDialog(null)} submit={form => {
        const target = editorTargets[Number(field(form, 'target'))];
        if (!target) return;
        const created = createEditorDocument(field(form, 'name'), { dialectId: target.dialectId, engineVersion: target.engineVersion });
        if (created) { local.start(created); selectView(created.views[0].id); setDialog(null); }
      }}>
        <label>새 문서 제목<input name="name" required /></label>
        <label>SQL 대상<select name="target">{editorTargets.map((target, index) => <option key={target.name} value={index}>{target.name}</option>)}</select></label>
      </Form>
    </Modal>}
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
        <label>문서 제목<input name="documentName" defaultValue={document.name} maxLength={local ? undefined : 200} required /></label>
      </Form>
    </Modal>}
    {view && dialog === 'view-settings' && <ViewSettings key={view.id + view.name} view={view} run={run}
      choose={selectView} close={() => setDialog(null)} />}
    {fk && dialect && <ForeignKeyForm document={document} dialect={dialect} seed={fk} run={run} close={() => setFk(null)} />}
    {deletion && <DeleteSchema document={document} objectId={deletion} run={run} close={() => setDeletion('')} />}
  </main></EditorReadOnly.Provider>;
}
