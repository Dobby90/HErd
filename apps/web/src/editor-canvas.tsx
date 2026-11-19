import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MiniMap, NodeResizer, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { Edge, Node, NodeProps, OnResizeEnd, OnSelectionChangeParams, ReactFlowInstance, XYPosition } from '@xyflow/react';
import { columnBadgesById, isIdentifyingForeignKey, physicalRelationships, primaryColumnsByTable } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { ColumnBadges, Icon } from './editor-controls.js';
import { defaultGroupSize, minGroupSize, secondaryName, viewColumnIds, viewLabel } from './editor-fields.js';
import { CanvasEditing, canvasFormPosition, dragType } from './canvas-edit.js';
import { canvasDisplay, foreignKeyLabel, logicalRelationshipLabel } from './canvas-display.js';
import { measureTableLayout } from './canvas-width.js';
import { columnTypeLabel } from './schema-edits.js';
import { arrangeOverlappingTables, overlappingTables } from './view-overlap.js';

type View = ErdDocument['views'][number];
type CanvasNode = Node<Record<string, unknown> & {
  label: string;
  logicalName?: string;
  description?: string;
  color?: string;
  tableId?: string;
  highlighted?: boolean;
  columnCount?: number;
  columnsCollapsed?: boolean;
  stackedColumns?: boolean;
  estimatedHeight?: number;
  connectedHandles?: Set<string>;
  columns?: Array<{
    id: string; name: string; type?: string; badges: string[]; highlighted?: boolean;
    logicalName?: string; description?: string; defaultSql?: string;
  }>;
}, 'table' | 'groupBox' | 'note'>;

export type CanvasFocus = { instanceId: string; columnId?: string };
export type LayoutSizes = Map<string, { width: number; height: number }>;
export type CanvasPosition = { point: XYPosition; screen: XYPosition };
const fitOptions = { padding: 0.18, maxZoom: 1.15 };
const canvasLabels = {
  'controls.ariaLabel': '캔버스 확대 및 축소',
  'controls.zoomIn.ariaLabel': '확대',
  'controls.zoomOut.ariaLabel': '축소',
  'controls.fitView.ariaLabel': '전체 보기',
};

function CanvasViewport({ focus, viewportOnly, empty }: { focus?: CanvasFocus; viewportOnly: boolean; empty: boolean }) {
  const ready = useNodesInitialized();
  const { fitView, getNode, setCenter, viewportInitialized } = useReactFlow<CanvasNode, Edge>();
  const opened = useRef(false);
  useEffect(() => {
    if (!viewportInitialized) return;
    if (!focus) {
      if (empty) opened.current = true;
      if (!opened.current && !viewportOnly && ready) {
        opened.current = true;
        void fitView(fitOptions);
      }
      return;
    }
    opened.current = true;
    if (viewportOnly) {
      const node = getNode(focus.instanceId);
      if (node) void setCenter(node.position.x + (node.measured?.width ?? node.initialWidth ?? 195) / 2,
        node.position.y + Math.min(node.measured?.height ?? node.initialHeight ?? 36, 260) / 2,
        { zoom: 1, duration: 160 });
    } else if (ready) void fitView({ nodes: [{ id: focus.instanceId }], maxZoom: 1.15, padding: 0.35, duration: 160 });
  }, [fitView, getNode, setCenter, viewportInitialized, ready, focus, viewportOnly, empty]);
  return null;
}

function CanvasDeleteButton({ label, title = label, remove }: {
  label: string; title?: string; remove(): void;
}) {
  return <button type="button" className="quiet danger canvas-node-action nodrag nopan"
    aria-label={label} title={title} onClick={event => { event.stopPropagation(); remove(); }}><Icon name="trash" /></button>;
}

const TableNode = memo(function TableNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { activeId, edit, form, change, toggleColumns, remove, reorder, link, linkColumn } = useContext(CanvasEditing);
  const [dropTarget, setDropTarget] = useState('');
  const [selectedColumn, setSelectedColumn] = useState('');
  const editing = edit?.instanceId === id ? edit : undefined;
  const active = activeId === id || (!activeId && selected);
  const tableId = data.tableId;
  const refresh = useUpdateNodeInternals();
  const handles = data.columns?.map(column =>
    [column.id, Boolean(column.logicalName), Boolean(column.description), Boolean(column.defaultSql)].join(':')).join('|');
  const hasLogicalName = Boolean(data.logicalName);
  const hasDescription = Boolean(data.description);
  const stacked = data.stackedColumns;
  useEffect(() => refresh(id), [handles, hasLogicalName, hasDescription, id, refresh, editing, active, stacked]);
  const portClass = (handleId: string, kind = '') => `${kind}${data.connectedHandles?.has(handleId) ? ' connected-handle' : ''}`;
  const showCount = data.columnCount && (data.columnsCollapsed || (active && toggleColumns));
  const addColumn = active && change && data.columns && !data.columnsCollapsed;
  const editText = (value: string, field: 'table' | 'name' | 'type', columnId?: string) => {
    if (linkColumn && field === 'name') return <button type="button" className="canvas-text canvas-name-text nodrag nopan"
      aria-label={value + ' 관계 컬럼으로 선택'} title={value}>{value}</button>;
    const open = (event: MouseEvent) => {
      event.stopPropagation();
      change?.({ instanceId: id, field, columnId });
    };
    return change ? <button type="button" title={value} className={'canvas-text canvas-' + field + '-text'}
      aria-label={value + (field === 'type' ? ' 자료형 편집' : ' 이름 편집')}
      onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
      onClick={event => { if (event.detail === 0 || window.matchMedia('(pointer: coarse)').matches) open(event); }}
      onDoubleClick={open}>{value}</button> : <span className={'canvas-' + field + '-text'} title={value}>{value}</span>;
  };
  return <article className={'canvas-table' + (data.highlighted ? ' search-match' : '') + (stacked ? ' stacked-columns' : '')}>
    <strong className="canvas-table-header" data-table-id={tableId} onClick={() => setSelectedColumn('')}><Icon name="table" /><span className="canvas-names">{editText(data.label, 'table')}
      {data.logicalName && <span className="canvas-logical-name" title={data.logicalName}>{data.logicalName}</span>}
    </span>
      {active && remove && tableId && <CanvasDeleteButton label={data.label + ' 테이블 삭제'}
        title="모든 다이어그램에서 테이블 삭제" remove={() => remove(tableId)} />}
      {link && <button type="button" className="quiet canvas-node-action nodrag nopan" aria-label={data.label + ' 관계 연결 대상 선택'}
        title="연결할 테이블로 선택" onClick={event => { event.stopPropagation(); link(id); }}><Icon name="link" /></button>}
    </strong>
    <Handle id="table-in" type="target" position={Position.Left} className={portClass('table-in', 'table-handle')} isConnectable={false} />
    <Handle id="table-out" type="source" position={Position.Right} className={portClass('table-out', 'table-handle')} isConnectable={false} />
    <Handle id="reverse-table-in" type="target" position={Position.Right} className={portClass('reverse-table-in', 'table-handle route-handle')} isConnectable={false} />
    <Handle id="reverse-table-out" type="source" position={Position.Left} className={portClass('reverse-table-out', 'table-handle route-handle')} isConnectable={false} />
    {data.description && <p className="canvas-table-comment canvas-metadata-line" title={data.description}>{data.description}</p>}
    {editing?.field === 'table' && form}
    {data.columns?.map((column, index, rows) => <div className="canvas-column-slot" key={column.id}>
      <div className={'canvas-column' + (column.highlighted ? ' search-match' : '') + (dropTarget === column.id ? ' column-drop-target' : '')}
        data-column-selected={(active && selectedColumn === column.id) || undefined}
        onClick={event => {
          setSelectedColumn(column.id);
          if (linkColumn) { event.stopPropagation(); linkColumn(id, column.id); }
        }}
        onDragOver={event => {
          if (!reorder || !event.dataTransfer.types.includes(dragType.column)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          setDropTarget(column.id);
        }} onDragLeave={event => {
          if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget('');
        }} onDrop={event => {
          if (!reorder || !event.dataTransfer.types.includes(dragType.column)) return;
          event.preventDefault();
          event.stopPropagation();
          setDropTarget('');
          const value = event.dataTransfer.getData(dragType.column);
          const source = rows.find(row => JSON.stringify([id, row.id]) === value);
          const bounds = event.currentTarget.getBoundingClientRect();
          if (source) reorder(id, source.id, column.id, event.clientY > bounds.top + bounds.height / 2);
        }}>
      <Handle id={'in:' + column.id} type="target" position={Position.Left} className={portClass('in:' + column.id)}
        isConnectableStart={false} aria-label={column.name + ' 자식 연결점'} />
      {active && reorder && <button type="button" draggable className="quiet canvas-column-grip nodrag nopan" aria-label={column.name + ' 순서 이동'}
        title="드래그 또는 Alt+↑/↓로 순서 이동" onClick={event => event.stopPropagation()} onDragStart={event => {
          event.stopPropagation();
          event.dataTransfer.setData(dragType.column, JSON.stringify([id, column.id]));
          event.dataTransfer.effectAllowed = 'move';
        }} onDragEnd={() => setDropTarget('')} onKeyDown={event => {
          if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          const after = event.key === 'ArrowDown';
          const target = rows[index + (after ? 1 : -1)];
          if (target) reorder(id, column.id, target.id, after);
        }}><Icon name="grip" /></button>}
      <span className="canvas-names">{editText(column.name, 'name', column.id)}
        {column.logicalName && <span className="canvas-logical-name" title={column.logicalName}>{column.logicalName}</span>}
      </span>
      {column.type && editText(column.type, 'type', column.id)}<ColumnBadges values={column.badges} />
      <Handle id={'out:' + column.id} type="source" position={Position.Right} className={portClass('out:' + column.id)}
        isConnectableEnd={false} aria-label={column.name + ' 부모 연결점'} />
      <Handle id={'reverse-in:' + column.id} type="target" position={Position.Right} className={portClass('reverse-in:' + column.id, 'route-handle')} isConnectable={false} />
      <Handle id={'reverse-out:' + column.id} type="source" position={Position.Left} className={portClass('reverse-out:' + column.id, 'route-handle')} isConnectable={false} />
      </div>
      {(column.description || column.defaultSql) && <div className="canvas-column-meta">
        {column.defaultSql && <p className="canvas-metadata-line canvas-default" title={column.defaultSql}><span>DEFAULT </span>{column.defaultSql}</p>}
        {column.description && <p className="canvas-metadata-line" title={column.description}>{column.description}</p>}
      </div>}
      {editing?.columnId === column.id && form}
    </div>)}
    {editing && editing.field !== 'table' && !editing.columnId ? form : (showCount || addColumn) && <div className="canvas-table-actions">
      {showCount ? toggleColumns ? <button type="button" className="quiet canvas-column-count nodrag nopan" aria-expanded={!data.columnsCollapsed}
        aria-label={data.label + ` 컬럼 ${data.columnsCollapsed ? '펼치기' : '접기'} (${data.columnCount}개)`}
        onClick={event => { event.stopPropagation(); toggleColumns(id); }}>
        <Icon name={data.columnsCollapsed ? 'right' : 'chevron'} />컬럼 {data.columnCount}개</button>
        : <small>컬럼 {data.columnCount}개 접힘</small> : null}
      {addColumn && change && <button type="button" className="quiet canvas-add-column nodrag nopan" aria-label={data.label + ' 컬럼 추가'}
        onClick={event => { event.stopPropagation(); change({ instanceId: id, field: 'name' }); }}><Icon name="plus" />컬럼 추가</button>}
    </div>}
  </article>;
});

function AnnotationNode({ id, data, type, selected }: NodeProps<CanvasNode>) {
  const { activeId, changeAnnotation, remove, resizeGroup } = useContext(CanvasEditing);
  const group = type === 'groupBox';
  const active = activeId === id || (!activeId && selected);
  const finishResize = useCallback<OnResizeEnd>((_, bounds) => resizeGroup?.(id, bounds), [id, resizeGroup]);
  const open = changeAnnotation && ((event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
    const canvasBounds = event.currentTarget.closest('.canvas')?.getBoundingClientRect();
    if (!canvasBounds) return;
    const target = event.currentTarget.getBoundingClientRect();
    const screen = canvasFormPosition(canvasBounds, event.detail ? event.clientX : target.left,
      (event.detail ? event.clientY : target.bottom) + 8);
    changeAnnotation({ instanceId: id, field: group ? 'group' : 'note', screen });
  });
  const title = group ? '그룹 편집' : '메모 편집';
  return <>
    {group ? <strong className="group-name" title={data.label} onDoubleClick={open}>{data.label}</strong>
      : <div className="note-text" onDoubleClick={open}>{data.label}</div>}
    {active && (open || remove) && <div className="canvas-annotation-actions">
      {open && <button type="button" className="quiet canvas-node-action nodrag nopan" aria-label={title} title={title}
        onClick={open}><Icon name="edit" /></button>}
      {remove && <CanvasDeleteButton label={group ? data.label + ' 그룹 삭제' : '메모 삭제'}
        title={group ? '그룹 삭제' : '메모 삭제'} remove={() => remove(id)} />}
    </div>}
    {group && active && resizeGroup && <NodeResizer color="var(--accent)" minWidth={minGroupSize} minHeight={minGroupSize}
      handleClassName="canvas-group-resize-handle" lineClassName="canvas-group-resize-line" onResizeEnd={finishResize} />}
  </>;
}

const nodeTypes = { table: TableNode, groupBox: AnnotationNode, note: AnnotationNode };
const mapColors = { groupBox: 'var(--accent-soft)', note: 'var(--warning-line)', table: 'var(--edge)' };
const mapNodeColor = (node: CanvasNode) => node.selected || node.className === 'active-table'
  ? 'var(--accent)' : node.data.color ?? (node.type ? mapColors[node.type] : mapColors.table);

function annotationStyle(size: CSSProperties, color: string | undefined, base: string): CSSProperties {
  if (!color) return size;
  return { ...size, color: 'var(--ink)', borderColor: color, backgroundColor: `color-mix(in srgb, ${color} 18%, ${base})` };
}

function edgeRoute(source: CanvasNode, target: CanvasNode, fromColumn?: string, toColumn?: string) {
  const sourceHandle = source.data.columns?.some(column => column.id === fromColumn) ? 'out:' + fromColumn : 'table-out';
  const targetHandle = target.data.columns?.some(column => column.id === toColumn) ? 'in:' + toColumn : 'table-in';
  if (source.id === target.id) return { sourceHandle, targetHandle, type: 'smoothstep' };
  if (source.position.x + Number(source.style?.width) <= target.position.x) return { sourceHandle, targetHandle, type: 'default' };
  const reversed = target.position.x + Number(target.style?.width) <= source.position.x;
  return {
    sourceHandle: reversed ? 'reverse-' + sourceHandle : sourceHandle,
    targetHandle: 'reverse-' + targetHandle,
    type: reversed ? 'default' : 'smoothstep',
  };
}

function project(document: ErdDocument, view: View, dialect: EditorDialect | undefined, viewportOnly: boolean) {
  const display = canvasDisplay(document);
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));
  const columns = new Map(document.catalog.columns.map(column => [column.id, column]));
  const enums = new Map(document.catalog.enums.map(item => [item.id, item.physicalName]));
  const badges = display.columnBadges ? columnBadgesById(document) : undefined;
  const primary = primaryColumnsByTable(document);
  const measure = measureTableLayout();
  const full = view.nameDisplay === 'both';
  const titleMode = full ? 'physical' : view.nameDisplay;
  const instances = new Map<string, CanvasNode[]>();
  const nodes: CanvasNode[] = [
    ...(display.groups ? view.groups : []).map((group): CanvasNode => ({
      id: group.id, type: 'groupBox', position: { x: group.x, y: group.y },
      data: { label: group.name, color: group.color },
      style: annotationStyle(group.size ?? defaultGroupSize, group.color, 'transparent'), zIndex: -1,
    })),
    ...(display.notes ? view.notes : []).map((note): CanvasNode => ({
      id: note.id, type: 'note', position: { x: note.x, y: note.y },
      data: { label: note.text, color: note.color },
      style: annotationStyle(note.size ?? { width: 210 }, note.color, 'var(--surface)'), zIndex: 2,
    })),
  ];
  for (const instance of view.instances) {
    const table = tables.get(instance.tableId);
    if (!table) continue;
    const visible = display.columns ? viewColumnIds(table, instance) : [];
    const label = viewLabel(table, titleMode);
    const logicalName = secondaryName(table, view.nameDisplay);
    const description = display.tableComments ? table.description : undefined;
    const primaryColumns = primary.get(table.id);
    const rows = visible.flatMap(id => {
      const column = columns.get(id);
      if (!column) return [];
      const keyBadges = badges?.get(id) ?? [];
      const nullability = column.nullable && !primaryColumns?.has(id) ? 'null' : 'not null';
      return [{ id, name: viewLabel(column, titleMode),
        type: display.columnTypes ? columnTypeLabel(column.type, enums) : undefined,
        badges: display.columnNullability ? [...keyBadges, nullability] : keyBadges,
        logicalName: secondaryName(column, view.nameDisplay), description: display.columnComments ? column.description : undefined,
        defaultSql: display.columnDefaults ? column.default?.sql : undefined }];
    });
    const layout = measure(label, logicalName, rows);
    const width = instance.size?.width ?? layout.width;
    const stackedColumns = width < layout.rowWidth && Boolean(layout.typeWidth || layout.badgeWidth);
    const style = { width, '--canvas-type-width': `${layout.typeWidth}px`, '--canvas-badge-width': `${layout.badgeWidth}px` };
    const estimatedHeight = rows.reduce((height, row) => height + 25 + (row.logicalName ? 15 : 0)
      + (row.description ? 16 : 0) + (row.defaultSql ? 16 : 0) + (stackedColumns ? 18 : 0),
    36 + (logicalName ? 15 : 0) + (description ? 20 : 0) + (display.columns && instance.collapsed ? 28 : 0));
    const node: CanvasNode = {
      id: instance.id, type: 'table', position: { x: instance.x, y: instance.y },
      style, zIndex: 2,
      ...(viewportOnly && { initialWidth: width, initialHeight: estimatedHeight }),
      data: { tableId: table.id, label, logicalName, description, estimatedHeight, stackedColumns,
        columns: display.columns ? rows : undefined, columnsCollapsed: display.columns && instance.collapsed,
        columnCount: display.columns ? (instance.visibleColumnIds ?? table.columnIds).length : undefined },
    };
    nodes.push(node);
    const copies = instances.get(table.id) ?? [];
    copies.push(node);
    instances.set(table.id, copies);
  }
  const edges: Edge[] = [];
  if (!display.relationships) return { nodes, edges };
  const foreignKeys = display.relationshipLabels ? dialect?.inspectForeignKeys?.(document) : undefined;
  for (const key of physicalRelationships(document)) {
    const pair = key.pairs[0];
    const identifying = isIdentifyingForeignKey(key, primary);
    const label = display.relationshipLabels
      ? foreignKeyLabel(identifying, foreignKeys ? foreignKeys.cardinality(key) : dialect?.cardinality(document, key), true) : undefined;
    for (const source of instances.get(key.tableId) ?? []) {
      const targets = key.tableId === key.targetTableId ? [source] : instances.get(key.targetTableId) ?? [];
      for (const target of targets) {
        edges.push({
          id: JSON.stringify([key.id, source.id, target.id]), data: { objectId: key.id },
          source: source.id, target: target.id,
          ...edgeRoute(source, target, pair.sourceColumnId, pair.targetColumnId),
          label,
          className: 'fk-edge ' + (identifying ? 'identifying-edge' : 'non-identifying-edge'),
        });
      }
    }
  }
  for (const relation of document.relationships) {
    for (const source of instances.get(relation.sourceTableId) ?? []) {
      const targets = relation.sourceTableId === relation.targetTableId ? [source] : instances.get(relation.targetTableId) ?? [];
      for (const target of targets) edges.push({
        id: JSON.stringify([relation.id, source.id, target.id]), data: { objectId: relation.id },
        source: source.id, target: target.id, ...edgeRoute(source, target),
        label: display.relationshipLabels ? logicalRelationshipLabel(relation) : undefined, className: 'logical-edge', type: 'smoothstep',
      });
    }
  }
  const nodesById = new Map(nodes.map(node => [node.id, node]));
  for (const edge of edges) {
    const source = nodesById.get(edge.source);
    const target = nodesById.get(edge.target);
    if (source && edge.sourceHandle) (source.data.connectedHandles ??= new Set()).add(edge.sourceHandle);
    if (target && edge.targetHandle) (target.data.connectedHandles ??= new Set()).add(edge.targetHandle);
  }
  return { nodes, edges };
}

export function EditorCanvas({ document, view, dialect, select, clearSelection, selectInstances, focus, activeTableId, activeRelationId,
  connect, move, resolveOverlaps, layoutSizes, snap, readOnly, panMode, showMap, mapId, placing, picking, pickId, place, canvasForm, dropTable, instruction, editRelation }: {
  document: ErdDocument; view: View; dialect?: EditorDialect;
  select(id: string): void;
  clearSelection(): void;
  selectInstances(ids: string[]): void;
  focus?: CanvasFocus;
  activeTableId?: string;
  activeRelationId?: string;
  layoutSizes: LayoutSizes;
  connect(parentColumnId: string, childTableId: string, childColumnId?: string): void;
  move(positions: Map<string, XYPosition>): void;
  resolveOverlaps?(view: View): void;
  snap: boolean;
  readOnly: boolean;
  panMode: boolean;
  showMap: boolean;
  mapId: string;
  placing?: boolean;
  picking?: boolean;
  pickId?: string;
  place?(position: CanvasPosition): void;
  canvasForm?: { screen: XYPosition; content: ReactNode };
  dropTable?(tableId: string, position: XYPosition): void;
  instruction?: ReactNode;
  editRelation?(id: string): void;
}) {
  const viewportOnly = view.instances.length >= 120;
  const projected = useMemo(() => project(document, view, dialect, viewportOnly), [document, view, dialect, viewportOnly]);
  const [nodes, setNodes] = useState(projected.nodes);
  const [connecting, setConnecting] = useState(false);
  const canResolveOverlaps = Boolean(resolveOverlaps) && !connecting;
  const overlaps = useMemo(() => {
    if (!canResolveOverlaps || nodes.some(node => node.dragging)) return undefined;
    const measured = new Map(nodes.map(node => [node.id, node]));
    const cards = projected.nodes.flatMap(node => {
      if (node.type !== 'table') return [];
      const current = measured.get(node.id);
      const size = current?.style?.width === node.style?.width ? current?.measured : undefined;
      return [{ id: node.id, ...node.position, width: Number(node.style?.width), height: size?.height ?? node.data.estimatedHeight ?? 36 }];
    });
    const ids = overlappingTables(cards);
    if (!ids.size) return undefined;
    const notes = view.notes.map(note => ({ x: note.x, y: note.y,
      width: measured.get(note.id)?.measured?.width ?? note.size?.width ?? 210,
      height: measured.get(note.id)?.measured?.height ?? note.size?.height ?? Math.max(42, note.text.split('\n').length * 24 + 20) }));
    return { cards, ids, notes };
  }, [canResolveOverlaps, nodes, projected.nodes, view.notes]);
  const displayNodes = useMemo(() => nodes.map(node => {
    const className = node.id === pickId ? 'relationship-origin' : activeTableId && node.data.tableId === activeTableId ? 'active-table' : undefined;
    // A selected group stays behind its tables and notes.
    const zIndex = node.selected && node.type !== 'groupBox' ? 3 : node.zIndex;
    return className || zIndex !== node.zIndex ? { ...node, className, zIndex } : node;
  }), [activeTableId, nodes, pickId]);
  const edges = useMemo(() => {
    const active = new Set(view.instances.filter(instance => instance.tableId === activeTableId).map(instance => instance.id));
    if (!activeRelationId && !active.size) return projected.edges;
    return projected.edges.map(edge => {
      const related = activeRelationId ? edge.data?.objectId === activeRelationId : active.has(edge.source) || active.has(edge.target);
      return { ...edge, className: `${edge.className} ${related ? 'related-edge' : 'muted-edge'}`, zIndex: related ? 1 : 0 };
    });
  }, [activeRelationId, activeTableId, projected.edges, view.instances]);
  const onSelection = useCallback(({ nodes }: OnSelectionChangeParams) => {
    selectInstances(nodes.filter(node => node.type === 'table').map(node => node.id));
  }, [selectInstances]);
  useEffect(() => {
    // Large views also need the projected widths of tables outside the viewport.
    for (const node of projected.nodes) {
      if (node.type !== 'table') continue;
      const width = Number(node.style?.width);
      const previous = layoutSizes.get(node.id);
      const measuredHeight = previous?.width === width ? previous.height : 0;
      layoutSizes.set(node.id, { width, height: Math.max(measuredHeight, node.data.estimatedHeight ?? 36) });
    }
  }, [layoutSizes, projected.nodes]);
  useEffect(() => setNodes(previous => {
    const selected = new Set(previous.filter(node => node.selected).map(node => node.id));
    return projected.nodes.map(node => {
      const next = { ...node, selected: selected.has(node.id) };
      if (node.id !== focus?.instanceId) return next;
      return { ...next, data: { ...node.data, highlighted: true,
        columns: node.data.columns?.map(column => column.id === focus.columnId ? { ...column, highlighted: true } : column) } };
    });
  }), [projected, focus]);
  const anchor = view.instances[0];
  const flow = useRef<ReactFlowInstance<CanvasNode, Edge>>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const position = (x: number, y: number): CanvasPosition | undefined => {
    const bounds = canvas.current?.getBoundingClientRect();
    if (!bounds || !flow.current) return;
    return { point: flow.current.screenToFlowPosition({ x, y }, { snapToGrid: snap }), screen: canvasFormPosition(bounds, x, y) };
  };
  return <ReactFlowProvider initialNodes={projected.nodes} initialEdges={projected.edges} initialMinZoom={0.15} initialMaxZoom={2.5}>
    <div ref={canvas} className="canvas" tabIndex={0} aria-label="캔버스 탐색"
      data-mode={panMode ? 'pan' : 'select'} data-tool={placing ? 'place' : picking ? 'connect' : undefined} data-connecting={connecting || undefined}
      onDragOver={event => {
        if (readOnly || panMode || !event.dataTransfer.types.some(type => type === dragType.table || type === dragType.newTable)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }} onDrop={event => {
        if (readOnly || panMode) return;
        const isNew = event.dataTransfer.types.includes(dragType.newTable);
        const tableId = event.dataTransfer.getData(dragType.table);
        if (!isNew && !tableId) return;
        event.preventDefault();
        const at = position(event.clientX, event.clientY);
        if (at && isNew) place?.(at);
        if (at && tableId) dropTable?.(tableId, at.point);
      }}>
      <ReactFlow<CanvasNode, Edge>
        aria-label="ERD 캔버스"
        ariaLabelConfig={canvasLabels}
        onInit={instance => { flow.current = instance; }}
        nodesDraggable={!readOnly && !picking && !placing && !panMode} nodesConnectable={!readOnly && !picking && !placing && !panMode}
        elementsSelectable={!panMode} nodesFocusable={!panMode} edgesFocusable={!panMode}
        elevateNodesOnSelect={false}
        nodes={displayNodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={changes => {
          setNodes(previous => applyNodeChanges(readOnly || panMode ? changes.filter(change => change.type !== 'position') : changes, previous));
          const positions = new Map<string, XYPosition>();
          // React Flow batches keyboard moves and pointer drag completion with dragging set to false.
          for (const change of changes) {
            if (change.type === 'dimensions' && change.dimensions) layoutSizes.set(change.id, change.dimensions);
            if (change.type === 'position' && change.dragging === false && change.position) {
              positions.set(change.id, change.position);
            }
          }
          if (!readOnly && !panMode && positions.size) move(positions);
        }}
        onNodeClick={panMode ? undefined : (_, node) => select(node.id)}
        onPaneClick={event => {
          if (panMode) return;
          if (!placing || readOnly) return clearSelection();
          const at = position(event.clientX, event.clientY);
          if (at) place?.(at);
        }}
        onPaneContextMenu={event => { if (placing || picking) event.preventDefault(); }}
        onSelectionChange={onSelection}
        onEdgeClick={panMode ? undefined : (_, edge) => select(String(edge.data?.objectId ?? ''))}
        onEdgeDoubleClick={panMode ? undefined : (_, edge) => { if (!picking && !placing) editRelation?.(String(edge.data?.objectId ?? '')); }}
        onConnectStart={() => setConnecting(true)} onConnectEnd={(event, state) => {
          setConnecting(false);
          const from = state.fromHandle?.id;
          if (readOnly || panMode || state.isValid || !from?.startsWith('out:')) return;
          const point = 'changedTouches' in event ? event.changedTouches[0] : event;
          const header = point && globalThis.document.elementFromPoint(point.clientX, point.clientY)
            ?.closest<HTMLElement>('.canvas-table-header');
          if (header?.dataset.tableId) connect(from.slice(4), header.dataset.tableId);
        }}
        isValidConnection={connection => Boolean(connection.sourceHandle?.startsWith('out:') && connection.targetHandle?.startsWith('in:'))}
        onConnect={({ sourceHandle, targetHandle, target }) => {
          const childTableId = view.instances.find(instance => instance.id === target)?.tableId;
          if (!readOnly && !panMode && childTableId && sourceHandle?.startsWith('out:') && targetHandle?.startsWith('in:')) {
            connect(sourceHandle.slice(4), childTableId, targetHandle.slice(3));
          }
        }}
        connectionRadius={18} snapToGrid={snap} snapGrid={[20, 20]} deleteKeyCode={null} selectionOnDrag={!panMode}
        zoomOnDoubleClick={!placing && !picking}
        panOnDrag={panMode ? true : [1, 2]} panActivationKeyCode="Space" multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        onlyRenderVisibleElements={viewportOnly}
        defaultViewport={viewportOnly && anchor ? { x: 24 - anchor.x * 0.75, y: 24 - anchor.y * 0.75, zoom: 0.75 } : undefined}
        minZoom={0.15} maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <CanvasViewport focus={focus} viewportOnly={viewportOnly} empty={projected.nodes.length === 0} />
        {canvasDisplay(document).grid && <Background gap={22} size={1} color="var(--dot)" />}
        <Controls showInteractive={false} orientation="horizontal" fitViewOptions={fitOptions} />
      </ReactFlow>
      {instruction}
      {overlaps && resolveOverlaps && <div className="canvas-overlap-notice">
        <span role="status">겹친 카드 {overlaps.ids.size}개</span>
        <button type="button" onClick={() => resolveOverlaps(arrangeOverlappingTables(view, overlaps.cards, overlaps.ids, overlaps.notes))}>
          겹친 카드 정리</button>
      </div>}
      {placing && !canvasForm && <button type="button" className="canvas-place-center quiet" onClick={() => {
        const bounds = canvas.current?.getBoundingClientRect();
        if (!bounds) return;
        const at = position(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        if (at) place?.(at);
      }}>화면 중앙에 추가</button>}
      {canvasForm && <div className="canvas-popover" style={{ left: canvasForm.screen.x, top: canvasForm.screen.y }}>{canvasForm.content}</div>}
    </div>
    <div id={mapId} className="canvas-map" hidden={!showMap}>
      {showMap && <MiniMap<CanvasNode> ariaLabel="다이어그램 미니맵" pannable zoomable nodeColor={mapNodeColor} maskColor="var(--map-mask)"
        maskStrokeColor="var(--accent)" maskStrokeWidth={1.5} style={{ width: 178, height: 98 }} />}
    </div>
  </ReactFlowProvider>;
}
