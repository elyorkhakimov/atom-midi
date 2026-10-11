import type { Pattern } from '../rhythmCopy/patterns';

/** One recorded hit. `pos` is in beats from the loop start, 0 ≤ pos < loop length. */
export interface BeatNote {
  pos: number;
  pad: number;
  velocity: number;
}

/** A beat saved under "My beats" (Beat maker) and offered in Rhythm copy. */
export interface CustomBeat {
  id: string;
  name: string;
  bpm: number;
  bars: number;
  kitId: string;
  notes: BeatNote[];
  savedAt: number;
}

export const BEATS_PER_BAR = 4;
export const BAR_CHOICES = [1, 2, 4] as const;

/** Nudge grids: divisions per beat. */
export const GRIDS = [
  { div: 1, label: '1/4' },
  { div: 2, label: '1/8' },
  { div: 3, label: '1/8 triplet' },
  { div: 4, label: '1/16' },
  { div: 6, label: '1/16 triplet' },
  { div: 8, label: '1/32' },
] as const;
export const DEFAULT_GRID = 3; // 1/16

/** Wraps a position into [0, loopBeats). */
export function wrap(pos: number, loopBeats: number): number {
  const p = pos % loopBeats;
  return p < 0 ? p + loopBeats : p;
}

/**
 * Position of a hit in the loop. `heard` and `origin` are on the same clock (s): `origin`
 * is when beat 1 of the first pass is heard. Hits up to half a beat early count for beat 1.
 */
export function hitPosition(heard: number, origin: number, beatDur: number, loopBeats: number): number | null {
  const beats = (heard - origin) / beatDur;
  if (beats < -0.5) return null;
  return wrap(beats, loopBeats);
}

/**
 * Snaps every note to the nearest grid line ("Nudge"). Notes that land on the same pad and
 * line (a flam) merge into the loudest one.
 */
export function quantize<T extends BeatNote>(notes: readonly T[], div: number, loopBeats: number): T[] {
  const byCell = new Map<string, T>();
  for (const n of notes) {
    const pos = wrap(Math.round(n.pos * div) / div, loopBeats);
    const key = `${n.pad}:${Math.round(pos * div)}`;
    const prev = byCell.get(key);
    if (!prev || n.velocity > prev.velocity) byCell.set(key, { ...n, pos });
  }
  return sortNotes([...byCell.values()]);
}

export function sortNotes<T extends BeatNote>(notes: T[]): T[] {
  return notes.sort((a, b) => a.pos - b.pos || a.pad - b.pad);
}

/** Repeats or cuts a loop when its length changes, so a 1-bar groove fills 2 bars. */
export function resizeLoop<T extends BeatNote>(notes: readonly T[], fromBeats: number, toBeats: number): T[] {
  const out: T[] = [];
  for (let start = 0; start < toBeats; start += fromBeats) {
    for (const n of notes) if (n.pos + start < toBeats) out.push({ ...n, pos: n.pos + start });
  }
  return sortNotes(out);
}

/** A saved beat as a Rhythm copy pattern: positions rounded to 16th-note steps. */
export function beatToPattern(beat: CustomBeat): Pattern {
  const steps = beat.bars * 16;
  const seen = new Set<string>();
  const notes: (readonly [number, number])[] = [];
  for (const n of beat.notes) {
    const step = Math.round(n.pos * 4) % steps;
    const key = `${step}:${n.pad}`;
    if (seen.has(key)) continue;
    seen.add(key);
    notes.push([step, n.pad]);
  }
  return { id: `custom.${beat.id}`, name: `★ ${beat.name}`, bars: beat.bars, notes };
}

/** "Beat 1", "Beat 2", …: the lowest number not taken. */
export function nextBeatName(beats: readonly CustomBeat[]): string {
  const taken = new Set(beats.map((b) => b.name));
  for (let i = 1; ; i++) if (!taken.has(`Beat ${i}`)) return `Beat ${i}`;
}

/** Drops malformed entries from storage. */
export function isCustomBeat(b: unknown): b is CustomBeat {
  const x = b as CustomBeat;
  return (
    !!x &&
    typeof x.id === 'string' &&
    typeof x.name === 'string' &&
    Number.isFinite(x.bpm) &&
    Number.isInteger(x.bars) &&
    x.bars > 0 &&
    Array.isArray(x.notes) &&
    x.notes.every((n) => Number.isFinite(n?.pos) && Number.isInteger(n?.pad) && n.pad >= 0 && n.pad < 16 && Number.isFinite(n?.velocity))
  );
}
