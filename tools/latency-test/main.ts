import { findLag, makeChirp, summarizeLoopback, type LagMatch, type LoopbackSummary } from '../../src/calibration/loopback';
import { splitMidiMessages } from '../../src/midi/split';
import { listInputs, requestMidi } from '../../src/midi/webMidi';
import { $, deviceSummary, download, h, pill } from '../shared/dom';

type Hint = AudioContextLatencyCategory | number;

interface HintResult {
  hint: string;
  sampleRate: number;
  baseLatencyMs: number | null;
  outputLatencyMs: number | null;
  /** Mic latency as reported by the track settings, if any. */
  inputLatencyMs: number | null;
  loopback: LoopbackSummary | null;
  /** Round trip minus reported input latency. */
  outputEstimateMs: number | null;
  probes: { lagMs: number; score: number }[];
}

const PROBES = 10;
const LEAD_IN_S = 0.6;
const MIN_GAP_S = 0.45;
/** Larger than any plausible round trip, smaller than the gap between probes. */
const MAX_LAG_S = 0.4;

const statusEl = $('#status');
const progress = $('#progress');
const table = $('#results') as HTMLTableElement;
const runBtn = $('#run') as HTMLButtonElement;
const exportBtn = $('#export') as HTMLButtonElement;

const results: HintResult[] = [];
let mic: MediaStream | null = null;

const WORKLET = `
class LoopbackRecorder extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; this.start = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.n === 0) this.start = currentFrame;
    this.buf.set(ch, this.n);
    this.n += ch.length;
    if (this.n > this.buf.length - 128) {
      this.port.postMessage({ start: this.start, data: this.buf.slice(0, this.n) });
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('loopback-recorder', LoopbackRecorder);
`;
const workletUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));

const ms = (s: number | undefined) => (typeof s === 'number' ? +(s * 1000).toFixed(1) : null);
const fmt = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);
const parseHint = (v: string): Hint => (v === 'interactive' || v === 'balanced' || v === 'playback' ? v : Number(v));
const wait = (msDelay: number) => new Promise((r) => setTimeout(r, msDelay));

async function getMic(): Promise<MediaStream> {
  if (mic?.active) return mic;
  // Processing off: echo cancellation would remove the very chirp we're listening for,
  // and on Android it can also switch the phone into a slower "call" audio mode.
  mic = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });
  return mic;
}

async function measure(hint: Hint, stream: MediaStream): Promise<HintResult> {
  const ctx = new AudioContext({ latencyHint: hint });
  try {
    await ctx.resume();
    await ctx.audioWorklet.addModule(workletUrl);
    const sr = ctx.sampleRate;
    const src = ctx.createMediaStreamSource(stream);
    const rec = new AudioWorkletNode(ctx, 'loopback-recorder', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    const sink = ctx.createGain();
    sink.gain.value = 0; // keeps the recorder pulled without playing the mic back
    src.connect(rec).connect(sink).connect(ctx.destination);
    await wait(400); // let the mic start and outputLatency settle

    const chirp = makeChirp(sr);
    const buffer = ctx.createBuffer(1, chirp.length, sr);
    buffer.copyToChannel(chirp, 0);

    const t0 = ctx.currentTime;
    const origin = Math.round(t0 * sr);
    const probeTimes: number[] = [];
    let t = t0 + LEAD_IN_S;
    for (let i = 0; i < PROBES; i++) {
      probeTimes.push(t);
      const node = ctx.createBufferSource();
      node.buffer = buffer;
      node.connect(ctx.destination);
      node.start(t);
      t += MIN_GAP_S + Math.random() * 0.15; // irregular, so an echo can't line up with the next probe
    }
    const end = probeTimes.at(-1)! + MAX_LAG_S + 0.2;
    const recording = new Float32Array(Math.ceil((end - t0) * sr) + sr);
    rec.port.onmessage = (e: MessageEvent<{ start: number; data: Float32Array }>) => {
      const at = e.data.start - origin;
      if (at < 0 || at >= recording.length) return;
      recording.set(e.data.data.subarray(0, recording.length - at), at);
    };

    while (ctx.currentTime < end + 0.15) {
      progress.textContent = `${hintLabel(hint)}: listening… ${Math.max(0, Math.ceil(end - ctx.currentTime))} s`;
      await wait(150);
    }
    rec.port.onmessage = null;

    const matches: (LagMatch | null)[] = probeTimes.map((pt) => findLag(recording, chirp, Math.round(pt * sr) - origin, Math.round(MAX_LAG_S * sr)));
    const loopback = summarizeLoopback(matches, sr);
    const track = stream.getAudioTracks()[0];
    const inputLatencyMs = ms((track?.getSettings() as MediaTrackSettings & { latency?: number }).latency);
    return {
      hint: hintLabel(hint),
      sampleRate: sr,
      baseLatencyMs: ms(ctx.baseLatency),
      outputLatencyMs: ms(ctx.outputLatency),
      inputLatencyMs,
      loopback,
      outputEstimateMs: loopback && inputLatencyMs !== null ? loopback.roundTripMs - inputLatencyMs : null,
      probes: matches.map((m) => ({ lagMs: m ? +((m.lag / sr) * 1000).toFixed(2) : NaN, score: m ? +m.score.toFixed(3) : 0 })),
    };
  } finally {
    await ctx.close();
  }
}

function hintLabel(hint: Hint): string {
  return typeof hint === 'number' ? `${hint}` : hint;
}

function render(): void {
  table.replaceChildren(
    h(
      'tr',
      {},
      ...['Setting', 'Rate', 'Reported output', 'Round trip (measured)', 'Range', 'Heard', 'Mic (reported)', 'Output ≈'].map((t) => h('th', { textContent: t })),
    ),
    ...results.map((r) => {
      const reported = r.baseLatencyMs !== null || r.outputLatencyMs !== null ? (r.baseLatencyMs ?? 0) + (r.outputLatencyMs ?? 0) : null;
      const lb = r.loopback;
      return h(
        'tr',
        {},
        h('td', { textContent: r.hint }),
        h('td', { textContent: `${r.sampleRate / 1000} kHz` }),
        h('td', { textContent: `${fmt(reported)} (base ${fmt(r.baseLatencyMs)} + out ${fmt(r.outputLatencyMs)})` }),
        h('td', {}, lb ? h('b', { textContent: fmt(lb.roundTripMs) }) : pill('not heard', 'bad')),
        h('td', { textContent: lb ? `${Math.round(lb.minMs)}–${Math.round(lb.maxMs)} ms` : '—' }),
        h('td', {}, pill(`${lb?.heard ?? 0}/${r.probes.length}`, !lb ? 'bad' : lb.heard < r.probes.length ? 'warn' : 'ok')),
        h('td', { textContent: fmt(r.inputLatencyMs) }),
        h('td', { textContent: fmt(r.outputEstimateMs) }),
      );
    }),
  );
  $('#explain').hidden = results.length === 0;
}

runBtn.addEventListener('click', async () => {
  const hints = [...document.querySelectorAll<HTMLInputElement>('input[name=hint]:checked')].map((el) => parseHint(el.value));
  if (!hints.length) return;
  runBtn.disabled = true;
  statusEl.replaceChildren();
  try {
    await stopFeel();
    progress.textContent = 'Waiting for microphone permission…';
    const stream = await getMic();
    for (const hint of hints) {
      const r = await measure(hint, stream);
      results.push(r);
      render();
      await wait(300);
    }
    progress.textContent = 'Done.';
    exportBtn.disabled = false;
  } catch (err) {
    statusEl.replaceChildren(pill(err instanceof Error ? err.message : String(err), 'bad'));
    progress.textContent = '';
  } finally {
    runBtn.disabled = false;
  }
});

exportBtn.addEventListener('click', () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  download(`latency-report-${stamp}.json`, JSON.stringify({ date: new Date().toISOString(), userAgent: deviceSummary(), results }, null, 2));
});

// ---------------------------------------------------------------------------
// Feel test: pad hit → click through the chosen setting.
// ---------------------------------------------------------------------------
const feelBtn = $('#feel') as HTMLButtonElement;
const feelHint = $('#feelHint') as HTMLSelectElement;
const feelInfo = $('#feelInfo');
let feelCtx: AudioContext | null = null;
let clickBuf: AudioBuffer | null = null;
let midiHooked = false;

function click(velocity = 100): void {
  if (!feelCtx || !clickBuf) return;
  const src = feelCtx.createBufferSource();
  src.buffer = clickBuf;
  const g = feelCtx.createGain();
  g.gain.value = (velocity / 127) ** 2;
  src.connect(g).connect(feelCtx.destination);
  src.start();
}

async function stopFeel(): Promise<void> {
  const ctx = feelCtx;
  feelCtx = null;
  feelBtn.textContent = 'Start feel test';
  feelInfo.textContent = '';
  await ctx?.close();
}

async function startFeel(): Promise<void> {
  await stopFeel();
  const ctx = new AudioContext({ latencyHint: parseHint(feelHint.value) });
  await ctx.resume();
  // Woodblock-ish: a fast-decaying 1.8 kHz tone with a noise transient.
  const n = Math.round(ctx.sampleRate * 0.06);
  clickBuf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = clickBuf.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / ctx.sampleRate;
    d[i] = 0.8 * Math.exp(-t * 90) * (Math.sin(2 * Math.PI * 1800 * t) + (i < 48 ? Math.random() - 0.5 : 0));
  }
  feelCtx = ctx;
  feelBtn.textContent = 'Stop feel test';
  await wait(300);
  if (feelCtx === ctx) feelInfo.textContent = `reported output ${fmt(((ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0)) * 1000)} · ${ctx.sampleRate / 1000} kHz`;

  if (!midiHooked) {
    try {
      const access = await requestMidi();
      const hook = () => {
        for (const input of listInputs(access)) {
          input.onmidimessage = (e) => {
            if (!e.data) return;
            for (const m of splitMidiMessages(e.data)) if ((m[0]! & 0xf0) === 0x90 && m[2]! > 0) click(m[2]);
          };
        }
      };
      hook();
      access.onstatechange = hook;
      midiHooked = true;
    } catch (err) {
      statusEl.replaceChildren(pill(`MIDI: ${err instanceof Error ? err.message : String(err)} — keyboard still works`, 'warn'));
    }
  }
}

feelBtn.addEventListener('click', () => void (feelCtx ? stopFeel() : startFeel()));
feelHint.addEventListener('change', () => void (feelCtx && startFeel()));
window.addEventListener('keydown', (e) => {
  if (!e.repeat && 'asdfghjk'.includes(e.key)) click();
});
