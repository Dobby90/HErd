import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { duplicateDocument } from '@erd/model';
import { createEditorDocument, DocumentEditor, editorTargets } from './editor.js';
import { field, Form, Modal } from './editor-fields.js';
import { ApiFailure, apiRequest } from './project-api.js';
import type { DocumentSummary, Identity, Project, ServerDocument } from './project-api.js';
import { readDraft, readDrafts, restoreDraft } from './recovery.js';
import { removeServerDraft, serverDrafts } from './server-drafts.js';
import type { ServerDraft } from './server-drafts.js';
import { ServerEditor } from './server-editor.js';

type Location = { projectId?: string; documentId?: string };
type ProjectView = { project: Project; documents: DocumentSummary[] };
type OpenDocument = { id: string; editor: ServerEditor; drafts: ServerDraft[] };
type LocalDraft = { key: string; name: string; updatedAt: string };
const readLocation = (): Location => {
  const query = new URLSearchParams(window.location.search);
  return { projectId: query.get('project') ?? undefined, documentId: query.get('erd') ?? undefined };
};
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
const date = (value: string) => new Date(value).toLocaleString();
const textMatch = (text: string, query: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());

function WorkspaceEditor({ entry, readOnly, suspended, topActions, preview, fork, discard, logIn }: {
  entry: OpenDocument; readOnly: boolean; suspended: boolean; topActions: ReactNode; preview(): void; fork(): void;
  discard(draft?: ServerDraft): void; logIn(): void;
}) {
  const { editor, drafts } = entry;
  const state = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const [problem, setProblem] = useState('');
  const [ignored, ignore] = useState<string[]>([]);
  const status = {
    saved: `서버 저장됨 · 리비전 ${state.revision}`, saving: '서버 저장 중', failed: '서버 저장 실패',
    offline: '오프라인', conflict: '저장 충돌', login: '로그인 만료',
  }[state.phase];
  async function restore(draft: ServerDraft) {
    setProblem('');
    try {
      editor.restore(draft);
      if (await editor.safeguard()) {
        await removeServerDraft(draft.key, draft);
        ignore(keys => [...keys, draft.key]);
      }
    } catch (error) {
      setProblem(message(error));
    }
  }

  return <DocumentEditor readOnly={readOnly || suspended} topActions={topActions} session={{
    document: state.history.present, loading: false, diagnostics: state.diagnostics,
    canUndo: state.history.past.length > 0, canRedo: state.history.future.length > 0,
    status: { text: readOnly ? `읽기 전용 · 리비전 ${state.revision}` : status, error: !['saved', 'saving'].includes(state.phase) },
    run: (command, guard) => editor.run(command, guard), step: direction => editor.step(direction),
  }} saveActions={<>
    {state.issue && <p>{state.issue}</p>}
    {state.recoveryIssue && <p role="alert">{state.recoveryIssue}</p>}
    {problem && <p role="alert">{problem}</p>}
    {state.phase === 'conflict' && <div className="actions">
      <button type="button" onClick={preview}>서버 최신본 확인</button>
      <button type="button" onClick={fork}>내 변경을 새 문서로 복제</button>
      <button type="button" onClick={() => discard()}>변경 폐기 후 다시 열기</button>
    </div>}
    {state.phase === 'login' && <button type="button" onClick={logIn}>재로그인</button>}
    {(state.phase === 'offline' || state.phase === 'failed' || state.recoveryIssue) &&
      <button type="button" onClick={() => editor.retry()}>저장 다시 시도</button>}
    {!readOnly && drafts.some(draft => !ignored.includes(draft.key)) && <details>
      <summary>브라우저 복구본</summary>
      <ul className="object-list">{drafts.filter(draft => !ignored.includes(draft.key)).map(draft =>
        <li key={draft.key} className="actions">
          <button type="button" disabled={editor.hasChanges()} onClick={() => void restore(draft)}>
            복구본 열기 · {date(draft.updatedAt)} · 기준 리비전 {draft.baseRevision}
          </button>
          <button type="button" aria-label={`브라우저 복구본 삭제 ${date(draft.updatedAt)}`} onClick={() => {
            if (window.confirm('이 브라우저 복구본을 삭제하시겠습니까?')) {
              void removeServerDraft(draft.key, draft).then(() => ignore(keys => [...keys, draft.key]), error => setProblem(message(error)));
            }
          }}>삭제</button>
        </li>)}</ul>
    </details>}
  </>} />;
}

function ServerPreview({ envelope, close }: { envelope: ServerDocument; close(): void }) {
  return <DocumentEditor readOnly topActions={<button type="button" onClick={close}>내 편집으로 돌아가기</button>} session={{
    document: envelope.document, loading: false, diagnostics: [], canUndo: false, canRedo: false,
    status: { text: `서버 최신본 · 리비전 ${envelope.revision}` }, run: () => false, step: () => undefined,
  }} />;
}

export function Workspace() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const currentIdentity = useRef<Identity | null>(null);
  const [location, setLocation] = useState(readLocation);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectView, setProjectView] = useState<ProjectView>();
  const [open, setOpen] = useState<OpenDocument>();
  const [preview, setPreview] = useState<ServerDocument>();
  const [query, setQuery] = useState('');
  const [epoch, reload] = useState(0);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [loginPrompt, setLoginPrompt] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'local'>();
  const [localDrafts, setLocalDrafts] = useState<LocalDraft[]>([]);
  const editors = useRef(new Map<string, ServerEditor>());
  const projectId = location.projectId;
  const documentId = location.documentId;
  const owner = identity?.user?.id;
  const project = projectView?.project.id === projectId ? projectView?.project : undefined;

  function go(next: Location) {
    const query = new URLSearchParams({ workspace: '1' });
    if (next.projectId) query.set('project', next.projectId);
    if (next.documentId) query.set('erd', next.documentId);
    window.history.pushState(null, '', '/?' + query);
    setLocation(next);
    setPreview(undefined);
    setQuery('');
    setProblem('');
    reload(value => value + 1);
  }

  async function refreshIdentity() {
    const identity = await apiRequest<Identity>('/me');
    if (currentIdentity.current?.user?.id !== identity.user?.id) {
      for (const editor of editors.current.values()) editor.stop();
      editors.current.clear();
      setProjects(null);
      setProjectView(undefined);
      setOpen(undefined);
    }
    currentIdentity.current = identity;
    setIdentity(identity);
    return identity;
  }

  async function act(action: () => Promise<void>) {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setProblem('');
    try {
      await action();
    } catch (error) {
      setProblem(message(error));
      if (error instanceof ApiFailure && error.status === 401) setLoginPrompt(true);
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  useEffect(() => {
    void act(async () => { await refreshIdentity(); });
    const onPop = () => { setLocation(readLocation()); setPreview(undefined); setProblem(''); setQuery(''); };
    const online = () => { for (const editor of editors.current.values()) editor.online(); };
    const leave = (event: BeforeUnloadEvent) => {
      if ([...editors.current.values()].some(editor => editor.hasUnprotectedChanges())) {
        event.preventDefault();
        event.returnValue = true;
      }
    };
    window.addEventListener('popstate', onPop);
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', leave);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', leave);
    };
  }, []);

  useEffect(() => {
    if (!owner) return;
    let current = true;
    async function load(userId: string) {
      if (!projectId) {
        const list = await apiRequest<Project[]>('/projects');
        if (current) setProjects(list);
        return;
      }
      const base = '/projects/' + projectId;
      const [info, documents] = await Promise.all([apiRequest<Project>(base), apiRequest<DocumentSummary[]>(base + '/erds')]);
      if (!current) return;
      setProjectView({ project: info, documents });
      if (!documentId) return;
      if (!documents.some(item => item.id === documentId)) throw new Error('이 프로젝트에서 ERD를 찾을 수 없습니다.');
      const [envelope, drafts] = await Promise.all([
        apiRequest<ServerDocument>('/erds/' + documentId),
        serverDrafts(userId, documentId).catch(() => []),
      ]);
      if (!current) return;
      let editor = editors.current.get(documentId);
      if (!editor || (!editor.hasChanges() && envelope.revision > editor.snapshot().revision)) {
        editor?.stop();
        editor = new ServerEditor(userId, envelope, () =>
          currentIdentity.current?.user?.id === userId ? currentIdentity.current.csrfToken : null);
        editors.current.set(documentId, editor);
      }
      setOpen({ id: documentId, editor, drafts: drafts.filter(draft => !editor.ownsDraft(draft.key)) });
    }
    void load(owner).catch(error => {
      if (!current) return;
      setProblem(message(error));
      if (error instanceof ApiFailure && error.status === 401) setLoginPrompt(true);
    });
    return () => { current = false; };
  }, [owner, projectId, documentId, epoch]);

  const csrf = identity?.csrfToken;
  const refresh = () => reload(value => value + 1);

  async function protectWork() {
    const results = await Promise.all([...editors.current.values()].map(editor => editor.safeguard()));
    if (results.some(saved => !saved)) throw new Error('저장하지 못한 작업의 브라우저 복구본을 만들 수 없습니다. 다시 시도해 주세요.');
  }

  function logIn(development: boolean) {
    void act(async () => {
      await protectWork();
      if (!development) {
        window.location.assign('/api/auth/login?returnTo=' + encodeURIComponent('/' + window.location.search));
        return;
      }
      await apiRequest('/auth/development', { method: 'POST' });
      const signedIn = await refreshIdentity();
      setLoginPrompt(false);
      for (const editor of editors.current.values()) {
        if (editor.owner === signedIn.user?.id && editor.snapshot().phase === 'login') editor.retry();
      }
      refresh();
    });
  }

  function logOut() {
    void act(async () => {
      await protectWork();
      await apiRequest('/auth/logout', { method: 'POST', csrf }).catch(error => {
        if (!(error instanceof ApiFailure && error.status === 401)) throw error;
      });
      await refreshIdentity();
      setLoginPrompt(false);
    });
  }

  const backToProject = () => go({ projectId });
  const loginButtons = <div className="actions">
    {identity?.auth.oidc && <button type="button" disabled={busy} onClick={() => logIn(false)}>OIDC 로그인</button>}
    {identity?.auth.development && <button type="button" disabled={busy} onClick={() => logIn(true)}>개발 계정으로 로그인</button>}
  </div>;

  if (owner && project && open && open.id === documentId) {
    const discard = () => {
      if (!window.confirm('현재 로컬 변경을 폐기하고 서버 버전을 다시 열겠습니까?')) return;
      void act(async () => {
        const envelope = await apiRequest<ServerDocument>('/erds/' + open.id);
        await open.editor.discard();
        const editor = new ServerEditor(owner, envelope, () =>
          currentIdentity.current?.user?.id === owner ? currentIdentity.current.csrfToken : null);
        editors.current.set(open.id, editor);
        setOpen({ ...open, editor });
        setPreview(undefined);
      });
    };
    return <>
      {preview?.document.id === documentId ? <ServerPreview key={preview.revision} envelope={preview} close={() => setPreview(undefined)} /> :
        <WorkspaceEditor key={open.id + ':' + open.editor.instanceKey} entry={open} readOnly={project.role === 'viewer'} suspended={busy}
          topActions={<><button type="button" onClick={backToProject}>ERD 목록</button>
            <button type="button" disabled={busy} onClick={logOut}>로그아웃</button></>}
          preview={() => void act(async () => setPreview(await apiRequest<ServerDocument>('/erds/' + open.id)))}
          fork={() => void act(async () => {
            const source = open.editor.snapshot().history.present;
            const document = duplicateDocument(source, crypto.randomUUID(), source.name.slice(0, 194) + ' (내 편집)');
            const copy = await apiRequest<ServerDocument>('/projects/' + project.id + '/erds', { method: 'POST', csrf, body: { document } });
            await open.editor.discard();
            editors.current.delete(open.id);
            go({ projectId, documentId: copy.document.id });
          })}
          discard={discard} logIn={() => setLoginPrompt(true)} />}
      {problem && <p className="workspace-notice" role="alert">{problem}</p>}
      {loginPrompt && <Modal title="다시 로그인" close={() => setLoginPrompt(false)}>{loginButtons}</Modal>}
    </>;
  }

  const writable = project && project.role !== 'viewer';
  const openLocal = () => void act(async () => {
    const entries = await readDrafts();
    const local = entries.filter(entry => !('invalid' in entry)).flatMap(entry => {
      try {
        const { document, draft } = restoreDraft(entry);
        return [{ key: draft.key, name: document.name, updatedAt: draft.updatedAt }];
      } catch {
        return [];
      }
    });
    setLocalDrafts(local);
    setDialog('local');
  });

  return <main className="project-page">
    <header className="topbar">
      <h1>ERD 프로젝트</h1>
      {owner && projectId && <button type="button" onClick={() => go({})}>프로젝트 목록</button>}
      <a href="/" className="workspace-link">로컬 편집기</a>
      {identity?.user && <div className="actions project-account"><span>{identity.user.displayName}</span>
        <button type="button" disabled={busy} onClick={logOut}>로그아웃</button></div>}
    </header>
    <div className="project-content">
      {problem && <p role="alert">{problem}</p>}
      {!identity && <><p role="status">{busy ? '로그인 상태 확인 중' : '로그인 상태를 확인하지 못했습니다.'}</p>
        {!busy && <button type="button" onClick={() => void act(async () => { await refreshIdentity(); })}>다시 시도</button>}</>}
      {identity && !identity.user && <section className="project-panel">
        <h2>프로젝트에 로그인</h2>
        {loginButtons}
        {!identity.auth.oidc && !identity.auth.development && <p>프로젝트 저장을 사용하려면 서비스 DB와 로그인 공급자를 설정하세요.</p>}
      </section>}
      {owner && !projectId && <section className="project-panel" aria-label="프로젝트 목록">
        <h2>프로젝트</h2>
        <Form disabled={busy} button="프로젝트 생성" submit={form => void act(async () => {
          const created = await apiRequest<Project>('/projects', { method: 'POST', csrf, body: { name: field(form, 'name') } });
          go({ projectId: created.id });
        })}><label>새 프로젝트 이름<input name="name" required maxLength={200} /></label></Form>
        <label>프로젝트 검색<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {!projects ? <p role="status">프로젝트 불러오는 중</p> : projects.length === 0 ? <p>프로젝트가 없습니다.</p> :
          <ul className="project-list">{projects.filter(item => textMatch(item.name, query)).map(item =>
            <li key={item.id}><button type="button" onClick={() => go({ projectId: item.id })}>{item.name}</button>
              <span>{item.role} · ERD {item.documentCount}개</span><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time></li>)}</ul>}
      </section>}
      {owner && projectId && !project && !problem && <p role="status">프로젝트 불러오는 중</p>}
      {project && <section className="project-panel" aria-label="ERD 목록">
        <div className="section-heading"><h2>{project.name}</h2><p>{project.role} · ERD {project.documentCount}개</p></div>
        {project.role === 'owner' && <div className="project-tools">
          <Form disabled={busy} key={project.id + project.name} button="프로젝트 이름 변경" submit={form => void act(async () => {
            await apiRequest('/projects/' + project.id, { method: 'PATCH', csrf, body: { name: field(form, 'name') } });
            refresh();
          })}><label>프로젝트 이름<input name="name" required maxLength={200} defaultValue={project.name} /></label></Form>
          <button type="button" className="danger" disabled={busy} onClick={() => {
            if (!window.confirm(`프로젝트 '${project.name}'와 포함된 ERD ${project.documentCount}개를 모두 삭제하시겠습니까?`)) return;
            void act(async () => {
              await apiRequest('/projects/' + project.id, { method: 'DELETE', csrf, body: { documentCount: project.documentCount } });
              for (const document of projectView?.documents ?? []) {
                editors.current.get(document.id)?.stop();
                editors.current.delete(document.id);
              }
              go({});
            });
          }}>프로젝트 삭제</button>
        </div>}
        {writable && <div className="actions">
          <button type="button" disabled={busy} onClick={() => setDialog('new')}>새 ERD</button>
          <button type="button" disabled={busy} onClick={openLocal}>로컬 복구본 가져오기</button>
        </div>}
        <label>ERD 검색<input type="search" value={query} onChange={event => setQuery(event.target.value)} /></label>
        {documentId && !problem && <p role="status">ERD 불러오는 중</p>}
        {projectView?.documents.length === 0 ? <p>저장된 ERD가 없습니다.</p> :
          <ul className="project-list">{projectView?.documents.filter(item => textMatch(item.title, query)).map(item =>
            <li key={item.id}>
              <button type="button" onClick={() => go({ projectId, documentId: item.id })}>{item.title}</button>
              <span>리비전 {item.revision}</span><time dateTime={item.updatedAt}>{date(item.updatedAt)}</time>
              {writable && <div className="actions">
                <button type="button" disabled={busy} aria-label={item.title + ' 복제'} onClick={() => void act(async () => {
                  const copy = await apiRequest<ServerDocument>('/erds/' + item.id + '/duplicate', { method: 'POST', csrf });
                  go({ projectId, documentId: copy.document.id });
                })}>복제</button>
                {project.role === 'owner' && <button type="button" className="danger" disabled={busy} aria-label={item.title + ' 삭제'} onClick={() => {
                  if (!window.confirm(`ERD '${item.title}'을 삭제하시겠습니까?`)) return;
                  void act(async () => {
                    await apiRequest('/erds/' + item.id, { method: 'DELETE', csrf });
                    editors.current.get(item.id)?.stop();
                    editors.current.delete(item.id);
                    refresh();
                  });
                }}>삭제</button>}
              </div>}
            </li>)}</ul>}
      </section>}
    </div>
    {loginPrompt && owner && <Modal title="다시 로그인" close={() => setLoginPrompt(false)}>{loginButtons}</Modal>}
    {dialog === 'new' && writable && <Modal title="새 서버 ERD" close={() => setDialog(undefined)}>
      <Form button="ERD 생성" disabled={busy} cancel={() => setDialog(undefined)} submit={form => void act(async () => {
        const choice = editorTargets[Number(field(form, 'target'))];
        if (!choice) return;
        const document = createEditorDocument(field(form, 'name').trim(), { dialectId: choice.dialectId, engineVersion: choice.engineVersion });
        if (!document) throw new Error('ERD 이름을 입력하세요.');
        const saved = await apiRequest<ServerDocument>('/projects/' + project.id + '/erds', { method: 'POST', csrf, body: { document } });
        setDialog(undefined);
        go({ projectId, documentId: saved.document.id });
      })}>
        <label>ERD 이름<input name="name" maxLength={200} required /></label>
        <label>SQL 대상<select name="target">{editorTargets.map((target, index) =>
          <option value={index} key={target.name}>{target.name}</option>)}</select></label>
        {problem && <p role="alert">{problem}</p>}
      </Form>
    </Modal>}
    {dialog === 'local' && writable && <Modal title="로컬 복구본을 새 ERD로 저장" close={() => setDialog(undefined)}>
      {localDrafts.length ? <Form button="새 ERD로 저장" disabled={busy} cancel={() => setDialog(undefined)} submit={form => void act(async () => {
        const { document: local } = restoreDraft(await readDraft(field(form, 'draft')));
        const name = field(form, 'name').trim() || local.name.slice(0, 200);
        const document = duplicateDocument(local, crypto.randomUUID(), name);
        const saved = await apiRequest<ServerDocument>('/projects/' + project.id + '/erds', { method: 'POST', csrf, body: { document } });
        setDialog(undefined);
        go({ projectId, documentId: saved.document.id });
      })}>
        <label>로컬 복구본<select name="draft" required>{localDrafts.map(draft =>
          <option key={draft.key} value={draft.key}>{draft.name} · {date(draft.updatedAt)}</option>)}</select></label>
        <label>새 ERD 이름<input name="name" maxLength={200} placeholder="복구본 이름 사용" /></label>
        {problem && <p role="alert">{problem}</p>}
      </Form> : <p>가져올 로컬 복구본이 없습니다.</p>}
    </Modal>}
  </main>;
}
