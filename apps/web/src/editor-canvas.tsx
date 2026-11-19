import { memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { Edge, Node, NodeProps, OnSelectionChangeParams, ReactFlowInstance, XYPosition } from '@xyflow/react';
import { columnBadgesById, isIdentifyingForeignKey, physicalRelationships, primaryColumnsByTable } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { ColumnBadges, Icon } from './editor-controls.js';
import { secondaryName, viewColumnIds, viewLabel } from './editor-fields.js';
import { CanvasEditing, dragType } from './canvas-edit.js';
import { canvasDisplay } from './canvas-display.js';
import { measureTableWidths } from './canvas-width.js';
import { columnTypeLabel } from './schema-edits.js';

type View = ErdDocument['views'][number];
type CanvasNode = Node<Record<string, unknown> & {
  label: string;
  logicalName?: string;
  description?: string;
  color?: string;
  tableId?: string;
  highlighted?: boolean;
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

function CanvasDeleteButton({ label, title = label, remove, annotation = false }: {
  label: string; title?: string; remove(): void; annotation?: boolean;
}) {
  return <button type="button" className={'quiet danger canvas-node-action nodrag nopan' + (annotation ? ' canvas-annotation-action' : '')}
    aria-label={label} title={title} onClick={event => { event.stopPropagation(); remove(); }}><Icon name="trash" /></button>;
}

const TableNode = memo(function TableNode({ id, data }: NodeProps<CanvasNode>) {
  const { activeId, edit, form, change, remove, reorder, link } = useContext(CanvasEditing);
  const [dropTarget, setDropTarget] = useState('');
  const editing = edit?.instanceId === id ? edit : undefined;
  const active = activeId === id;
  const tableId = data.tableId;
  const refresh = useUpdateNodeInternals();
  const handles = data.columns?.map(column =>
    [column.id, Boolean(column.logicalName), Boolean(column.description), Boolean(column.defaultSql)].join(':')).join('|');
  const hasLogicalName = Boolean(data.logicalName);
  const hasDescription = Boolean(data.description);
  useEffect(() => refresh(id), [handles, hasLogicalName, hasDescription, id, refresh, editing, active]);
  const editText = (value: string, field: 'table' | 'name' | 'type', columnId?: string) => {
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
  return <article className={'canvas-table' + (data.highlighted ? ' search-match' : '')}>
    <strong><Icon name="table" /><span className="canvas-names">{editText(data.label, 'table')}
      {data.logicalName && <span className="canvas-logical-name" title={data.logicalName}>{data.logicalName}</span>}
    </span>
      {active && remove && tableId && <CanvasDeleteButton label={data.label + ' 테이블 삭제'}
        title="모든 뷰에서 테이블 삭제" remove={() => remove(tableId)} />}
      {link && <button type="button" className="quiet canvas-node-action nodrag nopan" aria-label={data.label + ' 관계 연결 대상 선택'}
        title="연결할 테이블로 선택" onClick={event => { event.stopPropagation(); link(id); }}><Icon name="link" /></button>}
    </strong>
    <Handle id="table-in" type="target" position={Position.Left} className="table-handle" isConnectable={false} />
    <Handle id="table-out" type="source" position={Position.Right} className="table-handle" isConnectable={false} />
    <Handle id="reverse-table-in" type="target" position={Position.Right} className="table-handle route-handle" isConnectable={false} />
    <Handle id="reverse-table-out" type="source" position={Position.Left} className="table-handle route-handle" isConnectable={false} />
    {data.description && <p className="canvas-table-comment canvas-metadata-line" title={data.description}>{data.description}</p>}
    {editing?.field === 'table' && form}
    {data.columns?.map((column, index, rows) => <div className="canvas-column-slot" key={column.id}>
      <div className={'canvas-column' + (column.highlighted ? ' search-match' : '') + (dropTarget === column.id ? ' column-drop-target' : '')}
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
      <Handle id={'in:' + column.id} type="target" position={Position.Left} aria-label={column.name + ' 참조점'} />
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
      <Handle id={'out:' + column.id} type="source" position={Position.Right} aria-label={column.name + ' 연결점'} />
      <Handle id={'reverse-in:' + column.id} type="target" position={Position.Right} className="route-handle" isConnectable={false} />
      <Handle id={'reverse-out:' + column.id} type="source" position={Position.Left} className="route-handle" isConnectable={false} />
      </div>
      {(column.description || column.defaultSql) && <div className="canvas-column-meta">
        {column.defaultSql && <p className="canvas-metadata-line canvas-default" title={column.defaultSql}><span>DEFAULT </span>{column.defaultSql}</p>}
        {column.description && <p className="canvas-metadata-line" title={column.description}>{column.description}</p>}
      </div>}
      {editing?.columnId === column.id && form}
    </div>)}
    {editing && editing.field !== 'table' && !editing.columnId ? form :
      data.columns && active && change && <button type="button" className="quiet canvas-add-column nodrag nopan" aria-label={data.label + ' 컬럼 추가'}
        onClick={event => { event.stopPropagation(); change({ instanceId: id, field: 'name' }); }}><Icon name="plus" />컬럼 추가</button>}
  </article>;
});

function GroupNode({ id, data }: NodeProps<CanvasNode>) {
  const { activeId, remove } = useContext(CanvasEditing);
  return <><strong className="group-name">{data.label}</strong>
    {activeId === id && remove && <CanvasDeleteButton annotation label={data.label + ' 그룹 삭제'} title="그룹 삭제" remove={() => remove(id)} />}
  </>;
}

function NoteNode({ id, data }: NodeProps<CanvasNode>) {
  const { activeId, remove } = useContext(CanvasEditing);
  return <><div className="note-text">{data.label}</div>
    {activeId === id && remove && <CanvasDeleteButton annotation label="메모 삭제" remove={() => remove(id)} />}
  </>;
}

const nodeTypes = { table: TableNode, groupBox: GroupNode, note: NoteNode };
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
  const measureWidth = measureTableWidths();
  const full = view.nameDisplay === 'both';
  const titleMode = full ? 'physical' : view.nameDisplay;
  const instances = new Map<string, CanvasNode[]>();
  const nodes: CanvasNode[] = [
    ...(display.groups ? view.groups : []).map((group): CanvasNode => ({
      id: group.id, type: 'groupBox', position: { x: group.x, y: group.y },
      data: { label: group.name, color: group.color },
      style: annotationStyle(group.size ?? { width: 480, height: 250 }, group.color, 'transparent'), zIndex: -1,
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
    const rows = visible.flatMap(id => {
      const column = columns.get(id);
      return column ? [{ id, name: viewLabel(column, titleMode),
        type: display.columnTypes ? columnTypeLabel(column.type, enums) : undefined, badges: badges?.get(id) ?? [],
        logicalName: secondaryName(column, view.nameDisplay), description: display.columnComments ? column.description : undefined,
        defaultSql: display.columnDefaults ? column.default?.sql : undefined }] : [];
    });
    const width = instance.size?.width ?? measureWidth(label, logicalName, rows);
    const node: CanvasNode = {
      id: instance.id, type: 'table', position: { x: instance.x, y: instance.y },
      style: { width }, zIndex: 2,
      ...(viewportOnly && { initialWidth: width, initialHeight: rows.reduce((height, row) =>
        height + 25 + (row.logicalName ? 15 : 0) + (row.description ? 16 : 0) + (row.defaultSql ? 16 : 0),
      36 + (logicalName ? 15 : 0) + (description ? 20 : 0)) }),
      data: { tableId: table.id, label, logicalName, description, columns: display.columns ? rows : undefined },
    };
    nodes.push(node);
    const copies = instances.get(table.id) ?? [];
    copies.push(node);
    instances.set(table.id, copies);
  }
  const edges: Edge[] = [];
  if (!display.relationships) return { nodes, edges };
  const primary = primaryColumnsByTable(document);
  const foreignKeys = display.relationshipLabels ? dialect?.inspectForeignKeys?.(document) : undefined;
  for (const key of physicalRelationships(document)) {
    const meaning = display.relationshipLabels && (foreignKeys ? foreignKeys.cardinality(key) : dialect?.cardinality(document, key));
    const pair = key.pairs[0];
    const identifying = isIdentifyingForeignKey(key, primary);
    const label = meaning
      ? `${identifying ? '식별' : '비식별'} · 자식 0..${meaning.childMax === 1 ? '1' : 'N'} · 부모 ${meaning.parentOptional ? '0..1' : '1'}`
      : 'FK · 검토 필요';
    for (const source of instances.get(key.tableId) ?? []) {
      const targets = key.tableId === key.targetTableId ? [source] : instances.get(key.targetTableId) ?? [];
      for (const target of targets) {
        edges.push({
          id: JSON.stringify([key.id, source.id, target.id]), data: { objectId: key.id },
          source: source.id, target: target.id,
          ...edgeRoute(source, target, pair.sourceColumnId, pair.targetColumnId),
          label: display.relationshipLabels ? label : undefined,
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
        label: display.relationshipLabels ? relation.name + ' · 논리' : undefined, className: 'logical-edge', type: 'smoothstep',
      });
    }
  }
  return { nodes, edges };
}

export function EditorCanvas({ document, view, dialect, select, clearSelection, selectInstances, focus, activeTableId, activeRelationId,
  connect, move, layoutSizes, snap, readOnly, panMode, showMap, mapId, placing, picking, pickId, place, placementForm, dropTable, instruction, editRelation }: {
  document: ErdDocument; view: View; dialect?: EditorDialect;
  select(id: string): void;
  clearSelection(): void;
  selectInstances(ids: string[]): void;
  focus?: CanvasFocus;
  activeTableId?: string;
  activeRelationId?: string;
  layoutSizes: LayoutSizes;
  connect(sourceColumnId: string, targetColumnId: string): void;
  move(positions: Map<string, XYPosition>): void;
  snap: boolean;
  readOnly: boolean;
  panMode: boolean;
  showMap: boolean;
  mapId: string;
  placing?: boolean;
  picking?: boolean;
  pickId?: string;
  place?(position: CanvasPosition): void;
  placementForm?: { screen: XYPosition; content: ReactNode };
  dropTable?(tableId: string, position: XYPosition): void;
  instruction?: ReactNode;
  editRelation?(id: string): void;
}) {
  const viewportOnly = view.instances.length >= 120;
  const projected = useMemo(() => project(document, view, dialect, viewportOnly), [document, view, dialect, viewportOnly]);
  const [nodes, setNodes] = useState(projected.nodes);
  const displayNodes = useMemo(() => nodes.map(node => {
    const className = node.id === pickId ? 'relationship-origin' : activeTableId && node.data.tableId === activeTableId ? 'active-table' : undefined;
    return className ? { ...node, className } : node;
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
      layoutSizes.set(node.id, { width: Number(node.style?.width), height: layoutSizes.get(node.id)?.height ?? 0 });
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
    return { point: flow.current.screenToFlowPosition({ x, y }, { snapToGrid: snap }),
      screen: { x: Math.min(Math.max(x - bounds.left, 8), Math.max(bounds.width - 258, 8)),
        y: Math.min(Math.max(y - bounds.top, 8), Math.max(bounds.height - 310, 8)) } };
  };
  return <ReactFlowProvider initialNodes={projected.nodes} initialEdges={projected.edges} initialMinZoom={0.15} initialMaxZoom={2.5}>
    <div ref={canvas} className="canvas" tabIndex={0} aria-label="캔버스 탐색"
      data-mode={panMode ? 'pan' : 'select'} data-tool={placing ? 'place' : picking ? 'connect' : undefined}
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
        isValidConnection={connection => Boolean(connection.sourceHandle?.startsWith('out:') && connection.targetHandle?.startsWith('in:'))}
        onConnect={({ sourceHandle, targetHandle }) => {
          if (!readOnly && !panMode && sourceHandle?.startsWith('out:') && targetHandle?.startsWith('in:')) connect(sourceHandle.slice(4), targetHandle.slice(3));
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
      {placing && !placementForm && <button type="button" className="canvas-place-center quiet" onClick={() => {
        const bounds = canvas.current?.getBoundingClientRect();
        if (!bounds) return;
        const at = position(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
        if (at) place?.(at);
      }}>화면 중앙에 추가</button>}
      {placementForm && <div className="canvas-placement" style={{ left: placementForm.screen.x, top: placementForm.screen.y }}>{placementForm.content}</div>}
    </div>
    <div id={mapId} className="canvas-map" hidden={!showMap}>
      {showMap && <MiniMap<CanvasNode> ariaLabel="뷰 미니맵" pannable zoomable nodeColor={mapNodeColor} maskColor="var(--map-mask)"
        maskStrokeColor="var(--accent)" maskStrokeWidth={1.5} style={{ width: 178, height: 98 }} />}
    </div>
  </ReactFlowProvider>;
}
