import { useEffect, useRef, useState } from 'react';
import type { Catalog, SqlTarget } from '@erd/model';
import type { DialectProfile, ImportApplied, ParseSqlJob, StatementResult } from '@erd/sql-contract';
import { Modal } from './editor-fields.js';
import { apiRequest } from './project-api.js';

type ApplyMode =
  | { mode: 'create'; name: string }
  | { mode: 'replace' | 'append'; erdId: string; baseRevision: number };
type Destination = { id: string; target: SqlTarget; savedRevision(): Promise<number> } & (
  { mode: 'replace' } | { mode: 'append'; viewId?: string; viewName?: string; namespaces: Catalog['namespaces'] }
);
type Profile = DialectProfile & { maxInputBytes?: number };

const labels: Record<StatementResult['status'], string> = {
  converted: '변환', 'ignored-nonstructural': '제어문·설정', unsupported: '제외', error: '오류',
};
const stateLabels: Record<ParseSqlJob['state'], string> = {
  queued: '대기 중', running: '분석 중', succeeded: '분석 완료', failed: '분석 실패', cancelled: '분석 취소됨',
};
const objectLabels: Record<keyof Catalog, string> = {
  namespaces: '스키마', tables: '테이블', columns: '컬럼', constraints: '제약', indexes: '인덱스', enums: 'ENUM', sequences: '시퀀스',
};
const active = (job?: ParseSqlJob) => job?.state === 'queued' || job?.state === 'running';
const problem = (error: unknown) => error instanceof Error ? error.message : 'DDL 가져오기를 처리하지 못했습니다.';
const targetKey = ({ dialectId, engineVersion }: SqlTarget) => dialectId + ':' + engineVersion;
const sourcePosition = (location?: { line?: number; column?: number }) =>
  location?.line ? location.line + '행 ' + location.column + '열' : '';

export function SqlImport({ projectId, csrf, destination, disabled, onApplied }: {
  projectId: string; csrf?: string | null; destination?: Destination; disabled: boolean;
  onApplied(result: ImportApplied): void;
}) {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>();
  const [choice, setChoice] = useState('');
  const [sql, setSql] = useState('');
  const [namespace, setNamespace] = useState('public');
  const [name, setName] = useState('SQL로 만든 ERD');
  const [job, setJob] = useState<ParseSqlJob>();
  const [baseRevision, setBaseRevision] = useState<number>();
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [applyRetry, setApplyRetry] = useState(false);
  const epoch = useRef(0);
  const activeJob = useRef<ParseSqlJob | undefined>(undefined);
  const submit = useRef<{ signature: string; id: string } | undefined>(undefined);
  const apply = useRef<{ signature: string; jobId: string; body: ApplyMode & { mutationId: string; lossFingerprint?: string } } | undefined>(undefined);
  const jobPath = (id: string) => '/sql/jobs/' + id;
  const append = destination?.mode === 'append' ? destination : undefined;
  const heading = append ? 'DDL로 테이블 추가' : destination ? 'DDL로 모델 교체' : 'DDL로 새 ERD 만들기';
  const targets = (profiles ?? []).flatMap(profile => profile.versions
    .filter(value => value.capabilities.table?.import === 'supported' &&
      profile.metadata.profiles.some(engine => engine.version === value.version && engine.status === 'certified'))
    .map(value => ({ dialectId: profile.metadata.id, engineVersion: value.version, name: profile.metadata.name + ' ' + value.version })));
  const selected = destination?.target ?? targets.find(target => targetKey(target) === choice) ?? targets[0];
  const maxBytes = profiles?.find(profile => profile.metadata.id === selected?.dialectId)?.maxInputBytes ?? 5 * 1024 * 1024;
  const catalog = job?.output?.catalog;
  const losses = job?.output?.losses ?? [];
  const working = pending || applying;
  const canApply = !working && !expired && job?.state === 'succeeded' && catalog && (!losses.length || confirmed) &&
    (destination ? baseRevision !== undefined : Boolean(name.trim()));

  useEffect(() => () => {
    epoch.current += 1;
    const current = activeJob.current;
    if (current && active(current)) void apiRequest(jobPath(current.id), { method: 'DELETE', csrf }).catch(() => undefined);
  }, [csrf]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void apiRequest<Profile[]>('/sql/dialects').then(value => {
      if (current) setProfiles(value);
    }, error => { if (current) setError(problem(error)); });
    return () => { current = false; };
  }, [open]);

  useEffect(() => {
    if (!job || !active(job) || pollError) return;
    const attempt = epoch.current;
    let watching = true;
    const timer = setTimeout(() => {
      void apiRequest<ParseSqlJob>(jobPath(job.id)).then(next => {
        if (watching && epoch.current === attempt && active(activeJob.current)) {
          activeJob.current = next;
          setJob(next);
        }
      }, error => { if (watching && epoch.current === attempt) setPollError(problem(error)); });
    }, 250);
    return () => { watching = false; clearTimeout(timer); };
  }, [job, pollError]);

  useEffect(() => {
    if (!job?.expiresAt) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, Date.parse(job.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [job?.id, job?.expiresAt]);

  function invalidate() {
    epoch.current += 1;
    const current = activeJob.current;
    if (current && active(current)) void apiRequest(jobPath(current.id), { method: 'DELETE', csrf }).catch(() => undefined);
    activeJob.current = undefined;
    submit.current = undefined;
    apply.current = undefined;
    setJob(undefined);
    setBaseRevision(undefined);
    setConfirmed(false);
    setExpired(false);
    setApplyRetry(false);
    setPollError('');
    setError('');
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    invalidate();
    const attempt = epoch.current;
    setSql('');
    if (!file.name.toLowerCase().endsWith('.sql') || file.size > maxBytes) {
      setError('입력 한도 내의 UTF-8 .sql 파일을 선택하세요.');
      return;
    }
    try {
      const input = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
      if (input.includes('\0') || input.startsWith('PGDMP')) throw new Error('SQL text expected');
      if (epoch.current === attempt) setSql(input);
    } catch {
      if (epoch.current === attempt) setError('파일을 UTF-8 PostgreSQL 텍스트로 읽을 수 없습니다.');
    }
  }

  async function analyze() {
    if (!selected || !sql.trim() || !namespace.trim()) return;
    const attempt = ++epoch.current;
    setPending(true);
    activeJob.current = undefined;
    setJob(undefined);
    setConfirmed(false);
    setApplyRetry(false);
    apply.current = undefined;
    setExpired(false);
    setError('');
    setPollError('');
    try {
      if (new TextEncoder().encode(sql).length > maxBytes) throw new Error('SQL 입력 크기 한도를 초과했습니다.');
      const revision = await destination?.savedRevision();
      if (epoch.current !== attempt) return;
      const target = { dialectId: selected.dialectId, engineVersion: selected.engineVersion };
      const payload = { kind: 'parse', target, defaultNamespace: namespace, sql,
        append: append && { erdId: append.id, baseRevision: revision, viewId: append.viewId } };
      const signature = JSON.stringify(payload);
      if (submit.current?.signature !== signature) submit.current = { signature, id: crypto.randomUUID() };
      const next = await apiRequest<ParseSqlJob>('/projects/' + projectId + '/sql/jobs', {
        method: 'POST', csrf, body: { ...payload, mutationId: submit.current.id },
      });
      if (epoch.current !== attempt) {
        if (active(next)) void apiRequest(jobPath(next.id), { method: 'DELETE', csrf }).catch(() => undefined);
        return;
      }
      submit.current = undefined;
      activeJob.current = next;
      setBaseRevision(revision);
      setJob(next);
    } catch (error) {
      if (epoch.current === attempt) setError(problem(error));
    } finally {
      if (epoch.current === attempt) setPending(false);
    }
  }

  async function cancel() {
    const current = activeJob.current;
    if (!current || !active(current)) return;
    const attempt = epoch.current;
    setPending(true);
    try {
      const result = await apiRequest<ParseSqlJob>(jobPath(current.id), { method: 'DELETE', csrf });
      if (epoch.current === attempt) {
        activeJob.current = result;
        setPollError('');
        setJob(result);
      }
    } catch (error) {
      if (epoch.current === attempt) setError(problem(error));
    } finally {
      if (epoch.current === attempt) setPending(false);
    }
  }

  async function applyResult(retry = false) {
    const attempt = epoch.current;
    setApplying(true);
    setError('');
    try {
      if (!retry) {
        if (!canApply || !job) return;
        if (destination && await destination.savedRevision() !== baseRevision) {
          throw new Error('편집본이 변경되었습니다. 최신 리비전에서 다시 분석하세요.');
        }
        if (epoch.current !== attempt) return;
        const options: ApplyMode = destination
          ? { mode: destination.mode, erdId: destination.id, baseRevision: baseRevision! }
          : { mode: 'create', name: name.trim() };
        const body = { ...options, lossFingerprint: job.output?.lossFingerprint };
        const signature = JSON.stringify([job.id, body]);
        if (apply.current?.signature !== signature) {
          apply.current = { jobId: job.id, signature, body: { ...body, mutationId: crypto.randomUUID() } };
        }
      }
      if (!apply.current) return;
      const applied = await apiRequest<ImportApplied>(jobPath(apply.current.jobId) + '/apply', {
        method: 'POST', csrf, body: apply.current.body,
      });
      if (epoch.current === attempt) {
        setOpen(false);
        invalidate();
        onApplied(applied);
      }
    } catch (error) {
      if (epoch.current === attempt) {
        setError(problem(error));
        setApplyRetry(Boolean(apply.current));
      }
    } finally {
      setApplying(false);
    }
  }

  function close() {
    if (applying) return;
    invalidate();
    setPending(false);
    setOpen(false);
  }

  return <>
    <button type="button" disabled={disabled} onClick={() => setOpen(true)}>{heading}</button>
    {open && <Modal title={heading} close={close}>
      <section className="sql-import">
        {append && <p className="muted">추가할 다이어그램 · {append.viewName ?? '기본 다이어그램'}</p>}
        <fieldset disabled={working}>
          <label>SQL 대상<select value={selected ? targetKey(selected) : ''} disabled={Boolean(destination)}
            onChange={event => { invalidate(); setChoice(event.target.value); }}>
            {(destination && selected ? [{ ...selected, name: targets.find(target => targetKey(target) === targetKey(selected))?.name ?? targetKey(selected) }] : targets)
              .map(target => <option key={targetKey(target)} value={targetKey(target)}>{target.name}</option>)}
          </select></label>
          <label>기본 스키마<input value={namespace} onChange={event => { invalidate(); setNamespace(event.target.value); }} maxLength={63} /></label>
          <label>UTF-8 .sql 파일<input type="file" accept=".sql,text/plain,application/sql" onChange={event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void loadFile(file);
          }} /></label>
          <label>DDL 입력<textarea rows={9} value={sql} spellCheck={false} onChange={event => { invalidate(); setSql(event.target.value); }} /></label>
        </fieldset>
        <div className="actions">
          <button type="button" disabled={!profiles || !selected || !sql.trim() || !namespace.trim() || working || active(job)}
            onClick={() => void analyze()}>DDL 분석</button>
          {active(job) && <button type="button" disabled={working} onClick={() => void cancel()}>분석 취소</button>}
        </div>
        {pending && <p role="status">분석 요청 처리 중</p>}
        {job && <p role="status">{stateLabels[job.state]} · {job.target.engineVersion} · 기본 스키마 {job.options.defaultNamespace}
          {baseRevision !== undefined && ' · 기준 리비전 ' + baseRevision}</p>}
        {expired && <p>분석 보관 기간이 지났습니다.</p>}
        {error && <p role="alert">{error}</p>}
        {pollError && <p role="alert">{pollError} <button type="button" onClick={() => setPollError('')}>상태 다시 조회</button></p>}
        {!expired && job?.output?.diagnostics.length ? <ul aria-label="분석 오류">{job.output.diagnostics.map((item, index) =>
          <li key={index}>{sourcePosition(item.location)} {item.message}</li>)}</ul> : null}
        {!expired && catalog && <>
          <h3>{append ? '추가할 모델 객체' : '변환 및 이름 해석'}</h3>
          <p>{Object.entries(catalog).map(([kind, items]) => objectLabels[kind as keyof Catalog] + ' ' + items.length).join(' · ')}</p>
          <ul>{catalog.tables.map(table => <li key={table.id}>
            {[...catalog.namespaces, ...(append?.namespaces ?? [])].find(schema => schema.id === table.namespaceId)?.physicalName}.{table.physicalName}
          </li>)}</ul>
        </>}
        {!expired && job?.output?.statements?.length ? <details>
          <summary>문장별 결과 {job.output.statements.length}개</summary>
          <ol>{job.output.statements.map(item => <li key={item.ordinal}>
            {sourcePosition(item.location)} · {labels[item.status]} · {item.message ?? item.kind}
          </li>)}</ol>
        </details> : null}
        {!expired && losses.length ? <>
          <h3>제외할 항목</h3>
          <ul>{losses.map((item, index) => <li key={index}>{sourcePosition(item.location)} · {item.message}</li>)}</ul>
          {catalog && <label className="checkbox"><input type="checkbox" checked={confirmed} disabled={working}
            onChange={event => setConfirmed(event.target.checked)} />이 분석의 제외 항목을 확인했습니다.</label>}
        </> : null}
        {catalog && !expired && <>
          {append
            ? <p>새 테이블을 현재 다이어그램에 배치합니다. 적용 전 버전은 서버 이력에 저장됩니다.</p>
            : destination
            ? <p>적용하면 기존 모델과 배치를 새 모델과 기본 다이어그램로 교체합니다. 교체 전 버전은 서버 이력에 저장됩니다.</p>
            : <label>새 ERD 이름<input value={name} onChange={event => setName(event.target.value)} maxLength={200} disabled={working} /></label>}
          <button type="button" className="primary" disabled={!canApply} onClick={() => void applyResult()}>
            {append ? '현재 다이어그램에 테이블 추가' : destination ? '확인하고 모델 교체' : '새 ERD에 적용'}
          </button>
        </>}
        {applying && <p role="status">가져오기 적용 중</p>}
        {applyRetry && !applying && <button type="button" onClick={() => void applyResult(true)}>같은 요청 다시 적용</button>}
      </section>
    </Modal>}
  </>;
}
