import { CORNER_PADS, PAD_COLS, PAD_COUNT } from '../midi/atomMap';
import type { PadLed } from '../midi/ledFrame';

export interface Player {
  name: string;
  css: string;
  led: PadLed;
}

/** Same colours everywhere: pads, screen, scores. */
export const PLAYERS: readonly Player[] = [
  { name: 'Red', css: '#ff4d4d', led: { r: 127, g: 0, b: 0 } },
  { name: 'Blue', css: '#3d8bff', led: { r: 0, g: 20, b: 127 } },
  { name: 'Green', css: '#2fd16b', led: { r: 0, g: 127, b: 0 } },
  { name: 'Yellow', css: '#ffd02b', led: { r: 127, g: 90, b: 0 } },
];

/**
 * Pads per player for simultaneous games: 1 player = whole board, 2 = left/right
 * halves, 3–4 = one corner pad each (so hands don't collide).
 */
export function playerPads(count: number): number[][] {
  const all = Array.from({ length: PAD_COUNT }, (_, i) => i);
  if (count <= 1) return [all];
  if (count === 2) {
    return [all.filter((p) => p % PAD_COLS < PAD_COLS / 2), all.filter((p) => p % PAD_COLS >= PAD_COLS / 2)];
  }
  return CORNER_PADS.slice(0, count).map((p) => [p]);
}

export function playerOfPad(layout: readonly number[][], pad: number): number {
  return layout.findIndex((pads) => pads.includes(pad));
}

export function dim(led: PadLed, k: number): PadLed {
  return { r: led.r * k, g: led.g * k, b: led.b * k };
}
