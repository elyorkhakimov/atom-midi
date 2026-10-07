/**
 * Generates the "Electro" kit (808/909-style) into public/kits/electro/.
 * Every sound is synthesized here, so the kit is original work released as CC0.
 *
 *   node tools/kit-gen/make-electronic-kit.ts
 *
 * 16 instruments x 3 velocity layers x 2 round-robin variants, mono 16-bit 48 kHz WAV.
 * Layers differ in timbre (brightness, click, decay); loudness comes from the engine's
 * velocity gain, so every file is peak-normalized.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SR = 48000;
const OUT = join(import.meta.dirname, '../../public/kits/electro');
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type FilterType = 'lp' | 'hp' | 'bp';

/** RBJ biquad, applied in place. */
function biquad(x: Float32Array, type: FilterType, freq: number, q = 0.707): Float32Array {
  const w = (TAU * Math.min(freq, SR * 0.45)) / SR;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / (2 * q);
  let b0: number, b1: number, b2: number;
  if (type === 'lp') [b0, b1, b2] = [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];
  else if (type === 'hp') [b0, b1, b2] = [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2];
  else [b0, b1, b2] = [alpha, 0, -alpha];
  const a0 = 1 + alpha;
  const a1 = -2 * cos;
  const a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i]!;
    const y0 = (b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    x[i] = y0;
  }
  return x;
}

function buf(seconds: number): Float32Array {
  return new Float32Array(Math.round(seconds * SR));
}

function noise(seconds: number, r: () => number): Float32Array {
  const b = buf(seconds);
  for (let i = 0; i < b.length; i++) b[i] = r() * 2 - 1;
  return b;
}

/** Sine with a frequency function of time. */
function sweep(seconds: number, freqAt: (t: number) => number, phase0 = 0): Float32Array {
  const b = buf(seconds);
  let ph = phase0;
  for (let i = 0; i < b.length; i++) {
    b[i] = Math.sin(ph);
    ph += (TAU * freqAt(i / SR)) / SR;
  }
  return b;
}

/** Sum of square waves (808 cymbal/hat/cowbell metal). */
function metal(seconds: number, freqs: number[], detune: number): Float32Array {
  const b = buf(seconds);
  for (const f0 of freqs) {
    const f = f0 * detune;
    for (let i = 0; i < b.length; i++) b[i]! += ((i * f) / SR) % 1 < 0.5 ? 1 : -1;
  }
  return b;
}

function env(b: Float32Array, fn: (t: number) => number): Float32Array {
  for (let i = 0; i < b.length; i++) b[i]! *= fn(i / SR);
  return b;
}

const decay = (tau: number) => (t: number) => Math.exp(-t / tau);

function mix(...parts: [Float32Array, number][]): Float32Array {
  const len = Math.max(...parts.map(([p]) => p.length));
  const out = new Float32Array(len);
  for (const [p, g] of parts) for (let i = 0; i < p.length; i++) out[i]! += p[i]! * g;
  return out;
}

function drive(b: Float32Array, amount: number): Float32Array {
  const k = 1 + amount;
  const norm = Math.tanh(k);
  for (let i = 0; i < b.length; i++) b[i] = Math.tanh(b[i]! * k) / norm;
  return b;
}

/** Trim silence below -60 dB, fade in 1 ms / out 10 ms, then peak-normalize to -1 dBFS. */
function finish(b: Float32Array): Float32Array {
  const peakOf = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const rawPeak = peakOf(b) || 1;
  let end = b.length;
  while (end > 1 && Math.abs(b[end - 1]! / rawPeak) < 0.001) end--;
  const out = b.slice(0, Math.min(b.length, end + Math.round(0.005 * SR)));
  const fade = Math.min(out.length, Math.round(0.01 * SR));
  const att = Math.round(0.001 * SR); // avoids a click from DC at sample start
  for (let i = 0; i < out.length; i++) {
    const fromEnd = out.length - 1 - i;
    if (fromEnd < fade) out[i]! *= fromEnd / fade;
    if (i < att) out[i]! *= i / att;
  }
  const g = 0.891 / (peakOf(out) || 1);
  for (let i = 0; i < out.length; i++) out[i]! *= g;
  return out;
}

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------------------------------------------------------------------------
// Instruments. `i` = layer intensity (soft 0.35, medium 0.65, hard 1),
// `r` = per-variant random source, `d` = per-variant detune (~±1.5%).
// ---------------------------------------------------------------------------
type Voice = (i: number, r: () => number, d: number) => Float32Array;

const HAT_FREQS = [205.3, 304.4, 369.6, 522.7, 540, 800];

const voices: Record<string, Voice> = {
  kick: (i, r, d) => {
    const body = env(sweep(0.8, (t) => (48 + (120 + 120 * i) * Math.exp(-t / 0.028)) * d), decay(0.22 + 0.12 * i));
    const click = env(biquad(noise(0.01, r), 'hp', 2500), decay(0.002));
    return drive(mix([body, 1], [click, 0.25 * i]), 0.5 + 2 * i);
  },
  snare: (i, r, d) => {
    const tone = mix(
      [env(sweep(0.25, () => 185 * d), decay(0.06)), 0.7],
      [env(sweep(0.25, () => 330 * d), decay(0.04)), 0.4],
    );
    const n = env(biquad(biquad(noise(0.4, r), 'hp', 1200), 'lp', 3500 + 7000 * i), decay(0.09 + 0.07 * i));
    return mix([tone, 0.8 - 0.3 * i], [n, 0.6 + 0.4 * i]);
  },
  closedHat: (i, _r, d) =>
    env(biquad(biquad(metal(0.25, HAT_FREQS, d), 'bp', 10000, 1), 'hp', 6500 + 1500 * i), decay(0.025 + 0.02 * i)),
  openHat: (i, _r, d) =>
    env(biquad(biquad(metal(1.4, HAT_FREQS, d), 'bp', 10000, 1), 'hp', 6500 + 1500 * i), decay(0.25 + 0.15 * i)),
  lowTom: (i, r, d) => tom(105, i, r, d),
  midTom: (i, r, d) => tom(150, i, r, d),
  highTom: (i, r, d) => tom(215, i, r, d),
  clap: (i, r) => {
    const n = biquad(biquad(noise(0.5, r), 'bp', 1100 + 400 * i, 1.5), 'hp', 600);
    return env(n, (t) => {
      const bursts = [0, 0.011, 0.022].reduce((a, s) => a + (t >= s && t < s + 0.011 ? Math.exp(-(t - s) / 0.004) : 0), 0);
      return bursts + (t >= 0.03 ? 0.7 * Math.exp(-(t - 0.03) / (0.08 + 0.08 * i)) : 0);
    });
  },
  rim: (i, r, d) =>
    mix(
      [env(sweep(0.08, () => 1700 * d), decay(0.012)), 1],
      [env(sweep(0.08, () => 480 * d), decay(0.018)), 0.6],
      [env(biquad(noise(0.02, r), 'hp', 3000), decay(0.002 + 0.002 * i)), 0.5],
    ),
  cowbell: (i, _r, d) => {
    const m = biquad(metal(0.6, [540, 800], d), 'bp', 2000 + 800 * i, 1.2);
    return env(m, (t) => 0.6 * Math.exp(-t / 0.012) + 0.4 * Math.exp(-t / (0.12 + 0.08 * i)));
  },
  clave: (i, _r, d) => env(sweep(0.12, () => 2500 * d), decay(0.018 + 0.012 * i)),
  shaker: (i, r) =>
    env(biquad(noise(0.2, r), 'hp', 4500 + 2000 * i), (t) => Math.min(1, t / 0.012) * Math.exp(-Math.max(0, t - 0.012) / 0.05)),
  crash: (i, r, d) => {
    const m = biquad(metal(2.6, HAT_FREQS.map((f) => f * 1.45), d), 'hp', 4000);
    const n = biquad(noise(2.6, r), 'hp', 5000);
    return env(mix([m, 0.6], [n, 0.5]), (t) => Math.exp(-t / (0.6 + 0.4 * i)) * Math.min(1, t / 0.002));
  },
  ride: (i, r, d) => {
    const m = biquad(metal(2.0, HAT_FREQS.map((f) => f * 1.9), d), 'bp', 7000, 0.8);
    const ping = env(sweep(2.0, () => 3200 * d), decay(0.25));
    const n = env(biquad(noise(0.05, r), 'hp', 6000), decay(0.004 * (1 + i)));
    return env(mix([m, 0.5], [ping, 0.25 + 0.15 * i], [n, 0.4 * i]), decay(0.55 + 0.25 * i));
  },
  boom: (i, _r, d) =>
    drive(env(sweep(1.8, (t) => (42 + 70 * Math.exp(-t / 0.05)) * d), decay(0.5 + 0.2 * i)), 0.3 + 1.5 * i),
  zap: (i, _r, d) => env(sweep(0.35, (t) => (300 + (1500 + 2500 * i) * Math.exp(-t / 0.04)) * d), decay(0.08 + 0.04 * i)),
};

function tom(f0: number, i: number, r: () => number, d: number): Float32Array {
  const body = env(sweep(0.7, (t) => f0 * d * (1 + 0.5 * Math.exp(-t / 0.05))), decay(0.18 + 0.1 * i));
  const n = env(biquad(noise(0.05, r), 'bp', f0 * 8, 1), decay(0.006));
  return drive(mix([body, 1], [n, 0.3 * i]), 0.3 + i);
}

// ---------------------------------------------------------------------------
// Kit layout (pad 0 = bottom-left), names and pad colours (0–127 RGB)
// ---------------------------------------------------------------------------
const INSTRUMENTS: { id: keyof typeof voices; name: string; color: [number, number, number]; chokeGroup?: string }[] = [
  // bottom row
  { id: 'kick', name: 'Kick', color: [127, 0, 0] },
  { id: 'snare', name: 'Snare', color: [127, 40, 0] },
  { id: 'closedHat', name: 'Closed hat', color: [127, 110, 0], chokeGroup: 'hat' },
  { id: 'openHat', name: 'Open hat', color: [90, 127, 0], chokeGroup: 'hat' },
  // row 2
  { id: 'lowTom', name: 'Low tom', color: [0, 127, 20] },
  { id: 'midTom', name: 'Mid tom', color: [0, 127, 60] },
  { id: 'highTom', name: 'High tom', color: [0, 127, 110] },
  { id: 'clap', name: 'Clap', color: [127, 0, 60] },
  // row 3
  { id: 'rim', name: 'Rim', color: [0, 90, 127] },
  { id: 'cowbell', name: 'Cowbell', color: [0, 40, 127] },
  { id: 'clave', name: 'Clave', color: [30, 0, 127] },
  { id: 'shaker', name: 'Shaker', color: [70, 0, 127] },
  // top row
  { id: 'crash', name: 'Crash', color: [110, 0, 127] },
  { id: 'ride', name: 'Ride', color: [127, 0, 110] },
  { id: 'boom', name: 'Boom', color: [127, 10, 10] },
  { id: 'zap', name: 'Zap', color: [127, 127, 127] },
];

const LAYERS = [
  { name: 'soft', intensity: 0.35, minVelocity: 1, maxVelocity: 50 },
  { name: 'medium', intensity: 0.65, minVelocity: 51, maxVelocity: 100 },
  { name: 'hard', intensity: 1, minVelocity: 101, maxVelocity: 127 },
];
const ROUND_ROBIN = 2;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let totalBytes = 0;
let seed = 1;
const instruments: Record<string, unknown> = {};
for (const inst of INSTRUMENTS) {
  const layers = LAYERS.map((layer) => {
    const samples: string[] = [];
    for (let v = 0; v < ROUND_ROBIN; v++) {
      const r = rng(seed++);
      const detune = 1 + (r() - 0.5) * 0.03;
      const file = `${inst.id}_${layer.name}_${v + 1}.wav`;
      const data = wav(finish(voices[inst.id]!(layer.intensity, r, detune)));
      writeFileSync(join(OUT, file), data);
      totalBytes += data.length;
      samples.push(file);
    }
    return { minVelocity: layer.minVelocity, maxVelocity: layer.maxVelocity, samples };
  });
  instruments[inst.id] = {
    name: inst.name,
    color: inst.color,
    ...(inst.chokeGroup ? { chokeGroup: inst.chokeGroup } : {}),
    crossfade: 8,
    layers,
  };
}

const kit = {
  id: 'electro',
  name: 'Electro',
  description: '808/909-style electronic kit',
  license: 'CC0-1.0',
  source: 'Synthesized by tools/kit-gen/make-electronic-kit.ts in this repository (original work).',
  sampleRate: SR,
  pads: INSTRUMENTS.map((i) => i.id),
  instruments,
};
writeFileSync(join(OUT, 'kit.json'), JSON.stringify(kit, null, 2) + '\n');
console.log(`electro: ${INSTRUMENTS.length * LAYERS.length * ROUND_ROBIN} files, ${(totalBytes / 1e6).toFixed(2)} MB`);
