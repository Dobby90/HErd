import type { CanvasDisplay, ErdDocument } from '@erd/model';
import type { EditorDialect } from '@erd/sql-contract';

export const displayFields = [
  ['tableComments', '테이블 코멘트'],
  ['columns', '컬럼 목록'],
  ['columnTypes', '컬럼 자료형'],
  ['columnBadges', 'PK·FK·UNIQUE 배지'],
  ['columnNullability', 'NULL 허용 여부'],
  ['columnDefaults', '컬럼 기본값'],
  ['columnComments', '컬럼 코멘트'],
  ['relationships', '관계선'],
  ['relationshipLabels', '관계선 라벨'],
  ['notes', '메모'],
  ['groups', '그룹'],
  ['grid', '배경 격자'],
] as const satisfies ReadonlyArray<readonly [keyof CanvasDisplay, string]>;

type LogicalRelationship = ErdDocument['relationships'][number];
export const logicalCardinalities = { 'one-to-one': '1:1', 'one-to-many': '1:N', 'many-to-many': 'N:M' } as const;

export function logicalRelationshipLabel(relation: LogicalRelationship) {
  return `${relation.name} · 논리 · ${logicalCardinalities[relation.cardinality]}`;
}

export function foreignKeyLabel(identifying: boolean, meaning: ReturnType<EditorDialect['cardinality']>) {
  if (!meaning) return 'FK · 검토 필요';
  return `${identifying ? '식별' : '비식별'} · 자식 0..${meaning.childMax === 1 ? '1' : 'N'} · 부모 ${meaning.parentOptional ? '0..1' : '1'}`;
}

const defaults: CanvasDisplay = {
  tableComments: false,
  columns: true,
  columnTypes: true,
  columnBadges: true,
  columnNullability: false,
  columnDefaults: true,
  columnComments: false,
  relationships: true,
  relationshipLabels: true,
  notes: true,
  groups: true,
  grid: true,
};

export function canvasDisplay(document: ErdDocument): CanvasDisplay {
  return { ...defaults, ...document.canvasDisplay };
}
