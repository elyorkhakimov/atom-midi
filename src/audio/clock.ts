/**
 * Conversion between performance.now() (ms, where MIDI timestamps live) and
 * AudioContext time (s). The mapping refers to when a sample is *heard*, so it
 * includes output latency: an event scheduled at audio time T is heard at
 * audioToPerf(T), and that's the moment scoring compares hits against.
 */
export interface OutputSnapshot {
  contextTime: number;
  performanceTime: number;
}

export function audioToPerf(audioTime: number, snap: OutputSnapshot): number {
  return snap.performanceTime + (audioTime - snap.contextTime) * 1000;
}

export function perfToAudio(perfTime: number, snap: OutputSnapshot): number {
  return snap.contextTime + (perfTime - snap.performanceTime) / 1000;
}

export class AudioClock {
  constructor(private readonly ctx: AudioContext) {}

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Output latency estimate in ms (base + output), for display. */
  get latencyMs(): number {
    const c = this.ctx as AudioContext & { outputLatency?: number };
    return ((c.baseLatency ?? 0) + (c.outputLatency ?? 0)) * 1000;
  }

  snapshot(): OutputSnapshot {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime && ts.contextTime !== undefined && ts.performanceTime > 0) {
      return { contextTime: ts.contextTime, performanceTime: ts.performanceTime };
    }
    // Fallback: currentTime is about to be rendered and is heard after the output latency.
    return { contextTime: this.ctx.currentTime, performanceTime: performance.now() + this.latencyMs };
  }

  audioToPerf(audioTime: number): number {
    return audioToPerf(audioTime, this.snapshot());
  }

  perfToAudio(perfTime: number): number {
    return perfToAudio(perfTime, this.snapshot());
  }
}
