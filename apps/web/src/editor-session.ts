import { useEffect, useRef, useState } from 'react';
import { commitDocument, documentHistory, stepHistory } from '@erd/model';
import type { DocumentCommand, DocumentHistory, ErdDocument, ModelDiagnostic } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';
import { draftKey, readDraft, readDrafts, restoreDraft, writeDraft } from './recovery.js';
import type { Draft, DraftEntry } from './recovery.js';

const activeKey = 'erd-active-draft';
const sample = () => structuredClone(sampleDocument);
type Pending = { document: ErdDocument };
type Session = { history: DocumentHistory; generation: number; recoveryKey: string };
type SaveState = { text: string; error?: boolean; retry?: { kind: 'read'; key?: string } | { kind: 'write' } };
const initialSave = { text: '복구본 확인 중' };

function markActive(key: string, shared = true) {
  try {
    sessionStorage.setItem(activeKey, key);
    if (shared) localStorage.setItem(activeKey, key);
  } catch {
    // IndexedDB retains the draft when browser preferences are unavailable.
  }
}

function preferredKey() {
  try {
    return sessionStorage.getItem(activeKey) ?? localStorage.getItem(activeKey);
  } catch {
    return null;
  }
}

function recoveryError(error: unknown, key: string): SaveState {
  const message = error instanceof Error ? error.message : '';
  return {
    text: message.includes('Future document format version') ? '이 복구본은 더 최신 문서 형식입니다.' : '복구본이 손상되었습니다.',
    error: true, retry: { kind: 'read', key },
  };
}

export function useEditorSession() {
  const [document, setDocument] = useState(sample);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveState>(initialSave);
  const [diagnostics, setDiagnostics] = useState<ModelDiagnostic[]>([]);
  const [drafts, setDrafts] = useState<DraftEntry[]>([]);
  const [otherTab, setOtherTab] = useState(false);
  const sessions = useRef(new Map<string, Session>());
  const active = useRef(draftKey(sampleDocument.id));
  const pending = useRef(new Map<Session, Pending>());
  const writes = useRef(Promise.resolve());
  const readAttempt = useRef(0);
  const tab = useRef('');
  const channel = useRef<BroadcastChannel | null>(null);

  function switchTo(value: ErdDocument, draft: Draft) {
    let session = sessions.current.get(draft.key);
    if (!session || (!pending.current.has(session) && draft.generation > session.generation)) {
      session = { history: documentHistory(value), generation: draft.generation, recoveryKey: draft.key };
      sessions.current.set(draft.key, session);
    }
    active.current = draft.key;
    setDocument(session.history.present);
    setDiagnostics([]);
    markActive(draft.key, !draft.tabId);
  }

  async function restore(key: string) {
    const attempt = ++readAttempt.current;
    setStatus(initialSave);
    let stored: unknown;
    try {
      stored = await readDraft(key);
    } catch {
      if (attempt === readAttempt.current) {
        setStatus({ text: '브라우저 복구본을 읽을 수 없습니다.', error: true, retry: { kind: 'read', key } });
      }
      return false;
    }
    if (attempt !== readAttempt.current) return false;
    try {
      const { document, draft } = restoreDraft(stored);
      switchTo(document, draft);
      setStatus({ text: draft.tabId ? '탭 충돌 복구본을 열었습니다.' : '브라우저 복구 완료' });
      void readDrafts().then(setDrafts, () => undefined);
      return true;
    } catch (error) {
      setStatus(recoveryError(error, key));
      return false;
    }
  }

  async function reload() {
    const attempt = ++readAttempt.current;
    try {
      const records = await readDrafts();
      setDrafts(records);
      if (attempt !== readAttempt.current) return false;
      const preferred = preferredKey();
      const key = preferred ?? records[0]?.key;
      if (key) return await restore(key);
      setStatus({ text: records.length ? '복구본을 선택할 수 있습니다.' : '브라우저 임시 저장 대기' });
    } catch {
      if (attempt === readAttempt.current) {
        setStatus({ text: '브라우저 복구본을 읽을 수 없습니다.', error: true, retry: { kind: 'read' } });
      }
    } finally {
      setLoading(false);
    }
    return false;
  }

  useEffect(() => {
    tab.current = crypto.randomUUID();
    void reload();
    const warn = (event: BeforeUnloadEvent) => {
      if (!pending.current.size) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  useEffect(() => {
    setOtherTab(false);
    if (typeof BroadcastChannel !== 'function') return;
    const connection = new BroadcastChannel('erd-local-document:' + document.id);
    channel.current = connection;
    const peers = new Set<string>();
    connection.onmessage = ({ data }) => {
      if (data.tab === tab.current) return;
      if (data.kind === 'leave') peers.delete(data.tab);
      else peers.add(data.tab);
      setOtherTab(peers.size > 0);
      if (data.kind === 'open') connection.postMessage({ kind: 'present', tab: tab.current });
      if (data.kind === 'saved') void readDrafts().then(setDrafts, () => undefined);
    };
    connection.postMessage({ kind: 'open', tab: tab.current });
    const leave = () => connection.postMessage({ kind: 'leave', tab: tab.current });
    window.addEventListener('pagehide', leave);
    return () => {
      window.removeEventListener('pagehide', leave);
      leave();
      connection.close();
      channel.current = null;
    };
  }, [document.id]);

  function current(): Session {
    let session = sessions.current.get(active.current);
    if (!session) {
      session = { history: documentHistory(document), generation: 0, recoveryKey: active.current };
      sessions.current.set(active.current, session);
    }
    return session;
  }

  function save(value: ErdDocument, session: Session) {
    ++readAttempt.current;
    setStatus({ text: '브라우저 저장 중' });
    const work = { document: value };
    pending.current.set(session, work);
    writes.current = writes.current.then(async () => {
      try {
        const previousKey = session.recoveryKey;
        const { draft, conflict } = await writeDraft(work.document, previousKey, session.generation, tab.current);
        const isActive = active.current === previousKey;
        session.generation = draft.generation;
        session.recoveryKey = draft.key;
        if (draft.key !== previousKey) {
          sessions.current.delete(previousKey);
          sessions.current.set(draft.key, session);
          if (isActive) active.current = draft.key;
        }
        if (pending.current.get(session) === work) {
          pending.current.delete(session);
          if (isActive) {
            markActive(draft.key, !draft.tabId);
            setStatus({ text: conflict ? '탭 충돌 · 별도 복구본 저장 완료' : '브라우저 저장 완료' });
          }
        }
        if (isActive) channel.current?.postMessage({ kind: 'saved', tab: tab.current });
        void readDrafts().then(setDrafts, () => undefined);
      } catch (error) {
        if (active.current !== session.recoveryKey || pending.current.get(session) !== work) return;
        const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
        setStatus({ text: quota ? '브라우저 저장 공간이 부족합니다.' : '브라우저 저장에 실패했습니다.',
          error: true, retry: { kind: 'write' } });
      }
    });
  }

  function update(history: DocumentHistory, session: Session) {
    if (session.history === history) return;
    session.history = history;
    setDocument(history.present);
    save(history.present, session);
  }

  const session = sessions.current.get(active.current);
  const history = session?.history;
  return {
    document, loading, status, drafts, otherTab, diagnostics,
    unsaved: Boolean(session && pending.current.has(session)),
    canUndo: Boolean(history?.past.length), canRedo: Boolean(history?.future.length),
    run(command: DocumentCommand, guard?: (before: ErdDocument, after: ErdDocument) => ModelDiagnostic[]) {
      const session = current();
      const result = commitDocument(session.history, command);
      const rejected = result.history !== session.history ? guard?.(session.history.present, result.history.present) ?? [] : [];
      setDiagnostics(rejected.length ? rejected : result.diagnostics);
      if (rejected.length) return false;
      update(result.history, session);
      return !result.diagnostics.some(issue => issue.code !== 'invalidated-expression');
    },
    step(direction: 'undo' | 'redo') {
      const session = current();
      setDiagnostics([]);
      update(stepHistory(session.history, direction), session);
    },
    start(value: ErdDocument) {
      const key = draftKey(value.id);
      const session = { history: documentHistory(value), generation: 0, recoveryKey: key };
      active.current = key;
      sessions.current.set(key, session);
      setDocument(value);
      setDiagnostics([]);
      save(value, session);
    },
    restore,
    retry() {
      if (status.retry?.kind === 'read') return status.retry.key ? restore(status.retry.key) : reload();
      if (session) {
        const work = pending.current.get(session);
        if (work) save(work.document, session);
      }
    },
  };
}
