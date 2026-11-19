type WidthRow = { name: string; logicalName?: string; type?: string; badges: string[] };

export function measureTableLayout() {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return () => ({ width: 195, rowWidth: 195, typeWidth: 0, badgeWidth: 0 });

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
  const rowSpace = 2 + 15 + (1.14 + .56) * rem;
  return (label: string, logicalName: string | undefined, rows: WidthRow[]) => {
    const headerWidth = Math.max(widthOf(label, title), widthOf(logicalName, logical)) + headerSpace;
    let nameWidth = 0, typeWidth = 0, badgeWidth = 0;
    for (const row of rows) {
      const badges = row.badges.reduce((sum, text) => sum + widthOf(text.toUpperCase(), badge) + 8, 0)
        + Math.max(0, row.badges.length - 1) * .16 * rem;
      nameWidth = Math.max(nameWidth, widthOf(row.name, name), widthOf(row.logicalName, logical));
      typeWidth = Math.max(typeWidth, widthOf(row.type, type));
      badgeWidth = Math.max(badgeWidth, badges);
    }
    typeWidth = Math.ceil(typeWidth);
    badgeWidth = Math.ceil(badgeWidth);
    const rowWidth = Math.ceil(nameWidth + typeWidth + badgeWidth + rowSpace);
    const width = Math.max(195, Math.min(640, Math.ceil(Math.max(headerWidth, rowWidth))));
    return { width, rowWidth, typeWidth, badgeWidth };
  };
}
