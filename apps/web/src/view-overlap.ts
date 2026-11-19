import type { Rect } from '@xyflow/react';
import { defaultGroupSize } from './editor-fields.js';
import type { View } from './editor-fields.js';

export type TableBounds = Rect & { id: string };
const gap = 24;
const groupPadding = 20;

function intersects(first: Rect, second: Rect, padding = 0) {
  return first.x < second.x + second.width + padding && first.x + first.width + padding > second.x &&
    first.y < second.y + second.height + padding && first.y + first.height + padding > second.y;
}

export function overlappingTables(cards: TableBounds[]) {
  const ordered = [...cards].sort((a, b) => a.x - b.x);
  const ids = new Set<string>();
  for (const [index, card] of ordered.entries()) {
    for (let other = index + 1; other < ordered.length && ordered[other].x < card.x + card.width; other++) {
      if (!intersects(card, ordered[other])) continue;
      ids.add(card.id);
      ids.add(ordered[other].id);
    }
  }
  return ids;
}

function slide(card: TableBounds, obstacles: Rect[], axis: 'x' | 'y') {
  const extent = axis === 'x' ? 'width' : 'height';
  const position = { ...card };
  for (const obstacle of [...obstacles].sort((a, b) => a[axis] - b[axis])) {
    if (intersects(position, obstacle, gap)) position[axis] = obstacle[axis] + obstacle[extent] + gap;
  }
  return position;
}

export function arrangeOverlappingTables(view: View, cards: TableBounds[], overlapping: ReadonlySet<string>, notes: Rect[]): View {
  const ordered = [...cards].sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const participants = new Map(view.instances.map(instance => [instance.id, instance.groupId]));
  const groups = new Map(view.groups.map(group => [group.id, group]));
  const occupied = ordered.filter(card => !overlapping.has(card.id));
  const moved = new Map<string, Rect>();

  for (const card of ordered) {
    if (!overlapping.has(card.id)) continue;
    if (!occupied.some(other => intersects(card, other))) {
      occupied.push(card);
      continue;
    }
    const obstacles = [...occupied, ...notes];
    const right = slide(card, obstacles, 'x');
    const below = slide(card, obstacles, 'y');
    const group = groups.get(participants.get(card.id) ?? '');
    const size = group?.size ?? defaultGroupSize;
    const overflow = (position: Rect) => group ?
      Math.max(0, position.x + position.width + groupPadding - group.x - size.width) +
      Math.max(0, position.y + position.height + groupPadding - group.y - size.height) : 0;
    const next = right.x - card.x + overflow(right) <= below.y - card.y + overflow(below) ? right : below;
    occupied.push(next);
    moved.set(card.id, next);
    if (group) {
      const width = Math.max(size.width, next.x + next.width + groupPadding - group.x);
      const height = Math.max(size.height, next.y + next.height + groupPadding - group.y);
      if (width !== size.width || height !== size.height) groups.set(group.id, { ...group, size: { width, height } });
    }
  }

  return { ...view, groups: [...groups.values()], instances: view.instances.map(instance => {
    const next = moved.get(instance.id);
    return next ? { ...instance, x: next.x, y: next.y } : instance;
  }) };
}
