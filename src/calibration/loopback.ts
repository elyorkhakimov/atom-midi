import { median } from './stats';

/**
 * Acoustic loopback: the device plays a short chirp and records it with its own
 * microphone. The delay between the frame a probe was scheduled at and the frame
 * it shows up in the recording is the round trip (output + input latency), on
 * the audio clock, independent of what the browser reports.
 */

/** Hann-windowed linear sweep from f0 to f1 Hz. Sharp autocorrelation peak, robust to room noise. */
export function makeChirp(sampleRate: number, durationS = 0.012, f0 = 1500, f1 = 6000, amplitude = 0.9): Float32Array<ArrayBuffer> {
  const n = Math.round(durationS * sampleRate);
  const out = new Float32Array(n);
  const k = (f1 - f0) / durationS;
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    out[i] = amplitude * w * Math.sin(2 * Math.PI * (f0 * t + (k / 2) * t * t));
  }
  return out;
}

export interface LagMatch {
  /** Samples after `from` where the probe starts. */
  lag: number;
  /** Normalized cross-correlation at the peak, 0–1. */
  score: number;
}

/**
 * Find `ref` in `rec` starting between `from` and `from + maxLag`. Normalized so
 * a quiet mic still scores well; null if the window runs past the recording.
 */
export function findLag(rec: Float32Array, ref: Float32Array, from: number, maxLag: number): LagMatch | null {
  const n = ref.length;
  const start = Math.max(0, from);
  const last = Math.min(start + maxLag, rec.length - n);
  if (last < start) return null;
  let refEnergy = 0;
  for (let i = 0; i < n; i++) refEnergy += ref[i]! * ref[i]!;
  // Running energy of the n-sample window under the reference.
  let winEnergy = 0;
  for (let i = 0; i < n; i++) winEnergy += rec[start + i]! * rec[start + i]!;
  let best: LagMatch = { lag: 0, score: 0 };
  for (let p = start; p <= last; p++) {
    if (p > start) {
      const out = rec[p - 1]!;
      const inn = rec[p + n - 1]!;
      winEnergy += inn * inn - out * out;
    }
    if (winEnergy <= 1e-12) continue;
    let dot = 0;
    for (let i = 0; i < n; i++) dot += rec[p + i]! * ref[i]!;
    const score = dot / Math.sqrt(refEnergy * winEnergy);
    if (score > best.score) best = { lag: p - start, score };
  }
  return best;
}

/** Probes scoring below this are treated as not heard. */
export const MIN_MATCH_SCORE = 0.25;

export interface LoopbackSummary {
  /** Median round trip of the probes that were heard, ms. */
  roundTripMs: number;
  minMs: number;
  maxMs: number;
  heard: number;
  sent: number;
}

export function summarizeLoopback(matches: readonly (LagMatch | null)[], sampleRate: number): LoopbackSummary | null {
  const ms = matches.filter((m): m is LagMatch => m !== null && m.score >= MIN_MATCH_SCORE).map((m) => (m.lag / sampleRate) * 1000);
  if (ms.length < 3) return null;
  return { roundTripMs: median(ms), minMs: Math.min(...ms), maxMs: Math.max(...ms), heard: ms.length, sent: matches.length };
}
