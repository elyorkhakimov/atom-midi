import { describe, expect, it } from 'vitest';
import { GRIDS, adjacentLine, beatToPattern, hitPosition, isCustomBeat, nextBeatName, quantize, resizeLoop, sameCell, type CustomBeat } from './beat';

const note = (pos: number, pad = 0, velocity = 100) => ({ pos, pad, velocity });

describe('beat maker', () => {
  it('places hits in the loop; up to half a beat early counts for beat 1', () => {
    // 120 BPM: 0.5 s per beat, 4-beat loop starting at t = 10.
    expect(hitPosition(10, 10, 0.5, 4)).toBe(0);
    expect(hitPosition(10.75, 10, 0.5, 4)).toBeCloseTo(1.5, 9);
    expect(hitPosition(12.25, 10, 0.5, 4)).toBeCloseTo(0.5, 9); // second pass
    expect(hitPosition(9.9, 10, 0.5, 4)).toBeCloseTo(3.8, 9); // early for beat 1: end of the loop
    expect(hitPosition(9.7, 10, 0.5, 4)).toBeNull(); // during the count-in
  });

  it('Nudge snaps to the grid, wraps the loop end to beat 1 and merges flams', () => {
    const q = quantize([note(0.93), note(1.48, 1), note(3.97), note(2.02, 2, 60), note(1.97, 2, 90)], 4, 4);
    expect(q).toEqual([note(0), note(1, 0), note(1.5, 1), note(2, 2, 90)].sort((a, b) => a.pos - b.pos || a.pad - b.pad));
    expect(quantize([note(0.3)], 3, 4)[0]!.pos).toBeCloseTo(1 / 3, 9); // triplets
  });

  it('keeps notes from different kits apart, and offers 1/32 triplets', () => {
    const q = quantize([{ ...note(1), kit: 'acoustic' }, { ...note(1.01), kit: 'electro' }], 4, 4);
    expect(q.map((n) => n.kit)).toEqual(['acoustic', 'electro']);
    expect(GRIDS.map((g) => g.div)).toContain(12);
    expect(quantize([note(0.09)], 12, 4)[0]!.pos).toBeCloseTo(1 / 12, 9);
  });

  it('moves a note to the next grid line either way, round the loop', () => {
    expect(adjacentLine(1.03, 1, 4, 4, false)).toBeCloseTo(1.25, 9);
    expect(adjacentLine(1.03, -1, 4, 4, false)).toBeCloseTo(1, 9);
    expect(adjacentLine(1, 1, 4, 4, false)).toBeCloseTo(1.25, 9);
    expect(adjacentLine(1.03, -1, 4, 4, true)).toBeCloseTo(0.75, 9); // shown on 1 under Nudge
    expect(adjacentLine(0, -1, 4, 4, true)).toBeCloseTo(3.75, 9);
    expect(adjacentLine(3.9, 1, 4, 4, false)).toBe(0);
  });

  it('finds the notes Nudge shows as one dot', () => {
    expect(sameCell(note(1.02), note(0.98), 4, 4)).toBe(true);
    expect(sameCell(note(3.98), note(0.01), 4, 4)).toBe(true); // wraps to beat 1
    expect(sameCell(note(1), note(1, 1), 4, 4)).toBe(false);
    expect(sameCell({ ...note(1), kit: 'a' }, { ...note(1), kit: 'b' }, 4, 4)).toBe(false);
  });

  it('a longer loop repeats the groove, a shorter one cuts it', () => {
    expect(resizeLoop([note(0), note(3.5)], 4, 8).map((n) => n.pos)).toEqual([0, 3.5, 4, 7.5]);
    expect(resizeLoop([note(1), note(5)], 8, 4).map((n) => n.pos)).toEqual([1]);
  });

  it('turns a saved beat into a Rhythm copy pattern of 16th steps', () => {
    const beat: CustomBeat = { id: 'x', name: 'Beat 1', bpm: 95, bars: 2, kitId: 'acoustic', savedAt: 0, notes: [note(0), note(0.02), note(1.5, 1), note(7.99, 2)] };
    const p = beatToPattern(beat);
    expect(p).toMatchObject({ id: 'custom.x', bars: 2 });
    expect(p.notes).toEqual([[0, 0], [6, 1], [0, 2]]);
    expect(isCustomBeat(beat)).toBe(true);
    expect(isCustomBeat({ ...beat, notes: [{ pos: 0, pad: 16, velocity: 1 }] })).toBe(false);
    expect(isCustomBeat({ ...beat, notes: [{ ...note(0), kit: 'electro' }] })).toBe(true);
    expect(isCustomBeat({ ...beat, notes: [{ ...note(0), kit: 3 }] })).toBe(false);
  });

  it('names new beats with the lowest free number', () => {
    const named = (name: string) => ({ name }) as CustomBeat;
    expect(nextBeatName([])).toBe('Beat 1');
    expect(nextBeatName([named('Beat 1'), named('Beat 3')])).toBe('Beat 2');
  });
});
