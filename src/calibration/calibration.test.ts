import { describe, expect, it } from 'vitest';
import { computeLatencyOffset, plausibleOffset } from './latency';
import { median, trimmedMean } from './stats';

describe('stats', () => {
  it('median and trimmed mean', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(trimmedMean([0, 10, 10, 10, 10, 10, 10, 10, 10, 1000], 0.1)).toBe(10);
  });
});

describe('computeLatencyOffset', () => {
  const beats = Array.from({ length: 16 }, (_, i) => 1000 + i * 600);

  it('measures a constant offset', () => {
    const taps = beats.map((b) => b + 42);
    expect(computeLatencyOffset(taps, beats)).toMatchObject({ offsetMs: 42, stdDevMs: 0, samples: 14 });
  });

  it('handles jitter, ignores the first beats, stray taps and outliers', () => {
    const jitter = [5, -5, 3, -3, 8, -8, 2, -2, 6, -6, 1, -1, 4, -4, 0, 0];
    const taps = [...beats.map((b, i) => b + 30 + jitter[i]!), 1300, beats[8]! + 31];
    const r = computeLatencyOffset(taps, beats)!;
    expect(Math.abs(r.offsetMs - 30)).toBeLessThan(2);
    expect(r.samples).toBe(14);
  });

  it('returns null with too few matching taps', () => {
    expect(computeLatencyOffset([beats[3]!, beats[4]!], beats)).toBeNull();
  });
});

describe('plausibleOffset', () => {
  it('accepts device delay plus tapping habit, rejects reacting to the click', () => {
    expect(plausibleOffset(35)).toBe(true);
    expect(plausibleOffset(-40)).toBe(true);
    expect(plausibleOffset(190)).toBe(false);
  });
});
