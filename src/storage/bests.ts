/**
 * Session bests (until reload) and all-time bests (stored per device).
 * `better` decides direction: reaction times want lower, scores want higher.
 */
export type Better = 'lower' | 'higher';

export class BestTracker {
  private readonly session = new Map<string, number>();

  constructor(
    private readonly allTime: () => Record<string, number>,
    private readonly saveAllTime: (b: Record<string, number>) => void,
  ) {}

  /** Records a result; returns which records it set. */
  record(key: string, value: number, better: Better): { sessionBest: boolean; allTimeBest: boolean } {
    const beats = (old: number | undefined) => old === undefined || (better === 'lower' ? value < old : value > old);
    const sessionBest = beats(this.session.get(key));
    if (sessionBest) this.session.set(key, value);
    const all = this.allTime();
    const allTimeBest = beats(all[key]);
    if (allTimeBest) this.saveAllTime({ ...all, [key]: value });
    return { sessionBest, allTimeBest };
  }

  sessionBest(key: string): number | undefined {
    return this.session.get(key);
  }

  allTimeBest(key: string): number | undefined {
    return this.allTime()[key];
  }
}
