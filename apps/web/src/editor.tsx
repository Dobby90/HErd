import { useState } from 'react';
import type { ReactNode } from 'react';
import type { XYPosition } from '@xyflow/react';
import { createDocument, validateDocumentStructure } from '@erd/model';
import type { Catalog, DocumentCommand, ErdDocument, ModelDiagnostic, SqlTarget } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { postgresqlEditor } from '@erd/dialect-postgresql/ui';
import { EditorCanvas } from './editor-canvas.js';
import { columnsOf, duplicateView, EditorReadOnly, emptyView, field, Form, id, label, Modal, named, NameFields, placement, putView } from './editor-fields.js';
import type { View } from './editor-fields.js';
import { useEditorSession } from './editor-session.js';
import { ColumnForm, DeleteSchema, ForeignKeyForm, IndexForm, KeyForm } from './schema-inspector.js';
import type { FkDialog } from './schema-inspector.js';

const dialects = new Map<string, EditorDialect>([[postgresqlEditor.metadata.id, postgresqlEditor]]);
export const editorTargets = [...dialects.values()].flatMap(dialect => dialect.metadata.profiles.filter(profile => profile.status === 'certified')
  .map(profile => ({ dialectId: dialect.metadata.id, engineVersion: profile.version, name: dialect.metadata.name + ' ' + profile.version })));
type Run = (command: DocumentCommand) => boolean;
type Inspector =
  | { type: 'object'; id: string }
  | { type: 'namespace' | 'table'; namespaceId?: string }
  | { type: 'column' | 'pk' | 'unique' | 'check' | 'index'; tableId: string; id?: string }
  | { type: 'relationship'; id?: string };

function ViewSettings({ view, run, choose }: { view: View; run: Run; choose(id: string): void }) {
  return <>
    <Form button="뷰 이름 적용" submit={form => run(putView({ ...view, name: field(form, 'name') }))}>
      <label>뷰 이름<input name="name" defaultValue={view.name} required /></label>
    </Form>
    <div className="actions">
      <button type="button" onClick={() => {
        const copy = duplicateView(view);
        if (run(putView(copy))) choose(copy.id);
      }}>뷰 복제</button>
      <button type="button" onClick={() => {
        if (window.confirm('이 뷰와 배치를 삭제하시겠습니까?')) run({ kind: 'remove-view', viewId: view.id });
      }}>뷰 삭제</button>
    </div>
  </>;
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
  if (!selection) return <p>스키마 또는 캔버스에서 확인할 객체를 선택하세요.</p>;
  const { catalog } = document;
  const selectedId = 'id' in selection ? selection.id : undefined;
  const instance = view?.instances.find(item => item.id === selectedId);
  const note = view?.notes.find(item => item.id === selectedId);
  const group = view?.groups.find(item => item.id === selectedId);
  const relationship = document.relationships.find(item => item.id === selectedId);
  const namespace = catalog.namespaces.find(item => item.id === selectedId);
  const column = catalog.columns.find(item => item.id === selectedId);
  const constraint = catalog.constraints.find(item => item.id === selectedId);
  const index = catalog.indexes.find(item => item.id === selectedId);
  const tableId = 'tableId' in selection ? selection.tableId : instance?.tableId ?? column?.tableId ?? constraint?.tableId ?? index?.tableId ?? selectedId;
  const table = catalog.tables.find(item => item.id === tableId);
  const close = () => inspect(table ? { type: 'object', id: table.id } : null);
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
    if (column || selection.type === 'column') return <><h3>{column ? '컬럼' : '새 컬럼'}</h3>
      <ColumnForm key={JSON.stringify([table, column])} document={document} table={table} column={column} dialect={dialect} run={run} close={close} />
      {column && removeButton}</>;
    if (constraint?.kind === 'fk') return <>
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
    if (keyKind === 'pk' || keyKind === 'unique' || keyKind === 'check') return <>
      <h3>{keyKind.toUpperCase()} 제약</h3>
      <KeyForm key={JSON.stringify([table, constraint, keyKind])} document={document} table={table}
        kind={keyKind} existing={constraint} run={run} close={close} />{constraint && removeButton}</>;
    if (index || selection.type === 'index') return <><h3>인덱스</h3>
      <IndexForm key={JSON.stringify([table, index])} document={document} table={table} existing={index} run={run} close={close} />
      {index && removeButton}</>;
  }

  if (table || selection.type === 'table') {
    return <>
      <h3>{table ? '테이블' : '새 테이블'}</h3>
      <Form key={JSON.stringify(table) ?? selection.type} button={table ? '테이블 적용' : '테이블 만들기'}
        disabled={capability?.table.edit !== 'supported' || !catalog.namespaces.length} submit={form => {
          const value: Catalog['tables'][number] = {
            ...named(form), id: table?.id ?? id(), namespaceId: field(form, 'namespace'), columnIds: table?.columnIds ?? [],
          };
          const command: DocumentCommand = { kind: 'put-catalog', collection: 'tables', value };
          const actions: DocumentCommand[] = [command];
          if (view && !table) actions.push(putView({ ...view, instances: [...view.instances, placement(view, value.id)] }));
          if (run({ kind: 'batch', commands: actions })) inspect({ type: 'object', id: instance?.id ?? value.id });
        }}>
        <NameFields value={table ?? { physicalName: '' }} />
        <label>네임스페이스<select name="namespace" defaultValue={table?.namespaceId ?? (selection.type === 'table' ? selection.namespaceId : undefined)}>
          {catalog.namespaces.map(item => <option key={item.id} value={item.id}>{label(item)}</option>)}
        </select></label>
      </Form>
      {table && <>
        {!readOnly && <div className="actions">
          <button type="button" onClick={() => inspect({ type: 'column', tableId: table.id })}>컬럼 추가</button>
          {(['pk', 'unique', 'check', 'index'] as const).map(type =>
            <button key={type} type="button" onClick={() => inspect({ type, tableId: table.id })}>{type.toUpperCase()} 추가</button>)}
          <button type="button" disabled={!dialect} onClick={() => fk({ tableId: table.id })}>외래 키 추가</button>
        </div>}
        <h4>컬럼</h4>
        <ul className="object-list">{columnsOf(document, table.id).map(item =>
          <li key={item.id}><button type="button" onClick={() => inspect({ type: 'object', id: item.id })}>{label(item)}</button></li>)}</ul>
        <h4>제약 및 인덱스</h4>
        <ul className="object-list">{[...catalog.constraints, ...catalog.indexes].filter(item => item.tableId === table.id)
          .map(item => <li key={item.id}><button type="button" onClick={() => inspect({ type: 'object', id: item.id })}>
            {'kind' in item ? item.kind.toUpperCase() : item.unique ? 'UNIQUE INDEX' : 'INDEX'} · {label(item)}
          </button></li>)}</ul>
        {!readOnly && view && instance && <>
          <Form key={JSON.stringify(instance)} button="배치 적용" submit={form => run(putView({
            ...view, instances: view.instances.map(item => item.id === instance.id ? {
              ...item, groupId: field(form, 'group') || undefined, collapsed: form.has('collapsed'),
            } : item),
          }))}><GroupField view={view} groupId={instance.groupId} />
            <label className="checkbox"><input type="checkbox" name="collapsed" defaultChecked={instance.collapsed} />컬럼 접기</label>
          </Form>
          <button type="button" onClick={() => {
            run({ kind: 'remove-instance', viewId: view.id, instanceId: instance.id });
            inspect({ type: 'object', id: table.id });
          }}>이 뷰에서 숨기기</button>
        </>}
        {!readOnly && view && !view.instances.some(item => item.tableId === table.id) && <button type="button" onClick={() => {
          const item = placement(view, table.id);
          if (run(putView({ ...view, instances: [...view.instances, item] }))) inspect({ type: 'object', id: item.id });
        }}>현재 뷰에 배치</button>}
        {!readOnly && <button type="button" className="danger" onClick={() => remove(table.id)}>스키마에서 실제 삭제</button>}
      </>}
    </>;
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

export function DocumentEditor({ session, local, readOnly = false, topActions, saveActions, exportAction }: {
  session: EditingSession; local?: LocalSession; readOnly?: boolean; topActions?: ReactNode; saveActions?: ReactNode; exportAction?(viewId: string | undefined): ReactNode;
}) {
  const { document } = session;
  const [chosenView, chooseView] = useState('');
  const [selection, inspect] = useState<Inspector | null>(null);
  const [query, setQuery] = useState('');
  const [snap, setSnap] = useState(true);
  const [dialog, setDialog] = useState<'document' | 'view' | null>(null);
  const [fk, setFk] = useState<FkDialog | null>(null);
  const [deletion, setDeletion] = useState('');
  const registered = dialects.get(document.target.dialectId);
  const dialect = registered?.metadata.profiles.some(profile => profile.version === document.target.engineVersion &&
    profile.status === 'certified') ? registered : undefined;
  const run: Run = command => !readOnly && !session.loading && session.run(command, (before, after) => {
    if (!dialect) return [];
    const issues = (document: ErdDocument) => document.catalog.constraints.flatMap(key => key.kind === 'fk'
      ? dialect.validateForeignKey(document, key) : []);
    const previous = new Set(issues(before).map(issue => issue.code + ':' + issue.objectId));
    return issues(after).filter(issue => !previous.has(issue.code + ':' + issue.objectId))
      .map((issue): ModelDiagnostic => ({ ...issue, severity: 'error' }));
  });
  const capability = dialect?.capabilities(document.target);
  const view = document.views.find(item => item.id === chosenView) ?? document.views[0];
  const structure = validateDocumentStructure(document);
  const semantic = dialect?.validate(document, { target: document.target }) ?? [];
  const issues = [...session.diagnostics.filter(issue => !semantic.some(item => item.code === issue.code && item.objectId === issue.objectId)), ...semantic];
  const matches = (text: string) => text.toLocaleLowerCase().includes(query.toLocaleLowerCase().trim());
  const selectView = (id: string) => { chooseView(id); inspect(null); };
  const selectObject = (id: string) => inspect({ type: 'object', id });

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

  return <EditorReadOnly.Provider value={readOnly}><main className="editor">
    <header className="topbar">
      <div className="document-title">
        <h1>{document.name}</h1>
        <span>{dialect?.metadata.name ?? document.target.dialectId} {document.target.engineVersion}</span>
      </div>
      {!readOnly && <Form key={document.id + document.name} button="제목 적용" disabled={session.loading || readOnly}
        submit={form => run({ kind: 'title', name: field(form, 'documentName') })}>
        <label>문서 제목<input name="documentName" defaultValue={document.name} maxLength={local ? undefined : 200} required /></label>
      </Form>}
      <div className="actions">
        {topActions}
        {exportAction?.(view?.id)}
        {local && <button type="button" disabled={local.loading || local.unsaved} onClick={() => setDialog('document')}>새 문서</button>}
        {!readOnly && <><button type="button" disabled={!session.canUndo} onClick={() => session.step('undo')}>실행 취소</button>
        <button type="button" disabled={!session.canRedo} onClick={() => session.step('redo')}>다시 실행</button></>}
      </div>
      <div className="save-state">
        <p role={session.status.error ? 'alert' : 'status'}>{session.status.text}</p>
        {local?.status.retry && <button type="button" onClick={() => void openRecovery()}>다시 시도</button>}
        {saveActions}
        {local?.otherTab && <p role="status">다른 탭에서 이 문서를 열었습니다.</p>}
      </div>
    </header>
    <div className="editor-layout">
      <aside className="navigator" aria-label="문서 탐색">
        <div className="section-heading"><h2>스키마</h2><button type="button" disabled={session.loading || readOnly} onClick={() => inspect({ type: 'namespace' })}>네임스페이스 추가</button></div>
        <label>스키마 및 뷰 검색<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {document.catalog.namespaces.map(namespace => {
          const tables = document.catalog.tables.filter(table => table.namespaceId === namespace.id &&
            (matches(label(namespace)) || matches(label(table) + ' ' + (table.logicalName ?? ''))));
          if (!tables.length && !matches(label(namespace))) return null;
          return <section key={namespace.id} className="schema-section">
            <button type="button" onClick={() => selectObject(namespace.id)}>{label(namespace)}</button>
            <ul className="object-list">{tables.map(table => <li key={table.id}>
              <button type="button" onClick={() => selectObject(view?.instances.find(item => item.tableId === table.id)?.id ?? table.id)}>{label(table)}</button>
            </li>)}</ul>
            <button type="button" disabled={session.loading || readOnly} onClick={() => inspect({ type: 'table', namespaceId: namespace.id })}>테이블 추가</button>
          </section>;
        })}
        <div className="section-heading"><h2>뷰</h2><button type="button" disabled={session.loading || readOnly} onClick={() => setDialog('view')}>뷰 추가</button></div>
        <ul className="object-list">{document.views.filter(item => matches(item.name)).map(item => <li key={item.id}>
          <button type="button" aria-pressed={view?.id === item.id} onClick={() => selectView(item.id)}>{item.name}</button>
        </li>)}</ul>
        {view && !readOnly && <ViewSettings key={view.id + view.name} view={view} run={run} choose={selectView} />}
        <div className="section-heading"><h2>논리 관계</h2>
          <button type="button" disabled={readOnly || !document.catalog.tables.length} onClick={() => inspect({ type: 'relationship' })}>관계 추가</button></div>
        <ul className="object-list">{document.relationships.map(item => <li key={item.id}>
          <button type="button" onClick={() => selectObject(item.id)}>{item.name}</button></li>)}</ul>
        <h2>SQL 지원</h2>
        <ul className="support-list">
          <li>DDL 가져오기 · {capability?.table.import === 'supported' ? '지원' : '미구현'}</li>
          <li>DDL 내보내기 · {capability?.table.export === 'supported' ? (local ? '서버 문서에서 지원' : '지원') : '미구현'}</li>
          {(['enum', 'sequence', 'identity'] as const).map(feature =>
            <li key={feature}>{feature.toUpperCase()} · {capability?.[feature].edit === 'supported' ? '편집 가능' : '보존 전용'}</li>)}
        </ul>
        {local && local.drafts.length > 0 && <><h2>브라우저 복구본</h2><ul className="object-list">
          {local.drafts.map(draft => <li key={draft.key}><button type="button" disabled={local.unsaved} onClick={() => void openRecovery(draft.key)}>
            {'invalid' in draft ? '손상된 복구본' :
              `${draft.tabId ? '탭 충돌 복구본' : '저장된 복구본'} · ${draft.updatedAt} · ${draft.documentId}`}
          </button></li>)}
        </ul></>}
      </aside>
      <section className="workspace" aria-label="다이어그램">
        {view ? <>
          <div className="canvas-toolbar">
            <h2>{view.name}</h2>
            <label>이름 표시<select disabled={readOnly} value={view.nameDisplay ?? 'physical'} onChange={event =>
              run(putView({ ...view, nameDisplay: event.target.value === 'logical' ? 'logical' : 'physical' }))}>
              <option value="physical">물리명</option><option value="logical">논리명</option>
            </select></label>
            <label className="checkbox"><input type="checkbox" checked={snap} disabled={readOnly} onChange={event => setSnap(event.target.checked)} />그리드 맞춤</label>
            <button type="button" disabled={readOnly} onClick={() => {
              const group = { id: id(), name: '새 그룹', x: 0, y: 0 };
              if (run(putView({ ...view, groups: [...view.groups, group] }))) selectObject(group.id);
            }}>그룹 추가</button>
            <button type="button" disabled={readOnly} onClick={() => {
              const note = { id: id(), text: '새 메모', x: 120, y: -100 };
              if (run(putView({ ...view, notes: [...view.notes, note] }))) selectObject(note.id);
            }}>메모 추가</button>
          </div>
          <div className="canvas">
            <EditorCanvas key={document.id + view.id} document={document} view={view} dialect={dialect} select={selectObject} move={move} snap={snap} readOnly={readOnly}
              connect={(sourceColumnId, targetColumnId) => {
                const source = document.catalog.columns.find(item => item.id === sourceColumnId);
                const target = document.catalog.columns.find(item => item.id === targetColumnId);
                if (dialect && source && target) setFk({ tableId: source.tableId, targetTableId: target.tableId, sourceColumnId, targetColumnId });
              }} />
          </div>
        </> : <p className="empty-view">도면을 그리려면 뷰를 추가하세요.</p>}
      </section>
      <aside className="inspector" aria-label="속성">
        <h2>속성</h2>
        {!session.loading && <Properties document={document} view={view} dialect={dialect} selection={selection}
          run={run} inspect={inspect} fk={setFk} remove={setDeletion} readOnly={readOnly} />}
        <h2>진단</h2>
        <p role="status">{structure.length === 0 ? '구조 검증 통과' : '구조 오류 ' + structure.length + '건'}</p>
        {issues.length > 0 && <ul className="diagnostics">{issues.map((issue, index) => <li key={index}>
          {issue.objectId && <button type="button" onClick={() => selectObject(issue.objectId ?? '')}>{issue.objectId}</button>}
          <span>{issue.message}</span>
        </li>)}</ul>}
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
    {fk && dialect && <ForeignKeyForm document={document} dialect={dialect} seed={fk} run={run} close={() => setFk(null)} />}
    {deletion && <DeleteSchema document={document} objectId={deletion} run={run} close={() => setDeletion('')} />}
  </main></EditorReadOnly.Provider>;
}
