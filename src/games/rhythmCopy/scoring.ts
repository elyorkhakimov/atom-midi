/** Rhythm copy scoring (spec §9). Times in ms, hits already latency-adjusted. */
export const MATCH_WINDOW_MS = 100;
export const EXTRA_PENALTY = 25;

export interface Note {
  pad: number;
  t: number;
}

export interface RhythmScore {
  points: number;
  maxPoints: number;
  /** 0–100. */
  percent: number;
  /** Signed error (hit − expected) for each matched expected note, null = missed. */
  errors: (number | null)[];
  /** For each hit: index of the expected note it matched, or -1 (extra / wrong pad). */
  hitMatches: number[];
  misses: number;
  extras: number;
  meanAbsErrorMs: number | null;
  /** Positive = late on average. */
  meanErrorMs: number | null;
}

/**
 * Each hit matches the nearest expected note on the same pad within ±100 ms; every
 * expected note matches at most one hit (closest pairs first).
 * Points: 100 × (1 − |err|/100 ms) per match; miss = 0; extra or wrong-pad hit = −25.
 */
export function scoreRhythm(expected: readonly Note[], hits: readonly Note[]): RhythmScore {
  const pairs: { e: number; h: number; err: number }[] = [];
  hits.forEach((hit, h) =>
    expected.forEach((exp, e) => {
      const err = hit.t - exp.t;
      if (hit.pad === exp.pad && Math.abs(err) <= MATCH_WINDOW_MS) pairs.push({ e, h, err });
    }),
  );
  pairs.sort((a, b) => Math.abs(a.err) - Math.abs(b.err));

  const errors: (number | null)[] = Array(expected.length).fill(null);
  const hitMatches: number[] = Array(hits.length).fill(-1);
  for (const { e, h, err } of pairs) {
    if (errors[e] !== null || hitMatches[h] !== -1) continue;
    errors[e] = err;
    hitMatches[h] = e;
  }

  const matched = errors.filter((x): x is number => x !== null);
  const extras = hitMatches.filter((m) => m === -1).length;
  const points = matched.reduce((sum, err) => sum + 100 * (1 - Math.abs(err) / MATCH_WINDOW_MS), 0) - EXTRA_PENALTY * extras;
  const maxPoints = 100 * expected.length;
  return {
    points,
    maxPoints,
    percent: maxPoints ? Math.max(0, (points / maxPoints) * 100) : 0,
    errors,
    hitMatches,
    misses: expected.length - matched.length,
    extras,
    meanAbsErrorMs: matched.length ? matched.reduce((a, x) => a + Math.abs(x), 0) / matched.length : null,
    meanErrorMs: matched.length ? matched.reduce((a, x) => a + x, 0) / matched.length : null,
  };
}
