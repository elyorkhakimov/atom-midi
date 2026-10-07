import { describe, expect, it } from 'vitest';
import { BestTracker } from './bests';

describe('BestTracker', () => {
  it('tracks session and all-time bests in the right direction', () => {
    let stored: Record<string, number> = { 'reaction.single': 200 };
    const b = new BestTracker(() => stored, (x) => (stored = x));
    expect(b.record('reaction.single', 250, 'lower')).toEqual({ sessionBest: true, allTimeBest: false });
    expect(b.record('reaction.single', 180, 'lower')).toEqual({ sessionBest: true, allTimeBest: true });
    expect(stored['reaction.single']).toBe(180);
    expect(b.record('rhythm.x', 80, 'higher').allTimeBest).toBe(true);
    expect(b.record('rhythm.x', 70, 'higher')).toEqual({ sessionBest: false, allTimeBest: false });
  });
});
