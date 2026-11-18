import { useCallback, useEffect, useMemo, useState } from 'react';
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow, useNodesInitialized, useReactFlow, useUpdateNodeInternals } from '@xyflow/react';
import type { Edge, Node, NodeProps, OnSelectionChangeParams, XYPosition } from '@xyflow/react';
import { columnBadges, physicalRelationships } from '@erd/model';
import type { ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';
import { viewColumnIds, viewLabel } from './editor-fields.js';

type View = ErdDocument['views'][number];
type CanvasNode = Node<Record<string, unknown> & {
  label: string;
  highlighted?: boolean;
  columns?: Array<{ id: string; name: string; badges: string[]; highlighted?: boolean }>;
}, 'table' | 'groupBox' | 'note'>;

export type CanvasFocus = { instanceId: string; columnId?: string };
export type LayoutSizes = Map<string, { width: number; height: number }>;

function FocusNode({ focus }: { focus?: CanvasFocus }) {
  const ready = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (focus && ready) void fitView({ nodes: [{ id: focus.instanceId }], maxZoom: 1.15, padding: 0.35, duration: 160 });
  }, [fitView, ready, focus]);
  return null;
}

function TableNode({ id, data }: NodeProps<CanvasNode>) {
  const refresh = useUpdateNodeInternals();
  const handles = data.columns?.map(column => column.id).join(':');
  useEffect(() => refresh(id), [handles, id, refresh]);
  return <article className={'canvas-table' + (data.highlighted ? ' search-match' : '')}>
    <strong>{data.label}</strong>
    <Handle id="table-in" type="target" position={Position.Left} isConnectable={false} />
    <Handle id="table-out" type="source" position={Position.Right} isConnectable={false} />
    {data.columns?.map(column => <div className={'canvas-column' + (column.highlighted ? ' search-match' : '')} key={column.id}>
      <Handle id={'in:' + column.id} type="target" position={Position.Left} aria-label={column.name + ' 참조점'} />
      <span>{column.name}</span><small>{column.badges.join(' · ').toUpperCase()}</small>
      <Handle id={'out:' + column.id} type="source" position={Position.Right} aria-label={column.name + ' 연결점'} />
    </div>)}
  </article>;
}

function GroupNode({ data }: NodeProps<CanvasNode>) {
  return <strong>{data.label}</strong>;
}

function NoteNode({ data }: NodeProps<CanvasNode>) {
  return <div className="note-text">{data.label}</div>;
}

const nodeTypes = { table: TableNode, groupBox: GroupNode, note: NoteNode };

function project(document: ErdDocument, view: View, dialect: EditorDialect | undefined, focus?: CanvasFocus) {
  const tables = new Map(document.catalog.tables.map(table => [table.id, table]));
  const columns = new Map(document.catalog.columns.map(column => [column.id, column]));
  const instances = new Map<string, CanvasNode[]>();
  const nodes: CanvasNode[] = [
    ...view.groups.map((group): CanvasNode => ({
      id: group.id, type: 'groupBox', position: { x: group.x, y: group.y },
      data: { label: group.name }, style: group.size ?? { width: 480, height: 250 }, zIndex: -1,
    })),
    ...view.notes.map((note): CanvasNode => ({
      id: note.id, type: 'note', position: { x: note.x, y: note.y },
      data: { label: note.text }, style: note.size ?? { width: 210 },
    })),
  ];
  for (const instance of view.instances) {
    const table = tables.get(instance.tableId);
    if (!table) continue;
    const visible = viewColumnIds(table, instance);
    const node: CanvasNode = {
      id: instance.id, type: 'table', position: { x: instance.x, y: instance.y },
      style: { width: instance.size?.width ?? 195 },
      data: {
        label: viewLabel(table, view.nameDisplay), highlighted: instance.id === focus?.instanceId,
        columns: visible.flatMap(id => {
          const column = columns.get(id);
          return column ? [{ id, name: viewLabel(column, view.nameDisplay), badges: columnBadges(document, id),
            highlighted: instance.id === focus?.instanceId && id === focus.columnId }] : [];
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
    const meaning = dialect?.cardinality(document, key);
    const pair = key.pairs[0];
    for (const source of instances.get(key.tableId) ?? []) {
      const targets = key.tableId === key.targetTableId ? [source] : instances.get(key.targetTableId) ?? [];
      for (const target of targets) {
        edges.push({
          id: JSON.stringify([key.id, source.id, target.id]), data: { objectId: key.id },
          source: source.id, target: target.id,
          sourceHandle: source.data.columns?.some(column => column.id === pair.sourceColumnId) ? 'out:' + pair.sourceColumnId : 'table-out',
          targetHandle: target.data.columns?.some(column => column.id === pair.targetColumnId) ? 'in:' + pair.targetColumnId : 'table-in',
          label: meaning ? `자식 0..${meaning.childMax === 1 ? '1' : 'N'} · 부모 ${meaning.parentOptional ? '0..1' : '1'}` : 'FK · 검토 필요',
          className: 'fk-edge',
          type: source.id === target.id ? 'smoothstep' : 'default',
        });
      }
    }
  }
  for (const relation of document.relationships) {
    for (const source of instances.get(relation.sourceTableId) ?? []) {
      const targets = relation.sourceTableId === relation.targetTableId ? [source] : instances.get(relation.targetTableId) ?? [];
      for (const target of targets) edges.push({
        id: JSON.stringify([relation.id, source.id, target.id]), data: { objectId: relation.id },
        source: source.id, target: target.id, sourceHandle: 'table-out', targetHandle: 'table-in',
        label: relation.name + ' · 논리', className: 'logical-edge', type: 'smoothstep',
      });
    }
  }
  return { nodes, edges };
}

export function EditorCanvas({ document, view, dialect, select, selectInstances, focus, connect, move, layoutSizes, snap, readOnly }: {
  document: ErdDocument; view: View; dialect?: EditorDialect;
  select(id: string): void;
  selectInstances(ids: string[]): void;
  focus?: CanvasFocus;
  layoutSizes: LayoutSizes;
  connect(sourceColumnId: string, targetColumnId: string): void;
  move(positions: Map<string, XYPosition>): void;
  snap: boolean;
  readOnly: boolean;
}) {
  const projected = useMemo(() => project(document, view, dialect, focus), [document, view, dialect, focus]);
  const [nodes, setNodes] = useState(projected.nodes);
  const onSelection = useCallback(({ nodes }: OnSelectionChangeParams) => {
    selectInstances(nodes.filter(node => node.type === 'table').map(node => node.id));
  }, [selectInstances]);
  useEffect(() => setNodes(previous => {
    const selected = new Set(previous.filter(node => node.selected).map(node => node.id));
    return projected.nodes.map(node => ({ ...node, selected: selected.has(node.id) }));
  }), [projected]);
  return <ReactFlow<CanvasNode, Edge>
    aria-label="ERD 캔버스"
    nodesDraggable={!readOnly} nodesConnectable={!readOnly}
    nodes={nodes} edges={projected.edges} nodeTypes={nodeTypes}
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
    onSelectionChange={onSelection}
    onEdgeClick={(_, edge) => select(String(edge.data?.objectId ?? ''))}
    isValidConnection={connection => Boolean(connection.sourceHandle?.startsWith('out:') && connection.targetHandle?.startsWith('in:'))}
    onConnect={({ sourceHandle, targetHandle }) => {
      if (!readOnly && sourceHandle?.startsWith('out:') && targetHandle?.startsWith('in:')) connect(sourceHandle.slice(4), targetHandle.slice(3));
    }}
    connectionRadius={18} snapToGrid={snap} snapGrid={[20, 20]} deleteKeyCode={null} selectionOnDrag
    panOnDrag={[1, 2]} multiSelectionKeyCode={['Shift', 'Meta', 'Control']} fitView
    minZoom={0.15} maxZoom={2.5}
    proOptions={{ hideAttribution: true }}
  >
    <FocusNode focus={focus} />
    <Background gap={20} color="#54647b" />
    <Controls showInteractive={false} />
    <MiniMap pannable zoomable />
  </ReactFlow>;
}
