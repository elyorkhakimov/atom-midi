/**
 * The native Android app (android/) exposes `window.PadNative`. When present, the ATOM is
 * read natively and all sound (kits, synth, cues, metronome) comes from the native Oboe
 * engine; the page opens no audio output of its own. In a browser `nativeBridge` is null
 * and nothing here runs.
 *
 * Native times are CLOCK_MONOTONIC nanoseconds; page times are performance.now() ms.
 */
interface PadNativeApi {
  nowNs(): number;
  latencyMs(): number;
  status(): string;
  midiSend(csv: string): boolean;
  setLive(mask: number, fixedVelocity: number, synth: boolean, patchCsv: string, freqsCsv: string): void;
  setHitLeds(spec: string): void;
  synthNoteOn(pad: number, velocity: number, patchCsv: string, freq: number, heardNs: number): void;
  synthNoteOff(pad: number): void;
  setShaping(threshold: number, gamma: number, doubleTriggerMs: number): void;
  loadKit(id: string): void;
  /** Loads a kit without selecting it (answers with kitLoaded too). */
  preloadKit(id: string): void;
  playInstrument(name: string, velocity: number, heardNs: number): number;
  /** An instrument of a loaded kit other than the current one. */
  playKitInstrument(kitId: string, name: string, velocity: number, heardNs: number): number;
  setCue(name: string, base64: string, sampleRate: number): void;
  playCue(name: string, bus: number, gain: number, heardNs: number): number;
  stopVoice(id: number): void;
  stopAll(): void;
  setMasterGain(gain: number): void;
  setBusGain(bus: number, gain: number): void;
  /**
   * Saves a WAV (base64) to Downloads, as is (`format` 'wav') or encoded to AAC ('m4a').
   * Returns the saved file's name, or "error: …".
   */
  saveAudio(name: string, format: string, wavBase64: string): string;
}

export interface NativeStatus {
  audio: {
    running: boolean;
    sampleRate?: number;
    framesPerBurst?: number;
    bufferFrames?: number;
    exclusive?: boolean;
    mmap?: boolean;
    latencyMs?: number;
    xruns?: number;
    /** Last few stream opens: path (MMAP/legacy), sharing, burst, rate. */
    opens?: string[];
  };
  midi: { connected: boolean; name: string | null };
  /** Package name (the low-latency build uses an allow-listed one; see android/README.md). */
  app?: string;
}

/** Callbacks the native side invokes through `window.__padNative`. */
interface NativeCallbacks {
  /** Batched: [bytes, timestampNs] per message, in arrival order. */
  midi(batch: [number[], number][]): void;
  midiState(connected: boolean, name: string): void;
  kitLoaded(id: string, ok: boolean): void;
}

declare global {
  interface Window {
    PadNative?: PadNativeApi;
    __padNative?: NativeCallbacks;
  }
}

/** Bus numbers of the native engine (engine.h). */
export const NativeBus = { kit: 0, metronome: 1, cue: 2, synth: 3 } as const;

class NativeBridge {
  /** nowNs() - performance.now() * 1e6, from the tightest of a few samples. */
  private offsetNs = 0;
  private latency = 0;
  private latencyAt = -Infinity;
  private readonly kitWaiters = new Map<string, ((ok: boolean) => void)[]>();
  onMidi: ((bytes: number[], perfMs: number) => void) | null = null;
  onMidiState: ((connected: boolean, name: string) => void) | null = null;

  constructor(readonly api: PadNativeApi) {
    this.syncClock();
    // The clocks don't drift measurably, but re-sync now and then to be safe.
    setInterval(() => this.syncClock(), 10_000);
    window.__padNative = {
      midi: (batch) => {
        for (const [bytes, ns] of batch) this.onMidi?.(bytes, this.nsToPerf(ns));
      },
      midiState: (connected, name) => this.onMidiState?.(connected, name),
      kitLoaded: (id, ok) => {
        const waiters = this.kitWaiters.get(id) ?? [];
        this.kitWaiters.delete(id);
        for (const w of waiters) w(ok);
      },
    };
  }

  private syncClock(): void {
    let best = Infinity;
    for (let i = 0; i < 5; i++) {
      const a = performance.now();
      const ns = this.api.nowNs();
      const b = performance.now();
      if (b - a < best) {
        best = b - a;
        this.offsetNs = ns - ((a + b) / 2) * 1e6;
      }
    }
  }

  nsToPerf(ns: number): number {
    return (ns - this.offsetNs) / 1e6;
  }

  perfToNs(ms: number): number {
    return ms * 1e6 + this.offsetNs;
  }

  /** Render-to-heard latency of the native stream (refreshed at most every 500 ms). */
  get latencyMs(): number {
    const now = performance.now();
    if (now - this.latencyAt > 500) {
      this.latency = Math.max(0, this.api.latencyMs());
      this.latencyAt = now;
    }
    return this.latency;
  }

  status(): NativeStatus {
    return JSON.parse(this.api.status()) as NativeStatus;
  }

  loadKit(id: string): Promise<void> {
    return this.whenKitLoaded(id, () => this.api.loadKit(id));
  }

  preloadKit(id: string): Promise<void> {
    return this.whenKitLoaded(id, () => this.api.preloadKit(id));
  }

  private whenKitLoaded(id: string, request: () => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const list = this.kitWaiters.get(id) ?? [];
      list.push((ok) => (ok ? resolve() : reject(new Error(`Native kit ${id} failed to load`))));
      this.kitWaiters.set(id, list);
      request();
    });
  }

  /** Uploads a cue as mono float32 PCM (channel 0). */
  setCue(name: string, buffer: AudioBuffer): void {
    const pcm = buffer.getChannelData(0);
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    this.api.setCue(name, btoa(bin), buffer.sampleRate);
  }
}

export const nativeBridge: NativeBridge | null = typeof window !== 'undefined' && window.PadNative ? new NativeBridge(window.PadNative) : null;
