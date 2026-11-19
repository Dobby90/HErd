import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';

type Panel = 'schema' | 'inspector';
type Preferences = Partial<Record<Panel, number>> & { lastResized?: Panel };

const storageKey = 'herd.editor-panel-widths';
const minCanvasWidth = 360;
const collapsedSchemaWidth = 42;
const minWidths = { schema: 167, inspector: 228 };
const maxWidths = { schema: 384, inspector: 520 };

function savedWidths(): Preferences {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (!value || typeof value !== 'object') return {};
    const widths: Preferences = {};
    const stored = value as Record<string, unknown>;
    if (stored.lastResized === 'schema' || stored.lastResized === 'inspector') widths.lastResized = stored.lastResized;
    for (const panel of ['schema', 'inspector'] as const) {
      const candidate = stored[panel];
      if (typeof candidate === 'number' && Number.isFinite(candidate)) widths[panel] = boundedWidth(panel, candidate);
    }
    return widths;
  } catch {
    return {};
  }
}

function boundedWidth(panel: Panel, value: number, max = maxWidths[panel]) {
  return Math.min(max, Math.max(minWidths[panel], Math.round(value)));
}

function preferredWidths(width: number, widths: Preferences) {
  return {
    schema: widths.schema ?? (width <= 1100 ? boundedWidth('schema', width * .18) : 205),
    inspector: widths.inspector ?? (width <= 1100 ? boundedWidth('inspector', width * .24) : 282),
  };
}

function fitWidths(width: number, widths: Preferences, collapsed: boolean) {
  const preferred = preferredWidths(width, widths);
  const schema = collapsed ? collapsedSchemaWidth : preferred.schema;
  const overflow = Math.max(0, schema + preferred.inspector + minCanvasWidth - width);
  if (collapsed) return { schema, inspector: preferred.inspector - overflow };
  if (!overflow) return { schema, inspector: preferred.inspector };
  const schemaRoom = schema - minWidths.schema;
  const inspectorRoom = preferred.inspector - minWidths.inspector;
  // Give the most recently adjusted panel room first without replacing either saved preference.
  const schemaReduction = widths.lastResized === 'schema' ? Math.max(0, overflow - inspectorRoom)
    : Math.min(schemaRoom, overflow);
  return { schema: schema - schemaReduction, inspector: preferred.inspector - overflow + schemaReduction };
}

function PanelDivider({ panel, label, controls, width, max, preview, commit }: {
  panel: Panel; label: string; controls: string; width: number; max: number;
  preview(value?: number): void; commit(value?: number): void;
}) {
  const drag = useRef<{ pointer: number; startX: number; width: number; value: number }>(null);
  const direction = panel === 'schema' ? 1 : -1;

  function finish(event: PointerEvent<HTMLDivElement>, apply: boolean) {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    drag.current = null;
    preview();
    if (apply && current.value !== current.width) commit(boundedWidth(panel, current.value, max));
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * direction * (event.shiftKey ? 40 : 10);
      const next = boundedWidth(panel, width + delta, max);
      if (next !== width) commit(next);
    }
  }

  return <div className={'editor-panel-divider editor-panel-divider-' + panel} role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-controls={controls}
    aria-valuemin={minWidths[panel]} aria-valuemax={max} aria-valuenow={width}
    title={`${label} · 더블클릭하여 기본 너비로 복원`}
    onKeyDown={keyboard} onDoubleClick={() => commit()} onPointerDown={event => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointer: event.pointerId, startX: event.clientX, width, value: width };
    }} onPointerMove={event => {
      const current = drag.current;
      if (!current || current.pointer !== event.pointerId) return;
      current.value = boundedWidth(panel, current.width + direction * (event.clientX - current.startX), max);
      preview(current.value);
    }} onPointerUp={event => finish(event, true)} onPointerCancel={event => finish(event, false)}
    onLostPointerCapture={event => finish(event, false)} />;
}

export function EditorPanels({ children, mobilePane, schemaCollapsed, schemaId, inspectorId }: {
  children: ReactNode; mobilePane: string; schemaCollapsed: boolean; schemaId: string; inspectorId: string;
}) {
  const layout = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preferred, setPreferred] = useState(savedWidths);
  const [drag, setDrag] = useState<{ panel: Panel; width: number }>();

  useLayoutEffect(() => {
    const element = layout.current;
    if (!element) return;
    const update = () => {
      setWidth(element.clientWidth);
      if (element.clientWidth <= 780) setDrag(undefined);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const desktop = width > 780;
  const fitted = desktop ? fitWidths(width, preferred, schemaCollapsed) : undefined;
  const shown = fitted && { ...fitted };
  if (shown && drag && !(schemaCollapsed && drag.panel === 'schema')) {
    const other = drag.panel === 'schema' ? 'inspector' : 'schema';
    shown[drag.panel] = boundedWidth(drag.panel, drag.width, Math.min(maxWidths[drag.panel], width - minCanvasWidth - shown[other]));
  }
  const layoutStyle = shown && {
    '--desktop-schema-width': shown.schema + 'px',
    '--desktop-inspector-width': shown.inspector + 'px',
  };

  function divider(panel: Panel, label: string, controls: string) {
    if (!shown) return;
    const other = panel === 'schema' ? 'inspector' : 'schema';
    const max = Math.min(maxWidths[panel], width - minCanvasWidth - shown[other]);
    return <PanelDivider panel={panel} label={label} controls={controls} width={shown[panel]} max={max}
      preview={value => setDrag(value === undefined ? undefined : { panel, width: value })} commit={value => {
        const next = { ...preferred };
        if (value === undefined) {
          delete next[panel];
          if (next.lastResized === panel) delete next.lastResized;
        } else {
          next[panel] = value;
          next.lastResized = panel;
        }
        setPreferred(next);
        try { localStorage.setItem(storageKey, JSON.stringify(next)); } catch { /* Keep the current tab's widths. */ }
      }} />;
  }

  return <div ref={layout} className="editor-layout" data-mobile-pane={mobilePane} data-schema-collapsed={schemaCollapsed}
    data-resizing={Boolean(drag)} style={layoutStyle as CSSProperties | undefined}>
    {children}
    {!schemaCollapsed && divider('schema', '스키마 너비 조절', schemaId)}
    {divider('inspector', '속성 너비 조절', inspectorId)}
  </div>;
}
