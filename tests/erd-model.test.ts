import { describe, expect, it } from 'vitest';
import { validateDocumentStructure, columnBadges, physicalRelationships } from '@erd/model';
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
