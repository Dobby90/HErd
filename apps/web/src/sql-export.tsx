import { useEffect, useRef, useState } from 'react';
import type { ErdDocument } from '@erd/model';
import type { DialectProfile, GenerateJobOptions, GenerateSqlJob } from '@erd/sql-contract';
import { Modal } from './editor-fields.js';
import { apiRequest } from './project-api.js';
import type { ServerDocument } from './project-api.js';

const labels: Record<GenerateSqlJob['state'], string> = {
  queued: '대기 중', running: '생성 중', succeeded: '완료', failed: '실패', cancelled: '취소됨',
};
const objects = { namespaces: '스키마', tables: '테이블', columns: '컬럼', constraints: '제약', indexes: '인덱스', enums: 'ENUM', sequences: '시퀀스' };
const active = (job?: GenerateSqlJob) => job?.state === 'queued' || job?.state === 'running';
const failure = (error: unknown) => error instanceof Error ? error.message : 'SQL 작업을 처리하지 못했습니다.';

export function SqlExport({ document, revision, dirty, projectId, csrf, viewId, disabled, viewer, prepare }: {
  document: ErdDocument; revision: number; dirty: boolean; projectId: string; csrf?: string | null; viewId?: string;
  disabled: boolean; viewer: boolean; prepare(): Promise<ServerDocument>;
}) {
  const [open, setOpen] = useState(false);
  const [job, setJob] = useState<GenerateSqlJob>();
  const [fileName, setFileName] = useState('');
  const [scope, setScope] = useState<'all' | 'view' | 'tables'>('all');
  const [select, setSelect] = useState<string[]>([]);
  const [comments, setComments] = useState(true);
  const [source, setSource] = useState<ErdDocument>();
  const [catalog, setCatalog] = useState<DialectProfile[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [copied, setCopied] = useState(false);
  const [expired, setExpired] = useState(false);
  const submission = useRef<{ signature: string; mutationId: string } | undefined>(undefined);
  const currentJob = useRef<GenerateSqlJob | undefined>(undefined);
  currentJob.current = job;
  const live = active(job);
  const working = busy || live;
  const displayed = source ?? document;
  const view = displayed.views.find(view => view.id === viewId);
  const viewTables = view?.instances.map(item => item.tableId) ?? [];
  const tableIds = scope === 'all' ? undefined : scope === 'view' ? [...new Set(viewTables)] : select;
  const profile = catalog?.find(item => item.metadata.id === displayed.target.dialectId);
  const available = profile?.versions.find(item => item.version === displayed.target.engineVersion)?.capabilities.table?.export === 'supported';
  const stale = Boolean(job && (revision > job.revision || dirty));
  const sameOptions = (options: GenerateJobOptions, tableIds?: readonly string[]) => options.includeComments === comments &&
    JSON.stringify(options.tableIds ?? null) === JSON.stringify(tableIds ? [...tableIds].sort() : null);
  const optionsChanged = Boolean(job && !sameOptions(job.options, tableIds));
  const planned = job?.state === 'succeeded' && sameOptions(job.options, tableIds) && !expired;

  useEffect(() => {
    if (!open) return;
    let current = true;
    void apiRequest<DialectProfile[]>('/sql/dialects').then(profiles => {
      if (current) setCatalog(profiles);
    }, error => { if (current) setError(failure(error)); });
    return () => { current = false; };
  }, [open]);

  useEffect(() => {
    if (!job || !live || pollError) return;
    let current = true;
    const timer = setTimeout(() => {
      void apiRequest<GenerateSqlJob>('/sql/jobs/' + job.id).then(next => {
        if (current) setJob(previous => previous?.id === next.id && active(previous) ? next : previous);
      }, error => { if (current) setPollError(failure(error)); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [job, live, pollError]);

  useEffect(() => {
    if (!job?.expiresAt) return;
    const timer = setTimeout(() => {
      setExpired(true);
      setJob(previous => previous?.id === job.id ? { ...previous, output: null } : previous);
    }, Math.max(0, Date.parse(job.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [job?.id, job?.expiresAt]);

  async function openExport() {
    setSource(undefined);
    setOpen(true);
    if (!viewer) return;
    setBusy(true);
    setError('');
    try {
      const saved = await prepare();
      setSource(saved.document);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }

  async function requestJob(previewOnly: boolean) {
    setBusy(true);
    setError('');
    setCopied(false);
    setPollError('');
    try {
      const saved = await prepare();
      setSource(saved.document);
      const latestTables = new Set(saved.document.catalog.tables.map(item => item.id));
      const selected = scope === 'view'
        ? [...new Set(saved.document.views.find(view => view.id === viewId)?.instances.map(item => item.tableId) ?? [])]
        : tableIds;
      if (selected && (!selected.length || selected.some(id => !latestTables.has(id)))) {
        setSelect(select.filter(id => latestTables.has(id)));
        throw new Error('최신 문서에서 내보낼 테이블을 선택하세요.');
      }
      if (!previewOnly && selected && (!planned || job?.revision !== saved.revision || !sameOptions(job.options, selected))) {
        throw new Error('문서 또는 선택 범위가 변경되었습니다. 의존성을 다시 확인하세요.');
      }
      const options: GenerateJobOptions = { tableIds: selected, includeComments: comments, previewOnly };
      const payload = { kind: 'generate', erdId: saved.document.id, revision: saved.revision, options };
      const signature = JSON.stringify(payload);
      if (submission.current?.signature !== signature) submission.current = { signature, mutationId: crypto.randomUUID() };
      const next = await apiRequest<GenerateSqlJob>('/projects/' + projectId + '/sql/jobs', {
        method: 'POST', csrf, body: { ...payload, mutationId: submission.current.mutationId },
      });
      submission.current = undefined;
      setExpired(false);
      setFileName(saved.document.name);
      setJob(next);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!job) return;
    setBusy(true);
    setPollError('');
    try {
      const cancelled = await apiRequest<GenerateSqlJob>('/sql/jobs/' + job.id, { method: 'DELETE', csrf });
      if (currentJob.current?.id === job.id) setJob(cancelled);
    } catch (error) {
      setError(failure(error));
    } finally {
      setBusy(false);
    }
  }

  const sql = job?.state === 'succeeded' && !expired && !optionsChanged ? job.output?.sql : undefined;
  const download = () => {
    if (!job || !sql) return;
    const url = URL.createObjectURL(new Blob([sql], { type: 'application/sql;charset=utf-8' }));
    const link = window.document.createElement('a');
    link.href = url;
    link.download = fileName.replace(/[\\/:*?"<>|\p{Cc}]/gu, '_').slice(0, 100) + '-r' + job.revision + '.sql';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const namespaceNames = new Map(displayed.catalog.namespaces.map(item => [item.id, item.physicalName]));

  return <>
    <button type="button" disabled={disabled} onClick={() => void openExport()}>DDL 내보내기</button>
    {open && <Modal title="DDL 내보내기" close={() => setOpen(false)}>
      <section className="sql-export">
        <p>{profile?.metadata.name ?? displayed.target.dialectId} {displayed.target.engineVersion}</p>
        <fieldset disabled={working}>
          <label>내보낼 범위<select value={scope} onChange={event => setScope(event.target.value as typeof scope)}>
            <option value="all">전체 스키마</option>
            <option value="view" disabled={!view}>현재 뷰{view ? ' · ' + view.name : ''}</option>
            <option value="tables">선택한 테이블</option>
          </select></label>
          {scope === 'tables' && <div className="sql-table-list">{displayed.catalog.tables.map(table =>
            <label className="checkbox" key={table.id}><input type="checkbox" checked={select.includes(table.id)}
              onChange={event => setSelect(event.target.checked ? [...select, table.id] : select.filter(id => id !== table.id))} />
              {namespaceNames.get(table.namespaceId)}.{table.physicalName}
            </label>)}</div>}
          <label className="checkbox"><input type="checkbox" checked={comments} onChange={event => setComments(event.target.checked)} />설명 포함</label>
        </fieldset>
        <div className="actions">
          {scope !== 'all' && <button type="button" disabled={!available || working || !tableIds?.length}
            onClick={() => void requestJob(true)}>의존성 확인</button>}
          <button type="button" disabled={!available || working || (scope !== 'all' && !planned)}
            onClick={() => void requestJob(false)}>{sql ? '다시 생성' : 'SQL 생성'}</button>
          {live && <button type="button" disabled={busy} onClick={() => void cancel()}>작업 취소</button>}
        </div>
        {busy && <p role="status">서버 리비전과 SQL 작업 확인 중</p>}
        {job && <p role="status">작업 {labels[job.state]} · 원본 리비전 {job.revision} · 어댑터 {job.adapterVersion}</p>}
        {stale && <p>현재 편집본과 원본 리비전이 다릅니다. 최신 내용이 필요하면 다시 생성하세요.</p>}
        {expired && <p>결과 보관 기간이 지났습니다. SQL을 다시 생성하세요.</p>}
        {error && <p role="alert">{error}</p>}
        {pollError && <p role="alert">{pollError} <button type="button" onClick={() => setPollError('')}>상태 다시 조회</button></p>}
        {job?.output?.diagnostics.length ? <ul aria-label="내보내기 진단">
          {job.output.diagnostics.map((item, index) => <li key={item.code + index}>{item.message}
            {item.objectId && ' · ' + item.objectId}</li>)}
        </ul> : null}
        {job?.options.tableIds && job.output && !optionsChanged && <div>
          <h3>자동 포함 의존성</h3>
          {job.output.dependencies.length ? <ul>{job.output.dependencies.map(item =>
            <li key={item.objectId}>{objects[item.kind]} · {[item.namespace, item.name].filter(Boolean).join('.')}</li>)}</ul> :
            <p>자동으로 추가할 객체가 없습니다.</p>}
        </div>}
        {sql && <>
          <label>SQL 미리보기<textarea readOnly value={sql} rows={10} /></label>
          <div className="actions">
            <button type="button" onClick={() => void navigator.clipboard.writeText(sql).then(
              () => setCopied(true), () => setError('클립보드에 복사하지 못했습니다.'))}>SQL 복사</button>
            <button type="button" onClick={download}>.sql 다운로드</button>
            {copied && <span role="status">복사 완료</span>}
          </div>
        </>}
      </section>
    </Modal>}
  </>;
}
