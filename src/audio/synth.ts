/**
 * Small subtractive synth for Free Jam: oscillator(s) -> low-pass -> ADSR amp.
 * The patch format, presets and parameter stepping are pure; SynthVoices is the
 * Web Audio part.
 */

export const WAVES = ['sine', 'triangle', 'square', 'sawtooth'] as const;
export type Wave = (typeof WAVES)[number];

export const SCALES = {
  pentatonic: [0, 2, 4, 7, 9],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
} as const;
export type ScaleName = keyof typeof SCALES;
const SCALE_NAMES = Object.keys(SCALES) as ScaleName[];

export interface SynthPatch {
  wave: Wave;
  /** Octave of pad 0 (bottom-left); 4 = middle C. */
  octave: number;
  scale: ScaleName;
  /** A second oscillator detuned by this many cents; 0 = one oscillator. */
  detune: number;
  /** Seconds. */
  attack: number;
  /** Seconds to fall 60 dB towards the sustain level. */
  decay: number;
  /** 0..1 of the peak, held while the pad is down. */
  sustain: number;
  /** Seconds to fall 60 dB after the pad is released. */
  release: number;
  /** Low-pass cutoff, Hz. */
  cutoff: number;
  /** Filter Q. */
  resonance: number;
  /** 0..1: how far the filter opens at the start of the note, closing over the decay. */
  filterEnv: number;
  /** 0..1 output level. */
  level: number;
}

export const SYNTH_PRESETS: Record<'pluck' | 'pad', { name: string; patch: SynthPatch }> = {
  // The ATOM test page's sound.
  pluck: {
    name: 'Pluck',
    patch: { wave: 'triangle', octave: 4, scale: 'pentatonic', detune: 0, attack: 0.002, decay: 0.35, sustain: 0, release: 0.1, cutoff: 12000, resonance: 0, filterEnv: 0, level: 0.8 },
  },
  pad: {
    name: 'Warm pad',
    patch: { wave: 'sawtooth', octave: 3, scale: 'pentatonic', detune: 12, attack: 0.06, decay: 1.2, sustain: 0.6, release: 0.9, cutoff: 1600, resonance: 2, filterEnv: 0.35, level: 0.7 },
  },
};

export const DEFAULT_CUSTOM_PATCH: SynthPatch = { ...SYNTH_PRESETS.pluck.patch };

type NumKey = { [K in keyof SynthPatch]: SynthPatch[K] extends number ? K : never }[keyof SynthPatch];

export type ParamDef =
  | { key: 'wave'; label: string; kind: 'choice'; options: readonly Wave[] }
  | { key: 'scale'; label: string; kind: 'choice'; options: readonly ScaleName[] }
  | { key: NumKey; label: string; kind: 'linear'; min: number; max: number; step: number; format(v: number): string }
  /** Multiplies by `ratio` per knob step: even feel from milliseconds to seconds. */
  | { key: NumKey; label: string; kind: 'log'; min: number; max: number; ratio: number; format(v: number): string };

const seconds = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const percent = (v: number) => `${Math.round(v * 100)}%`;

/** Three rows of four, one row per set of ATOM knobs. */
export const PARAM_ROWS: readonly (readonly ParamDef[])[] = [
  [
    { key: 'wave', label: 'Wave', kind: 'choice', options: WAVES },
    { key: 'octave', label: 'Octave', kind: 'linear', min: 1, max: 6, step: 1, format: (v) => String(v) },
    { key: 'scale', label: 'Scale', kind: 'choice', options: SCALE_NAMES },
    { key: 'detune', label: 'Detune', kind: 'linear', min: 0, max: 50, step: 1, format: (v) => `${v} ct` },
  ],
  [
    { key: 'attack', label: 'Attack', kind: 'log', min: 0.002, max: 2, ratio: 1.15, format: seconds },
    { key: 'decay', label: 'Decay', kind: 'log', min: 0.03, max: 4, ratio: 1.12, format: seconds },
    { key: 'sustain', label: 'Sustain', kind: 'linear', min: 0, max: 1, step: 0.05, format: percent },
    { key: 'release', label: 'Release', kind: 'log', min: 0.02, max: 4, ratio: 1.12, format: seconds },
  ],
  [
    { key: 'cutoff', label: 'Filter', kind: 'log', min: 150, max: 12000, ratio: 1.08, format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`) },
    { key: 'resonance', label: 'Resonance', kind: 'linear', min: 0, max: 15, step: 0.5, format: (v) => v.toFixed(1) },
    { key: 'filterEnv', label: 'Filter env', kind: 'linear', min: 0, max: 1, step: 0.05, format: percent },
    { key: 'level', label: 'Level', kind: 'linear', min: 0, max: 1, step: 0.05, format: percent },
  ],
];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Moves one parameter by `delta` knob steps (choices wrap around). */
export function stepParam(patch: SynthPatch, def: ParamDef, delta: number): SynthPatch {
  if (delta === 0) return patch;
  if (def.kind === 'choice') {
    const opts = def.options as readonly string[];
    const i = opts.indexOf(patch[def.key]);
    const next = opts[(((i + Math.sign(delta)) % opts.length) + opts.length) % opts.length]!;
    return { ...patch, [def.key]: next };
  }
  const v = patch[def.key];
  const next =
    def.kind === 'log'
      ? clamp(v * def.ratio ** delta, def.min, def.max)
      : clamp(Math.round((v + def.step * delta) / def.step) * def.step, def.min, def.max);
  return { ...patch, [def.key]: +next.toPrecision(6) };
}

/** Fills missing or out-of-range fields (e.g. from older saved settings) from the default. */
export function sanitizePatch(p: Partial<SynthPatch> | undefined): SynthPatch {
  const out: SynthPatch = { ...DEFAULT_CUSTOM_PATCH };
  if (!p) return out;
  for (const def of PARAM_ROWS.flat()) {
    const v = p[def.key];
    if (def.kind === 'choice') {
      if (typeof v === 'string' && (def.options as readonly string[]).includes(v)) (out as unknown as Record<string, unknown>)[def.key] = v;
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      out[def.key] = clamp(v, def.min, def.max);
    }
  }
  return out;
}

/** Semitones above C of the patch's octave for a pad, walking up the scale from pad 0. */
export function padSemitone(pad: number, scale: ScaleName): number {
  const steps = SCALES[scale];
  return steps[pad % steps.length]! + 12 * Math.floor(pad / steps.length);
}

/** Root notes of the scale, for brighter pad colours. */
export function isRoot(pad: number, scale: ScaleName): boolean {
  return pad % SCALES[scale].length === 0;
}

/** `transpose` shifts every pad by semitones (a key change). */
export function padFrequency(pad: number, patch: SynthPatch, transpose = 0): number {
  const c0 = 16.3516;
  return c0 * 2 ** patch.octave * 2 ** ((padSemitone(pad, patch.scale) + transpose) / 12);
}

/** What plays synth notes: SynthVoices (Web Audio) or the native engine in the Android app. */
export interface SynthOut {
  noteOn(pad: number, velocity: number, patch: SynthPatch, transpose?: number): void;
  noteOff(pad: number): void;
  stopAll(): void;
}

/** The patch as the native engine takes it: [wave, detune, attack, decay, sustain, release, cutoff, resonance, filterEnv, level]. */
export function patchToFloats(p: SynthPatch): number[] {
  return [WAVES.indexOf(p.wave), p.detune, p.attack, p.decay, p.sustain, p.release, p.cutoff, p.resonance, p.filterEnv, p.level];
}

/** Square and saw are much louder than sine at the same amplitude. */
const WAVE_GAIN: Record<Wave, number> = { sine: 1, triangle: 1, square: 0.45, sawtooth: 0.55 };
const MAX_SYNTH_VOICES = 16;
/** Time constant for a 60 dB fall over `t` seconds. */
const tc60 = (t: number) => Math.max(0.001, t / 6.9);

interface SynthVoice {
  pad: number;
  oscs: OscillatorNode[];
  amp: GainNode;
  start: number;
  patch: SynthPatch;
}

/** Polyphonic voices: one per held pad, oldest stolen past the limit. */
export class SynthVoices implements SynthOut {
  private voices: SynthVoice[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly out: AudioNode,
  ) {}

  noteOn(pad: number, velocity: number, patch: SynthPatch, transpose = 0): void {
    const ctx = this.ctx;
    const t = ctx.currentTime;
    for (const v of this.voices.filter((v) => v.pad === pad)) this.release(v, t, 0.03);
    while (this.voices.length >= MAX_SYNTH_VOICES) this.release(this.voices[0]!, t, 0.01);

    const vel = clamp(velocity, 1, 127) / 127;
    const peak = 0.5 * patch.level * WAVE_GAIN[patch.wave] * vel ** 2 / (patch.detune > 0 ? 1.4 : 1);
    const freq = padFrequency(pad, patch, transpose);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = patch.resonance;
    // Softer hits sound darker.
    const base = clamp(patch.cutoff * (0.45 + 0.55 * vel), 40, 20000);
    const open = clamp(base * (1 + patch.filterEnv * 15), 40, 20000);
    filter.frequency.setValueAtTime(open, t);
    if (open > base) filter.frequency.setTargetAtTime(base, t + patch.attack, tc60(patch.decay) * 1.5);

    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, t);
    amp.gain.linearRampToValueAtTime(peak, t + Math.max(0.002, patch.attack));
    amp.gain.setTargetAtTime(peak * patch.sustain, t + patch.attack, tc60(patch.decay));

    const oscs = (patch.detune > 0 ? [-patch.detune / 2, patch.detune / 2] : [0]).map((cents) => {
      const o = ctx.createOscillator();
      o.type = patch.wave;
      o.frequency.value = freq;
      o.detune.value = cents;
      o.connect(filter);
      o.start(t);
      return o;
    });
    filter.connect(amp).connect(this.out);

    const voice: SynthVoice = { pad, oscs, amp, start: t, patch };
    oscs[0]!.onended = () => {
      amp.disconnect();
      filter.disconnect();
      this.voices = this.voices.filter((v) => v !== voice);
    };
    // Notes without sustain end by themselves; held notes wait for noteOff.
    if (patch.sustain === 0) for (const o of oscs) o.stop(t + patch.attack + patch.decay * 1.3 + 0.05);
    this.voices.push(voice);
  }

  /** Pad hits are short taps, so a patch without sustain rings out its decay like a plucked string. */
  noteOff(pad: number): void {
    const t = this.ctx.currentTime;
    for (const v of this.voices.filter((v) => v.pad === pad && v.patch.sustain > 0)) this.release(v, t, v.patch.release);
  }

  stopAll(): void {
    const t = this.ctx.currentTime;
    for (const v of [...this.voices]) this.release(v, t, 0.02);
  }

  private release(v: SynthVoice, t: number, releaseS: number): void {
    this.voices = this.voices.filter((x) => x !== v);
    const at = Math.max(t, v.start);
    const g = v.amp.gain;
    if (typeof g.cancelAndHoldAtTime === 'function') g.cancelAndHoldAtTime(at);
    else {
      g.cancelScheduledValues(at);
      g.setValueAtTime(g.value, at);
    }
    g.setTargetAtTime(0, at, tc60(releaseS));
    for (const o of v.oscs) {
      try {
        o.stop(at + releaseS * 1.2 + 0.02);
      } catch {
        /* already stopped */
      }
    }
  }
}
