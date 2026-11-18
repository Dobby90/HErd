import { useRef, useState } from 'react';
import { Modal } from './editor-fields.js';
import { ApiFailure, apiRequest } from './project-api.js';
import type { SavedRevision, SnapshotDetail, SnapshotInfo } from './project-api.js';

const kinds: Record<SnapshotInfo['kind'], string> = {
  manual: '수동 저장', checkpoint: '자동 체크포인트', 'before-import': 'DDL 교체 전', 'before-restore': '버전 복원 전',
};

interface Page {
  revision: number;
  snapshots: SnapshotInfo[];
  hasMore: boolean;
}

type RestoreRequest = { baseRevision: number; mutationId: string };

export function VersionHistory({ erdId, csrf, readOnly, disabled, save, openVersion, restored }: {
  erdId: string; csrf?: string | null; readOnly: boolean; disabled: boolean;
  save(action: string): Promise<number>;
  openVersion(version: SnapshotDetail): void;
  restored(result: SavedRevision, synchronize?: boolean): void;
}) {
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<Page>();
  const [nextOffset, setNextOffset] = useState(0);
  const [selected, setSelected] = useState<SnapshotDetail>();
  const [description, setDescription] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<RestoreRequest>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [conflicted, setConflicted] = useState(false);
  const manual = useRef<{ baseRevision: number; description: string; mutationId: string } | undefined>(undefined);
  const path = '/erds/' + erdId + '/revisions';

  async function load(offset = 0) {
    const data = await apiRequest<Page>(path + '?offset=' + offset);
    setNextOffset(offset + data.snapshots.length);
    setList(old => offset && old
      ? { ...data, snapshots: [...old.snapshots, ...data.snapshots.filter(next => !old.snapshots.some(item => item.id === next.id))] }
      : data);
  }

  async function act(run: () => Promise<void>) {
    setBusy(true);
    setProblem('');
    try { await run(); }
    catch (error) { setProblem(error instanceof Error ? error.message : '버전 이력 요청을 처리하지 못했습니다.'); }
    finally { setBusy(false); }
  }

  function close() {
    if (busy || pending) return;
    setOpen(false);
    setConfirming(false);
    setConflicted(false);
    setSelected(undefined);
    setList(undefined);
  }

  async function restore() {
    if (!selected || readOnly || disabled) return;
    const request = pending ?? { baseRevision: await save('버전을 복원하기'), mutationId: crypto.randomUUID() };
    setPending(request);
    try {
      const info = await apiRequest<SavedRevision>(path + '/' + selected.id + '/restore', { method: 'POST', csrf, body: request });
      setPending(undefined);
      restored(info);
    } catch (error) {
      if (error instanceof ApiFailure && error.status >= 400 && error.status < 500) {
        setPending(undefined);
        setConfirming(false);
        setConflicted(error.code === 'REVISION_CONFLICT');
        await load().catch(() => undefined);
      }
      throw error;
    }
  }

  return <>
    <button type="button" disabled={disabled} onClick={() => { setOpen(true); void act(() => load()); }}>버전 이력</button>
    {open && <Modal title="서버 버전 이력" close={close}>
      <p>{list && `현재 서버 리비전 ${list.revision} · `}아래에는 열거나 복원할 수 있는 스냅샷이 표시됩니다.</p>
      {!readOnly && !selected && <form className="version-form" onSubmit={event => {
        event.preventDefault();
        void act(async () => {
          const baseRevision = await save('스냅샷을 저장하기');
          if (manual.current?.baseRevision !== baseRevision || manual.current.description !== description) {
            manual.current = { baseRevision, description, mutationId: crypto.randomUUID() };
          }
          await apiRequest(path, { method: 'POST', csrf, body: manual.current });
          manual.current = undefined;
          setDescription('');
          await load();
        });
      }}>
        <label>스냅샷 설명<input value={description} maxLength={200} onChange={event => setDescription(event.target.value)} /></label>
        <button disabled={busy || disabled} type="submit">수동 스냅샷 저장</button>
      </form>}
      {busy && <p role="status">서버와 동기화 중</p>}
      {problem && <p role="alert">{problem}</p>}
      {selected ? <section>
        <h3>{kinds[selected.kind]} · 리비전 {selected.sourceRevision}</h3>
        <p>{selected.document.name} · 테이블 {selected.document.catalog.tables.length}개 · 뷰 {selected.document.views.length}개</p>
        {selected.description && <p>{selected.description}</p>}
        {confirming && <p>현재 ERD의 모델, 제목, 모든 뷰를 이 버전으로 교체합니다. 현재 서버 버전은 복원 전 스냅샷으로 보존됩니다.</p>}
        {pending && problem && <p>복원 응답을 확인하지 못했습니다. 동일한 요청으로 다시 시도하거나 서버 최신본을 여세요.</p>}
        <div className="actions">
          {!pending && <button type="button" disabled={busy} onClick={() => { setConfirming(false); setSelected(undefined); }}>버전 목록</button>}
          {!confirming && <button type="button" disabled={busy} onClick={() => { close(); openVersion(selected); }}>과거 버전 열기</button>}
          {!readOnly && !conflicted && (confirming
            ? <button type="button" className="danger" disabled={busy || disabled} onClick={() => void act(restore)}>
              {pending ? '같은 복원 요청 다시 시도' : '확인하고 버전 복원'}
            </button>
            : <button type="button" disabled={busy || disabled} onClick={() => setConfirming(true)}>이 버전으로 복원</button>)}
          {((pending && problem) || conflicted) && <button type="button" disabled={busy} onClick={() => void act(async () => {
            const current = await apiRequest<SavedRevision>('/erds/' + erdId);
            setPending(undefined);
            restored(current, true);
          })}>서버 최신본 열기</button>}
        </div>
      </section> : <>
        {list && !list.snapshots.length && <p>저장된 스냅샷이 없습니다.</p>}
        <ul className="version-list">{list?.snapshots.map(item => <li key={item.id}>
          <button type="button" disabled={busy} onClick={() => void act(async () => {
            setSelected(await apiRequest<SnapshotDetail>(path + '/' + item.id));
          })}>{kinds[item.kind]} · 리비전 {item.sourceRevision}</button>
          <span>{item.author} · <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time></span>
          {item.description && <span>{item.description}</span>}
        </li>)}</ul>
        {list?.hasMore && <button type="button" disabled={busy} onClick={() => void act(() => load(nextOffset))}>이전 버전 더 보기</button>}
        {problem && <button type="button" disabled={busy} onClick={() => void act(() => load())}>이력 다시 불러오기</button>}
      </>}
    </Modal>}
  </>;
}
