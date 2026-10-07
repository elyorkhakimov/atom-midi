/**
 * Throwaway synth for the test pages: lets you hear whether pad hits get through
 * while LEDs animate. Not the app's audio engine (that's src/audio, Phase 1).
 */

// Two octaves of C major pentatonic, pad 0 (bottom-left) lowest.
const SCALE = [0, 2, 4, 7, 9];

export class TestSynth {
  readonly ctx: AudioContext;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
  }

  /** Must be called from a user gesture at least once. */
  resume(): Promise<void> {
    return this.ctx.resume();
  }

  latencyInfo(): { sampleRate: number; baseLatencyMs: number | null; outputLatencyMs: number | null } {
    const ms = (s: number | undefined) => (typeof s === 'number' ? +(s * 1000).toFixed(1) : null);
    return {
      sampleRate: this.ctx.sampleRate,
      baseLatencyMs: ms(this.ctx.baseLatency),
      outputLatencyMs: ms((this.ctx as AudioContext & { outputLatency?: number }).outputLatency),
    };
  }

  /** Short pluck; gain = (velocity/127)^2. */
  hit(pad: number, velocity: number): void {
    const ctx = this.ctx;
    const step = SCALE[pad % SCALE.length]! + 12 * Math.floor(pad / SCALE.length);
    const freq = 261.63 * 2 ** (step / 12);
    const t = ctx.currentTime;
    const peak = 0.6 * (velocity / 127) ** 2;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.4);
  }
}
