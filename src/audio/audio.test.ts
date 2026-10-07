import { describe, expect, it } from 'vitest';
import acousticKit from '../../public/kits/acoustic/kit.json';
import electroKit from '../../public/kits/electro/kit.json';
import { softClip } from './engine';
import { audioToPerf, perfToAudio } from './clock';
import { PARAM_ROWS, SYNTH_PRESETS, isRoot, padFrequency, padSemitone, sanitizePatch, stepParam } from './synth';
import { RoundRobin, selectLayers, velocityGain, type KitJson, type KitLayer } from './kit';

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

describe('softClip', () => {
  it('is transparent below the knee and never exceeds ±1', () => {
    expect(softClip(0.5)).toBe(0.5);
    expect(softClip(-0.3)).toBe(-0.3);
    expect(softClip(0.9)).toBeGreaterThan(0.8);
    expect(softClip(0.9)).toBeLessThan(0.9);
    expect(softClip(2)).toBeLessThan(1);
    expect(softClip(-2)).toBeGreaterThan(-1);
    expect(softClip(1.2)).toBeGreaterThan(softClip(1.1)); // still monotonic
  });
});

describe('drum kit layouts', () => {
  // Rhythm copy patterns assume these roles on pads 0–7 (see rhythmCopy/patterns.ts).
  const ROLES = [/kick/i, /snare/i, /closed.*hat/i, /open.*hat/i, /(low|floor).*tom/i, /(mid|rack).*tom/i, /high.*tom/i, /clap/i];
  for (const kit of [acousticKit, electroKit] as unknown as KitJson[]) {
    it(`${kit.id} puts kick, snare, hats, toms and clap on pads 1–8`, () => {
      ROLES.forEach((role, pad) => expect(kit.instruments[kit.pads[pad]!]!.name).toMatch(role));
    });
  }
});

describe('synth', () => {
  const pluck = SYNTH_PRESETS.pluck.patch;
  it('pluck matches the ATOM test page: pad 0 is middle C, pentatonic upwards', () => {
    expect(padFrequency(0, pluck)).toBeCloseTo(261.63, 1);
    expect([0, 1, 2, 3, 4, 5].map((p) => padSemitone(p, 'pentatonic'))).toEqual([0, 2, 4, 7, 9, 12]);
    expect(isRoot(5, 'pentatonic')).toBe(true);
    expect(padSemitone(15, 'chromatic')).toBe(15);
  });
  it('steps parameters within range; choices wrap', () => {
    const [waveDef, octaveDef] = PARAM_ROWS[0]!;
    expect(stepParam(pluck, waveDef!, 1).wave).toBe('square');
    expect(stepParam({ ...pluck, wave: 'sawtooth' }, waveDef!, 1).wave).toBe('sine');
    expect(stepParam(pluck, waveDef!, -1).wave).toBe('sine');
    expect(stepParam(pluck, octaveDef!, 10).octave).toBe(6);
    const sustain = PARAM_ROWS[1]![2]!;
    expect(stepParam(pluck, sustain, 3).sustain).toBeCloseTo(0.15, 9);
    const attack = PARAM_ROWS[1]![0]!;
    expect(stepParam(pluck, attack, -5).attack).toBe(0.002);
    expect(stepParam(pluck, attack, 1).attack).toBeCloseTo(0.0023, 9);
  });
  it('sanitizes saved patches', () => {
    expect(sanitizePatch(undefined)).toEqual(pluck);
    const p = sanitizePatch({ wave: 'nope' as never, cutoff: 1e9, decay: Number.NaN, octave: 2 });
    expect(p.wave).toBe(pluck.wave);
    expect(p.cutoff).toBe(12000);
    expect(p.decay).toBe(pluck.decay);
    expect(p.octave).toBe(2);
  });
});
