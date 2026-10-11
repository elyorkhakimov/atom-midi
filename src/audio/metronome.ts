import type { AudioEngine } from './engine';

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.12;

/**
 * Running metronome for open-ended play (free jam). Beats are scheduled ahead on
 * the audio clock; the timer only decides *when to schedule*, never when sounds play.
 */
export class Metronome {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextBeatTime = 0;
  private beat = 0;
  bpm = 120;
  beatsPerBar = 4;

  constructor(
    private readonly audio: AudioEngine,
    /** Called for every scheduled beat with its audio time (for visuals). */
    private readonly onBeat?: (beat: number, audioTime: number) => void,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer) return;
    this.beat = 0;
    this.nextBeatTime = this.audio.clock.now + 0.05;
    this.timer = setInterval(() => this.tick(), LOOKAHEAD_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    const horizon = this.audio.clock.now + SCHEDULE_AHEAD_S;
    while (this.nextBeatTime < horizon) {
      const accent = this.beat % this.beatsPerBar === 0;
      this.audio.click(accent, this.nextBeatTime);
      this.onBeat?.(this.beat, this.nextBeatTime);
      this.beat++;
      this.nextBeatTime += 60 / this.bpm;
    }
  }
}
