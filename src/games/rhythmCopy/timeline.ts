import type { Pattern } from './patterns';

export const DEMO_LOOPS = 3;
export const PLAY_LOOPS = 3;
export const COUNT_IN_BEATS = 4;

export interface TimedNote {
  pad: number;
  /** Audio-clock seconds. */
  at: number;
  /** Step within the loop (for drawing). */
  step: number;
  loop: number;
}

export interface Click {
  at: number;
  accent: boolean;
  /** Count-in clicks always play, even with the metronome off. */
  countIn: boolean;
}

export interface RhythmTimeline {
  stepDur: number;
  loopDur: number;
  demoStart: number;
  countInStart: number;
  playStart: number;
  end: number;
  demoNotes: TimedNote[];
  expected: TimedNote[];
  clicks: Click[];
}

/**
 * The app plays the pattern DEMO_LOOPS times (with a metronome), then a
 * COUNT_IN_BEATS-click count-in, then the player plays it PLAY_LOOPS times.
 */
export function buildTimeline(pattern: Pattern, bpm: number, start: number): RhythmTimeline {
  const beat = 60 / bpm;
  const stepDur = beat / 4;
  const loopDur = pattern.bars * 16 * stepDur;
  const beatsPerLoop = pattern.bars * 4;

  const notes = (from: number, loops: number): TimedNote[] =>
    Array.from({ length: loops }, (_, loop) =>
      pattern.notes.map(([step, pad]) => ({ pad, step, loop, at: from + loop * loopDur + step * stepDur })),
    )
      .flat()
      .sort((a, b) => a.at - b.at);

  const clicks: Click[] = [];
  const addBeats = (from: number, count: number, accentEvery: number, countIn = false) => {
    for (let i = 0; i < count; i++) clicks.push({ at: from + i * beat, accent: i % accentEvery === 0, countIn });
  };

  const demoStart = start;
  const countInStart = demoStart + DEMO_LOOPS * loopDur;
  const playStart = countInStart + COUNT_IN_BEATS * beat;
  const end = playStart + PLAY_LOOPS * loopDur;

  addBeats(demoStart, DEMO_LOOPS * beatsPerLoop, 4);
  addBeats(countInStart, COUNT_IN_BEATS, 1, true); // every count-in click accented
  addBeats(playStart, PLAY_LOOPS * beatsPerLoop, 4);

  return { stepDur, loopDur, demoStart, countInStart, playStart, end, demoNotes: notes(demoStart, DEMO_LOOPS), expected: notes(playStart, PLAY_LOOPS), clicks };
}
