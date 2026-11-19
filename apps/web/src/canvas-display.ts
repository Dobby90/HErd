import type { CanvasDisplay, ErdDocument } from '@erd/model';

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
