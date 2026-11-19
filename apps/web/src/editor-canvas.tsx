import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, ReactFlowProvider, useNodesInitialized, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { Edge, Node, NodeProps, OnSelectionChangeParams, XYPosition } from '@xyflow/react';
import { columnBadgesById, physicalRelationships } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { ColumnBadges, Icon } from './editor-controls.js';
import { viewColumnIds, viewLabel } from './editor-fields.js';

type View = ErdDocument['views'][number];
type CanvasNode = Node<Record<string, unknown> & {
  label: string;
  tableId?: string;
  highlighted?: boolean;
  columns?: Array<{ id: string; name: string; badges: string[]; highlighted?: boolean }>;
}, 'table' | 'groupBox' | 'note'>;

export type CanvasFocus = { instanceId: string; columnId?: string };
export type LayoutSizes = Map<string, { width: number; height: number }>;
const fitOptions = { padding: 0.18, maxZoom: 1.15 };
const canvasLabels = {
  'controls.ariaLabel': '캔버스 확대 및 축소',
  'controls.zoomIn.ariaLabel': '확대',
  'controls.zoomOut.ariaLabel': '축소',
  'controls.fitView.ariaLabel': '전체 보기',
};

function CanvasViewport({ focus, viewportOnly }: { focus?: CanvasFocus; viewportOnly: boolean }) {
  const ready = useNodesInitialized();
  const { fitView, getNode, setCenter, viewportInitialized } = useReactFlow<CanvasNode, Edge>();
  const opened = useRef(false);
  useEffect(() => {
    if (!viewportInitialized) return;
    if (!focus) {
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
  }, [fitView, getNode, setCenter, viewportInitialized, ready, focus, viewportOnly]);
  return null;
}

const TableNode = memo(function TableNode({ id, data }: NodeProps<CanvasNode>) {
  const refresh = useUpdateNodeInternals();
  const handles = data.columns?.map(column => column.id).join(':');
  useEffect(() => refresh(id), [handles, id, refresh]);
  return <article className={'canvas-table' + (data.highlighted ? ' search-match' : '')}>
    <strong><Icon name="table" /><span>{data.label}</span></strong>
    <Handle id="table-in" type="target" position={Position.Left} className="table-handle" isConnectable={false} />
    <Handle id="table-out" type="source" position={Position.Right} className="table-handle" isConnectable={false} />
    <Handle id="reverse-table-in" type="target" position={Position.Right} className="table-handle route-handle" isConnectable={false} />
    <Handle id="reverse-table-out" type="source" position={Position.Left} className="table-handle route-handle" isConnectable={false} />
    {data.columns?.map(column => <div className={'canvas-column' + (column.highlighted ? ' search-match' : '')} key={column.id}>
      <Handle id={'in:' + column.id} type="target" position={Position.Left} aria-label={column.name + ' 참조점'} />
      <span className="canvas-column-name">{column.name}</span><ColumnBadges values={column.badges} />
      <Handle id={'out:' + column.id} type="source" position={Position.Right} aria-label={column.name + ' 연결점'} />
      <Handle id={'reverse-in:' + column.id} type="target" position={Position.Right} className="route-handle" isConnectable={false} />
      <Handle id={'reverse-out:' + column.id} type="source" position={Position.Left} className="route-handle" isConnectable={false} />
    </div>)}
  </article>;
});

function GroupNode({ data }: NodeProps<CanvasNode>) {
  return <strong>{data.label}</strong>;
}

function NoteNode({ data }: NodeProps<CanvasNode>) {
  return <div className="note-text">{data.label}</div>;
}

const nodeTypes = { table: TableNode, groupBox: GroupNode, note: NoteNode };
const mapColors = { groupBox: 'var(--accent-soft)', note: 'var(--warning-line)', table: 'var(--edge)' };
const mapNodeColor = (node: CanvasNode) => node.selected || node.className === 'active-table'
  ? 'var(--accent)' : node.type ? mapColors[node.type] : mapColors.table;

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
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));
  const columns = new Map(document.catalog.columns.map(column => [column.id, column]));
  const badges = columnBadgesById(document);
  const foreignKeys = dialect?.inspectForeignKeys?.(document);
  const instances = new Map<string, CanvasNode[]>();
  const nodes: CanvasNode[] = [
    ...view.groups.map((group): CanvasNode => ({
      id: group.id, type: 'groupBox', position: { x: group.x, y: group.y },
      data: { label: group.name }, style: group.size ?? { width: 480, height: 250 }, zIndex: -1,
    })),
    ...view.notes.map((note): CanvasNode => ({
      id: note.id, type: 'note', position: { x: note.x, y: note.y },
      data: { label: note.text }, style: note.size ?? { width: 210 }, zIndex: 2,
    })),
  ];
  for (const instance of view.instances) {
    const table = tables.get(instance.tableId);
    if (!table) continue;
    const visible = viewColumnIds(table, instance);
    const width = instance.size?.width ?? 195;
    const node: CanvasNode = {
      id: instance.id, type: 'table', position: { x: instance.x, y: instance.y },
      style: { width }, zIndex: 2,
      ...(viewportOnly && { initialWidth: width, initialHeight: 36 + visible.length * 24 }),
      data: {
        tableId: table.id,
        label: viewLabel(table, view.nameDisplay),
        columns: visible.flatMap(id => {
          const column = columns.get(id);
          return column ? [{ id, name: viewLabel(column, view.nameDisplay), badges: badges.get(id) ?? [] }] : [];
        }),
      },
    };
    nodes.push(node);
    const copies = instances.get(table.id) ?? [];
    copies.push(node);
    instances.set(table.id, copies);
  }
  const edges: Edge[] = [];
  for (const key of physicalRelationships(document)) {
    const meaning = foreignKeys ? foreignKeys.cardinality(key) : dialect?.cardinality(document, key);
    const pair = key.pairs[0];
    for (const source of instances.get(key.tableId) ?? []) {
      const targets = key.tableId === key.targetTableId ? [source] : instances.get(key.targetTableId) ?? [];
      for (const target of targets) {
        edges.push({
          id: JSON.stringify([key.id, source.id, target.id]), data: { objectId: key.id },
          source: source.id, target: target.id,
          ...edgeRoute(source, target, pair.sourceColumnId, pair.targetColumnId),
          label: meaning ? `자식 0..${meaning.childMax === 1 ? '1' : 'N'} · 부모 ${meaning.parentOptional ? '0..1' : '1'}` : 'FK · 검토 필요',
          className: 'fk-edge',
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
        label: relation.name + ' · 논리', className: 'logical-edge', type: 'smoothstep',
      });
    }
  }
  return { nodes, edges };
}

export function EditorCanvas({ document, view, dialect, select, clearSelection, selectInstances, focus, activeTableId, activeRelationId,
  connect, move, layoutSizes, snap, readOnly, showMap, mapId }: {
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
  showMap: boolean;
  mapId: string;
}) {
  const viewportOnly = view.instances.length >= 120;
  const projected = useMemo(() => project(document, view, dialect, viewportOnly), [document, view, dialect, viewportOnly]);
  const [nodes, setNodes] = useState(projected.nodes);
  const displayNodes = useMemo(() => activeTableId ? nodes.map(node => node.data.tableId === activeTableId
    ? { ...node, className: 'active-table' } : node) : nodes, [activeTableId, nodes]);
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
  return <ReactFlowProvider initialNodes={projected.nodes} initialEdges={projected.edges} initialMinZoom={0.15} initialMaxZoom={2.5}>
    <div className="canvas">
      <ReactFlow<CanvasNode, Edge>
        aria-label="ERD 캔버스"
        ariaLabelConfig={canvasLabels}
        nodesDraggable={!readOnly} nodesConnectable={!readOnly}
        nodes={displayNodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={changes => {
          setNodes(previous => applyNodeChanges(readOnly ? changes.filter(change => change.type !== 'position') : changes, previous));
          const positions = new Map<string, XYPosition>();
          // React Flow batches keyboard moves and pointer drag completion with dragging set to false.
          for (const change of changes) {
            if (change.type === 'dimensions' && change.dimensions) layoutSizes.set(change.id, change.dimensions);
            if (change.type === 'position' && change.dragging === false && change.position) {
              positions.set(change.id, change.position);
            }
          }
          if (!readOnly && positions.size) move(positions);
        }}
        onNodeClick={(_, node) => select(node.id)}
        onPaneClick={clearSelection}
        onSelectionChange={onSelection}
        onEdgeClick={(_, edge) => select(String(edge.data?.objectId ?? ''))}
        isValidConnection={connection => Boolean(connection.sourceHandle?.startsWith('out:') && connection.targetHandle?.startsWith('in:'))}
        onConnect={({ sourceHandle, targetHandle }) => {
          if (!readOnly && sourceHandle?.startsWith('out:') && targetHandle?.startsWith('in:')) connect(sourceHandle.slice(4), targetHandle.slice(3));
        }}
        connectionRadius={18} snapToGrid={snap} snapGrid={[20, 20]} deleteKeyCode={null} selectionOnDrag
        panOnDrag={[1, 2]} multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
        onlyRenderVisibleElements={viewportOnly}
        defaultViewport={viewportOnly && anchor ? { x: 24 - anchor.x * 0.75, y: 24 - anchor.y * 0.75, zoom: 0.75 } : undefined}
        minZoom={0.15} maxZoom={2.5}
        proOptions={{ hideAttribution: true }}
      >
        <CanvasViewport focus={focus} viewportOnly={viewportOnly} />
        <Background gap={22} size={1} color="var(--dot)" />
        <Controls showInteractive={false} orientation="horizontal" fitViewOptions={fitOptions} />
      </ReactFlow>
    </div>
    <div id={mapId} className="canvas-map" hidden={!showMap}>
      {showMap && <MiniMap<CanvasNode> ariaLabel="뷰 미니맵" pannable zoomable nodeColor={mapNodeColor} maskColor="var(--map-mask)"
        maskStrokeColor="var(--accent)" maskStrokeWidth={1.5} style={{ width: 178, height: 98 }} />}
    </div>
  </ReactFlowProvider>;
}
