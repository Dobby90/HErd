import { useEffect, useRef, useState } from 'react';
import type { ErdDocument } from '@erd/model';
import { viewNameDisplaySchema } from '@erd/model';
import type { View } from './editor-fields.js';
import { Modal, ViewNameOptions, viewLabel } from './editor-fields.js';
import type { ImageOptions, renderDiagramImage } from './diagram-image.js';

type Result = Awaited<ReturnType<typeof renderDiagramImage>>;

export function ImageExport({ document, view, selection, verify }: {
  document: ErdDocument; view: View; selection: string[]; verify?(): Promise<void>;
}) {
  const [snapshot, setSnapshot] = useState<{ document: ErdDocument; view: View; selection: string[] }>();
  return <>
    <button type="button" onClick={() => setSnapshot(structuredClone({ document, view, selection }))}>이미지 내보내기</button>
    {snapshot && <ImageExportDialog {...snapshot} verify={verify}
      close={() => setSnapshot(undefined)} />}
  </>;
}

function ImageExportDialog({ document, view, selection, verify, close }: {
  document: ErdDocument; view: View; selection: string[]; verify?(): Promise<void>; close(): void;
}) {
  const [options, setOptions] = useState<ImageOptions>({
    names: view.nameDisplay ?? 'physical', columns: 'view', format: 'png', scale: 1,
    groups: true, notes: true, background: true,
  });
  const [chosen, setChosen] = useState(() => view.instances.filter(instance => selection.includes(instance.id)).map(instance => instance.id));
  const [scope, setScope] = useState<'view' | 'selected'>(chosen.length ? 'selected' : 'view');
  const [result, setResult] = useState<Result>();
  const [preview, setPreview] = useState('');
  const [decoded, setDecoded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const pending = useRef<AbortController | undefined>(undefined);
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));
  const namespaces = new Map(document.catalog.namespaces.map(namespace => [namespace.id, namespace]));
  const list = view.instances.flatMap(instance => {
    const table = tables.get(instance.tableId);
    if (!table) return [];
    const namespace = namespaces.get(table.namespaceId);
    return [{ id: instance.id, name: (namespace ? viewLabel(namespace, options.names) + '.' : '') + viewLabel(table, options.names) }];
  });
  const nameCounts = new Map<string, number>();
  list.forEach(item => nameCounts.set(item.name, (nameCounts.get(item.name) ?? 0) + 1));
  const occurrences = new Map<string, number>();

  useEffect(() => () => pending.current?.abort(), []);
  useEffect(() => {
    if (!result) { setPreview(''); return; }
    const url = URL.createObjectURL(result.blob);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [result]);

  function reset() {
    pending.current?.abort();
    setResult(undefined);
    setDecoded(false);
    setProblem('');
    setBusy(false);
  }
  function change(value: Partial<ImageOptions>) {
    reset();
    setOptions(current => ({ ...current, ...value }));
  }

  async function run(action: (signal: AbortSignal) => Promise<void>) {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setProblem('');
    setBusy(true);
    try { await action(controller.signal); }
    catch (error) {
      if (!controller.signal.aborted) setProblem(error instanceof Error ? error.message : '이미지를 만들지 못했습니다.');
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return <Modal title="뷰 이미지 내보내기" close={close}>
    <p>출력 뷰 <strong>{view.name}</strong></p>
    <div className="image-options">
      <label>출력 범위<select value={scope} onChange={event => { reset(); setScope(event.target.value === 'selected' ? 'selected' : 'view'); }}>
        <option value="view">현재 뷰 전체</option><option value="selected">선택한 테이블</option>
      </select></label>
      <label>표시할 이름<select value={options.names} onChange={event => change({ names: viewNameDisplaySchema.parse(event.target.value) })}>
        <ViewNameOptions />
      </select></label>
      <label>컬럼 표시<select value={options.columns} onChange={event => {
        const value = event.target.value;
        change({ columns: value === 'all' || value === 'collapsed' ? value : 'view' });
      }}>
        <option value="view">뷰의 접기·숨김 유지</option><option value="all">모든 컬럼 표시</option><option value="collapsed">모든 컬럼 접기</option>
      </select></label>
      <label>이미지 형식<select value={options.format} onChange={event => change({ format: event.target.value === 'svg' ? 'svg' : 'png' })}>
        <option value="png">PNG</option><option value="svg">SVG</option>
      </select></label>
      {options.format === 'png' && <label>PNG 배율<select value={options.scale} onChange={event => change({ scale: Number(event.target.value) })}>
        {[0.25, 0.5, 1, 2, 3, 4].map(scale => <option value={scale} key={scale}>{scale}×</option>)}
      </select></label>}
      {([['notes', '메모 포함'], ['groups', '그룹 포함'], ['background', '배경 포함']] as const).map(([key, label]) =>
        <label key={key} className="checkbox"><input type="checkbox" checked={options[key]} onChange={event => change({ [key]: event.target.checked })} />{label}</label>)}
    </div>
    {scope === 'selected' && <>
      <p>양쪽 테이블이 포함된 관계선만 출력합니다. 메모와 그룹은 선택한 테이블의 그룹을 따릅니다. 이 설정은 ERD에 저장되지 않습니다.</p>
      <fieldset className="image-selection"><legend>출력할 테이블</legend>{list.map(item => {
        const number = (occurrences.get(item.name) ?? 0) + 1;
        occurrences.set(item.name, number);
        return <label className="checkbox" key={item.id}><input type="checkbox" checked={chosen.includes(item.id)}
          onChange={event => { reset(); setChosen(value => event.target.checked ? [...value, item.id] : value.filter(id => id !== item.id)); }} />
        {item.name}{(nameCounts.get(item.name) ?? 0) > 1 && ' (' + number + ')'}</label>;
      })}</fieldset>
    </>}
    {problem && <p role="alert">{problem}</p>}
    {busy && <p role="status">이미지 준비 중</p>}
    <div className="actions">
      <button type="button" disabled={busy || (scope === 'selected' && !chosen.length)} onClick={() => {
        setResult(undefined);
        setDecoded(false);
        void run(async signal => {
          await verify?.();
          signal.throwIfAborted();
          const { renderDiagramImage } = await import('./diagram-image.js');
          const next = await renderDiagramImage(document, view, { ...options, instanceIds: scope === 'selected' ? chosen : undefined }, signal);
          signal.throwIfAborted();
          setResult(next);
        });
      }}>출력 미리보기</button>
      {busy && <button type="button" onClick={reset}>출력 취소</button>}
      {result && preview && decoded && !busy && <button type="button" onClick={() => void run(async signal => {
        await verify?.();
        signal.throwIfAborted();
        const url = URL.createObjectURL(result.blob);
        const link = window.document.createElement('a');
        link.href = url;
        link.download = (view.name.replace(/[^\p{Letter}\p{Number} _.-]+/gu, '_').trim().slice(0, 100) || 'erd') + '.' + options.format;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>{options.format.toUpperCase()} 다운로드</button>}
    </div>
    {result && preview && <>
      <p role="status">{result.width} × {result.height}px · 테이블 {result.tables}개{result.omitted > 0 && ` · 범위 밖 관계 ${result.omitted}개 생략`}</p>
      <img key={preview} className="image-preview" src={preview} alt="ERD 이미지 출력 미리보기" onLoad={() => setDecoded(true)} onError={() => {
        setResult(undefined);
        setProblem('이미지 미리보기를 열지 못했습니다. 배율을 낮추거나 뷰를 나누세요.');
      }} />
    </>}
  </Modal>;
}
