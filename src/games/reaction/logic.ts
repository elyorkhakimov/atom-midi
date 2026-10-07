/** Reaction timing rules. Times are performance.now() ms, already latency-adjusted. */

/** Hits before GO, or less than this after it, are false starts (nobody reacts that fast). */
export const FALSE_START_MS = 100;
export const MIN_DELAY_MS = 2000;
export const MAX_DELAY_MS = 6000;
/** No hit within this long after GO ends the round as "too slow". */
export const TIMEOUT_MS = 3000;

export function randomDelayMs(rand: () => number = Math.random): number {
  return MIN_DELAY_MS + rand() * (MAX_DELAY_MS - MIN_DELAY_MS);
}

export type Judgement = { kind: 'falseStart'; beforeGo: boolean } | { kind: 'ok'; ms: number };

export function judgeHit(hitT: number, goT: number): Judgement {
  const ms = hitT - goT;
  if (ms < FALSE_START_MS) return { kind: 'falseStart', beforeGo: ms < 0 };
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
