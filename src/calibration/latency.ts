import { stdDev, trimmedMean } from './stats';

export interface LatencyResult {
  /** Positive = taps register this many ms after the beat is heard. Subtract from hit times. */
  offsetMs: number;
  stdDevMs: number;
  samples: number;
}

export const LATENCY_WINDOW_MS = 250;
export const LATENCY_MIN_SAMPLES = 6;

/**
 * Pairs each tap with the nearest beat (within ±windowMs), skips taps on the first
 * `skipBeats` beats while the player settles in, and returns the trimmed mean error.
 * Times are performance.now() ms; beats are when the click is heard.
 */
export function computeLatencyOffset(
  taps: readonly number[],
  beats: readonly number[],
  { windowMs = LATENCY_WINDOW_MS, skipBeats = 2 } = {},
): LatencyResult | null {
  const errors: number[] = [];
  const used = new Set<number>();
  for (const t of taps) {
    let best = -1;
    for (let i = 0; i < beats.length; i++) {
      if (best < 0 || Math.abs(t - beats[i]!) < Math.abs(t - beats[best]!)) best = i;
    }
    if (best < skipBeats || used.has(best)) continue;
    const err = t - beats[best]!;
    if (Math.abs(err) > windowMs) continue;
    used.add(best);
    errors.push(err);
  }
  if (errors.length < LATENCY_MIN_SAMPLES) return null;
  const trimmed = trimmedMean(errors, 0.1);
  return { offsetMs: Math.round(trimmed * 10) / 10, stdDevMs: Math.round(stdDev(errors) * 10) / 10, samples: errors.length };
}

