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

/** Audio time source: Web Audio in the browser, the native engine in the Android app. */
export interface Clock {
  /** Current audio time, s. */
  readonly now: number;
  /** Output latency estimate in ms, for display. */
  readonly latencyMs: number;
  snapshot(): OutputSnapshot;
  audioToPerf(audioTime: number): number;
  perfToAudio(perfTime: number): number;
}

export class AudioClock implements Clock {
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

/**
 * Clock for the Android app, where sound comes from the native engine. Audio time is
 * performance.now() in seconds at the moment a sample is rendered; it's heard after
 * the native output latency. The WebView's AudioContext isn't involved, so its large
 * and jumpy latency never reaches scheduling or scoring.
 */
export class NativeAudioClock implements Clock {
  constructor(private readonly native: { readonly latencyMs: number }) {}

  get now(): number {
    return performance.now() / 1000;
  }

  get latencyMs(): number {
    return this.native.latencyMs;
  }

  snapshot(): OutputSnapshot {
    const perf = performance.now();
    return { contextTime: perf / 1000, performanceTime: perf + this.latencyMs };
  }

  audioToPerf(audioTime: number): number {
    return audioToPerf(audioTime, this.snapshot());
  }

  perfToAudio(perfTime: number): number {
    return perfToAudio(perfTime, this.snapshot());
  }
}
