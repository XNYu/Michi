export function computeGridTemplate(
  mode: 'single' | 'two' | 'three',
  openCount: number,
  widths?: (number | undefined)[],
  defaultWidth?: number,
): { gridTemplateColumns: string; overflow: boolean } {
  const cap = mode === 'single' ? 1 : mode === 'two' ? 2 : 3;
  const minW = defaultWidth ?? 360;
  if (openCount <= cap) {
    const cols = Array.from({ length: Math.max(openCount, 1) }, (_, i) => {
      const w = widths?.[i];
      return w !== undefined ? `${w}px` : '1fr';
    }).join(' ');
    return { gridTemplateColumns: cols, overflow: false };
  }
  const cols = Array.from({ length: openCount }, (_, i) => {
    const w = widths?.[i];
    return w !== undefined ? `${w}px` : `minmax(${minW}px, 1fr)`;
  }).join(' ');
  return { gridTemplateColumns: cols, overflow: true };
}
