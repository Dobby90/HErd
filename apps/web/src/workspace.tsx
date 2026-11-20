import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { ImportApplied } from '@erd/sql-contract';
import { duplicateDocument } from '@erd/model';
import { AdminUsers } from './admin-users.js';
import { createEditorDocument, DocumentEditor, editorTargets } from './editor.js';
import { ActionMenu, AppVersion, Icon } from './editor-controls.js';
import { field, Form, Modal } from './editor-fields.js';
import { ApiFailure, apiRequest } from './project-api.js';
import type { DocumentSummary, Identity, Project, SavedRevision, ServerDocument, SnapshotDetail } from './project-api.js';
import { ProjectMembers } from './project-members.js';
import { countDrafts, readDraft, readDrafts, restoreDraft } from './recovery.js';
import { removeServerDraft, serverDrafts } from './server-drafts.js';
import type { ServerDraft } from './server-drafts.js';
import { SqlExport } from './sql-export.js';
import { SqlImport } from './sql-import.js';
import { ServerEditor } from './server-editor.js';
import { ThemeToggle } from './theme.js';
import { ErdThumbnail } from './erd-thumbnail.js';
import { VersionHistory } from './version-history.js';

type Location = { projectId?: string; documentId?: string };
type ProjectView = { project: Project; documents: DocumentSummary[] };
type OpenDocument = { id: string; editor: ServerEditor; drafts: ServerDraft[] };
type LocalDraft = { key: string; name: string; updatedAt: string };
type LocalImport = { key: string; name: string; document: ReturnType<typeof duplicateDocument> };
const readLocation = (): Location => {
  const query = new URLSearchParams(window.location.search);
  return { projectId: query.get('project') ?? undefined, documentId: query.get('erd') ?? undefined };
};
const message = (error: unknown) => error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
const date = (value: string) => new Date(value).toLocaleString();
const listDate = (value: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium' }).format(new Date(value));
const textMatch = (text: string, query: string) => text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
const roles = { owner: '소유자', editor: '편집 가능', viewer: '읽기 전용' };

function PasswordAccess({ busy, signIn, reauthenticate = false }: {
  busy: boolean; signIn(registration: boolean, values: FormData): void; reauthenticate?: boolean;
}) {
  const [registration, setRegistration] = useState(false);
  return <div className="account-access">
    <Form key={String(registration)} button={registration ? '가입하고 로그인' : '로그인'} disabled={busy}
      submit={values => signIn(registration, values)}>
      <label>아이디<input name="username" autoComplete="username" minLength={3} maxLength={64} required /></label>
      {registration && <label>표시 이름<input name="displayName" autoComplete="name" maxLength={100} required /></label>}
      <label>비밀번호<input name="password" type="password" autoComplete={registration ? 'new-password' : 'current-password'}
        required /></label>
    </Form>
    {!reauthenticate && <button type="button" className="quiet accent" disabled={busy} onClick={() => setRegistration(value => !value)}>
      {registration ? '로그인으로 돌아가기' : '계정 만들기'}
    </button>}
  </div>;
}

function WorkspaceEditor({ entry, projectId, csrf, readOnly, suspended, topActions, initialPlacement, onImported, openVersion, onRestored, preview, fork, discard, logIn }: {
  entry: OpenDocument; projectId: string; csrf: string | null | undefined; readOnly: boolean; suspended: boolean; topActions: ReactNode;
  initialPlacement?: ImportApplied['placement'];
  onImported(result: ImportApplied): void; openVersion(snapshot: SnapshotDetail): void; onRestored(result: SavedRevision, synchronize?: boolean): void;
  preview(): void; fork(): void;
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

  const document = state.history.present;
  const destination = { id: entry.id, target: document.target };
  return <DocumentEditor readOnly={readOnly || suspended} initialPlacement={initialPlacement} topActions={<>{topActions}
    <VersionHistory erdId={entry.id} csrf={csrf} readOnly={readOnly} disabled={suspended} openVersion={openVersion} restored={onRestored}
      save={async action => (await editor.ensureSaved(action)).revision} />
  </>}
    importAction={readOnly ? undefined : viewId => <>
      <SqlImport projectId={projectId} csrf={csrf} disabled={suspended} onApplied={onImported}
        destination={{ ...destination, mode: 'append', viewId, viewName: document.views.find(view => view.id === viewId)?.name,
          namespaces: document.catalog.namespaces, savedRevision: async () => (await editor.ensureSaved('테이블을 추가하기')).revision }} />
      <SqlImport projectId={projectId} csrf={csrf} disabled={suspended} onApplied={onImported}
        destination={{ ...destination, mode: 'change', viewId, namespaces: document.catalog.namespaces,
          savedRevision: async () => (await editor.ensureSaved('모델을 변경하기')).revision }} />
      <SqlImport projectId={projectId} csrf={csrf} disabled={suspended} onApplied={onImported}
        destination={{ ...destination, mode: 'replace', savedRevision: async () => (await editor.ensureSaved('모델을 교체하기')).revision }} />
    </>}
    verifyImage={() => apiRequest<void>('/erds/' + entry.id, { method: 'HEAD' })}
    exportAction={(viewId, openDiagnostic) => <SqlExport document={state.history.present} revision={state.revision} dirty={editor.hasChanges()}
      projectId={projectId} csrf={csrf} viewId={viewId} disabled={suspended} viewer={readOnly} openDiagnostic={openDiagnostic}
      prepare={() => readOnly ? apiRequest<ServerDocument>('/erds/' + state.history.present.id) : editor.ensureSaved('DDL을 내보내기')} />}
    session={{
    document: state.history.present, diagnostics: state.diagnostics,
    canUndo: state.history.past.length > 0, canRedo: state.history.future.length > 0,
    status: { text: readOnly ? `읽기 전용 · 리비전 ${state.revision}` : status, error: !['saved', 'saving'].includes(state.phase) },
    run: (command, guard) => editor.run(command, guard), step: direction => editor.step(direction),
  }} saveActions={<>
    {state.issue && <p>{state.issue}</p>}
    {state.recoveryIssue && <p role="alert">{state.recoveryIssue}</p>}
    {problem && <p role="alert">{problem}</p>}
    {!readOnly && !suspended && state.phase === 'conflict' && <div className="actions">
      <button type="button" onClick={preview}>서버 최신본 확인</button>
      <button type="button" onClick={fork}>내 변경을 새 문서로 복제</button>
      <button type="button" onClick={() => discard()}>변경 폐기 후 다시 열기</button>
    </div>}
    {state.phase === 'login' && <button type="button" onClick={logIn}>재로그인</button>}
    {!readOnly && !suspended && (state.phase === 'offline' || state.phase === 'failed' || state.recoveryIssue) &&
      <button type="button" onClick={() => editor.retry()}>저장 다시 시도</button>}
    {!readOnly && drafts.some(draft => !ignored.includes(draft.key)) && <details>
      <summary>브라우저 복구본</summary>
      <ul className="object-list">{drafts.filter(draft => !ignored.includes(draft.key)).map(draft =>
        <li key={draft.key} className="actions">
          <button type="button" disabled={suspended || editor.hasChanges()} onClick={() => void restore(draft)}>
            복구본 열기 · {date(draft.updatedAt)} · 기준 리비전 {draft.baseRevision}
          </button>
          <button type="button" disabled={suspended} aria-label={`브라우저 복구본 삭제 ${date(draft.updatedAt)}`} onClick={() => {
            if (window.confirm('이 브라우저 복구본을 삭제하시겠습니까?')) {
              void removeServerDraft(draft.key, draft).then(() => ignore(keys => [...keys, draft.key]), error => setProblem(message(error)));
            }
          }}>삭제</button>
        </li>)}</ul>
    </details>}
  </>} />;
}

type Preview = { envelope: ServerDocument; snapshotId?: string };

function ServerPreview({ preview: { envelope, snapshotId }, close }: { preview: Preview; close(): void }) {
  const url = '/erds/' + envelope.document.id + (snapshotId ? '/revisions/' + snapshotId : '');
  return <DocumentEditor readOnly verifyImage={() => apiRequest<void>(url, { method: 'HEAD' })}
    topActions={<button type="button" onClick={close}>{snapshotId ? '현재 문서로 돌아가기' : '내 편집으로 돌아가기'}</button>} session={{
    document: envelope.document, diagnostics: [], canUndo: false, canRedo: false,
    status: { text: `${snapshotId ? '과거 버전 · 읽기 전용' : '서버 최신본'} · 리비전 ${envelope.revision}` }, run: () => false, step: () => undefined,
  }} />;
}

export function Workspace() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const currentIdentity = useRef<Identity | null>(null);
  const [location, setLocation] = useState(readLocation);
  const currentLocation = useRef(location);
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [projectView, setProjectView] = useState<ProjectView>();
  const [open, setOpen] = useState<OpenDocument>();
  const [preview, setPreview] = useState<Preview>();
  const [query, setQuery] = useState('');
  const [epoch, reload] = useState(0);
  const [problem, setProblem] = useState('');
  const [denied, setDenied] = useState<string>();
  const [notice, setNotice] = useState<{ text: string; transient?: boolean }>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [loginPrompt, setLoginPrompt] = useState(false);
  const [dialog, setDialog] = useState<'new' | 'local' | 'new-project' | 'rename'>();
  const [applied, setApplied] = useState<ImportApplied>();
  const [localDrafts, setLocalDrafts] = useState<{ available: LocalDraft[]; invalid: number }>({ available: [], invalid: 0 });
  const [legacyCount, setLegacyCount] = useState(0);
  const [legacyLink] = useState(() => new URLSearchParams(window.location.search).has('local'));
  const localImport = useRef<LocalImport>(undefined);
  const editors = useRef(new Map<string, ServerEditor>());
  const projectId = location.projectId;
  const documentId = location.documentId;
  const owner = identity?.user?.id;
  const project = projectView?.project.id === projectId ? projectView?.project : undefined;
  const noticeVisible = Boolean(owner && project && open && open.id === documentId && !problem);

  useEffect(() => {
    let active = true;
    void countDrafts().then(count => { if (active) setLegacyCount(count); }, () => undefined);
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!notice?.transient || !noticeVisible) return;
    const timer = window.setTimeout(() => setNotice(current => current === notice ? undefined : current), 3500);
    return () => window.clearTimeout(timer);
  }, [notice, noticeVisible]);

  function go(next: Location) {
    const query = new URLSearchParams();
    if (next.projectId) query.set('project', next.projectId);
    if (next.documentId) query.set('erd', next.documentId);
    window.history.pushState(null, '', query.size ? '/?' + query : '/');
    currentLocation.current = next;
    setLocation(next);
    setPreview(undefined);
    setApplied(undefined);
    setDialog(undefined);
    setNotice(undefined);
    setQuery('');
    setProblem('');
    setDenied(undefined);
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
      setDenied(undefined);
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
      if (error instanceof ApiFailure && error.code === 'LOGIN_REQUIRED') setLoginPrompt(true);
    } finally {
      setBusy(false);
      running.current = false;
    }
  }

  useEffect(() => {
    void act(async () => { await refreshIdentity(); });
    const onPop = () => {
      currentLocation.current = readLocation();
      setLocation(currentLocation.current);
      setPreview(undefined);
      setApplied(undefined);
      setDialog(undefined);
      setProblem('');
      setNotice(undefined);
      setDenied(undefined);
      setQuery('');
    };
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
    if (!owner || (projectId && denied === projectId)) return;
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
  }, [owner, projectId, documentId, epoch, denied]);

  const csrf = identity?.csrfToken;
  const refresh = () => reload(value => value + 1);

  useEffect(() => {
    if (!projectId || !project || !owner) return;
    let active = true;
    let checking = false;
    function clearEditors() {
      for (const item of projectView?.documents ?? []) {
        const editor = editors.current.get(item.id);
        if (editor) {
          editor.stop();
          void editor.safeguard();
          editors.current.delete(item.id);
        }
      }
      setOpen(undefined);
      setPreview(undefined);
    }
    async function check() {
      if (!active || checking) return;
      checking = true;
      try {
        const current = await apiRequest<Project>('/projects/' + projectId);
        if (!active || currentLocation.current.projectId !== projectId || currentIdentity.current?.user?.id !== owner || current.role === project?.role) return;
        clearEditors();
        setProjectView(previous => previous && previous.project.id === projectId ? { ...previous, project: current } : previous);
        setNotice({ text: current.role === 'viewer' ? '편집 권한이 변경되어 읽기 전용으로 열었습니다.' : '프로젝트 역할이 변경되었습니다.' });
        refresh();
      } catch (error) {
        if (!active || currentLocation.current.projectId !== projectId || currentIdentity.current?.user?.id !== owner) return;
        if (error instanceof ApiFailure && error.status === 404) {
          clearEditors();
          setProjectView(undefined);
          setProjects(null);
          setNotice(undefined);
          setProblem('이 프로젝트에 대한 접근 권한이 회수되었거나 프로젝트가 삭제되었습니다.');
          setDenied(projectId);
        } else if (error instanceof ApiFailure && error.status === 401) {
          setLoginPrompt(true);
        }
      } finally {
        checking = false;
      }
    }
    const interval = setInterval(() => void check(), 5000);
    window.addEventListener('focus', check);
    window.addEventListener('herd:check-project-access', check);
    return () => {
      active = false;
      clearInterval(interval);
      window.removeEventListener('focus', check);
      window.removeEventListener('herd:check-project-access', check);
    };
  }, [owner, projectId, project?.role]);

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

  function logInWithPassword(registration: boolean, values: FormData) {
    void act(async () => {
      await protectWork();
      await apiRequest(registration ? '/auth/register' : '/auth/password', { method: 'POST', body: {
        username: field(values, 'username'), password: field(values, 'password'),
        ...(registration && { displayName: field(values, 'displayName') }),
      } });
      const signedIn = await refreshIdentity();
      setLoginPrompt(false);
      if (registration || (owner && signedIn.user?.id !== owner)) {
        go({});
        return;
      }
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
  const reauth = <>
    {identity?.auth.local && <PasswordAccess busy={busy} signIn={logInWithPassword} reauthenticate />}
    {problem && <p role="alert">{problem}</p>}
    {loginButtons}
  </>;

  if (owner && project && open && open.id === documentId) {
    const editorIsCurrent = () => currentIdentity.current?.user?.id === owner &&
      currentLocation.current.documentId === open.id && editors.current.get(open.id) === open.editor;
    const reloadAfterReplacement = (status: string, result?: ImportApplied) => {
      if (!editorIsCurrent()) return;
      editors.current.delete(open.id);
      setOpen(undefined);
      setPreview(undefined);
      setApplied(result);
      setNotice({ text: status, transient: Boolean(result) });
      const reopen = (cleaned: boolean) => {
        if (currentIdentity.current?.user?.id !== owner || currentLocation.current.documentId !== open.id) return;
        if (!cleaned) setNotice({ text: status + ' 브라우저 복구본을 정리하지 못했습니다.' });
        refresh();
      };
      void open.editor.discard().then(() => reopen(true), () => reopen(false));
    };
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
      {preview?.envelope.document.id === documentId ? <ServerPreview key={preview.snapshotId ?? preview.envelope.revision} preview={preview} close={() => setPreview(undefined)} /> :
        <WorkspaceEditor key={open.id + ':' + open.editor.instanceKey} entry={open} projectId={project.id} csrf={csrf} readOnly={project.role === 'viewer'} suspended={busy}
          initialPlacement={applied?.erdId === open.id && applied.revision === open.editor.snapshot().revision ? applied.placement : undefined}
          topActions={<><button type="button" onClick={backToProject}>ERD 목록</button>
            <button type="button" disabled={busy} onClick={logOut}>로그아웃</button></>}
          onImported={result => reloadAfterReplacement(result.mode === 'change' ? `모델 변경을 리비전 ${result.revision}에 저장했습니다.`
            : result.placement ? `추가한 테이블을 리비전 ${result.revision}에 저장했습니다.`
            : `리비전 ${result.revision}에 가져오기를 적용했습니다. 교체 전 버전은 서버 이력에 저장되었습니다.`, result)}
          onRestored={(result, synchronized) => reloadAfterReplacement(synchronized ? `서버 리비전 ${result.revision}을 열었습니다.`
            : `복원 결과를 리비전 ${result.revision}으로 저장했습니다. 복원 전 버전은 서버 이력에 저장되었습니다.`)}
          openVersion={snapshot => {
            if (editorIsCurrent()) setPreview({ snapshotId: snapshot.id, envelope: {
              document: snapshot.document, revision: snapshot.sourceRevision, updatedAt: snapshot.createdAt,
            } });
          }}
          preview={() => void act(async () => {
            const envelope = await apiRequest<ServerDocument>('/erds/' + open.id);
            if (editorIsCurrent()) setPreview({ envelope });
          })}
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
      {!problem && notice && <div className="workspace-notice">
        <p role="status">{notice.text}</p>
        <button type="button" className="quiet icon-button" aria-label="알림 닫기" onClick={() => setNotice(undefined)}><Icon name="close" /></button>
      </div>}
      {loginPrompt && <Modal title="다시 로그인" close={() => setLoginPrompt(false)}>{reauth}</Modal>}
    </>;
  }

  const writable = project && project.role !== 'viewer';
  const openLocal = () => void act(async () => {
    const entries = await readDrafts();
    const available = entries.flatMap(entry => {
      if ('invalid' in entry) return [];
      try {
        const { document, draft } = restoreDraft(entry);
        return [{ key: draft.key, name: document.name, updatedAt: draft.updatedAt }];
      } catch {
        return [];
      }
    });
    localImport.current = undefined;
    setLocalDrafts({ available, invalid: entries.length - available.length });
    setDialog('local');
  });

  function projectList(items: Project[], shared = false) {
    const matching = items.filter(item => textMatch(item.name, query));
    if (!matching.length) return <div className="list-empty">
      <span className="collection-glyph"><Icon name={shared ? 'users' : 'folder'} /></span>
      <p>{query.trim() ? '검색 결과가 없습니다.' : '만든 프로젝트가 없습니다.'}</p>
    </div>;
    return <ul className="project-list">{matching.map(item =>
      <li key={item.id}>
        <button type="button" className="collection-open" aria-label={item.name} onClick={() => go({ projectId: item.id })}>
          <span className={'collection-glyph' + (shared ? ' shared-glyph' : '')}><Icon name={shared ? 'users' : 'folder'} /></span>
          <span className="collection-info"><strong>{item.name}</strong><span>ERD {item.documentCount}개{shared && ' · ' + roles[item.role]}</span></span>
          <time dateTime={item.updatedAt}>{listDate(item.updatedAt)}</time><span className="row-arrow"><Icon name="right" /></span>
        </button>
      </li>)}</ul>;
  }

  function search(label: string) {
    return <label className="collection-search"><span className="sr-only">{label}</span><Icon name="search" />
      <input type="search" placeholder={label} value={query} onChange={event => setQuery(event.target.value)} />
    </label>;
  }

  const ownProjects = projects?.filter(item => item.createdBy === owner);
  const sharedProjects = projects?.filter(item => item.createdBy !== owner);
  const documents = projectView?.documents.filter(item => textMatch(item.title, query));
  return <main className="project-page">
    <header className="topbar">
      <div className="workspace-navigation">
        <div className="brand-lockup">
          <button type="button" className="brand-home quiet" aria-label="HERD 프로젝트 홈" onClick={() => go({})}>
            <span className="brand-mark"><Icon name="brand" /></span><strong>HERD</strong>
          </button>
          <AppVersion />
        </div>
      </div>
      <div className="actions project-account">
        <ThemeToggle />
        {identity?.user && <>
          {identity.user.isAdmin && <AdminUsers key={identity.user.id + ':admin'} csrf={csrf} />}
          <span className="account-name" title={identity.user.displayName}>{identity.user.displayName}</span>
          <button type="button" className="quiet" disabled={busy} onClick={logOut}>로그아웃</button>
        </>}
      </div>
    </header>
    <div className="project-content">
      {(legacyLink || legacyCount > 0) && !documentId && <section className="local-migration" aria-label="로컬 작업 이전">
        <div>
          <h2>로컬 작업 이전</h2>
          <p>로컬 편집기가 종료되었습니다. 이 브라우저에 저장된 작업은 편집 가능한 프로젝트에서 새 ERD로 가져올 수 있습니다.</p>
        </div>
        {writable && <button type="button" disabled={busy} onClick={openLocal}>로컬 작업 옮기기</button>}
      </section>}
      {problem && <p role="alert">{problem}</p>}
      {!identity && <><p role="status">{busy ? '로그인 상태 확인 중' : '로그인 상태를 확인하지 못했습니다.'}</p>
        {!busy && <button type="button" onClick={() => void act(async () => { await refreshIdentity(); })}>다시 시도</button>}</>}
      {identity && !identity.user && <section className="project-panel login-panel">
        <span className="collection-glyph"><Icon name="brand" /></span>
        <h1>프로젝트에 로그인</h1>
        {identity.auth.local && <PasswordAccess busy={busy} signIn={logInWithPassword} />}
        {loginButtons}
        {!identity.auth.local && !identity.auth.oidc && !identity.auth.development && <p>프로젝트 저장을 사용하려면 서비스 DB와 로그인을 설정하세요.</p>}
      </section>}
      {owner && !projectId && <>
        <div className="workspace-heading">
          <h1>프로젝트</h1>
          <button type="button" className="primary" disabled={busy} onClick={() => setDialog('new-project')}>
            <Icon name="plus" />새 프로젝트
          </button>
        </div>
        {search('프로젝트 검색')}
        <section className="collection" aria-label="프로젝트 목록">
          <div className="collection-heading"><h2>내가 만든 프로젝트</h2>{ownProjects && <span>{ownProjects.length}</span>}</div>
          {ownProjects ? projectList(ownProjects) : <p role="status">프로젝트 불러오는 중</p>}
        </section>
        {Boolean(sharedProjects?.length) && <section className="collection" aria-label="공유받은 프로젝트">
          <div className="collection-heading"><h2>공유받은 프로젝트</h2><span>{sharedProjects!.length}</span></div>
          {projectList(sharedProjects!, true)}
        </section>}
      </>}
      {owner && projectId && <button type="button" className="quiet workspace-back" onClick={() => go({})}><Icon name="back" />프로젝트 목록</button>}
      {owner && projectId && !project && !problem && <p role="status">프로젝트 불러오는 중</p>}
      {project && <>
        <div className="workspace-heading">
          <div className="workspace-project-title">
            <span className="collection-glyph"><Icon name="folder" /></span>
            <div><h1>{project.name}</h1><p>{roles[project.role]}</p></div>
          </div>
          {project.role === 'owner' && owner && <div className="actions workspace-heading-actions" role="group" aria-label="프로젝트 관리">
            <ProjectMembers key={project.id} projectId={project.id} userId={owner} csrf={csrf}
              selfChanged={() => window.dispatchEvent(new Event('herd:check-project-access'))} />
            <ActionMenu label="프로젝트 설정" icon="settings" iconOnly>
              <button type="button" disabled={busy} onClick={() => setDialog('rename')}><Icon name="edit" />프로젝트 이름 변경</button>
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
              }}><Icon name="trash" />프로젝트 삭제</button>
            </ActionMenu>
          </div>}
        </div>
        <div className="collection-toolbar">
          {search('ERD 검색')}
          {writable && <div className="actions project-erd-actions" role="group" aria-label="ERD 작업">
            <ActionMenu label="가져오기" icon="import">
              <SqlImport key={project.id} projectId={project.id} csrf={csrf} disabled={busy}
                onApplied={result => go({ projectId: project.id, documentId: result.erdId })} />
              <button type="button" disabled={busy} onClick={openLocal}>로컬 복구본 가져오기</button>
            </ActionMenu>
            <button type="button" className="primary" disabled={busy} onClick={() => setDialog('new')}><Icon name="plus" />새 ERD</button>
          </div>}
        </div>
        <section className="collection" aria-label="ERD 목록">
          <div className="collection-heading"><h2>ERD 목록</h2><span>{project.documentCount}</span></div>
          {documentId && !problem && <p role="status">ERD 불러오는 중</p>}
          {documents?.length ? <ul className="project-list erd-list">{documents.map(item =>
            <li key={item.id}>
              <button type="button" className="collection-open" aria-label={item.title} onClick={() => go({ projectId, documentId: item.id })}>
                <ErdThumbnail id={item.id} revision={item.revision} />
                <span className="collection-info"><strong>{item.title}</strong><span>리비전 {item.revision}</span></span>
                <time dateTime={item.updatedAt}>{listDate(item.updatedAt)}</time><span className="row-arrow"><Icon name="right" /></span>
              </button>
              {writable && <ActionMenu label={item.title + ' 관리'} icon="more" iconOnly>
                <button type="button" disabled={busy} aria-label={item.title + ' 복제'} onClick={() => void act(async () => {
                  await editors.current.get(item.id)?.ensureSaved('ERD를 복제하기');
                  const copy = await apiRequest<ServerDocument>('/erds/' + item.id + '/duplicate', { method: 'POST', csrf });
                  if (currentLocation.current.projectId !== projectId) return;
                  if (currentLocation.current.documentId) refresh();
                  else go({ projectId, documentId: copy.document.id });
                })}><Icon name="copy" />복제</button>
                {project.role === 'owner' && <button type="button" className="danger" disabled={busy} aria-label={item.title + ' 삭제'} onClick={() => {
                  if (!window.confirm(`ERD '${item.title}'을 삭제하시겠습니까?`)) return;
                  void act(async () => {
                    await apiRequest('/erds/' + item.id, { method: 'DELETE', csrf });
                    editors.current.get(item.id)?.stop();
                    editors.current.delete(item.id);
                    refresh();
                  });
                }}><Icon name="trash" />삭제</button>}
              </ActionMenu>}
            </li>)}</ul> : <div className="list-empty">
              <span className="collection-glyph"><Icon name="brand" /></span>
              <p>{query.trim() ? '검색 결과가 없습니다.' : '저장된 ERD가 없습니다.'}</p>
            </div>}
        </section>
      </>}
    </div>
    {loginPrompt && owner && <Modal title="다시 로그인" close={() => setLoginPrompt(false)}>{reauth}</Modal>}
    {dialog === 'new-project' && owner && <Modal title="새 프로젝트" close={() => setDialog(undefined)}>
      <Form disabled={busy} button="프로젝트 생성" cancel={() => setDialog(undefined)} submit={form => void act(async () => {
        const created = await apiRequest<Project>('/projects', { method: 'POST', csrf, body: { name: field(form, 'name') } });
        go({ projectId: created.id });
      })}>
        <label>새 프로젝트 이름<input name="name" required maxLength={200} /></label>
        {problem && <p role="alert">{problem}</p>}
      </Form>
    </Modal>}
    {dialog === 'rename' && project?.role === 'owner' && <Modal title="프로젝트 이름 변경" close={() => setDialog(undefined)}>
      <Form disabled={busy} button="프로젝트 이름 변경" cancel={() => setDialog(undefined)} submit={form => void act(async () => {
        await apiRequest('/projects/' + project.id, { method: 'PATCH', csrf, body: { name: field(form, 'name') } });
        setDialog(undefined);
        refresh();
      })}>
        <label>프로젝트 이름<input name="name" required maxLength={200} defaultValue={project.name} /></label>
        {problem && <p role="alert">{problem}</p>}
      </Form>
    </Modal>}
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
    {dialog === 'local' && writable && <Modal title="로컬 복구본을 새 ERD로 저장" close={() => { if (!busy) setDialog(undefined); }}>
      {localDrafts.invalid > 0 && <p role="alert">읽을 수 없는 복구본이 {localDrafts.invalid}개 있습니다. 브라우저에 원본을 보관합니다.</p>}
      {localDrafts.available.length ? <Form button="새 ERD로 저장" disabled={busy} cancel={() => setDialog(undefined)} submit={form => void act(async () => {
        const key = field(form, 'draft');
        const name = field(form, 'name').trim();
        if (localImport.current?.key !== key || localImport.current.name !== name) {
          const { document: local } = restoreDraft(await readDraft(key));
          localImport.current = { key, name, document: duplicateDocument(local, crypto.randomUUID(), name || local.name.slice(0, 200)) };
        }
        const { document } = localImport.current;
        try {
          await apiRequest<ServerDocument>('/projects/' + project.id + '/erds', { method: 'POST', csrf, body: { document } });
        } catch (error) {
          if (!(error instanceof ApiFailure && error.code === 'DOCUMENT_ID_CONFLICT')) throw error;
          // A previous attempt may have committed before its response reached the browser.
          await apiRequest<ServerDocument>('/erds/' + document.id);
        }
        if (currentLocation.current.projectId === project.id) go({ projectId, documentId: document.id });
      })}>
        <label>로컬 복구본<select name="draft" required>{localDrafts.available.map(draft =>
          <option key={draft.key} value={draft.key}>{draft.name} · {date(draft.updatedAt)}</option>)}</select></label>
        <label>새 ERD 이름<input name="name" maxLength={200} placeholder="복구본 이름 사용" /></label>
        {problem && <p role="alert">{problem}</p>}
      </Form> : <p>가져올 로컬 복구본이 없습니다.</p>}
    </Modal>}
  </main>;
}
