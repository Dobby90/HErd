import { useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import type { Ref } from 'react';

export type SqlInputHandle = { jumpToLine(line: number): void };

export function SqlInput({ value, onChange, ref }: {
  value: string; onChange(value: string): void; ref: Ref<SqlInputHandle>;
}) {
  const id = useId();
  const input = useRef<HTMLTextAreaElement>(null);
  const [scroll, setScroll] = useState({ top: 0, height: 0, lineHeight: 1 });
  const [activeLine, setActiveLine] = useState<{ line: number; source: string }>();
  const lineCount = useMemo(() => {
    let count = 1;
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '\n' || (value[i] === '\r' && value[i + 1] !== '\n')) count += 1;
    }
    return count;
  }, [value]);

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      setScroll({ top: element.scrollTop, height: element.clientHeight, lineHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useImperativeHandle(ref, () => ({
    jumpToLine(line) {
      const element = input.current;
      if (!element) return;
      // Textareas normalize CRLF and CR to LF. Use the original line number instead of the file's string offset.
      let start = 0;
      for (let current = 1; current < line; current += 1) {
        const next = element.value.indexOf('\n', start);
        if (next === -1) return;
        start = next + 1;
      }
      const end = element.value.indexOf('\n', start);
      element.focus({ preventScroll: true });
      element.setSelectionRange(start, end === -1 ? element.value.length : end);
      element.scrollTop = Math.max(0, (line - 1) * scroll.lineHeight - (element.clientHeight - scroll.lineHeight) / 2);
      element.scrollLeft = 0;
      element.scrollIntoView({ block: 'nearest' });
      setActiveLine({ line, source: value });
      setScroll(previous => ({ ...previous, top: element.scrollTop }));
    },
  }), [scroll.lineHeight, value]);

  const first = Math.min(lineCount - 1, Math.max(0, Math.floor(scroll.top / scroll.lineHeight) - 1));
  const visible = Math.min(lineCount - first, Math.ceil(scroll.height / scroll.lineHeight) + 3);
  return <div className="sql-input-field">
    <label htmlFor={id}>DDL 입력</label>
    <div className="sql-input">
      <div className="sql-line-numbers" aria-hidden="true" style={{ width: Math.max(4, String(lineCount).length + 2) + 'ch' }}>
        <div style={{ transform: `translateY(${first * scroll.lineHeight - scroll.top}px)` }}>
          {Array.from({ length: visible }, (_, index) => {
            const line = first + index + 1;
            return <div key={line} data-active={(line === activeLine?.line && value === activeLine.source) || undefined}>{line}</div>;
          })}
        </div>
      </div>
      <textarea id={id} ref={input} rows={9} wrap="off" value={value} spellCheck={false}
        onScroll={event => {
          const top = event.currentTarget.scrollTop;
          setScroll(previous => previous.top === top ? previous : { ...previous, top });
        }} onChange={event => {
          setActiveLine(undefined);
          onChange(event.target.value);
        }} />
    </div>
  </div>;
}
