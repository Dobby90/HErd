import type { ErdDocument } from '@erd/model';
import { isIdentifyingForeignKey, physicalRelationships, primaryColumnsByTable } from '@erd/model';
import type { View } from './editor-fields.js';
import { viewColumnIds, viewLabel } from './editor-fields.js';
import { columnTypeLabel } from './schema-edits.js';
import fontUrl from './fonts/noto-sans-kr.woff2?url';
import fontLicense from './fonts/noto-sans-kr-OFL.txt?raw';

export type ImageOptions = {
  instanceIds?: string[];
  names: NonNullable<View['nameDisplay']>;
  columns: 'view' | 'all' | 'collapsed';
  notes: boolean;
  groups: boolean;
  background: boolean;
  format: 'png' | 'svg';
  scale: number;
};

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };
type Shape =
  | ({ kind: 'rect'; fill: string; stroke?: string } & Box)
  | ({ kind: 'text'; value: string; size: number; color: string } & Point)
  | { kind: 'line'; points: Point[]; color: string; dash?: [number, number]; fill?: boolean };
type TableBox = Box & { rows: Map<string, number> };
type Scene = { bounds: Box; shapes: Shape[]; omitted: number; tables: number };

const family = 'Herd Noto Sans KR';
const font = (size: number) => `${size}px "${family}", sans-serif`;
const labelSize = 14;
const rowHeight = 25;
const headerHeight = 36;
const detailHeight = 17;
const detailSize = 12;
const gutter = 14;
const margin = 24;
const canvasColor = '#f7f8fa';
// eslint-disable-next-line no-control-regex -- XML 1.0 disallows these controls.
const clean = (value: string) => value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\p{Surrogate}]/gu, '\ufffd');
const singleLine = (value: string) => clean(value.replace(/[\r\n\t]/g, ' '));

function pngLimit(value: unknown, fallback: number, hardMax: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, hardMax) : fallback;
}

export const pngLimits = {
  side: pngLimit(import.meta.env.VITE_ERD_PNG_MAX_SIDE, 4096, 32767),
  pixels: pngLimit(import.meta.env.VITE_ERD_PNG_MAX_PIXELS, 16_000_000, 268_435_456),
};

function connection(source: TableBox, target: TableBox, sourceColumn?: string, targetColumn?: string): Point[] {
  const self = source === target;
  const sourceY = source.rows.get(sourceColumn ?? '') ?? source.y + (self ? 9 : 24);
  const targetY = target.rows.get(targetColumn ?? '') ?? target.y + (self ? 16 : 24);
  const sourceRight = source.x + source.width;
  const targetRight = target.x + target.width;
  if (self) {
    const y = sourceY === targetY ? targetY + 9 : targetY;
    return [{ x: sourceRight, y: sourceY }, { x: sourceRight + 34, y: sourceY },
      { x: sourceRight + 34, y }, { x: sourceRight, y }];
  }
  if (sourceRight + 12 < target.x || targetRight + 12 < source.x) {
    const right = source.x < target.x;
    const from = right ? sourceRight : source.x;
    const to = right ? target.x : targetRight;
    const mid = (from + to) / 2 + (right ? -1 : 1) * Math.min(10, Math.abs(to - from) / 4);
    return [{ x: from, y: sourceY }, { x: mid, y: sourceY }, { x: mid, y: targetY }, { x: to, y: targetY }];
  }
  const right = Math.max(sourceRight, targetRight) + 28;
  const targetAnchor = sourceY === targetY ? targetY + 8 : targetY;
  return [{ x: sourceRight, y: sourceY }, { x: right, y: sourceY }, { x: right, y: targetAnchor }, { x: targetRight, y: targetAnchor }];
}

function edgeShapes(points: Point[], color: string, dash?: [number, number]): Shape[] {
  const end = points[points.length - 1];
  const before = points[points.length - 2];
  const base = end.x + (before.x > end.x ? 8 : -8);
  return [{ kind: 'line', points, color, dash },
    { kind: 'line', points: [end, { x: base, y: end.y - 4 }, { x: base, y: end.y + 4 }], color, fill: true }];
}

function projectScene(document: ErdDocument, view: View, options: ImageOptions, measure: CanvasRenderingContext2D): Scene {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  const bounds = (x: number, y: number) => {
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  };
  const widthOf = (value: string, size: number) => {
    measure.font = font(size);
    const text = measure.measureText(value);
    return Math.max(0, text.actualBoundingBoxLeft) + Math.max(text.width, text.actualBoundingBoxRight);
  };
  function add(shapes: Shape[], shape: Shape) {
    if (shape.kind === 'rect') {
      bounds(shape.x, shape.y);
      bounds(shape.x + shape.width, shape.y + shape.height);
    } else if (shape.kind === 'line') {
      for (const point of shape.points) bounds(point.x, point.y);
    } else {
      measure.font = font(shape.size);
      const text = measure.measureText(shape.value);
      bounds(shape.x - Math.max(0, text.actualBoundingBoxLeft), shape.y - text.actualBoundingBoxAscent);
      bounds(shape.x + Math.max(text.width, text.actualBoundingBoxRight), shape.y + text.actualBoundingBoxDescent);
    }
    shapes.push(shape);
  }
  function text(shapes: Shape[], x: number, y: number, value: string, size: number, color: string) {
    add(shapes, { kind: 'text', x, y, value, size, color });
  }

  const ids = options.instanceIds && new Set(options.instanceIds);
  const background: Shape[] = [];
  const relations: Shape[] = [];
  const foreground: Shape[] = [];
  const instances = new Map<string, TableBox[]>();
  const groupIds = new Set<string>();
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));
  const columns = new Map(document.catalog.columns.map(column => [column.id, column]));
  const enums = new Map(document.catalog.enums.map(item => [item.id, item.physicalName]));
  let tableCount = 0;
  for (const instance of view.instances) {
    if (ids && !ids.has(instance.id)) continue;
    const table = tables.get(instance.tableId);
    if (!table) continue;
    if (instance.groupId) groupIds.add(instance.groupId);
    const visible = options.columns === 'all' ? table.columnIds
      : options.columns === 'collapsed' ? [] : viewColumnIds(table, instance);
    const full = options.names === 'both';
    const details = (lines: (string | undefined)[]) => lines.filter((value): value is string => Boolean(value)).map(singleLine);
    const tableDetails = full ? details([table.description]) : [];
    const names = visible.flatMap(id => {
      const column = columns.get(id);
      return column ? [{ id, name: singleLine(viewLabel(column, options.names)), details: full ? details([
        columnTypeLabel(column.type, enums), column.default && 'DEFAULT ' + column.default.sql, column.description,
      ]) : [] }] : [];
    });
    const title = singleLine(viewLabel(table, options.names));
    const { x, y } = instance;
    const width = Math.ceil(Math.max(instance.size?.width ?? 195, widthOf(title, 17) + gutter * 2,
      ...names.map(column => widthOf(column.name, labelSize) + gutter * 2),
      ...[...tableDetails, ...names.flatMap(column => column.details)].map(value => widthOf(value, detailSize) + gutter * 2)));
    const header = headerHeight + detailHeight * tableDetails.length;
    const height = header + names.reduce((sum, column) => sum + rowHeight + detailHeight * column.details.length, 0);
    const rows = new Map<string, number>();
    add(foreground, { kind: 'rect', x, y, width, height, fill: '#ffffff', stroke: '#c9d1df' });
    add(foreground, { kind: 'rect', x: x + 1, y: y + 1, width: width - 2, height: header - 1, fill: '#f1f3f9' });
    text(foreground, x + gutter, y + 24, title, 17, '#172033');
    tableDetails.forEach((value, index) => text(foreground, x + gutter, y + headerHeight + 8 + index * detailHeight, value, detailSize, '#5d687d'));
    let rowY = y + header;
    for (const column of names) {
      add(foreground, { kind: 'rect', x: x + 1, y: rowY, width: width - 2, height: 1, fill: '#e9edf3' });
      text(foreground, x + gutter, rowY + 17, column.name, labelSize, '#172033');
      column.details.forEach((value, index) =>
        text(foreground, x + gutter, rowY + rowHeight + 8 + index * detailHeight, value, detailSize, '#5d687d'));
      rows.set(column.id, rowY + rowHeight / 2);
      rowY += rowHeight + detailHeight * column.details.length;
    }
    const group = instances.get(table.id) ?? [];
    group.push({ x, y, width, height, rows });
    instances.set(table.id, group);
    tableCount++;
  }
  if (ids && !tableCount) throw new Error('이 뷰에서 출력할 테이블을 선택하세요.');

  for (const group of options.groups ? view.groups : []) {
    if (ids && !groupIds.has(group.id)) continue;
    const title = singleLine(group.name);
    const width = Math.max(group.size?.width ?? 480, widthOf(title, labelSize) + 2 * gutter);
    add(background, { kind: 'rect', x: group.x, y: group.y, width, height: group.size?.height ?? 250,
      fill: '#eef0fa', stroke: '#a9afd0' });
    text(background, group.x + gutter, group.y + 24, title, labelSize, '#545780');
  }
  for (const note of options.notes ? view.notes : []) {
    if (ids && (!note.groupId || !groupIds.has(note.groupId))) continue;
    const lines = clean(note.text).split(/\r\n|\r|\n/).map(singleLine);
    const width = lines.reduce((wide, line) => Math.max(wide, widthOf(line, labelSize) + 2 * gutter), note.size?.width ?? 210);
    const lineHeight = 23;
    const height = Math.max(note.size?.height ?? 0, lines.length * lineHeight + 16);
    add(foreground, { kind: 'rect', x: note.x, y: note.y, width, height, fill: '#fff6dc', stroke: '#e2c68c' });
    lines.forEach((line, index) => text(foreground, note.x + gutter, note.y + 24 + index * lineHeight, line, labelSize, '#5a4726'));
  }

  let omitted = 0;
  function relate(from: string, to: string, kind: 'identifying' | 'non-identifying' | 'logical', fromColumn?: string, toColumn?: string) {
    const sources = instances.get(from) ?? [];
    const targets = instances.get(to) ?? [];
    if (ids && (sources.length === 0) !== (targets.length === 0)) omitted++;
    for (const source of sources) {
      for (const target of from === to ? [source] : targets) {
        if (relations.length >= 100_000) throw new Error('관계선이 너무 많습니다. 뷰를 나누어 출력하세요.');
        const line = connection(source, target, fromColumn, toColumn);
        const dash: [number, number] | undefined = kind === 'logical' ? [2, 4] : kind === 'non-identifying' ? [6, 3] : undefined;
        for (const shape of edgeShapes(line, kind === 'logical' ? '#8e7fa7' : '#7d8aa2', dash)) add(relations, shape);
      }
    }
  }
  const primary = primaryColumnsByTable(document);
  for (const key of physicalRelationships(document)) {
    relate(key.tableId, key.targetTableId, isIdentifyingForeignKey(key, primary) ? 'identifying' : 'non-identifying',
      key.pairs[0]?.sourceColumnId, key.pairs[0]?.targetColumnId);
  }
  for (const link of document.relationships) relate(link.sourceTableId, link.targetTableId, 'logical');
  const shapes = [...background, ...relations, ...foreground];
  if (!shapes.length) throw new Error('이 뷰에 출력할 객체가 없습니다.');
  const width = Math.ceil(right - left + margin * 2);
  const height = Math.ceil(bottom - top + margin * 2);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || Math.max(Math.abs(left), Math.abs(top), Math.abs(right), Math.abs(bottom)) > 10_000_000) {
    throw new Error('출력 좌표 범위가 너무 큽니다. 뷰를 나누어 출력하세요.');
  }
  return { shapes, bounds: { x: left - margin, y: top - margin, width, height }, omitted, tables: tableCount };
}

const xml = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function svg(scene: Scene, name: string, background: boolean, fontData: string) {
  const { x, y, width, height } = scene.bounds;
  const markup = scene.shapes.map(shape => {
    if (shape.kind === 'text') return `<text x="${shape.x}" y="${shape.y}" fill="${shape.color}" font-size="${shape.size}">${xml(shape.value)}</text>`;
    if (shape.kind === 'rect') return `<rect x="${shape.x}" y="${shape.y}" width="${shape.width}" height="${shape.height}" fill="${shape.fill}"${shape.stroke ? ` stroke="${shape.stroke}"` : ''}/>`;
    const points = shape.points.map(point => `${point.x},${point.y}`).join(' ');
    if (shape.fill) return `<polygon points="${points}" fill="${shape.color}"/>`;
    return `<polyline points="${points}" fill="none" stroke="${shape.color}" stroke-width="1.6" stroke-linejoin="round"${shape.dash ? ' stroke-dasharray="' + shape.dash.join(' ') + '"' : ''}/>`;
  }).join('\n');
  return new Blob([`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${x} ${y} ${width} ${height}">
<title>${xml(singleLine(name))}</title>
<metadata>${xml(fontLicense)}</metadata>
<style>@font-face{font-family:"${family}";src:url(data:font/woff2;base64,${fontData}) format("woff2")}</style>
${background ? `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${canvasColor}"/>` : ''}
<g font-family="${family}, sans-serif" xml:space="preserve">${markup}</g>
</svg>`], { type: 'image/svg+xml;charset=utf-8' });
}

function draw(context: CanvasRenderingContext2D, shape: Shape) {
  if (shape.kind === 'rect') {
    context.fillStyle = shape.fill;
    context.fillRect(shape.x, shape.y, shape.width, shape.height);
    if (shape.stroke) {
      context.strokeStyle = shape.stroke;
      context.lineWidth = 1;
      context.setLineDash([]);
      context.strokeRect(shape.x, shape.y, shape.width, shape.height);
    }
  } else if (shape.kind === 'text') {
    context.font = font(shape.size);
    context.fillStyle = shape.color;
    context.fillText(shape.value, shape.x, shape.y);
  } else {
    context.beginPath();
    shape.points.forEach((point, index) => {
      if (index) context.lineTo(point.x, point.y);
      else context.moveTo(point.x, point.y);
    });
    if (shape.fill) {
      context.closePath();
      context.fillStyle = shape.color;
      context.fill();
    } else {
      context.strokeStyle = shape.color;
      context.lineWidth = 1.6;
      context.lineJoin = 'round';
      context.setLineDash(shape.dash ?? []);
      context.stroke();
    }
  }
}

function encodeFont(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let data = '';
  for (let i = 0; i < view.length; i += 8192) data += String.fromCharCode(...view.subarray(i, i + 8192));
  return btoa(data);
}

let fontLoad: Promise<ArrayBuffer> | undefined;
function loadFont(signal: AbortSignal) {
  fontLoad ??= (async () => {
    const response = await fetch(fontUrl, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error('Font response failed.');
    const bytes = await response.arrayBuffer();
    const face = await new FontFace(family, bytes).load();
    window.document.fonts.add(face);
    return bytes;
  })().catch(() => {
    fontLoad = undefined;
    throw new Error('출력 글꼴을 불러오지 못했습니다. 다시 시도하세요.');
  });
  signal.throwIfAborted();
  return fontLoad;
}

export async function renderDiagramImage(document: ErdDocument, view: View, options: ImageOptions, signal: AbortSignal) {
  const bytes = await loadFont(signal);
  signal.throwIfAborted();
  const canvas = window.document.createElement('canvas');
  const measure = canvas.getContext('2d');
  if (!measure) throw new Error('이 브라우저에서 이미지를 준비할 수 없습니다.');
  const scene = projectScene(document, view, options, measure);
  const scale = options.format === 'png' ? options.scale : 1;
  const width = Math.ceil(scene.bounds.width * scale);
  const height = Math.ceil(scene.bounds.height * scale);
  const info = { width, height, omitted: scene.omitted, tables: scene.tables };
  if (options.format === 'svg') return { ...info, blob: svg(scene, view.name, options.background, encodeFont(bytes)) };
  if (!(scale > 0) || width > pngLimits.side || height > pngLimits.side || width * height > pngLimits.pixels) {
    throw new Error(`PNG ${width} × ${height}px가 출력 한도를 초과합니다. 배율을 낮추거나 뷰를 나누세요.`);
  }
  try {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context || context.isContextLost()) throw new Error('이미지 메모리가 부족합니다. 배율을 낮추거나 뷰를 나누세요.');
    if (options.background) {
      context.fillStyle = canvasColor;
      context.fillRect(0, 0, width, height);
    }
    context.scale(scale, scale);
    context.translate(-scene.bounds.x, -scene.bounds.y);
    for (const shape of scene.shapes) draw(context, shape);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    signal.throwIfAborted();
    if (!blob?.size || context.isContextLost()) throw new Error('PNG를 만들지 못했습니다. 배율을 낮추거나 뷰를 나누세요.');
    return { ...info, blob };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
