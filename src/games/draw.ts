/** Canvas helpers shared by game screens. Sizes are in CSS pixels. */
export const THEME = {
  bg: '#0e1116',
  panel: '#1a2029',
  text: '#f2f5f8',
  muted: '#8b95a3',
  good: '#2fd16b',
  bad: '#ff4d4d',
  warn: '#ffb020',
  accent: '#4aa3ff',
  font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
};

export function clear(g: CanvasRenderingContext2D, w: number, h: number, color = THEME.bg): void {
  g.fillStyle = color;
  g.fillRect(0, 0, w, h);
}

export function text(
  g: CanvasRenderingContext2D,
  s: string,
  x: number,
  y: number,
  size: number,
  color = THEME.text,
  align: CanvasTextAlign = 'center',
  weight = 700,
): void {
  g.font = `${weight} ${Math.round(size)}px ${THEME.font}`;
  g.fillStyle = color;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillText(s, x, y);
}

/** Font size that fits `s` into `maxWidth`, capped at `max`. */
export function fitSize(g: CanvasRenderingContext2D, s: string, maxWidth: number, max: number, weight = 700): number {
  g.font = `${weight} ${max}px ${THEME.font}`;
  const w = g.measureText(s).width;
  return w > maxWidth ? (max * maxWidth) / w : max;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, fill: string): void {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
  g.fillStyle = fill;
  g.fill();
}

export function ledCss(c: { r: number; g: number; b: number }, alpha = 1): string {
  const k = 255 / 127;
  return `rgba(${Math.round(c.r * k)}, ${Math.round(c.g * k)}, ${Math.round(c.b * k)}, ${alpha})`;
}

export function formatMs(ms: number): string {
  return `${Math.round(ms)} ms`;
}
