/**
 * Built-in patterns. Steps are 16th notes (0–15 per bar). Pads follow the
 * kit layout: 0 kick, 1 snare, 2 closed hat, 3 open hat, 4–6 toms, 7 clap.
 */
export interface Pattern {
  id: string;
  name: string;
  bars: 1 | 2;
  notes: readonly (readonly [step: number, pad: number])[];
}

const K = 0, S = 1, H = 2, LT = 4, MT = 5, HT = 6, CL = 7;
const on = (pad: number, ...steps: number[]) => steps.map((s) => [s, pad] as const);

export const PATTERNS: readonly Pattern[] = [
  { id: 'steady', name: 'Steady', bars: 1, notes: on(K, 0, 4, 8, 12) },
  { id: 'kickSnare', name: 'Boom clap', bars: 1, notes: [...on(K, 0, 8), ...on(S, 4, 12)] },
  { id: 'doubleKick', name: 'Double kick', bars: 1, notes: [...on(K, 0, 2, 8), ...on(S, 4, 12)] },
  { id: 'hats', name: 'Hi-hats', bars: 1, notes: on(H, 0, 2, 4, 6, 8, 10, 12, 14) },
  { id: 'rock', name: 'Rock', bars: 1, notes: [...on(K, 0, 8), ...on(S, 4, 12), ...on(H, 2, 6, 10, 14)] },
  { id: 'skip', name: 'Skip', bars: 1, notes: [...on(K, 0, 6, 8), ...on(S, 4, 12)] },
  { id: 'clapAlong', name: 'Clap along', bars: 1, notes: [...on(K, 0, 8, 10), ...on(CL, 4, 12)] },
  { id: 'tomRoll', name: 'Tom roll', bars: 1, notes: [...on(HT, 0, 2), ...on(MT, 4, 6), ...on(LT, 8, 10), ...on(K, 12)] },
  {
    id: 'callAnswer', name: 'Call and answer', bars: 2,
    notes: [...on(K, 0, 4, 8), ...on(S, 12), ...on(K, 16, 20), ...on(S, 24, 26, 28)],
  },
  {
    id: 'funky', name: 'Funky', bars: 2,
    notes: [...on(K, 0, 3, 8, 11), ...on(S, 4, 12), ...on(K, 16, 22, 24), ...on(S, 20, 28, 30)],
  },
];

/** Pads used by a pattern, in kit order. */
export function patternPads(p: Pattern): number[] {
  return [...new Set(p.notes.map(([, pad]) => pad))].sort((a, b) => a - b);
}
