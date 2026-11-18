import { useEffect, useRef, useState } from 'react';
import { commitDocument, documentHistory, stepHistory } from '@erd/model';
import type { DocumentCommand, DocumentHistory, ErdDocument, ModelDiagnostic } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';
import { draftKey, readDrafts, restoreDraft, writeDraft } from './recovery.js';
import type { Draft } from './recovery.js';

const activeKey = 'erd-active-draft';
const sample = () => structuredClone(sampleDocument);
type Pending = { document: ErdDocument; sequence: number; recoveryKey: string };
type Session = { history: DocumentHistory; generation: number; recoveryKey: string };
type SaveState = { text: string; error?: boolean; retry?: 'read' | 'write' };
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

function recoveryError(error: unknown): SaveState {
  const message = error instanceof Error ? error.message : '';
  return {
    text: message.includes('Future document format version') ? '이 복구본은 더 최신 문서 형식입니다.' : '복구본이 손상되었습니다.',
    error: true, retry: 'read',
  };
}

export function useEditorSession() {
  const [document, setDocument] = useState(sample);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<SaveState>(initialSave);
  const [diagnostics, setDiagnostics] = useState<ModelDiagnostic[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [otherTab, setOtherTab] = useState(false);
  const sessions = useRef(new Map<string, Session>());
  const active = useRef(draftKey(sampleDocument.id));
  const pending = useRef(new Map<string, Pending>());
  const writes = useRef(Promise.resolve());
  const sequence = useRef(0);
  const tab = useRef('');
  const channel = useRef<BroadcastChannel | null>(null);

  function switchTo(value: ErdDocument, recoveryKey: string, generation: number) {
    let session = sessions.current.get(recoveryKey);
    if (!session || (!pending.current.has(recoveryKey) && generation > session.generation)) {
      session = { history: documentHistory(value), generation, recoveryKey };
      sessions.current.set(recoveryKey, session);
    }
    active.current = recoveryKey;
    setDocument(session.history.present);
    setDiagnostics([]);
    markActive(session.recoveryKey, generation >= 0);
  }

  function restore(draft: Draft) {
    try {
      const value = restoreDraft(draft);
      const generation = draft.tabId ? -1 : draft.generation;
      switchTo(value, draft.key, generation);
      setStatus(pending.current.has(draft.key) ? { text: '브라우저 저장 중' } : {
        text: draft.tabId ? '탭 충돌 복구본을 열었습니다.' : '브라우저 복구 완료',
      });
    } catch (error) {
      setStatus(recoveryError(error));
    }
  }

  function reload() {
    return readDrafts().then(records => {
      setDrafts(records);
      const preferred = preferredKey();
      const draft = records.find(item => item.key === preferred) ?? (preferred ? undefined : records[0]);
      if (draft && !pending.current.size && sequence.current === 0) restore(draft);
      else if (!pending.current.size) setStatus({ text: records.length ? '복구본을 선택할 수 있습니다.' : '브라우저 임시 저장 대기' });
    }, () => setStatus({ text: '브라우저 복구본을 읽을 수 없습니다.', error: true, retry: 'read' }))
      .finally(() => setLoading(false));
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

  function save(work: Pending, session: Session) {
    setStatus({ text: '브라우저 저장 중' });
    pending.current.set(work.recoveryKey, work);
    writes.current = writes.current.then(async () => {
      try {
        const { draft, conflict } = await writeDraft(work.document, session.generation, tab.current);
        session.generation = conflict ? -1 : draft.generation;
        session.recoveryKey = draft.key;
        if (pending.current.get(work.recoveryKey)?.sequence === work.sequence) {
          pending.current.delete(work.recoveryKey);
          if (active.current === work.recoveryKey) {
            if (draft.key !== work.recoveryKey) {
              sessions.current.delete(work.recoveryKey);
              sessions.current.set(draft.key, session);
              active.current = draft.key;
            }
            markActive(draft.key, !conflict);
            setStatus({ text: conflict ? '탭 충돌 · 별도 복구본 저장 완료' : '브라우저 저장 완료' });
          }
        }
        if (active.current === work.recoveryKey || active.current === draft.key) channel.current?.postMessage({ kind: 'saved', tab: tab.current });
        void readDrafts().then(setDrafts, () => undefined);
      } catch (error) {
        if (active.current !== work.recoveryKey || pending.current.get(work.recoveryKey)?.sequence !== work.sequence) return;
        const quota = error instanceof DOMException && error.name === 'QuotaExceededError';
        setStatus({ text: quota ? '브라우저 저장 공간이 부족합니다.' : '브라우저 저장에 실패했습니다.', error: true, retry: 'write' });
      }
    });
  }

  function update(history: DocumentHistory, session: Session) {
    if (session.history === history) return;
    session.history = history;
    setDocument(history.present);
    save({ document: history.present, sequence: ++sequence.current, recoveryKey: active.current }, session);
  }

  const history = sessions.current.get(active.current)?.history;
  return {
    document, loading, status, drafts, otherTab, diagnostics,
    unsaved: pending.current.has(active.current),
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
      save({ document: value, sequence: ++sequence.current, recoveryKey: key }, session);
    },
    restore,
    retry() {
      if (status.retry === 'read') void reload();
      else {
        const work = pending.current.get(active.current);
        if (work) save(work, current());
      }
    },
  };
}
