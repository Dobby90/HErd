import { commitDocument, documentHistory, stepHistory } from '@erd/model';
import type { DocumentCommand, DocumentHistory, ErdDocument, ModelDiagnostic } from '@erd/model';
import { ApiFailure, apiRequest } from './project-api.js';
import type { Mutation, SavedRevision, ServerDocument } from './project-api.js';
import { openServerDraft, removeServerDraft, storeServerDraft } from './server-drafts.js';
import type { ServerDraft } from './server-drafts.js';

type Phase = 'saved' | 'saving' | 'failed' | 'offline' | 'conflict' | 'login';
type Guard = (before: ErdDocument, after: ErdDocument) => ModelDiagnostic[];
interface State {
  history: DocumentHistory;
  diagnostics: ModelDiagnostic[];
  revision: number;
  updatedAt: string;
  phase: Phase;
  issue?: string;
  recoveryIssue?: string;
}

const debounce = 1000;
const reconnectDelay = 750;
const reconnectLimit = 3;

export class ServerEditor {
  private state: State;
  private readonly listeners = new Set<() => void>();
  readonly instanceKey = crypto.randomUUID();
  private readonly documentId: string;
  private version = 0;
  private saved = 0;
  private recoverableVersion = 0;
  private pending?: { mutation: Mutation; version: number };
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private recovery = Promise.resolve(true);
  private reconnectAttempts = 0;
  private stopped = false;

  constructor(readonly owner: string, envelope: ServerDocument, private readonly csrf: () => string | null) {
    this.documentId = envelope.document.id;
    this.state = { history: documentHistory(envelope.document), diagnostics: [],
      revision: envelope.revision, updatedAt: envelope.updatedAt, phase: 'saved' };
  }

  snapshot = () => this.state;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private update(changes: Partial<State>) {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }

  hasUnprotectedChanges() {
    return this.version > Math.max(this.saved, this.recoverableVersion);
  }

  ownsDraft(key: string) {
    return this.instanceKey === key;
  }

  hasChanges() {
    return this.version > this.saved;
  }

  private keepRecovery() {
    const generation = this.version;
    const clean = generation === this.saved;
    const { revision, history } = this.state;
    const pending = this.pending?.mutation;
    this.recovery = this.recovery.then(async () => {
      try {
        if (clean) await removeServerDraft(this.instanceKey);
        else await storeServerDraft(this.instanceKey, this.owner, revision, history.present, pending);
        this.recoverableVersion = generation;
        this.update({ recoveryIssue: undefined });
        return true;
      } catch {
        this.update({ recoveryIssue: '브라우저 복구본을 갱신하지 못했습니다.' });
        return clean;
      }
    });
    return this.recovery;
  }

  async safeguard() {
    if (!this.hasChanges()) return true;
    await this.keepRecovery();
    return !this.hasUnprotectedChanges();
  }

  run(command: DocumentCommand, guard?: Guard) {
    const { history } = this.state;
    const next = commitDocument(history, command);
    const rejected = next.history !== history ? guard?.(history.present, next.history.present) ?? [] : [];
    this.update({ diagnostics: rejected.length ? rejected : next.diagnostics });
    if (rejected.length) return false;
    this.edit(next.history);
    return !next.diagnostics.some(issue => issue.code !== 'invalidated-expression');
  }

  step(direction: 'undo' | 'redo') {
    this.update({ diagnostics: [] });
    this.edit(stepHistory(this.state.history, direction));
  }

  private edit(history: DocumentHistory) {
    if (this.stopped || history === this.state.history) return;
    this.version += 1;
    this.update({ history });
    void this.keepRecovery();
    if (this.state.phase === 'saved' || this.state.phase === 'saving') this.schedule();
  }

  private schedule(delay = debounce) {
    if (this.stopped || !this.hasChanges()) return;
    clearTimeout(this.timer);
    this.update({ phase: 'saving', issue: undefined });
    this.timer = setTimeout(() => { void this.flush(); }, delay);
  }

  retry() {
    this.reconnectAttempts = 0;
    if (this.state.phase !== 'conflict' && this.hasChanges()) this.schedule(0);
    else if (this.state.recoveryIssue) void this.keepRecovery();
  }

  online() {
    if (this.state.phase === 'offline') this.retry();
  }

  private reconnect() {
    if (this.stopped || this.reconnectAttempts >= reconnectLimit) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (this.stopped || this.state.phase !== 'offline') return;
      // Loopback services can be reachable even when the browser reports offline.
      this.reconnectAttempts += 1;
      this.schedule(0);
    }, reconnectDelay * 2 ** this.reconnectAttempts);
  }

  async ensureSaved(action: string) {
    while (!this.stopped && this.hasChanges() && this.state.phase === 'saving') {
      clearTimeout(this.timer);
      await (this.inFlight ?? this.flush());
    }
    if (this.stopped || this.hasChanges() || this.state.phase !== 'saved') {
      throw new Error(action + ' 전에 서버 저장 실패 또는 충돌을 해결해 주세요.');
    }
    return { document: this.state.history.present, revision: this.state.revision, updatedAt: this.state.updatedAt };
  }

  private async flush() {
    if (this.stopped || this.inFlight || !this.hasChanges() || this.state.phase !== 'saving') return;
    const attempt = this.pending ?? {
      version: this.version,
      mutation: { baseRevision: this.state.revision, mutationId: crypto.randomUUID(), document: this.state.history.present },
    };
    this.pending = attempt;
    const work = async () => {
      await this.keepRecovery();
      if (this.stopped) return;
      try {
        const saved = await apiRequest<SavedRevision>('/erds/' + this.documentId, {
          method: 'PUT', body: attempt.mutation, csrf: this.csrf(),
        });
        if (this.stopped) return;
        this.saved = attempt.version;
        this.pending = undefined;
        this.reconnectAttempts = 0;
        this.update({ revision: saved.revision, updatedAt: saved.updatedAt, phase: this.hasChanges() ? 'saving' : 'saved' });
        void this.keepRecovery();
      } catch (error) {
        if (this.stopped) return;
        const problem = error instanceof ApiFailure ? error : undefined;
        const phase = problem?.code === 'REVISION_CONFLICT' ? 'conflict'
          : problem?.status === 401 ? 'login' : problem?.status === 0 ? 'offline' : 'failed';
        if (problem && [400, 403, 413, 422].includes(problem.status)) this.pending = undefined;
        this.update({ phase, issue: problem?.message ?? '저장 응답을 확인하지 못했습니다.' });
        void this.keepRecovery();
        if (phase === 'offline') this.reconnect();
      }
    };
    this.inFlight = work();
    try {
      await this.inFlight;
    } finally {
      this.inFlight = undefined;
    }
    if (!this.stopped && this.state.phase === 'saving') {
      clearTimeout(this.timer);
      void this.flush();
    }
  }

  restore(draft: ServerDraft) {
    const { document, pending } = openServerDraft(draft, this.owner, this.documentId);
    if (this.hasChanges() || this.inFlight) throw new Error('현재 편집을 먼저 저장하거나 복구해 주세요.');
    this.version += 1;
    // A persisted retry may describe an earlier edit than the newest local document.
    if (pending) {
      const sameSnapshot = JSON.stringify(pending.document) === JSON.stringify(document);
      this.pending = { mutation: pending, version: sameSnapshot ? this.version : this.saved };
    }
    const matches = draft.baseRevision === this.state.revision;
    this.update({ history: documentHistory(document), revision: draft.baseRevision, diagnostics: [],
      phase: matches ? 'saving' : 'conflict', issue: matches ? undefined : '복구본의 기준 리비전과 현재 서버 버전이 다릅니다.' });
    void this.keepRecovery();
    if (matches) this.schedule(0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  async discard() {
    this.stop();
    await this.inFlight;
    await this.recovery;
    await removeServerDraft(this.instanceKey);
  }
}
