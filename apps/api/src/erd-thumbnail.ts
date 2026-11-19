import type { ErdDocument } from '@erd/model';

export function erdThumbnail(document: ErdDocument) {
  const instances = document.views[0]?.instances.slice(0, 24) ?? [];
  if (!instances.length) return { boxes: [], links: [] };
  const bounded = (position: number) => Math.max(-1e9, Math.min(1e9, position));
  const points = instances.map(({ x, y }) => ({ x: bounded(x), y: bounded(y) }));
  const left = Math.min(...points.map(item => item.x));
  const top = Math.min(...points.map(item => item.y));
  const right = Math.max(...points.map(item => item.x));
  const bottom = Math.max(...points.map(item => item.y));
  const scale = Math.min(0.1, 76 / Math.max(right - left, 1), 38 / Math.max(bottom - top, 1));
  const boxes = points.map(item => ({
    x: Math.round(56 + (item.x - left - (right - left) / 2) * scale),
    y: Math.round(34 + (item.y - top - (bottom - top) / 2) * scale),
  }));
  const byTable = new Map<string, number>();
  for (const [index, instance] of instances.entries()) {
    if (!byTable.has(instance.tableId)) byTable.set(instance.tableId, index);
  }
  const links: [number, number][] = [];
  const seen = new Set<string>();
  function link(source: string, target: string) {
    const from = byTable.get(source);
    const to = byTable.get(target);
    if (links.length >= 36 || from === undefined || to === undefined || from === to) return;
    const key = Math.min(from, to) + ':' + Math.max(from, to);
    if (seen.has(key)) return;
    seen.add(key);
    links.push([from, to]);
  }
  for (const key of document.catalog.constraints) if (key.kind === 'fk') link(key.tableId, key.targetTableId);
  for (const relation of document.relationships) link(relation.sourceTableId, relation.targetTableId);
  return { boxes, links };
}
