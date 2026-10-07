/** Reaction timing rules. Times are performance.now() ms, already latency-adjusted. */
import { PAD_COLS, PAD_ROWS } from '../../midi/atomMap';

/** classic: one GO sound, any pad. matchN: N zones with their own sound; hit the zone you hear. */
export type ReactionMode = 'classic' | 'match2' | 'match4';
export const REACTION_MODES: readonly ReactionMode[] = ['classic', 'match2', 'match4'];

/** What says GO: a sound, or only the pad lights (no sound at all). */
export type ReactionCue = 'sound' | 'lights';

export function zoneCount(mode: ReactionMode): number {
  return mode === 'match2' ? 2 : mode === 'match4' ? 4 : 1;
}

/**
 * Zone of a pad. 2 zones = left / right half. 4 zones = 2×2 quadrants:
 * 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right.
 */
export function zoneOf(pad: number, zones: number): number {
  const right = pad % PAD_COLS >= PAD_COLS / 2 ? 1 : 0;
  if (zones === 2) return right;
  if (zones === 4) return (Math.floor(pad / PAD_COLS) >= PAD_ROWS / 2 ? 0 : 2) + right;
  return 0;
}

/** Random zone, never the same one three times in a row (so it can't be guessed by habit or feel stuck). */
export function pickZone(zones: number, history: readonly number[], rand: () => number = Math.random): number {
  const [a, b] = history.slice(-2);
  const banned = a !== undefined && a === b ? a : -1;
  const options = Array.from({ length: zones }, (_, z) => z).filter((z) => z !== banned);
  return options[Math.floor(rand() * options.length)] ?? 0;
}

export const MIN_DELAY_MS = 2000;
export const MAX_DELAY_MS = 6000;
/** No hit within this long after GO ends the round as "too slow". */
export const TIMEOUT_MS = 3000;

export function randomDelayMs(rand: () => number = Math.random): number {
  return MIN_DELAY_MS + rand() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

/** `ms` is hit time minus GO. Only a hit before GO is a false start; any hit after it counts. */
export type Judgement = { kind: 'falseStart'; ms: number } | { kind: 'ok'; ms: number };

export function judgeHit(hitT: number, goT: number): Judgement {
  const ms = hitT - goT;
  if (ms < 0) return { kind: 'falseStart', ms };
  return { kind: 'ok', ms };
}

export interface BattleHit {
  player: number;
  t: number;
}

export interface BattleResult {
  /** Winning player index, or null if nobody made a clean hit. */
  winner: number | null;
  /** Reaction ms per player (first clean hit), null if none. */
  reaction: (number | null)[];
  disqualified: boolean[];
}

/**
 * Resolves a battle round strictly by timestamp, regardless of the order the
 * events arrived in. A player's first hit decides: early (false start) means
 * disqualified for the round, even if they hit again later.
 */
export function resolveBattle(hits: readonly BattleHit[], players: number, goT: number): BattleResult {
  const reaction: (number | null)[] = Array(players).fill(null);
  const disqualified: boolean[] = Array(players).fill(false);
  const decided: boolean[] = Array(players).fill(false);
  for (const h of [...hits].sort((a, b) => a.t - b.t)) {
    if (h.player < 0 || h.player >= players || decided[h.player]) continue;
    decided[h.player] = true;
    const j = judgeHit(h.t, goT);
    if (j.kind === 'falseStart') disqualified[h.player] = true;
    else reaction[h.player] = j.ms;
  }
  let winner: number | null = null;
  reaction.forEach((ms, p) => {
    if (ms !== null && (winner === null || ms < reaction[winner]!)) winner = p;
  });
  return { winner, reaction, disqualified };
}
