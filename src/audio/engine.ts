import { AudioClock } from './clock';
import { makeCues, type CueName } from './cues';
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

/**
 * Web Audio engine: sample kits with velocity layers, crossfades, round-robin,
 * choke groups and voice stealing; synthesized cues; separate kit/metronome/cue buses.
 * All playback takes an optional audio-clock time; omitted = as soon as possible.
 */
export class AudioEngine {
  readonly ctx: AudioContext;
  readonly clock: AudioClock;
  kit: LoadedKit | null = null;

  private readonly master: GainNode;
  private readonly kitBus: GainNode;
  private readonly metronomeBus: GainNode;
  private readonly cueBus: GainNode;
  private readonly cues: Record<CueName, AudioBuffer>;
  private readonly roundRobin = new RoundRobin();
  private voices: Voice[] = [];
  private readonly kitCache = new Map<string, Promise<LoadedKit>>();

  constructor() {
    // No sampleRate: use the device's native rate (avoids resampling latency on Android).
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.clock = new AudioClock(this.ctx);
    this.master = this.ctx.createGain();
    this.master.connect(this.ctx.destination);
    this.kitBus = this.bus(1);
    this.metronomeBus = this.bus(0.7);
    this.cueBus = this.bus(0.8);
    this.cues = makeCues(this.ctx);
  }

  private bus(gain: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = gain;
    g.connect(this.master);
    return g;
  }

  get running(): boolean {
    return this.ctx.state === 'running';
  }

  /** Must run inside a user gesture the first time. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  setMasterVolume(v: number): void {
    this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  setMetronomeVolume(v: number): void {
    this.metronomeBus.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  // -------------------------------------------------------------------------
  // Kits
  // -------------------------------------------------------------------------
  async loadKit(id: string): Promise<void> {
    let p = this.kitCache.get(id);
    if (!p) {
      p = this.fetchKit(id);
      this.kitCache.set(id, p);
      p.catch(() => this.kitCache.delete(id));
    }
    this.kit = await p;
  }

  private async fetchKit(id: string): Promise<LoadedKit> {
    const base = `${import.meta.env.BASE_URL}kits/${id}/`;
    const res = await fetch(`${base}kit.json`);
    if (!res.ok) throw new Error(`Kit ${id}: ${res.status}`);
    const json = (await res.json()) as KitJson;
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
    const id = this.instrumentForPad(pad);
    if (id) this.playInstrument(id, velocity, when);
  }

  playInstrument(id: string, velocity: number, when?: number): void {
    const kit = this.kit;
    const def = kit?.json.instruments[id];
    const layerBuffers = kit?.buffers[id];
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
      let dest: AudioNode = this.kitBus;
      if (def.velocityFilter) {
        const f = this.ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 600 + (velocity / 127) ** 2 * 16000;
        f.connect(this.kitBus);
        dest = f;
      }
      this.startVoice(buffer, baseGain * gain, t, dest, def.chokeGroup);
    }
  }

  private startVoice(buffer: AudioBuffer, gain: number, t: number, dest: AudioNode, chokeGroup?: string): void {
    while (this.voices.length >= MAX_VOICES) this.release(this.voices[0]!, t);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    source.connect(g).connect(dest);
    const voice: Voice = { source, gain: g, start: t, chokeGroup };
    source.onended = () => {
      g.disconnect();
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

  /** Stops all kit voices (e.g. leaving a game). */
  stopAll(): void {
    for (const v of [...this.voices]) this.release(v, this.ctx.currentTime);
  }

  // -------------------------------------------------------------------------
  // Cues and metronome
  // -------------------------------------------------------------------------
  /** Returns a handle that can cancel the cue before it plays. */
  playCue(name: CueName, when?: number, gain = 1): { cancel(): void } {
    return this.playBuffer(this.cues[name], this.cueBus, when, gain);
  }

  click(accent: boolean, when?: number): { cancel(): void } {
    return this.playBuffer(this.cues[accent ? 'clickAccent' : 'click'], this.metronomeBus, when);
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
