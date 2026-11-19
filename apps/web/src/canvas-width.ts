type WidthRow = { name: string; logicalName?: string; type: string; badges: string[] };

export function measureTableWidths() {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return () => 195;

  const root = getComputedStyle(document.documentElement);
  const rem = parseFloat(root.fontSize) || 16;
  const mono = root.getPropertyValue('--mono').trim() || 'monospace';
  const title = `650 ${.83 * rem}px ${mono}`;
  const name = `${.77 * rem}px ${mono}`;
  const logical = `${.69 * rem}px system-ui, sans-serif`;
  const type = `${.66 * rem}px ${mono}`;
  const badge = `700 ${.58 * rem}px ${mono}`;
  const measured = new Map<string, number>();

  function widthOf(value: string | undefined, font: string) {
    if (!value || !context) return 0;
    const key = font + '\0' + value;
    const previous = measured.get(key);
    if (previous !== undefined) return previous;
    context.font = font;
    const width = context.measureText(value).width;
    measured.set(key, width);
    return width;
  }

  // Reserve space for controls that appear when the table is selected.
  const headerSpace = 2 + 15 + 20 + (1.24 + .8) * rem;
  const rowSpace = 2 + 15 + (1.14 - .32 + .6) * rem;
  return (label: string, logicalName: string | undefined, rows: WidthRow[]) => {
    let width = Math.max(widthOf(label, title), widthOf(logicalName, logical)) + headerSpace;
    for (const row of rows) {
      const badges = row.badges.reduce((sum, text) => sum + widthOf(text, badge) + 8, 0)
        + Math.max(0, row.badges.length - 1) * .16 * rem;
      const typeWidth = Math.min(widthOf(row.type, type), 8 * rem);
      const rowWidth = Math.max(widthOf(row.name, name), widthOf(row.logicalName, logical)) + typeWidth + badges + rowSpace;
      width = Math.max(width, rowWidth);
    }
    return Math.max(195, Math.min(640, Math.ceil(width)));
  };
}
