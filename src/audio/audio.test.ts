import { describe, expect, it } from 'vitest';
import { audioToPerf, perfToAudio } from './clock';
import { RoundRobin, selectLayers, velocityGain, type KitLayer } from './kit';

describe('clock conversion', () => {
  const snap = { contextTime: 10, performanceTime: 50_000 };
  it('converts audio seconds to performance ms and back', () => {
    expect(audioToPerf(10, snap)).toBe(50_000);
    expect(audioToPerf(12.5, snap)).toBe(52_500);
    expect(perfToAudio(52_500, snap)).toBe(12.5);
    for (const t of [9.123, 10, 37.5]) expect(perfToAudio(audioToPerf(t, snap), snap)).toBeCloseTo(t, 9);
  });
});

describe('kit layers', () => {
  const layers: KitLayer[] = [
    { minVelocity: 1, maxVelocity: 50, samples: ['s'] },
    { minVelocity: 51, maxVelocity: 100, samples: ['m'] },
    { minVelocity: 101, maxVelocity: 127, samples: ['h'] },
  ];
  it('picks the layer containing the velocity', () => {
    expect(selectLayers(layers, 10)).toEqual([{ index: 0, gain: 1 }]);
    expect(selectLayers(layers, 75)).toEqual([{ index: 1, gain: 1 }]);
    expect(selectLayers(layers, 127)).toEqual([{ index: 2, gain: 1 }]);
  });
  it('crossfades with equal power near a boundary', () => {
    const [lo, hi] = selectLayers(layers, 50.5, 8);
    expect(lo!.index).toBe(0);
    expect(hi!.index).toBe(1);
    expect(lo!.gain ** 2 + hi!.gain ** 2).toBeCloseTo(1, 9);
    expect(lo!.gain).toBeCloseTo(hi!.gain, 9);
    expect(selectLayers(layers, 75, 8)).toEqual([{ index: 1, gain: 1 }]);
  });
  it('gain curve is (v/127)^2', () => {
    expect(velocityGain(127)).toBe(1);
    expect(velocityGain(0)).toBe(0);
    expect(velocityGain(63.5)).toBeCloseTo(0.25, 9);
  });
  it('round-robin cycles per key', () => {
    const rr = new RoundRobin();
    expect([rr.pick('a', 2), rr.pick('a', 2), rr.pick('a', 2), rr.pick('b', 3)]).toEqual([0, 1, 0, 0]);
  });
});
