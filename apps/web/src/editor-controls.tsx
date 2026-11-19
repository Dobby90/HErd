import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

const icons = {
  brand: 'M4 4h6v5H4z M14 15h6v5h-6z M10 6.5h7V15 M4 15h6v5H4z M7 9v6',
  search: 'M15.5 15.5 20 20 M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z',
  table: 'M4 5h16v14H4z M4 10h16 M10 10v9',
  view: 'M4 5h16v14H4z M4 9h16 M9 9v10',
  schema: 'M4 7h6l2 2h8v10H4z',
  column: 'M7 4h10v16H7z M7 9h10 M7 14h10',
  plus: 'M12 5v14 M5 12h14',
  chevron: 'm7 10 5 5 5-5',
  right: 'm10 7 5 5-5 5',
  back: 'm14 7-5 5 5 5',
  edit: 'm13 6 5 5 M5 19l4-1 11-11-4-4L5 14z',
  undo: 'M9 5 4 10l5 5 M4 10h10a5 5 0 0 1 0 10',
  redo: 'm15 5 5 5-5 5 M20 10H10a5 5 0 0 0 0 10',
  export: 'M12 4v11 m-4-4 4 4 4-4 M5 16v4h14v-4',
  map: 'm4 7 5-3 6 3 5-3v13l-5 3-6-3-5 3z M9 4v13 M15 7v13',
  settings: 'M4 7h16 M4 17h16 M9 4v6 M15 14v6',
  check: 'm5 12 4 4L19 6',
  import: 'M12 4v11 m-4-4 4 4 4-4 M4 15v5h16v-5',
  folder: 'M3 7V5h7l2 2h9v12H3z M3 10h18',
  users: 'M15 19v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2 M12 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z M17 4a3 3 0 0 1 0 6 M21 19v-2a4 4 0 0 0-3-3.9',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  copy: 'M9 9h12v12H9z M15 5V3H3v12h2',
  trash: 'M4 7h16 M9 7V4h6v3 M6 7l1 13h10l1-13 M10 10v7 M14 10v7',
  sun: 'M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1.5 1.5 m11 11L19 19 M5 19l1.5-1.5 m11-11L19 5 M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  moon: 'M20 15.3A8.5 8.5 0 0 1 8.7 4 8.5 8.5 0 1 0 20 15.3Z',
  link: 'M9 15l6-6 M8 18l-1 1a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0 m4-3 1-1a3.5 3.5 0 0 1 5 5l-5 5a3.5 3.5 0 0 1-5 0',
  grip: 'M9 5h.01 M15 5h.01 M9 12h.01 M15 12h.01 M9 19h.01 M15 19h.01',
};

export function Icon({ name }: { name: keyof typeof icons }) {
  return <svg className="ui-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={icons[name]} /></svg>;
}

export function ColumnBadges({ values }: { values: string[] }) {
  return values.length > 0 && <span className="column-badges">{values.map(value =>
    <small key={value} className={'badge-' + value}>{value.toUpperCase()}</small>)}</span>;
}

export function ActionMenu({ label, icon, primary, iconOnly, children }: {
  label: string; icon: keyof typeof icons; primary?: boolean; iconOnly?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss, true);
    return () => document.removeEventListener('pointerdown', dismiss, true);
  }, [open]);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return <div className="action-menu" ref={menu} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }} onKeyDown={event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  }}>
    <button ref={trigger} type="button" className={primary ? 'primary' : iconOnly ? 'quiet icon-button' : 'quiet'}
      aria-label={iconOnly ? label : undefined} title={iconOnly ? label : undefined} aria-expanded={open} aria-controls={panelId}
      onClick={() => setOpen(value => !value)}><Icon name={icon} />{!iconOnly && <>{label}<span className="menu-chevron"><Icon name="chevron" /></span></>}</button>
    <div className="action-menu-panel" id={panelId} hidden={!open} onClick={event => {
      const button = (event.target as Element).closest('button');
      if (button && event.currentTarget.contains(button)) close();
    }}>{children}</div>
  </div>;
}
