import { nativeBridge } from '../native/bridge';
import { CLIP_INPUT_RANGE, KIT_BUS_GAIN, softClipCurve } from './engine';
import { RoundRobin, selectLayers, velocityGain, type KitJson } from './kit';
import { decodeKitBuffers, fetchKitJson, type KitBuffers } from './kitFiles';

export const EXPORT_RATE = 48000;
const CHANNELS = 2;
/** Room after the last pass for its sounds to ring out. */
const MAX_TAIL_S = 3;
const STEAL_FADE_S = 0.008;
/** Exports are raised (never lowered) to peak here: the live mix leaves headroom for the click. */
const EXPORT_PEAK = 10 ** (-1 / 20);

export interface RenderNote {
  /** Seconds from the start. */
  at: number;
  pad: number;
  velocity: number;
  kit: string;
}

/**
 * Renders kit hits offline, the way AudioEngine plays them live (velocity layers, crossfades,
 * velocity filter, round-robin, choke groups, kit bus level and soft clipper). `length` is in
 * seconds; the render runs on until the last sound ends (at most MAX_TAIL_S more), and is
 * normalized up to EXPORT_PEAK.
 */
export async function renderKitNotes(notes: readonly RenderNote[], length: number): Promise<AudioBuffer> {
  const decoder = new OfflineAudioContext(CHANNELS, 1, EXPORT_RATE);
  const kits = new Map<string, { json: KitJson; buffers: KitBuffers }>();
  await Promise.all(
    [...new Set(notes.map((n) => n.kit))].map(async (id) => {
      const json = await fetchKitJson(id);
      kits.set(id, { json, buffers: await decodeKitBuffers(decoder, id, json) });
    }),
  );

  // Pick samples first, so the render is exactly as long as the sounds need.
  const rr = new RoundRobin();
  const hits: { at: number; buffer: AudioBuffer; gain: number; cutoff?: number; choke?: string }[] = [];
  for (const n of notes) {
    const kit = kits.get(n.kit);
    const id = kit?.json.pads[n.pad];
    const def = id ? kit!.json.instruments[id] : undefined;
    if (!def) continue;
    for (const { index, gain } of selectLayers(def.layers, n.velocity, def.crossfade ?? 0)) {
      const variants = kit!.buffers[id!]?.[index] ?? [];
      const buffer = variants[rr.pick(`${n.kit}/${id}/${index}`, variants.length)];
      if (!buffer) continue;
      const cutoff = def.velocityFilter ? 600 + (n.velocity / 127) ** 2 * 16000 : undefined;
      hits.push({ at: n.at, buffer, gain: velocityGain(n.velocity) * gain, cutoff, choke: def.chokeGroup && `${n.kit}/${def.chokeGroup}` });
    }
  }
  const end = Math.max(length, ...hits.map((h) => Math.min(h.at + h.buffer.duration, length + MAX_TAIL_S)));

  const ctx = new OfflineAudioContext(CHANNELS, Math.ceil(end * EXPORT_RATE), EXPORT_RATE);
  const range = ctx.createGain();
  range.gain.value = 1 / CLIP_INPUT_RANGE;
  const clipper = ctx.createWaveShaper();
  clipper.curve = softClipCurve();
  const bus = ctx.createGain();
  bus.gain.value = KIT_BUS_GAIN;
  bus.connect(range).connect(clipper).connect(ctx.destination);

  hits.sort((a, b) => a.at - b.at);
  const ringing = new Map<string, { gain: GainNode; source: AudioBufferSourceNode; at: number }[]>();
  for (const h of hits) {
    if (h.choke) {
      for (const v of ringing.get(h.choke) ?? []) {
        if (v.at >= h.at) continue;
        v.gain.gain.setTargetAtTime(0, h.at, STEAL_FADE_S / 3);
        v.source.stop(h.at + STEAL_FADE_S * 3);
      }
      ringing.set(h.choke, []);
    }
    const source = ctx.createBufferSource();
    source.buffer = h.buffer;
    const g = ctx.createGain();
    g.gain.value = h.gain;
    let out: AudioNode = source.connect(g);
    if (h.cutoff !== undefined) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = h.cutoff;
      out = out.connect(f);
    }
    out.connect(bus);
    source.start(h.at);
    if (h.choke) ringing.get(h.choke)!.push({ gain: g, source, at: h.at });
  }
  const out = await ctx.startRendering();
  normalizeUp(out, EXPORT_PEAK);
  return out;
}

function normalizeUp(buffer: AudioBuffer, peak: number): void {
  let max = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) for (const x of buffer.getChannelData(c)) max = Math.max(max, Math.abs(x));
  if (max <= 0 || max >= peak) return;
  const k = peak / max;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < ch.length; i++) ch[i]! *= k;
  }
}

/** 16-bit PCM WAV. */
export function encodeWav(buffer: AudioBuffer): Uint8Array<ArrayBuffer> {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = frames * channels * 2;
  const out = new DataView(new ArrayBuffer(44 + data));
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  out.setUint32(4, 36 + data, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true); // PCM
  out.setUint16(22, channels, true);
  out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * channels * 2, true);
  out.setUint16(32, channels * 2, true);
  out.setUint16(34, 16, true);
  ascii(36, 'data');
  out.setUint32(40, data, true);
  const chans = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let p = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of chans) {
      const x = Math.max(-1, Math.min(1, ch[i]!));
      out.setInt16(p, Math.round(x < 0 ? x * 0x8000 : x * 0x7fff), true);
      p += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

const AAC_CONFIG = { codec: 'mp4a.40.2', sampleRate: EXPORT_RATE, numberOfChannels: CHANNELS, bitrate: 192_000, aac: { format: 'adts' } } as const;

/** Whether this browser can encode AAC (WebCodecs, ADTS stream). */
async function canEncodeAac(): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    return Boolean((await AudioEncoder.isConfigSupported(AAC_CONFIG)).supported);
  } catch {
    return false;
  }
}

/** AAC-LC as a raw ADTS stream (.aac), via WebCodecs. */
async function encodeAac(buffer: AudioBuffer): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Uint8Array[] = [];
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk) => {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      chunks.push(bytes);
    },
    error: (e) => (failure = e),
  });
  encoder.configure(AAC_CONFIG);
  const block = 4096;
  const chans = Array.from({ length: CHANNELS }, (_, c) => buffer.getChannelData(Math.min(c, buffer.numberOfChannels - 1)));
  for (let start = 0; start < buffer.length; start += block) {
    const n = Math.min(block, buffer.length - start);
    const planar = new Float32Array(n * CHANNELS);
    chans.forEach((ch, c) => planar.set(ch.subarray(start, start + n), c * n));
    const data = new AudioData({ format: 'f32-planar', sampleRate: buffer.sampleRate, numberOfFrames: n, numberOfChannels: CHANNELS, timestamp: (start / buffer.sampleRate) * 1e6, data: planar });
    encoder.encode(data);
    data.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Browser download of a file made in the page. */
function download(bytes: Uint8Array<ArrayBuffer>, fileName: string, mime: string): void {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Saves a render as `<name>.wav` or as AAC: a download in the browser (.aac), Downloads/Pad
 * Games in the Android app (.m4a). Returns what to tell the player.
 */
export async function saveRender(buffer: AudioBuffer, name: string, format: 'wav' | 'aac'): Promise<string> {
  const wav = encodeWav(buffer);
  if (nativeBridge) {
    const where = nativeBridge.api.saveAudio(name, format === 'aac' ? 'm4a' : 'wav', toBase64(wav));
    if (where.startsWith('error')) throw new Error(where.replace(/^error:\s*/, ''));
    return `Saved to ${where}`;
  }
  if (format === 'wav') download(wav, `${name}.wav`, 'audio/wav');
  else if (await canEncodeAac()) download(await encodeAac(buffer), `${name}.aac`, 'audio/aac');
  else throw new Error("this browser can't make AAC, use WAV");
  return `Exported ${name}.${format}`;
}
