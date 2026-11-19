import type { ErdDocument } from '@erd/model';
import type { LayoutSizes } from './editor-canvas.js';
import { canvasDisplay } from './canvas-display.js';
import { viewColumnIds, viewLabel } from './editor-fields.js';
import type { View } from './editor-fields.js';

export function arrangeView(document: ErdDocument, view: View, measured: Readonly<LayoutSizes>): View {
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));
  const columnsById = new Map(document.catalog.columns.map(column => [column.id, column]));
  const display = canvasDisplay(document);
  const full = view.nameDisplay === 'both';
  const names = full ? 'physical' : view.nameDisplay;
  const instances = new Map<string, View['instances']>();
  for (const instance of view.instances) {
    const key = instance.groupId ?? '';
    const row = instances.get(key) ?? [];
    row.push(instance);
    instances.set(key, row);
  }
  const positions = new Map<string, { x: number; y: number }>();
  function pack(items: View['instances'], left: number, top: number) {
    const ordered = [...items].sort((a, b) => {
      const first = tables.get(a.tableId), second = tables.get(b.tableId);
      return viewLabel(first ?? { physicalName: '' }, names)
        .localeCompare(viewLabel(second ?? { physicalName: '' }, names)) ||
        a.x - b.x || a.y - b.y || a.id.localeCompare(b.id);
    });
    const width = items.reduce((width, item) => Math.max(width, measured.get(item.id)?.width ?? 0, item.size?.width ?? 0), 195);
    let y = top;
    for (let row = 0; row < ordered.length; row += 4) {
      let height = 0;
      ordered.slice(row, row + 4).forEach((item, column) => {
        positions.set(item.id, { x: left + column * (width + 60), y });
        const table = tables.get(item.tableId);
        const visible = display.columns && table ? viewColumnIds(table, item) : [];
        const extra = visible.reduce((height, id) => {
          const column = columnsById.get(id);
          return height + (full && column?.logicalName ? 15 : 0) + (display.columnComments && column?.description ? 16 : 0)
            + (display.columnDefaults && column?.default ? 16 : 0);
        }, (full && table?.logicalName ? 15 : 0) + (display.tableComments && table?.description ? 20 : 0));
        height = Math.max(height, measured.get(item.id)?.height ?? 0, item.size?.height ?? 0,
          42 + 28 * visible.length + extra);
      });
      y += height + 60;
    }
    const columns = Math.min(ordered.length, 4);
    return { width: columns ? width * columns + (columns - 1) * 60 : 0, height: y - top };
  }
  const standalone = pack(instances.get('') ?? [], 0, 0);
  let top = standalone.height;
  const groups = view.groups.map(group => {
    const y = top;
    const groupTables = pack(instances.get(group.id) ?? [], 20, y + 44);
    const notes = view.notes.filter(note => note.groupId === group.id);
    let noteY = y + 44 + groupTables.height;
    let noteWidth = 0;
    for (const note of notes) {
      positions.set(note.id, { x: 20, y: noteY });
      noteWidth = Math.max(noteWidth, note.size?.width ?? 210);
      noteY += Math.max(note.size?.height ?? 70, note.text.split('\n').length * 24 + 20) + 16;
    }
    const size = { width: Math.max(group.size?.width ?? 480, groupTables.width + 40, noteWidth + 40),
      height: Math.max(group.size?.height ?? 250, noteY - y + 20) };
    top += size.height + 60;
    return { ...group, x: 0, y, size };
  });
  for (const note of view.notes.filter(item => !item.groupId)) {
    positions.set(note.id, { x: 0, y: top });
    top += Math.max(note.size?.height ?? 70, note.text.split('\n').length * 24 + 20) + 16;
  }
  return { ...view, groups,
    instances: view.instances.map(item => ({ ...item, ...positions.get(item.id) })),
    notes: view.notes.map(item => ({ ...item, ...positions.get(item.id) })),
  };
}
