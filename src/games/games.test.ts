import { describe, expect, it } from 'vitest';
import { PLAYERS, playerOfPad, playerPads } from './players';
import { FALSE_START_MS, judgeHit, pickZone, randomDelayMs, resolveBattle, zoneOf } from './reaction/logic';
import { PATTERNS } from './rhythmCopy/patterns';
import { scoreRhythm } from './rhythmCopy/scoring';
import { COUNT_IN_BEATS, DEMO_LOOPS, PLAY_LOOPS, buildTimeline } from './rhythmCopy/timeline';

describe('reaction', () => {
  it('false start before GO and under 100 ms after', () => {
    expect(judgeHit(990, 1000)).toEqual({ kind: 'falseStart', beforeGo: true });
    expect(judgeHit(1000 + FALSE_START_MS - 1, 1000)).toEqual({ kind: 'falseStart', beforeGo: false });
    expect(judgeHit(1250, 1000)).toEqual({ kind: 'ok', ms: 250 });
  });
  it('random delay is 2–6 s', () => {
    expect(randomDelayMs(() => 0)).toBe(2000);
    expect(randomDelayMs(() => 0.999999)).toBeCloseTo(6000, 0);
  });
});

describe('reaction sound match', () => {
  it('splits the board into halves or quadrants', () => {
    // Bottom row is pads 0–3, top row 12–15.
    expect([0, 1, 2, 3].map((p) => zoneOf(p, 2))).toEqual([0, 0, 1, 1]);
    expect([12, 13, 14, 15].map((p) => zoneOf(p, 4))).toEqual([0, 0, 1, 1]); // top-left, top-right
    expect([0, 1, 2, 3].map((p) => zoneOf(p, 4))).toEqual([2, 2, 3, 3]); // bottom-left, bottom-right
    expect(zoneOf(9, 4)).toBe(0); // row 2, col 1: top-left
    expect(zoneOf(6, 4)).toBe(3); // row 1, col 2: bottom-right
  });
  it('never picks the same zone three times in a row', () => {
    for (let i = 0; i < 50; i++) expect(pickZone(2, [1, 1], Math.random)).toBe(0);
    expect(pickZone(4, [0, 1], () => 0)).toBe(0);
  });
});

describe('reaction battle', () => {
  it('resolves simultaneous hits by timestamp, not arrival order', () => {
    const r = resolveBattle(
      [
        { player: 2, t: 1253 },
        { player: 0, t: 1251 },
        { player: 3, t: 1252 },
        { player: 1, t: 1300 },
      ],
      4,
      1000,
    );
    expect(r.winner).toBe(0);
    expect(r.reaction).toEqual([251, 300, 253, 252]);
  });
  it('early hit disqualifies for the round even if the player hits again', () => {
    const r = resolveBattle(
      [
        { player: 0, t: 900 },
        { player: 0, t: 1150 },
        { player: 1, t: 1300 },
      ],
      2,
      1000,
    );
    expect(r.disqualified).toEqual([true, false]);
    expect(r.winner).toBe(1);
  });
  it('no winner when everyone jumps the gun', () => {
    expect(resolveBattle([{ player: 0, t: 1050 }, { player: 1, t: 999 }], 2, 1000).winner).toBeNull();
  });
});

describe('player layouts', () => {
  it('2 players get halves, 3–4 get corners', () => {
    const two = playerPads(2);
    expect(two[0]).toEqual([0, 1, 4, 5, 8, 9, 12, 13]);
    expect(two[1]).toEqual([2, 3, 6, 7, 10, 11, 14, 15]);
    expect(playerPads(4)).toEqual([[12], [15], [0], [3]]);
    expect(playerPads(3)).toHaveLength(3);
    expect(playerOfPad(playerPads(4), 15)).toBe(1);
    expect(playerOfPad(playerPads(4), 5)).toBe(-1);
    expect(PLAYERS.map((p) => p.name)).toEqual(['Red', 'Blue', 'Green', 'Yellow']);
  });
});

describe('rhythm scoring', () => {
  const expected = [0, 500, 1000, 1500].map((t, i) => ({ pad: i % 2, t }));

  it('perfect play scores 100%', () => {
    const s = scoreRhythm(expected, expected);
    expect(s.percent).toBe(100);
    expect(s.misses + s.extras).toBe(0);
  });
  it('points = 100 × (1 − |err|/100)', () => {
    const s = scoreRhythm([{ pad: 0, t: 0 }], [{ pad: 0, t: 30 }]);
    expect(s.points).toBeCloseTo(70, 9);
    expect(s.meanErrorMs).toBe(30);
  });
  it('misses score 0, wrong pad and extras cost 25, total floors at 0%', () => {
    const s = scoreRhythm(expected, [
      { pad: 0, t: 0 },
      { pad: 1, t: 1000 }, // wrong pad
      { pad: 0, t: 250 }, // extra
    ]);
    expect(s.misses).toBe(3);
    expect(s.extras).toBe(2);
    expect(s.points).toBe(100 - 50);
    expect(scoreRhythm(expected, [{ pad: 3, t: 0 }]).percent).toBe(0);
  });
  it('hits beyond ±100 ms do not match', () => {
    expect(scoreRhythm([{ pad: 0, t: 0 }], [{ pad: 0, t: 101 }]).misses).toBe(1);
  });
  it('each expected note matches one hit, closest first', () => {
    const s = scoreRhythm([{ pad: 0, t: 0 }], [{ pad: 0, t: 40 }, { pad: 0, t: 10 }]);
    expect(s.errors).toEqual([10]);
    expect(s.hitMatches).toEqual([-1, 0]);
  });

  it('acceptance: a perfectly played pattern scores ≥95% with realistic jitter', () => {
    for (const pattern of PATTERNS) {
      const tl = buildTimeline(pattern, 120, 0);
      const exp = tl.expected.map((n) => ({ pad: n.pad, t: n.at * 1000 }));
      const hits = exp.map((n, i) => ({ pad: n.pad, t: n.t + ((i * 7) % 9) - 4 })); // ±4 ms
      expect(scoreRhythm(exp, hits).percent).toBeGreaterThanOrEqual(95);
    }
  });
});

describe('rhythm timeline', () => {
  it('demo ×3, 4-click count-in, play ×3 at 120 BPM', () => {
    const p = PATTERNS[1]!; // 1 bar
    const tl = buildTimeline(p, 120, 10);
    expect(tl.loopDur).toBe(2);
    expect(tl.countInStart).toBe(10 + DEMO_LOOPS * 2);
    expect(tl.playStart).toBe(tl.countInStart + COUNT_IN_BEATS * 0.5);
    expect(tl.end).toBe(tl.playStart + PLAY_LOOPS * 2);
    expect(tl.expected).toHaveLength(p.notes.length * PLAY_LOOPS);
    expect(tl.demoNotes).toHaveLength(p.notes.length * DEMO_LOOPS);
    expect(tl.clicks).toHaveLength(DEMO_LOOPS * 4 + COUNT_IN_BEATS + PLAY_LOOPS * 4);
    expect(tl.clicks.filter((c) => c.countIn).map((c) => c.at)).toEqual([0, 1, 2, 3].map((i) => tl.countInStart + i * 0.5));
    expect(tl.expected.every((n, i, a) => i === 0 || n.at >= a[i - 1]!.at)).toBe(true);
  });
  it('has 10 built-in patterns with notes inside their bars', () => {
    expect(PATTERNS).toHaveLength(10);
    for (const p of PATTERNS) for (const [step] of p.notes) expect(step).toBeLessThan(p.bars * 16);
  });
});
