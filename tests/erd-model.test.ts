import { describe, expect, it } from 'vitest';
import { validateDocumentStructure, columnBadges, erdDocumentSchema, physicalRelationships } from '@erd/model';
import { sampleDocument } from '@erd/test-fixtures';

describe('ERD structure', () => {
  it('shares definitions across views and derives foreign keys separately', () => {
    expect(validateDocumentStructure(sampleDocument)).toEqual([]);
    expect(sampleDocument.views.map(view => view.instances[0].tableId)).toEqual(['orders', 'orders']);
    expect(physicalRelationships(sampleDocument).map(key => key.id)).toEqual(['order-user', 'item-order', 'item-product']);
    expect(sampleDocument.relationships.map(relation => relation.id)).toEqual(['reporting']);
    expect(columnBadges(sampleDocument, 'item-order-number')).toEqual(['pk', 'fk']);
  });

  it('reports duplicate IDs, missing columns, and invalid composite mappings', () => {
    const broken = structuredClone(sampleDocument);
    broken.catalog.tables[0].id = broken.catalog.namespaces[0].id;
    const foreignKey = broken.catalog.constraints.find(key => key.id === 'item-order');
    if (foreignKey?.kind !== 'fk') throw new Error('Expected the composite foreign key');
    foreignKey.pairs[0].sourceColumnId = foreignKey.pairs[1].sourceColumnId;
    foreignKey.pairs[0].targetColumnId = 'missing';
    expect(validateDocumentStructure(broken).map(issue => issue.code)).toEqual(expect.arrayContaining([
      'duplicate-id', 'invalid-column-reference', 'invalid-foreign-key',
    ]));
    foreignKey.pairs.pop();
    expect(validateDocumentStructure(broken).map(issue => issue.code)).toContain('invalid-foreign-key');
  });
});

it('distinguishes runtime shape errors from wrong-table composite key references', () => {
  const document = structuredClone(sampleDocument);
  document.catalog.columns[0].type.arrayDimensions = -1;
  expect(erdDocumentSchema.safeParse(document).success).toBe(false);

  document.catalog.columns[0].type.arrayDimensions = 0;
  const foreignKey = document.catalog.constraints.find(key => key.id === 'item-order');
  if (foreignKey?.kind !== 'fk') throw new Error('Expected the composite foreign key');
  foreignKey.pairs[0].sourceColumnId = 'user-id';
  expect(erdDocumentSchema.safeParse(document).success).toBe(true);
  expect(validateDocumentStructure(document)).toContainEqual(expect.objectContaining({
    code: 'invalid-column-reference', objectId: foreignKey.id,
  }));
});
