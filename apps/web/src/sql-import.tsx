import { useEffect, useId, useRef, useState } from 'react';
import type { Catalog, SqlTarget } from '@erd/model';
import type { Diagnostic, DialectProfile, ImportApplied, ParseSqlJob, StatementResult } from '@erd/sql-contract';
import { Modal } from './editor-fields.js';
import { apiRequest } from './project-api.js';
import { SqlInput } from './sql-input.js';
import type { SqlInputHandle } from './sql-input.js';

type ApplyMode =
  | { mode: 'create'; name: string }
  | { mode: 'replace' | 'append' | 'change'; erdId: string; baseRevision: number };
type Destination = { id: string; target: SqlTarget; savedRevision(): Promise<number> } & (
  { mode: 'replace' } | { mode: 'append' | 'change'; viewId?: string; viewName?: string; namespaces: Catalog['namespaces'] }
);
type Profile = DialectProfile & { maxInputBytes?: number };

const editorImportOptions = {
  append: {
    title: '새 테이블만 추가',
    description: '기존 테이블을 유지하고 새 테이블을 현재 다이어그램에 배치합니다.',
  },
  change: {
    title: '기존 테이블에 항목 추가',
    description: '컬럼·제약조건·인덱스를 추가합니다. 같은 DDL에 있는 새 테이블도 함께 가져옵니다.',
  },
  replace: {
    title: '모델 전체 교체',
    description: '현재 ERD의 모든 테이블과 다이어그램 배치를 가져온 DDL로 교체합니다.',
  },
};

const labels: Record<StatementResult['status'], string> = {
  converted: '변환', 'ignored-nonstructural': '제어문·설정', 'skipped-existing': '건너뜀', unsupported: '제외', error: '오류',
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
function SourceLink({ location, jump }: { location?: Diagnostic['location']; jump(line: number): void }) {
  const line = location?.line;
  if (!line) return null;
  return <button className="sql-source-link" type="button" onClick={() => jump(line)}>
    {line}행{location.column ? ' ' + location.column + '열' : ''}
  </button>;
}

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
  const [changesConfirmed, setChangesConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [applyRetry, setApplyRetry] = useState(false);
  const epoch = useRef(0);
  const activeJob = useRef<ParseSqlJob | undefined>(undefined);
  const sqlInput = useRef<SqlInputHandle>(null);
  const submit = useRef<{ signature: string; id: string } | undefined>(undefined);
  const apply = useRef<{ signature: string; jobId: string; body: ApplyMode & {
    mutationId: string; lossFingerprint?: string; changeFingerprint?: string;
  } } | undefined>(undefined);
  const jobPath = (id: string) => '/sql/jobs/' + id;
  const append = destination && destination.mode !== 'replace' ? destination : undefined;
  const changing = append?.mode === 'change';
  const option = destination && editorImportOptions[destination.mode];
  const heading = option?.title ?? 'DDL로 새 ERD 만들기';
  const descriptionId = useId();
  const targets = (profiles ?? []).flatMap(profile => profile.versions
    .filter(value => value.capabilities.table?.import === 'supported' &&
      profile.metadata.profiles.some(engine => engine.version === value.version && engine.status === 'certified'))
    .map(value => ({ dialectId: profile.metadata.id, engineVersion: value.version, name: profile.metadata.name + ' ' + value.version })));
  const selected = destination?.target ?? targets.find(target => targetKey(target) === choice) ?? targets[0];
  const maxBytes = profiles?.find(profile => profile.metadata.id === selected?.dialectId)?.maxInputBytes ?? 5 * 1024 * 1024;
  const catalog = job?.output?.catalog;
  const changes = job?.output?.changes ?? [];
  const losses = job?.output?.losses ?? [];
  const missingKey = losses.find(item => item.code === 'missing-foreign-key-table');
  const missingKeyLine = missingKey?.location?.line;
  const diagnostics = job?.output?.diagnostics ?? [];
  const notices = diagnostics.filter(item => item.severity === 'info');
  const problems = diagnostics.filter(item => item.severity !== 'info');
  const working = pending || applying;
  const canApply = !working && !expired && job?.state === 'succeeded' && catalog && (!losses.length || confirmed) &&
    (!changing || (changesConfirmed && job.output?.changeFingerprint)) &&
    (destination ? baseRevision !== undefined : Boolean(name.trim()));
  const jump = (line: number) => sqlInput.current?.jumpToLine(line);
  const applyLabel = changing ? '확인한 항목 추가' : append && catalog && missingKey ? '제외하고 나머지 추가'
    : append ? '현재 다이어그램에 테이블 추가' : destination ? heading : '새 ERD에 적용';

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
    setChangesConfirmed(false);
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
    setChangesConfirmed(false);
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
        append: append && { erdId: append.id, baseRevision: revision, viewId: append.viewId, mode: changing ? 'change' : undefined } };
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
        const body = { ...options, lossFingerprint: job.output?.lossFingerprint,
          changeFingerprint: changing ? job.output?.changeFingerprint : undefined };
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
    <button type="button" disabled={disabled} onClick={() => setOpen(true)} className={option && 'sql-import-option'}
      aria-label={option?.title} aria-describedby={option && descriptionId}>
      {heading}
      {option && <small id={descriptionId}>{option.description}</small>}
    </button>
    {open && <Modal title={heading} close={close}>
      <section className="sql-import">
        {option && <p className="muted">{option.description}</p>}
        {append && !changing && <p className="muted">추가할 다이어그램 · {append.viewName ?? '기본 다이어그램'}</p>}
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
          <SqlInput ref={sqlInput} value={sql} onChange={value => { invalidate(); setSql(value); }} />
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
        {!expired && notices.length ? <ul aria-label="분석 안내">{notices.map((item, index) =>
          <li key={index}><SourceLink location={item.location} jump={jump} /> {item.message}</li>)}</ul> : null}
        {!expired && problems.length ? <ul aria-label="분석 오류">{problems.map((item, index) =>
          <li key={index}><SourceLink location={item.location} jump={jump} /> {item.message}</li>)}</ul> : null}
        {!expired && catalog && <>
          <h3>{changing ? '추가할 항목 미리보기' : append ? '추가할 모델 객체' : '변환 및 이름 해석'}</h3>
          <p>{Object.entries(catalog).map(([kind, items]) => objectLabels[kind as keyof Catalog] + ' ' + items.length).join(' · ')}</p>
          <ul>{catalog.tables.map(table => <li key={table.id}>
            {[...catalog.namespaces, ...(append?.namespaces ?? [])].find(schema => schema.id === table.namespaceId)?.physicalName}.{table.physicalName}
          </li>)}</ul>
          {changing && changes.map(change => <section key={change.tableId} className="sql-table-change">
            <h4>{change.schema}.{change.table}</h4>
            <ul>
              {change.columns.map(column => <li key={'column-' + column.name}>컬럼 추가 · <code>{column.name}</code>
                <small><code>{column.type}{column.nullable ? '' : ' NOT NULL'}</code></small>
              </li>)}
              {change.constraints.map(key => <li key={'constraint-' + key.name}>
                {key.kind === 'fk' ? '외래 키' : key.kind.toUpperCase()} 추가 · <code>{key.name}</code>
                <small><code>{key.detail}</code></small>
              </li>)}
              {change.indexes.map(index => <li key={'index-' + index.name}>
                {index.unique ? 'UNIQUE 인덱스' : '인덱스'} 추가 · <code>{index.name}</code>
                {index.predicate && <small><code>WHERE {index.predicate}</code></small>}
              </li>)}
            </ul>
          </section>)}
        </>}
        {!expired && job?.output?.statements?.length ? <details>
          <summary>문장별 결과 {job.output.statements.length}개</summary>
          <ol>{job.output.statements.map(item => <li key={item.ordinal}>
            <SourceLink location={item.location} jump={jump} /> {labels[item.status]} · {item.message ?? item.kind}
          </li>)}</ol>
        </details> : null}
        {!expired && losses.length ? <>
          <h3>제외할 항목</h3>
          <ul aria-label="제외할 항목">{losses.map((item, index) => <li key={index}>
            <SourceLink location={item.location} jump={jump} /> {item.message}
          </li>)}</ul>
          {catalog && <label className="checkbox"><input type="checkbox" checked={confirmed} disabled={working}
            onChange={event => setConfirmed(event.target.checked)} />{missingKey
              ? '표시된 항목을 제외하고 가져오겠습니다.' : '이 분석의 제외 항목을 확인했습니다.'}</label>}
          {catalog && missingKeyLine && <div className="actions">
            <button type="button" disabled={working} onClick={() => jump(missingKeyLine)}>DDL 수정</button>
          </div>}
        </> : null}
        {catalog && !expired && <>
          {changing ? <>
            <label className="checkbox"><input type="checkbox" checked={changesConfirmed} disabled={working}
              onChange={event => setChangesConfirmed(event.target.checked)} />추가할 항목을 확인했습니다.</label>
            <p>변경 전 버전은 서버 이력에 저장됩니다.</p>
          </> : append
            ? <p>새 테이블을 현재 다이어그램에 배치합니다. 적용 전 버전은 서버 이력에 저장됩니다.</p>
            : destination
            ? <p>현재 다이어그램 배치도 교체됩니다. 이전 상태는 버전 이력에서 복원할 수 있습니다.</p>
            : <label>새 ERD 이름<input value={name} onChange={event => setName(event.target.value)} maxLength={200} disabled={working} /></label>}
          <button type="button" className="primary" disabled={!canApply} onClick={() => void applyResult()}>
            {applyLabel}
          </button>
        </>}
        {applying && <p role="status">가져오기 적용 중</p>}
        {applyRetry && !applying && <button type="button" disabled={Boolean((losses.length && !confirmed) || (changing && !changesConfirmed))}
          onClick={() => void applyResult(true)}>같은 요청 다시 적용</button>}
      </section>
    </Modal>}
  </>;
}
