import { isCustomBeat, sanitizeBeat, type CustomBeat } from '../games/beatMaker/beat';
import { load, save } from './persist';

export const BEATS_KEY = 'padgames.beats.v1';

/** Saved custom beats (per device), oldest first. */
export function loadBeats(): CustomBeat[] {
  const { beats } = load<{ beats: unknown }>(BEATS_KEY, { beats: [] });
  return Array.isArray(beats) ? beats.filter(isCustomBeat).map(sanitizeBeat) : [];
}

export function saveBeats(beats: readonly CustomBeat[]): void {
  save(BEATS_KEY, { beats });
}
