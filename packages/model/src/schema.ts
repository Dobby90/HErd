import { z } from 'zod';

const id = z.string().min(1);
const extension = z.object({ namespace: id, version: z.number().int().positive(), data: z.json() });
const named = z.strictObject({
  id,
  physicalName: z.string(),
  logicalName: z.string().optional(),
  description: z.string().optional(),
  extensions: z.array(extension).optional(),
});
const catalogObject = named.extend({ namespaceId: id });
export const sqlTargetSchema = z.object({ dialectId: id, engineVersion: id });
export const sqlExpressionSchema = sqlTargetSchema.extend({
  sql: z.string().min(1),
  references: z.array(id).optional(),
  referencesComplete: z.boolean().optional(),
  invalidated: z.literal(true).optional(),
});
const typeDescriptor = z.strictObject({
  reference: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('native'), name: id, namespace: id.optional() }),
    z.strictObject({ kind: z.literal('enum'), enumId: id }),
  ]),
  arguments: z.array(z.union([z.string(), z.number()])),
  arrayDimensions: z.number().int().nonnegative(),
  originalSql: z.string().optional(),
  attributes: z.array(extension).optional(),
});
const table = catalogObject.extend({ columnIds: z.array(id) });
const sequenceSettings = z.strictObject({
  increment: z.string().optional(),
  start: z.string().optional(),
  min: z.string().optional(),
  max: z.string().optional(),
  cache: z.string().optional(),
  cycle: z.boolean().optional(),
});
const column = named.extend({
  tableId: id,
  type: typeDescriptor,
  nullable: z.boolean(),
  default: sqlExpressionSchema.optional(),
  identity: z.enum(['always', 'by-default']).optional(),
  identitySequence: sequenceSettings.extend({ physicalName: id.optional() }).optional(),
});
const tableMember = named.extend({ tableId: id });
const keyColumns = z.array(id).min(1);
const constraint = z.discriminatedUnion('kind', [
  tableMember.extend({ kind: z.literal('pk'), columnIds: keyColumns }),
  tableMember.extend({ kind: z.literal('unique'), columnIds: keyColumns }),
  tableMember.extend({ kind: z.literal('fk'), targetTableId: id,
    targetKey: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('constraint'), id }),
      z.object({ kind: z.literal('index'), id }),
    ]),
    pairs: z.array(z.object({ sourceColumnId: id, targetColumnId: id })).min(1),
    onDelete: z.enum(['no-action', 'restrict', 'cascade', 'set-null', 'set-default']).optional(),
    onUpdate: z.enum(['no-action', 'restrict', 'cascade', 'set-null', 'set-default']).optional(),
  }),
  tableMember.extend({ kind: z.literal('check'), expression: sqlExpressionSchema }),
]);
const index = tableMember.extend({
  unique: z.boolean(),
  keys: z.array(z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('column'), columnId: id }),
    z.strictObject({ kind: z.literal('expression'), expression: sqlExpressionSchema }),
  ])).min(1),
  predicate: sqlExpressionSchema.optional(),
});
const position = z.object({ x: z.number(), y: z.number() });
const size = z.object({ width: z.number().positive(), height: z.number().positive() });
export const annotationColorSchema = z.string().length(7).regex(/^#[0-9a-f]{6}$/i);
export const viewNameDisplaySchema = z.enum(['physical', 'logical', 'both']);
const canvasDisplay = z.object({
  tableComments: z.boolean(),
  columns: z.boolean(),
  columnTypes: z.boolean(),
  columnBadges: z.boolean(),
  columnNullability: z.boolean(),
  columnDefaults: z.boolean(),
  columnComments: z.boolean(),
  relationships: z.boolean(),
  relationshipLabels: z.boolean(),
  notes: z.boolean(),
  groups: z.boolean(),
  grid: z.boolean(),
});
const view = z.object({
  id,
  name: id,
  nameDisplay: viewNameDisplaySchema.optional(),
  instances: z.array(position.extend({
    id, tableId: id, collapsed: z.boolean().optional(), size: size.optional(), visibleColumnIds: z.array(id).optional(), groupId: id.optional(),
  })),
  groups: z.array(position.extend({ id, name: id, size: size.optional(), color: annotationColorSchema.optional() })),
  notes: z.array(position.extend({ id, text: z.string(), size: size.optional(), groupId: id.optional(), color: annotationColorSchema.optional() })),
});

export const erdDocumentSchema = z.object({
  formatVersion: z.literal(1),
  id,
  name: id,
  target: sqlTargetSchema,
  canvasDisplay: canvasDisplay.partial().optional(),
  catalog: z.object({
    namespaces: z.array(named),
    tables: z.array(table),
    columns: z.array(column),
    constraints: z.array(constraint),
    indexes: z.array(index),
    enums: z.array(catalogObject.extend({ values: z.array(z.string()) })),
    sequences: z.array(catalogObject.extend({
      dataType: z.enum(['smallint', 'integer', 'bigint']).optional(),
      ...sequenceSettings.shape,
      ownedByColumnId: id.optional(),
    })),
  }),
  relationships: z.array(z.object({
    id, name: id, sourceTableId: id, targetTableId: id,
    cardinality: z.enum(['one-to-one', 'one-to-many', 'many-to-many']),
    description: z.string().optional(),
  })),
  views: z.array(view),
  extensions: z.array(extension),
});

export type ErdDocument = z.infer<typeof erdDocumentSchema>;
export type CanvasDisplay = z.infer<typeof canvasDisplay>;
export type SqlTarget = z.infer<typeof sqlTargetSchema>;
export type SqlExpression = z.infer<typeof sqlExpressionSchema>;
export type Catalog = ErdDocument['catalog'];
export type ForeignKey = Extract<Catalog['constraints'][number], { kind: 'fk' }>;
