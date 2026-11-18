import type { Catalog, ErdDocument, SqlTarget } from '@erd/model';

const target: SqlTarget = { dialectId: 'postgresql', engineVersion: '17' };
const column = (id: string, tableId: string, physicalName: string, type = 'integer'): Catalog['columns'][number] => ({
  id, tableId, physicalName, nullable: false,
  type: { reference: { kind: 'native', name: type }, arguments: [], arrayDimensions: 0 },
});
const table = (id: string, physicalName: string, logicalName: string, description: string, columnIds: string[]): Catalog['tables'][number] => ({
  id, namespaceId: 'public-schema', physicalName, logicalName, description, columnIds,
});
const pair = (sourceColumnId: string, targetColumnId: string) => ({ sourceColumnId, targetColumnId });

export const sampleDocument: ErdDocument = {
  formatVersion: 1,
  id: 'shop-sample',
  name: '주문 관리 샘플',
  target,
  catalog: {
    namespaces: [{ id: 'public-schema', physicalName: 'public', description: '주문 예제 스키마' }],
    tables: [
      table('users', 'users', '고객', '주문한 고객의 식별 정보', ['user-id']),
      table('orders', 'orders', '주문', '고객별 주문 번호로 주문을 식별', ['order-user-id', 'order-number']),
      table('items', 'order_items', '주문 항목', '주문에 담긴 상품과 수량', ['item-user-id', 'item-order-number', 'item-product-id', 'item-quantity']),
      table('products', 'products', '상품', '판매 상품의 식별 정보와 이름', ['product-id', 'product-name']),
    ],
    columns: [
      column('user-id', 'users', 'id'),
      column('order-user-id', 'orders', 'user_id'), column('order-number', 'orders', 'number'),
      column('item-user-id', 'items', 'user_id'), column('item-order-number', 'items', 'order_number'),
      column('item-product-id', 'items', 'product_id'),
      { ...column('item-quantity', 'items', 'quantity'), default: { ...target, sql: '1', references: [], referencesComplete: true } },
      column('product-id', 'products', 'id'), column('product-name', 'products', 'name', 'text'),
    ],
    constraints: [
      { id: 'user-pk', physicalName: 'users_pkey', tableId: 'users', kind: 'pk', columnIds: ['user-id'] },
      { id: 'order-pk', physicalName: 'orders_pkey', tableId: 'orders', kind: 'pk', columnIds: ['order-user-id', 'order-number'] },
      { id: 'item-pk', physicalName: 'order_items_pkey', tableId: 'items', kind: 'pk', columnIds: ['item-user-id', 'item-order-number', 'item-product-id'] },
      { id: 'product-pk', physicalName: 'products_pkey', tableId: 'products', kind: 'pk', columnIds: ['product-id'] },
      { id: 'order-user', physicalName: 'orders_user_fk', tableId: 'orders', kind: 'fk', targetTableId: 'users',
        targetKey: { kind: 'constraint', id: 'user-pk' }, pairs: [pair('order-user-id', 'user-id')] },
      { id: 'item-order', physicalName: 'order_items_order_fk', tableId: 'items', kind: 'fk', targetTableId: 'orders',
        targetKey: { kind: 'constraint', id: 'order-pk' }, pairs: [pair('item-user-id', 'order-user-id'), pair('item-order-number', 'order-number')] },
      { id: 'item-product', physicalName: 'order_items_product_fk', tableId: 'items', kind: 'fk', targetTableId: 'products',
        targetKey: { kind: 'constraint', id: 'product-pk' }, pairs: [pair('item-product-id', 'product-id')] },
      { id: 'item-quantity-check', physicalName: 'order_items_quantity_check', tableId: 'items', kind: 'check',
        expression: { ...target, sql: 'quantity > 0', references: ['item-quantity'], referencesComplete: true } },
    ],
    indexes: [{ id: 'product-name-index', physicalName: 'products_name_idx', tableId: 'products', unique: false,
      keys: [{ kind: 'expression', expression: { ...target, sql: 'lower(name)', references: ['product-name'], referencesComplete: true } }] }],
    enums: [],
    sequences: [],
  },
  relationships: [{ id: 'reporting', name: '고객별 상품 집계', sourceTableId: 'users', targetTableId: 'products', cardinality: 'many-to-many' }],
  views: [
    {
      id: 'overview', name: '주문 전체',
      instances: [
        { id: 'overview-orders', tableId: 'orders', x: 200, y: 40, size: { width: 240, height: 150 }, groupId: 'sales' },
        { id: 'overview-users', tableId: 'users', x: 0, y: 40 },
        { id: 'overview-items', tableId: 'items', x: 460, y: 40, groupId: 'sales' },
        { id: 'overview-products', tableId: 'products', x: 460, y: 240 },
      ],
      groups: [{ id: 'sales', name: '주문 처리', x: 180, y: 20 }],
      notes: [{ id: 'overview-note', text: '고객 ID와 주문 번호가 함께 주문을 식별합니다.', x: 200, y: 220, groupId: 'sales' }],
    },
    {
      id: 'products-view', name: '상품 연결',
      instances: [
        { id: 'products-orders', tableId: 'orders', visibleColumnIds: ['order-number'], x: 0, y: 0 },
        { id: 'products-items', tableId: 'items', x: 240, y: 0 },
        { id: 'products-products', tableId: 'products', x: 480, y: 0 },
      ],
      groups: [], notes: [],
    },
  ],
  extensions: [],
};
