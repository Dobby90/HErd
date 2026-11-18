import type { Catalog, ErdDocument } from '@erd/model';
import { exportTarget } from './ddl-export.js';

export function scaleDocument(id: string, tables: number, foreignKeys: number): ErdDocument {
  const catalog: Catalog = {
    namespaces: [{ id: 'scale-public', physicalName: 'public' }], tables: [], columns: [],
    constraints: [], indexes: [], enums: [], sequences: [],
  };
  const column = (table: number, value: number) => `scale-column-${table}-${value}`;
  const tableId = (index: number) => 'scale-table-' + index;
  const key = (table: number) => 'scale-pk-' + table;
  for (let index = 0; index < tables; index++) {
    const table = tableId(index);
    const columnIds = Array.from({ length: 20 }, (_, value) => column(index, value));
    catalog.tables.push({ id: table, namespaceId: 'scale-public', physicalName: 'shipment_' + index,
      logicalName: '배송 및 재고 관리 ' + index, columnIds });
    columnIds.forEach((id, value) => catalog.columns.push({ id, tableId: table,
      physicalName: value === 0 ? 'id' : 'attribute_' + value,
      logicalName: index === tables - 1 && value === 1 ? '최종 배송 찾기' : undefined,
      nullable: value !== 0,
      type: { reference: { kind: 'native', name: value < 8 ? 'integer' : 'text' }, arguments: [], arrayDimensions: 0 },
    }));
    catalog.constraints.push({ id: key(index), tableId: table, physicalName: 'shipment_pk_' + index, kind: 'pk', columnIds: [column(index, 0)] });
  }
  for (let index = 0; index < foreignKeys; index++) {
    const from = index % tables;
    const variant = 1 + Math.floor(index / tables);
    const to = (from + variant) % tables;
    catalog.constraints.push({
      id: 'scale-fk-' + index, tableId: tableId(from), physicalName: 'link_' + index, kind: 'fk',
      targetTableId: tableId(to), targetKey: { kind: 'constraint', id: key(to) },
      pairs: [{ sourceColumnId: column(from, variant), targetColumnId: column(to, 0) }],
    });
  }
  const columnsPerRow = tables >= 120 ? 12 : 10;
  const layout = (index: number, view: string, perRow: number, columnsVisible: boolean) => ({
    id: view + '-placement-' + index, tableId: tableId(index),
    x: (index % perRow) * 275, y: Math.floor(index / perRow) * (columnsVisible ? 260 : 180),
    collapsed: !columnsVisible && index % 5 !== 0 && index !== tables - 1,
    visibleColumnIds: catalog.tables[index].columnIds.slice(0, 6),
  });
  const views = [
    { id: 'overview', name: '전체 배치', instances: Array.from({ length: tables }, (_, index) => layout(index, 'overview', columnsPerRow, false)) },
    { id: 'west', name: '창고 상세', instances: Array.from({ length: 8 }, (_, index) => layout(index, 'west', 4, true)) },
    { id: 'east', name: '배송 상세', instances: Array.from({ length: 8 }, (_, index) => layout(tables - 8 + index, 'east', 4, true)) },
  ].map(view => ({ ...view, groups: [], notes: [] }));
  return { id, name: '릴리스 검증 모델 ' + tables, target: exportTarget, formatVersion: 1, catalog, views, relationships: [], extensions: [] };
}
