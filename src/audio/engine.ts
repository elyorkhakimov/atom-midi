import { NativeBus, nativeBridge } from '../native/bridge';
import { AudioClock, NativeAudioClock, type Clock } from './clock';
import { makeCues, type CueName } from './cues';
import { SynthVoices, padFrequency, patchToFloats, type SynthOut, type SynthPatch } from './synth';
import { RoundRobin, selectLayers, velocityGain, type KitJson } from './kit';

interface LoadedKit {
  json: KitJson;
  /** buffers[instrumentId][layer][variant] */
  buffers: Record<string, AudioBuffer[][]>;
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  start: number;
  chokeGroup: string | undefined;
}

export const MAX_VOICES = 32;
const STEAL_FADE_S = 0.008;
/** Kit samples are normalized to -1 dBFS; leave room for a full groove plus the click. */
const KIT_BUS_GAIN = 0.55;
/** The soft clipper is linear up to this level and handles input up to ±CLIP_INPUT_RANGE. */
const CLIP_KNEE = 0.6;
const CLIP_INPUT_RANGE = 2;

/**
 * Transparent below the knee, then saturates smoothly towards ±1 instead of
 * hard-clipping. A WaveShaper adds no latency (unlike DynamicsCompressorNode's
 * look-ahead), so it's safe on the live path.
 */
export function softClip(x: number): number {
  const a = Math.abs(x);
  if (a <= CLIP_KNEE) return x;
  const head = 1 - CLIP_KNEE;
  return Math.sign(x) * (CLIP_KNEE + head * Math.tanh((a - CLIP_KNEE) / head));
}

function softClipCurve(points = 4097): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(points);
  for (let i = 0; i < points; i++) curve[i] = softClip(((i / (points - 1)) * 2 - 1) * CLIP_INPUT_RANGE);
  return curve;
}

/**
 * Web Audio engine: sample kits with velocity layers, crossfades, round-robin,
 * choke groups and voice stealing; synthesized cues; separate kit/metronome/cue buses.
 * All playback takes an optional audio-clock time; omitted = as soon as possible.
 *
 * In the Android app (`nativeBridge`), everything plays on the native engine
 * (android/app/src/main/cpp, same behaviour). The page then uses an OfflineAudioContext only
 * to build and decode buffers, so it never opens a (slower, competing) audio output.
 */
export class AudioEngine {
  readonly ctx: BaseAudioContext;
  readonly clock: Clock;
  kit: LoadedKit | null = null;
  readonly synth: SynthOut;

  private readonly master: GainNode;
  private readonly kitBus: GainNode;
  private readonly metronomeBus: GainNode;
  private readonly cueBus: GainNode;
  private readonly cues: Record<CueName, AudioBuffer>;
  private readonly roundRobin = new RoundRobin();
  private voices: Voice[] = [];
  private readonly kitCache = new Map<string, Promise<LoadedKit>>();
  private readonly native = nativeBridge;
  private liveMask = 0;
  private liveSynth = false;
  private liveKey = '';
  private kitRequest = '';

  constructor() {
    // No sampleRate: use the device's native rate (avoids resampling latency on Android).
    const native = this.native;
    if (native) {
      this.ctx = new OfflineAudioContext(1, 1, 48000);
      this.clock = new NativeAudioClock(native);
    } else {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.clock = new AudioClock(ctx);
    }
    this.master = this.ctx.createGain();
    // The shaper's curve covers ±1, so scale the mix into it; the curve scales back.
    const range = this.ctx.createGain();
    range.gain.value = 1 / CLIP_INPUT_RANGE;
    const clipper = this.ctx.createWaveShaper();
    clipper.curve = softClipCurve();
    clipper.oversample = 'none';
    this.master.connect(range).connect(clipper).connect(this.ctx.destination);
    this.kitBus = this.bus(KIT_BUS_GAIN);
    this.metronomeBus = this.bus(0.7);
    this.cueBus = this.bus(0.8);
    this.synth = native ? new NativeSynth(native, (pad) => this.liveSynth && (this.liveMask & (1 << pad)) !== 0) : new SynthVoices(this.ctx, this.bus(KIT_BUS_GAIN));
    this.cues = makeCues(this.ctx);
    if (this.native) for (const [name, buffer] of Object.entries(this.cues)) this.native.setCue(name, buffer);
  }

  private bus(gain: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  get running(): boolean {
    if (this.native) return this.native.status().audio.running;
    return this.ctx.state === 'running';
  }

  /** Must run inside a user gesture the first time. */
  async resume(): Promise<void> {
    if (this.native) return;
    if (this.ctx.state !== 'running') await (this.ctx as AudioContext).resume();
  }

  setMasterVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
    this.native?.api.setMasterGain(v);
  }

  setMetronomeVolume(v: number): void {
    this.metronomeBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
    this.native?.api.setBusGain(NativeBus.metronome, v);
  }

  /**
   * Android app: pads in `mask` sound natively the moment they're hit, before the page sees
   * the event: the kit, or the synth when `synth` is given. playPad() without a time and
   * synth.noteOn/noteOff then skip those pads. `fixedVelocity` > 0 replaces the hit
   * velocity (Free jam's Full level). No effect in the browser.
   */
  setLivePads(mask: number, opts: { fixedVelocity?: number; synth?: { patch: SynthPatch; transpose: number } } = {}): void {
    const fixed = opts.fixedVelocity ?? 0;
    const synth = opts.synth;
    const patchCsv = synth ? patchToFloats(synth.patch).join(',') : '';
    const freqsCsv = synth ? Array.from({ length: 16 }, (_, pad) => padFrequency(pad, synth.patch, synth.transpose)).join(',') : '';
    const key = `${mask}|${fixed}|${patchCsv}|${freqsCsv}`;
    if (key === this.liveKey) return;
    this.liveKey = key;
    this.liveMask = mask;
    this.liveSynth = Boolean(synth);
    this.native?.api.setLive(mask, fixed, Boolean(synth), patchCsv, freqsCsv);
  }

  /** Native time at which a sound scheduled for audio time `when` should be heard; 0 = now. */
  private heardNs(when: number | undefined): number {
    return when === undefined || !this.native ? 0 : this.native.perfToNs(this.clock.audioToPerf(when));
  }

  // -------------------------------------------------------------------------
  // Kits
  // -------------------------------------------------------------------------
  async loadKit(id: string): Promise<void> {
    this.kitRequest = id;
    let p = this.kitCache.get(id);
    const cached = Boolean(p);
    if (!p) {
      p = this.fetchKit(id);
      this.kitCache.set(id, p);
      p.catch(() => this.kitCache.delete(id));
    }
    const kit = await p;
    // The native engine plays its own current kit: coming back to a cached one must select it
    // there again, or it keeps the last kit (and plays nothing for this kit's instrument names).
    if (this.native && cached) await this.native.loadKit(id);
    // Quick kit changes: the last one asked for wins, whatever order the loads finish in.
    if (this.kitRequest === id) this.kit = kit;
  }

  private async fetchKit(id: string): Promise<LoadedKit> {
    const base = `${import.meta.env.BASE_URL}kits/${id}/`;
    const res = await fetch(`${base}kit.json`);
    if (!res.ok) throw new Error(`Kit ${id}: ${res.status}`);
    const json = (await res.json()) as KitJson;
    if (this.native) {
      await this.native.loadKit(id);
      return { json, buffers: {} };
    }
    const decode = async (file: string) => {
      const r = await fetch(base + file);
      if (!r.ok) throw new Error(`Kit ${id}/${file}: ${r.status}`);
      return this.ctx.decodeAudioData(await r.arrayBuffer());
    };
    const buffers: Record<string, AudioBuffer[][]> = {};
    await Promise.all(
      Object.entries(json.instruments).map(async ([inst, def]) => {
        buffers[inst] = await Promise.all(def.layers.map((l) => Promise.all(l.samples.map(decode))));
      }),
    );
    return { json, buffers };
  }

  instrumentForPad(pad: number): string | undefined {
    return this.kit?.json.pads[pad];
  }

  padColor(pad: number): { r: number; g: number; b: number } | null {
    const id = this.instrumentForPad(pad);
    const c = id ? this.kit?.json.instruments[id]?.color : undefined;
    return c ? { r: c[0], g: c[1], b: c[2] } : null;
  }

  playPad(pad: number, velocity: number, when?: number): void {
    // Already played natively from the MIDI thread.
    if (when === undefined && this.native && !this.liveSynth && this.liveMask & (1 << pad)) return;
    const id = this.instrumentForPad(pad);
    if (id) this.playInstrument(id, velocity, when);
  }

  playInstrument(id: string, velocity: number, when?: number): void {
    const kit = this.kit;
    const def = kit?.json.instruments[id];
    const layerBuffers = kit?.buffers[id];
    if (this.native) {
      if (def) this.native.api.playInstrument(id, velocity, this.heardNs(when));
      return;
    }
    if (!def || !layerBuffers) return;
    const t = Math.max(when ?? 0, this.ctx.currentTime);

    if (def.chokeGroup) {
      for (const v of this.voices) if (v.chokeGroup === def.chokeGroup) this.release(v, t);
    }

    const baseGain = velocityGain(velocity);
    for (const { index, gain } of selectLayers(def.layers, velocity, def.crossfade ?? 0)) {
      const variants = layerBuffers[index] ?? [];
      const buffer = variants[this.roundRobin.pick(`${id}/${index}`, variants.length)];
      if (!buffer) continue;
      let filter: BiquadFilterNode | undefined;
      if (def.velocityFilter) {
        filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 600 + (velocity / 127) ** 2 * 16000;
        filter.connect(this.kitBus);
      }
      this.startVoice(buffer, baseGain * gain, t, filter ?? this.kitBus, def.chokeGroup, filter);
    }
  }

  private startVoice(buffer: AudioBuffer, gain: number, t: number, dest: AudioNode, chokeGroup?: string, filter?: AudioNode): void {
    while (this.voices.length >= MAX_VOICES) this.release(this.voices[0]!, t);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    source.connect(g).connect(dest);
    const voice: Voice = { source, gain: g, start: t, chokeGroup };
    source.onended = () => {
      g.disconnect();
      filter?.disconnect();
      this.voices = this.voices.filter((v) => v !== voice);
    };
    source.start(t);
    this.voices.push(voice);
  }

  private release(v: Voice, t: number): void {
    this.voices = this.voices.filter((x) => x !== v);
    const at = Math.max(t, v.start);
    v.gain.gain.cancelScheduledValues(at);
    v.gain.gain.setTargetAtTime(0, at, STEAL_FADE_S / 3);
    try {
      v.source.stop(at + STEAL_FADE_S * 3);
    } catch {
      /* already stopped */
    }
  }

  /** Stops all kit and synth voices (e.g. leaving a game). */
  stopAll(): void {
    for (const v of [...this.voices]) this.release(v, this.ctx.currentTime);
    this.native?.api.stopAll();
    this.synth.stopAll();
  }

  // -------------------------------------------------------------------------
  // Cues and metronome
  // -------------------------------------------------------------------------
  /**
   * Swaps in the recorded cue sounds from public/sounds/. Any that fail to load
   * keep their synthesized version, so this never blocks or breaks playback.
   */
  async loadCueFiles(): Promise<void> {
    const base = `${import.meta.env.BASE_URL}sounds/`;
    try {
      const res = await fetch(`${base}cues.json`);
      if (!res.ok) return;
      const manifest = (await res.json()) as Partial<Record<CueName, string>>;
      await Promise.all(
        Object.entries(manifest).map(async ([name, file]) => {
          if (!(name in this.cues) || !file) return;
          try {
            const r = await fetch(base + file);
            if (!r.ok) return;
            const buffer = await this.ctx.decodeAudioData(await r.arrayBuffer());
            this.cues[name as CueName] = buffer;
            this.native?.setCue(name, buffer);
          } catch {
            /* keep the synthesized cue */
          }
        }),
      );
    } catch {
      /* offline or missing: synthesized cues stay */
    }
  }

  /** Returns a handle that can cancel the cue before it plays. */
  playCue(name: CueName, when?: number, gain = 1): { cancel(): void } {
    return this.playNamed(name, this.cueBus, NativeBus.cue, when, gain);
  }

  click(accent: boolean, when?: number): { cancel(): void } {
    return this.playNamed(accent ? 'clickAccent' : 'click', this.metronomeBus, NativeBus.metronome, when);
  }

  private playNamed(name: CueName, bus: AudioNode, nativeBus: number, when?: number, gain = 1): { cancel(): void } {
    const native = this.native;
    if (native) {
      const id = native.api.playCue(name, nativeBus, gain, this.heardNs(when));
      return { cancel: () => native.api.stopVoice(id) };
    }
    return this.playBuffer(this.cues[name], bus, when, gain);
  }

  private playBuffer(buffer: AudioBuffer, bus: AudioNode, when?: number, gain = 1): { cancel(): void } {
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    let out: AudioNode = source;
    if (gain !== 1) {
      const g = this.ctx.createGain();
      g.gain.value = gain;
      source.connect(g);
      out = g;
    }
    out.connect(bus);
    source.start(Math.max(when ?? 0, this.ctx.currentTime));
    return {
      cancel: () => {
        try {
          source.stop();
        } catch {
          /* not started or already stopped */
        }
        source.disconnect();
      },
    };
  }
}

type NativeBridgeT = NonNullable<typeof nativeBridge>;

/** Synth notes on the native engine; pads it already plays live are skipped. */
class NativeSynth implements SynthOut {
  constructor(
    private readonly native: NativeBridgeT,
    private readonly isLive: (pad: number) => boolean,
  ) {}

  noteOn(pad: number, velocity: number, patch: SynthPatch, transpose = 0): void {
    if (this.isLive(pad)) return;
    this.native.api.synthNoteOn(pad, velocity, patchToFloats(patch).join(','), padFrequency(pad, patch, transpose), 0);
  }

  noteOff(pad: number): void {
    if (this.isLive(pad)) return;
    this.native.api.synthNoteOff(pad);
  }

  /** AudioEngine.stopAll() already stops native synth voices. */
  stopAll(): void {}
}
