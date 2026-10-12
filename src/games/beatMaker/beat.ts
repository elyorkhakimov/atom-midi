import { SYNTH_PRESETS, sanitizePatch, type SynthPatch } from '../../audio/synth';
import type { Pattern } from '../rhythmCopy/patterns';

/** One recorded hit. `pos` is in beats from the loop start, 0 ≤ pos < loop length. */
export interface BeatNote {
  pos: number;
  pad: number;
  velocity: number;
  /**
   * Sound it was played with: a kit id, or a synth id (SYNTH_PREFIX…) from the beat's
   * `synths`. Older beats leave it out and use the beat's kitId.
   */
  kit?: string;
  /** Synth notes: how long the pad was held, in beats. */
  len?: number;
}

export type SynthPreset = 'pluck' | 'pad' | 'custom';
export const SYNTH_NAMES: Record<SynthPreset, string> = { pluck: SYNTH_PRESETS.pluck.name, pad: SYNTH_PRESETS.pad.name, custom: 'Make' };

/** A synth sound as it was when played, so later edits (Make, key, tone) don't change the beat. */
export interface BeatSynth {
  preset: SynthPreset;
  patch: SynthPatch;
  transpose: number;
}

export const SYNTH_PREFIX = 'synth:';
/** Synth notes without a recorded length (held this many beats). */
export const DEFAULT_SYNTH_LEN = 0.25;

/** Same sound, same id: a short hash of the frozen sound. */
export function synthSoundId(s: BeatSynth): string {
  const json = JSON.stringify([s.preset, s.patch, s.transpose]);
  let h = 5381;
  for (let i = 0; i < json.length; i++) h = ((h * 33) ^ json.charCodeAt(i)) >>> 0;
  return `${SYNTH_PREFIX}${s.preset}.${h.toString(36)}`;
}

/** A beat saved under "My beats" (Beat maker) and offered in Rhythm copy. */
export interface CustomBeat {
  id: string;
  name: string;
  bpm: number;
  bars: number;
  kitId: string;
  notes: BeatNote[];
  /** Synth sounds the notes use, by id. */
  synths?: Record<string, BeatSynth>;
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
  { div: 12, label: '1/32 triplet' },
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
    const key = `${n.pad}:${n.kit ?? ''}:${Math.round(pos * div)}`;
    const prev = byCell.get(key);
    if (!prev || n.velocity > prev.velocity) byCell.set(key, { ...n, pos });
  }
  return sortNotes([...byCell.values()]);
}

export function sortNotes<T extends BeatNote>(notes: T[]): T[] {
  return notes.sort((a, b) => a.pos - b.pos || a.pad - b.pad);
}

/** Same sound in the same grid cell: Nudge plays (and shows) them as one note. */
export function sameCell(a: BeatNote, b: BeatNote, div: number, loopBeats: number): boolean {
  return a.pad === b.pad && a.kit === b.kit && wrap(Math.round(a.pos * div), loopBeats * div) === wrap(Math.round(b.pos * div), loopBeats * div);
}

/**
 * The grid line next to `pos` in direction `dir` (±1), round the loop. `fromLine` = `pos` is
 * already shown on a line (Nudge on), so the move is one whole step from it.
 */
export function adjacentLine(pos: number, dir: number, div: number, loopBeats: number, fromLine: boolean): number {
  const x = pos * div;
  const eps = 1e-6;
  const line = fromLine ? Math.round(x) + dir : dir > 0 ? Math.ceil(x + eps) : Math.floor(x - eps);
  return wrap(line / div, loopBeats);
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

/** Repairs synth patches from storage (missing or out-of-range fields). */
export function sanitizeBeat(b: CustomBeat): CustomBeat {
  if (!b.synths) return b;
  const synths: Record<string, BeatSynth> = {};
  for (const [id, s] of Object.entries(b.synths)) {
    if (!s || !(s.preset in SYNTH_NAMES)) continue;
    synths[id] = { preset: s.preset, patch: sanitizePatch(s.patch), transpose: Number.isFinite(s.transpose) ? s.transpose : 0 };
  }
  return { ...b, synths };
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
    x.notes.every((n) => Number.isFinite(n?.pos) && Number.isInteger(n?.pad) && n.pad >= 0 && n.pad < 16 && Number.isFinite(n?.velocity) && (n.kit === undefined || typeof n.kit === 'string') && (n.len === undefined || Number.isFinite(n.len))) &&
    (x.synths === undefined || (typeof x.synths === 'object' && x.synths !== null))
  );
}
