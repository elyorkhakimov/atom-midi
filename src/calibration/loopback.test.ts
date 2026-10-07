import { describe, expect, it } from 'vitest';
import { findLag, makeChirp, summarizeLoopback } from './loopback';

const SR = 48000;

/** Deterministic noise so the tests don't flake. */
function noise(n: number, level: number, seed = 1): Float32Array {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    out[i] = ((s / 2 ** 32) * 2 - 1) * level;
  }
  return out;
}

describe('findLag', () => {
  const ref = makeChirp(SR);

  it('finds a quiet, noisy copy of the probe', () => {
    const rec = noise(SR, 0.02);
    const at = 1000 + 3456;
    for (let i = 0; i < ref.length; i++) rec[at + i]! += ref[i]! * 0.1;
    const m = findLag(rec, ref, 1000, 0.3 * SR)!;
    expect(m.lag).toBe(3456);
    expect(m.score).toBeGreaterThan(0.5);
  });

  it('scores low when the probe is absent', () => {
    const m = findLag(noise(SR, 0.05, 7), ref, 0, 0.3 * SR)!;
    expect(m.score).toBeLessThan(0.25);
  });

  it('returns null past the end of the recording', () => {
    expect(findLag(new Float32Array(100), ref, 0, 1000)).toBeNull();
  });
});

describe('summarizeLoopback', () => {
  it('ignores unheard probes and reports the median', () => {
    const s = summarizeLoopback(
      [
        { lag: 4800, score: 0.8 },
        { lag: 4848, score: 0.7 },
        { lag: 4896, score: 0.6 },
        { lag: 20000, score: 0.1 },
        null,
      ],
      SR,
    )!;
    expect(s.roundTripMs).toBeCloseTo(101);
    expect(s.heard).toBe(3);
    expect(s.sent).toBe(5);
  });

  it('needs at least three heard probes', () => {
    expect(summarizeLoopback([{ lag: 1, score: 1 }], SR)).toBeNull();
  });
});
