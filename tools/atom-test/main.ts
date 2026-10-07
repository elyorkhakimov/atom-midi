import {
  BUTTONS,
  CORNER_PADS,
  ENCODER_CCS,
  NOTE_ON,
  PAD_COUNT,
  PAD_LED_BLUE_CHANNEL,
  PAD_LED_GREEN_CHANNEL,
  PAD_LED_RED_CHANNEL,
  PAD_LED_STATE,
  PAD_LED_STATE_CHANNEL,
  PRESSURE_CC,
  buttonColorMessages,
  buttonLedMessage,
  encoderIndex,
  nativeModeMessage,
  noteToPad,
  padAt,
  padColorMessages,
  padToNote,
  parseAtomMessage,
  isAtomPortName,
  type ButtonDef,
  type MidiBytes,
  type Rgb,
} from '../../src/midi/atomMap';
import { describeMidi, toHex } from '../../src/midi/describe';
import { LedFrameWriter, emptyFrame, scaleRgb } from '../../src/midi/ledFrame';
import { listInputs, listOutputs, portLabel, requestMidi, sendAll } from '../../src/midi/webMidi';
import { $, appendLog, deviceSummary, download, h, pill } from '../shared/dom';
import { TestSynth } from '../shared/testSynth';

const PLAYER_COLORS: Rgb[] = [
  { r: 127, g: 0, b: 0 }, // red
  { r: 0, g: 20, b: 127 }, // blue
  { r: 0, g: 127, b: 0 }, // green
  { r: 127, g: 90, b: 0 }, // yellow
];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let access: MIDIAccess | null = null;
let input: MIDIInput | null = null;
let output: MIDIOutput | null = null;
let nativeActive = false;

const base: Rgb[] = emptyFrame();
const held = new Set<number>();
let pressureMode: 'poly' | 'channel' | 'cc22' | null = null;
const encoderTotals = [0, 0, 0, 0];
const encoderMaxDelta = [0, 0, 0, 0];
const buttonBright = new Map<number, boolean>();
/** Full hex of unrecognised messages → count. */
const unknownSeen = new Map<string, number>();
const portsSeen = new Set<string>();
const buttonRgbWorks = new Map<number, HTMLInputElement>();
let synth: TestSynth | null = null;
const lag = { n: 0, sum: 0, max: 0, zeroOrFuture: 0 };
let actionGen = 0; // cancels running walks/animations

const log = $('#log');
const statusEl = $('#status');
const inSel = $('#inSel') as HTMLSelectElement;
const outSel = $('#outSel') as HTMLSelectElement;
const autoNative = $('#autoNative') as HTMLInputElement;
const hitModeSel = $('#hitMode') as HTMLSelectElement;
const soundBox = $('#sound') as HTMLInputElement;
type HitMode = 'batched' | 'stateFirst' | 'off';
const hitMode = (): HitMode => hitModeSel.value as HitMode;

function send(msg: MidiBytes): void {
  output?.send(msg as number[]);
}

const writer = new LedFrameWriter((batch) => output && sendAll(output, batch));
writer.brightness = 0.35;

function logLine(text: string): void {
  appendLog(log, `${performance.now().toFixed(1).padStart(10)}  ${text}`, 400);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------
function renderStatus(): void {
  statusEl.replaceChildren(
    pill(access ? 'MIDI ready' : 'MIDI not connected', access ? 'ok' : 'warn'),
    pill(output && output.state === 'connected' ? `ATOM: ${output.name}` : 'ATOM not found', output?.state === 'connected' ? 'ok' : 'bad'),
    pill(nativeActive ? 'native mode' : 'factory mode', nativeActive ? 'ok' : 'warn'),
    pill(`pressure: ${pressureMode ?? '?'}`, pressureMode === 'poly' ? 'ok' : pressureMode ? 'warn' : ''),
  );
}

// ---------------------------------------------------------------------------
// Ports, native mode, hot-plug
// ---------------------------------------------------------------------------
function fillPortSelects(): void {
  if (!access) return;
  const fill = (sel: HTMLSelectElement, ports: MIDIPort[], current: MIDIPort | null) => {
    sel.replaceChildren(
      h('option', { value: '', textContent: '—' }),
      ...ports.map((p) => h('option', { value: p.id, textContent: `${portLabel(p)}${p.state === 'connected' ? '' : ' (disconnected)'}` })),
    );
    const pick = current ?? ports.find((p) => p.state === 'connected' && isAtomPortName(p.name)) ?? null;
    sel.value = pick?.id ?? '';
  };
  fill(inSel, listInputs(access), input);
  fill(outSel, listOutputs(access), output);
}

function bindPorts(): void {
  if (!access) return;
  const newIn = access.inputs.get(inSel.value) ?? null;
  const newOut = access.outputs.get(outSel.value) ?? null;
  if (input && input !== newIn) input.onmidimessage = null;
  input = newIn;
  if (input) input.onmidimessage = onMidiMessage;
  for (const p of [newIn, newOut]) if (p) portsSeen.add(`${p.type}: ${portLabel(p)}`);
  const outChanged = newOut !== output;
  output = newOut;
  if (outChanged) nativeActive = false;
  if (output?.state === 'connected' && autoNative.checked && !nativeActive) setNative(true);
  renderStatus();
}

function setNative(on: boolean): void {
  if (!output) return;
  send(nativeModeMessage(on));
  nativeActive = on;
  logLine(`→ ${on ? 'ENTER' : 'EXIT'} native mode  ${toHex(nativeModeMessage(on))}`);
  if (on) {
    // Device LED state is unknown after (re-)entering: resend everything.
    writer.invalidate();
    for (const [cc, bright] of buttonBright) send(buttonLedMessage(cc, bright));
  }
  renderStatus();
}

$('#connect').addEventListener('click', async () => {
  try {
    // Same user gesture unlocks audio for the test sound.
    synth ??= new TestSynth();
    void synth.resume().then(() => logLine(`Audio: ${JSON.stringify(synth!.latencyInfo())}`));
    access = await requestMidi();
    access.onstatechange = (e) => {
      const p = (e as MIDIConnectionEvent).port;
      if (!p) return;
      logLine(`--- ${p.type} "${p.name}" ${p.state}/${p.connection}`);
      if (p.state === 'disconnected' && (p === output || p === input)) {
        if (p === output) {
          output = null;
          nativeActive = false;
        } else {
          input = null;
        }
        fillPortSelects();
        renderStatus();
        return;
      }
      if (p.state === 'connected' && (!input || !output)) {
        // Reconnect: pick the ATOM again and restore native mode + LEDs.
        fillPortSelects();
        bindPorts();
      } else {
        fillPortSelects();
      }
    };
    fillPortSelects();
    bindPorts();
    logLine('MIDI access granted');
  } catch (err) {
    statusEl.replaceChildren(pill(String((err as Error).message ?? err), 'bad'));
  }
});
inSel.addEventListener('change', bindPorts);
outSel.addEventListener('change', bindPorts);
$('#enterNative').addEventListener('click', () => setNative(true));
$('#exitNative').addEventListener('click', () => setNative(false));

window.addEventListener('pagehide', () => {
  if (autoNative.checked && nativeActive) setNative(false);
});
window.addEventListener('pageshow', () => {
  if (autoNative.checked && output && !nativeActive) setNative(true);
});
document.addEventListener('visibilitychange', () => {
  if (!autoNative.checked || !output) return;
  if (document.visibilityState === 'hidden' && nativeActive) setNative(false);
  if (document.visibilityState === 'visible' && !nativeActive) setNative(true);
});

// ---------------------------------------------------------------------------
// Pad grid (screen mirror)
// ---------------------------------------------------------------------------
interface PadView {
  el: HTMLDivElement;
  info: HTMLDivElement;
  pressure: HTMLDivElement;
}
const padViews: PadView[] = [];
const padGrid = $('#padGrid');
for (let row = 3; row >= 0; row--) {
  for (let col = 0; col < 4; col++) {
    const pad = padAt(row, col);
    const info = h('div', { className: 'info', textContent: `n${padToNote(pad)}` });
    const pressure = h('div', { className: 'pressure' });
    const el = h('div', { className: 'pad', title: `Click to light pad ${pad + 1} with the RGB sliders` },
      h('div', { className: 'num', textContent: String(pad + 1) }), info, pressure);
    el.addEventListener('click', () => setBasePad(pad, sliderColor()));
    padViews[pad] = { el, info, pressure };
    padGrid.append(el);
  }
}

function cssColor(c: Rgb): string {
  const k = 255 / 127;
  return `rgb(${Math.round(c.r * k)} ${Math.round(c.g * k)} ${Math.round(c.b * k)})`;
}

function renderPadColor(pad: number, c: Rgb): void {
  const v = padViews[pad];
  if (v) v.el.style.backgroundColor = c.r || c.g || c.b ? cssColor(c) : '';
}

function setBasePad(pad: number, c: Rgb): void {
  base[pad] = { ...c };
  writer.setPad(pad, c);
  renderPadColor(pad, c);
}

function setBaseFrame(colors: Rgb[]): void {
  colors.forEach((c, i) => {
    base[i] = { ...c };
    renderPadColor(i, c);
  });
  writer.setFrame(base);
}

function velocityColor(v: number): Rgb {
  // soft = blue, hard = red/white
  const t = v / 127;
  return { r: 127 * t, g: 127 * Math.max(0, t - 0.6) * 2.5, b: 127 * (1 - t) };
}

function showPressure(pad: number, value: number): void {
  const v = padViews[pad];
  if (v) v.pressure.style.height = `${(value / 127) * 100}%`;
}

// ---------------------------------------------------------------------------
// Encoders
// ---------------------------------------------------------------------------
const knobEls = ENCODER_CCS.map((cc, i) => {
  const val = h('div', { className: 'val', textContent: '0' });
  const meta = h('div', { className: 'mono muted', textContent: `CC ${cc}` });
  $('#knobs').append(h('div', { className: 'knob' }, h('div', { textContent: `Knob ${i + 1}` }), val, meta));
  return { val, meta };
});

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------
const buttonEls = new Map<number, HTMLDivElement>();
for (const b of BUTTONS) {
  const el = h('div', { className: 'btn', title: 'Click to toggle LED' },
    h('div', { className: 'name', textContent: b.label }),
    h('div', { className: 'meta', textContent: `CC ${b.cc} · ${b.side} · LED ${b.led}` }));
  const rgbBox = h('input', { type: 'checkbox', checked: b.led === 'rgb' });
  rgbBox.addEventListener('click', (e) => e.stopPropagation());
  buttonRgbWorks.set(b.cc, rgbBox);
  el.append(h('label', { className: 'rgbcheck' }, rgbBox, 'RGB'));
  el.addEventListener('click', () => setButtonLed(b, !(buttonBright.get(b.cc) ?? false)));
  buttonEls.set(b.cc, el);
  $('#buttons').append(el);
}

function setButtonLed(b: ButtonDef, bright: boolean): void {
  buttonBright.set(b.cc, bright);
  buttonEls.get(b.cc)?.classList.toggle('bright', bright);
  if (!output) return;
  if (b.led === 'rgb') {
    sendAll(output, bright ? buttonColorMessages(b.cc, scaleRgb(sliderColor(), writer.brightness)) : buttonColorMessages(b.cc, { r: 0, g: 0, b: 0 }));
  } else {
    send(buttonLedMessage(b.cc, bright));
  }
}
$('#btnAllBright').addEventListener('click', () => BUTTONS.forEach((b) => setButtonLed(b, true)));
$('#btnAllDim').addEventListener('click', () => BUTTONS.forEach((b) => setButtonLed(b, false)));
// Toggle: every button gets its own random hue, re-rolled every 700 ms at full
// brightness, so RGB buttons visibly change colour and mono ones just stay lit.
let rgbCycleTimer: ReturnType<typeof setInterval> | null = null;
const btnRgbAll = $('#btnRgbAll') as HTMLButtonElement;

function cycleButtonColors(): void {
  if (!output) return;
  for (const b of BUTTONS) {
    const c = hsv(Math.random() * 360);
    sendAll(output, buttonColorMessages(b.cc, c));
    const tile = buttonEls.get(b.cc);
    if (tile) tile.style.borderColor = cssColor(c);
  }
}

function stopButtonColorCycle(): void {
  if (rgbCycleTimer) clearInterval(rgbCycleTimer);
  rgbCycleTimer = null;
  btnRgbAll.textContent = 'Try RGB: cycle random colours on every button';
  for (const b of BUTTONS) {
    if (output) sendAll(output, buttonColorMessages(b.cc, { r: 0, g: 0, b: 0 }));
    const tile = buttonEls.get(b.cc);
    if (tile) tile.style.borderColor = '';
    if (buttonBright.get(b.cc)) setButtonLed(b, true);
  }
}

btnRgbAll.addEventListener('click', () => {
  if (rgbCycleTimer) {
    stopButtonColorCycle();
    return;
  }
  if (!output) return;
  cycleButtonColors();
  rgbCycleTimer = setInterval(cycleButtonColors, 700);
  btnRgbAll.textContent = 'Stop RGB cycle';
  logLine('→ cycling random RGB on every button (CC on ch 2/3/4); tick RGB on the ones that change colour');
});

// ---------------------------------------------------------------------------
// LED tests
// ---------------------------------------------------------------------------
const rIn = $('#r') as HTMLInputElement;
const gIn = $('#g') as HTMLInputElement;
const bIn = $('#b') as HTMLInputElement;
const rgbPad = $('#rgbPad') as HTMLSelectElement;
rgbPad.append(h('option', { value: 'all', textContent: 'All' }),
  ...Array.from({ length: PAD_COUNT }, (_, i) => h('option', { value: String(i), textContent: String(i + 1) })));

function sliderColor(): Rgb {
  return { r: Number(rIn.value), g: Number(gIn.value), b: Number(bIn.value) };
}
function updateSwatch(): void {
  $('#swatch').style.backgroundColor = cssColor(sliderColor());
}
[rIn, gIn, bIn].forEach((el) => el.addEventListener('input', updateSwatch));
updateSwatch();

function stopActions(): void {
  actionGen++;
  ($('#animFps') as HTMLSelectElement).value = '0';
}

document.querySelectorAll<HTMLButtonElement>('[data-fill]').forEach((btn) =>
  btn.addEventListener('click', () => {
    stopActions();
    const [r = 0, g = 0, b = 0] = btn.dataset.fill!.split(',').map(Number);
    setBaseFrame(Array.from({ length: PAD_COUNT }, () => ({ r, g, b })));
  }),
);

$('#applyRgb').addEventListener('click', () => {
  stopActions();
  const c = sliderColor();
  if (rgbPad.value === 'all') setBaseFrame(Array.from({ length: PAD_COUNT }, () => c));
  else setBasePad(Number(rgbPad.value), c);
});

$('#players').addEventListener('click', () => {
  stopActions();
  const frame = emptyFrame();
  CORNER_PADS.forEach((pad, i) => (frame[pad] = PLAYER_COLORS[i]!));
  setBaseFrame(frame);
});

$('#walk').addEventListener('click', async () => {
  stopActions();
  const gen = actionGen;
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    if (gen !== actionGen) return;
    const frame = emptyFrame();
    frame[pad] = { r: 127, g: 127, b: 127 };
    setBaseFrame(frame);
    await new Promise((r) => setTimeout(r, 400));
  }
  if (gen === actionGen) setBaseFrame(emptyFrame());
});

const brightIn = $('#bright') as HTMLInputElement;
brightIn.addEventListener('input', () => {
  writer.brightness = Number(brightIn.value) / 100;
  $('#brightVal').textContent = `${brightIn.value}%`;
  writer.setFrame(base);
});

($('#diffMode') as HTMLSelectElement).addEventListener('change', (e) => {
  writer.mode = (e.target as HTMLSelectElement).value as 'full' | 'minimal';
});

document.querySelectorAll<HTMLButtonElement>('[data-state]').forEach((btn) =>
  btn.addEventListener('click', () => {
    if (!output) return;
    stopActions();
    const state = Number(btn.dataset.state);
    const c = scaleRgb(sliderColor(), writer.brightness);
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      sendAll(output, padColorMessages(pad, c, state));
      base[pad] = sliderColor();
      renderPadColor(pad, state ? base[pad]! : { r: 0, g: 0, b: 0 });
    }
    // Raw sends bypass the writer: sync its target without flushing, and make the
    // next real change resend everything.
    writer.setFrame(base, false);
    writer.invalidate(false);
    logLine(`→ state ${state} on all pads (ch1 note-on vel ${state}) with RGB ${c.r.toFixed(0)},${c.g.toFixed(0)},${c.b.toFixed(0)}`);
  }),
);

($('#animFps') as HTMLSelectElement).addEventListener('change', (e) => {
  const fps = Number((e.target as HTMLSelectElement).value);
  actionGen++;
  const gen = actionGen;
  if (!fps) {
    writer.setFrame(base);
    return;
  }
  const t0 = performance.now();
  const timer = setInterval(() => {
    if (gen !== actionGen) {
      clearInterval(timer);
      return;
    }
    const t = (performance.now() - t0) / 1000;
    const frame = Array.from({ length: PAD_COUNT }, (_, pad) => hsv(((t * 0.25 + pad / PAD_COUNT) % 1) * 360));
    writer.setFrame(frame);
  }, 1000 / fps);
});

function hsv(hDeg: number): Rgb {
  const f = (n: number) => {
    const k = (n + hDeg / 60) % 6;
    return 127 * (1 - Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return { r: f(5), g: f(3), b: f(1) };
}

let lastCount = 0;
setInterval(() => {
  $('#rate').textContent = `${writer.messageCount - lastCount} msgs/s (${(writer.messageCount - lastCount) * 3} bytes/s)`;
  lastCount = writer.messageCount;
}, 1000);

// ---------------------------------------------------------------------------
// Incoming MIDI
// ---------------------------------------------------------------------------
function onMidiMessage(e: MIDIMessageEvent): void {
  const data = e.data;
  if (!data) return;
  const t = e.timeStamp;
  const msg = parseAtomMessage(data);

  // LED feedback first, before any other work.
  const mode = hitMode();
  const preloaded = mode === 'stateFirst' && 'pad' in msg && isDark(base[msg.pad]!);
  if (msg.kind === 'padDown' && preloaded && output) {
    // Bypasses the writer, which keeps believing this pad is dark (its base colour).
    send([NOTE_ON | PAD_LED_STATE_CHANNEL, padToNote(msg.pad), PAD_LED_STATE.solid]);
    sendAll(output, padColorMessages(msg.pad, scaleRgb(velocityColor(msg.velocity), writer.brightness)));
  } else if (msg.kind === 'padUp' && preloaded) {
    preloadPad(msg.pad);
  } else if (msg.kind === 'padDown' && mode !== 'off') {
    writer.setPad(msg.pad, velocityColor(msg.velocity));
    writer.flushNow();
  } else if (msg.kind === 'padUp' && mode !== 'off') {
    writer.setPad(msg.pad, base[msg.pad]!);
  }
  if (msg.kind === 'padDown' && soundBox.checked) synth?.hit(msg.pad, msg.velocity);

  const lagMs = performance.now() - t;
  if (t <= 0 || lagMs < 0) lag.zeroOrFuture++;
  else {
    lag.n++;
    lag.sum += lagMs;
    lag.max = Math.max(lag.max, lagMs);
  }

  if (wizard.handle(data)) {
    /* consumed by the wizard, but still shown below */
  }

  switch (msg.kind) {
    case 'padDown': {
      held.add(msg.pad);
      const v = padViews[msg.pad]!;
      v.el.classList.add('hit');
      v.info.textContent = `n${padToNote(msg.pad)} v${msg.velocity}`;
      break;
    }
    case 'padUp':
      held.delete(msg.pad);
      padViews[msg.pad]!.el.classList.remove('hit');
      showPressure(msg.pad, 0);
      break;
    case 'padPressure':
      setPressureMode('poly');
      showPressure(msg.pad, msg.value);
      break;
    case 'channelPressure':
      setPressureMode('channel');
      held.forEach((p) => showPressure(p, msg.value));
      break;
    case 'ccPressure':
      setPressureMode('cc22');
      held.forEach((p) => showPressure(p, msg.value));
      break;
    case 'button':
      buttonEls.get(msg.button.cc)?.classList.toggle('down', msg.down);
      break;
    case 'encoder': {
      encoderTotals[msg.index]! += msg.delta;
      encoderMaxDelta[msg.index] = Math.max(encoderMaxDelta[msg.index]!, Math.abs(msg.delta));
      const k = knobEls[msg.index]!;
      k.val.textContent = String(encoderTotals[msg.index]);
      k.meta.textContent = `CC ${ENCODER_CCS[msg.index]} · raw ${data[2]} · max |Δ| ${encoderMaxDelta[msg.index]}`;
      break;
    }
    case 'unknown': {
      const key = toHex(data);
      unknownSeen.set(key, (unknownSeen.get(key) ?? 0) + 1);
      break;
    }
  }

  const isPressure = msg.kind === 'padPressure' || msg.kind === 'channelPressure' || msg.kind === 'ccPressure';
  if (!isPressure) {
    logLine(`← t=${t.toFixed(1)} lag ${lagMs.toFixed(1)}  ${toHex(data).padEnd(9)} ${describeMidi(data).padEnd(42)} ${msg.kind}`);
  }
}

function setPressureMode(mode: 'poly' | 'channel' | 'cc22'): void {
  if (pressureMode === mode) return;
  pressureMode = mode;
  $('#pressureMode').textContent =
    mode === 'poly'
      ? 'Pressure mode: polyphonic aftertouch ✓'
      : `Pressure mode: ${mode === 'channel' ? 'channel aftertouch (one value for all pads)' : 'CC 22'} — for per-pad pressure: ` +
        'Exit native mode, hold Setup, tap pad 7, release Setup, then Enter native mode again';
  renderStatus();
}

// ---------------------------------------------------------------------------
// Guided mapping wizard
// ---------------------------------------------------------------------------
type Step =
  | { kind: 'pad'; pad: number }
  | { kind: 'button'; button: ButtonDef }
  | { kind: 'encoder'; index: number }
  | { kind: 'pressure' };

interface StepResult {
  step: string;
  expected: string;
  actual: string;
  result: 'pass' | 'fail' | 'skip';
}

const wizPrompt = $('#wizPrompt');
const wizTable = $('#wizTable') as HTMLTableElement;
const wizSkip = $('#wizSkip') as HTMLButtonElement;
const wizBack = $('#wizBack') as HTMLButtonElement;

/**
 * After a step is recorded, further messages from the same control (same status byte
 * and note/CC) are ignored until it has been quiet this long. A knob spin sends a
 * burst of CCs, and a pad can double-trigger; neither should answer the next step.
 */
const WIZ_REPEAT_QUIET_MS = 500;

function stepName(s: Step): string {
  switch (s.kind) {
    case 'pad': {
      const row = Math.floor(s.pad / 4) + 1;
      const col = (s.pad % 4) + 1;
      return `Pad ${s.pad + 1} (row ${row} from bottom, col ${col})`;
    }
    case 'button': return `Button ${s.button.label} (${s.button.side} column)`;
    case 'encoder': return `Knob ${s.index + 1} clockwise`;
    case 'pressure': return 'Pressure: press and hold any pad firmly';
  }
}

function stepExpected(s: Step): string {
  switch (s.kind) {
    case 'pad': return `Note On ch1 note ${padToNote(s.pad)}`;
    case 'button': return `CC ${s.button.cc} ch1 = 127`;
    case 'encoder': return `CC ${ENCODER_CCS[s.index]} value 1–63`;
    case 'pressure': return 'Poly AT (0xA0)';
  }
}

const wizard = {
  steps: [] as Step[],
  index: -1,
  results: [] as StepResult[],
  lastKey: -1,
  ignoreUntil: 0,

  get active(): boolean {
    return this.index >= 0 && this.index < this.steps.length;
  },

  start(): void {
    stopActions();
    this.steps = [
      ...Array.from({ length: PAD_COUNT }, (_, pad): Step => ({ kind: 'pad', pad })),
      ...BUTTONS.map((button): Step => ({ kind: 'button', button })),
      ...ENCODER_CCS.map((_, index): Step => ({ kind: 'encoder', index })),
      { kind: 'pressure' },
    ];
    this.results = [];
    this.index = 0;
    this.lastKey = -1;
    this.show();
  },

  show(): void {
    document.querySelectorAll('.wiz').forEach((el) => el.classList.remove('wiz'));
    setBaseFrame(emptyFrame());
    wizSkip.disabled = !this.active;
    wizBack.disabled = this.results.length === 0;
    if (!this.active) {
      wizPrompt.textContent = this.results.length ? 'Done ✓ — see table, then export the report below.' : '';
      return;
    }
    const s = this.steps[this.index]!;
    wizPrompt.textContent = `${this.index + 1}/${this.steps.length}: ${stepName(s)}`;
    if (s.kind === 'pad') {
      setBasePad(s.pad, { r: 0, g: 127, b: 0 });
      padViews[s.pad]?.el.classList.add('wiz');
    } else if (s.kind === 'button') {
      buttonEls.get(s.button.cc)?.classList.add('wiz');
    }
  },

  record(actual: string, pass: boolean): void {
    const s = this.steps[this.index]!;
    this.results.push({ step: stepName(s), expected: stepExpected(s), actual, result: pass ? 'pass' : 'fail' });
    this.index++;
    this.renderTable();
    this.show();
  },

  /** Undo the last recorded step so it can be redone. */
  back(): void {
    if (this.results.length === 0) return;
    this.results.pop();
    this.index = this.results.length;
    this.lastKey = -1;
    this.renderTable();
    this.show();
  },

  skip(): void {
    if (!this.active) return;
    const s = this.steps[this.index]!;
    this.results.push({ step: stepName(s), expected: stepExpected(s), actual: '—', result: 'skip' });
    this.index++;
    this.renderTable();
    this.show();
  },

  /** Returns true if the message completed the current step. Works on raw bytes. */
  handle(data: Uint8Array): boolean {
    if (!this.active) return false;
    const s = this.steps[this.index]!;
    const type = (data[0] ?? 0) & 0xf0;
    const ch = ((data[0] ?? 0) & 0x0f) + 1;
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;
    const desc = `${describeMidi(data)} [${toHex(data)}]`;
    const isNoteOn = type === NOTE_ON && d2 > 0;
    const isCcPress = type === 0xb0 && d2 > 0 && encoderIndex(d1) === null && d1 !== PRESSURE_CC;

    // Unexplained BF 7F (CC 127, ch 16) from the device: never an answer to a step.
    if (data[0] === 0xbf && d1 === 0x7f) return false;

    const now = performance.now();
    const key = ((data[0] ?? 0) << 8) | d1;
    if (key === this.lastKey && now < this.ignoreUntil) {
      this.ignoreUntil = now + WIZ_REPEAT_QUIET_MS;
      return false;
    }
    const consumed = this.match(s, desc, { type, ch, d1, d2, isNoteOn, isCcPress });
    if (consumed) {
      this.lastKey = key;
      this.ignoreUntil = now + WIZ_REPEAT_QUIET_MS;
    }
    return consumed;
  },

  match(
    s: Step,
    desc: string,
    { type, ch, d1, d2, isNoteOn, isCcPress }: { type: number; ch: number; d1: number; d2: number; isNoteOn: boolean; isCcPress: boolean },
  ): boolean {
    switch (s.kind) {
      case 'pad':
        if (!isNoteOn) return false;
        this.record(desc, ch === PAD_LED_STATE_CHANNEL + 1 && noteToPad(d1) === s.pad);
        return true;
      case 'button':
        if (!(isCcPress || (isNoteOn && noteToPad(d1) === null))) return false;
        this.record(desc, type === 0xb0 && ch === 1 && d1 === s.button.cc && d2 === 127);
        return true;
      case 'encoder':
        if (!(type === 0xb0 && d1 !== PRESSURE_CC && !BUTTONS.some((b) => b.cc === d1))) return false;
        this.record(desc, d1 === ENCODER_CCS[s.index] && d2 >= 1 && d2 <= 63);
        return true;
      case 'pressure':
        if (type === 0xa0) this.record(desc, true);
        else if (type === 0xd0 || (type === 0xb0 && d1 === PRESSURE_CC)) this.record(`${desc} — not per-pad; set Setup + pad 7`, false);
        else return false;
        return true;
    }
  },

  renderTable(): void {
    wizTable.replaceChildren(
      h('tr', {}, ...['Step', 'Expected', 'Received', ''].map((t) => h('th', { textContent: t }))),
      ...this.results.map((r) =>
        h('tr', {},
          h('td', { textContent: r.step }),
          h('td', { className: 'mono', textContent: r.expected }),
          h('td', { className: 'mono', textContent: r.actual }),
          h('td', { className: r.result, textContent: r.result.toUpperCase() })),
      ),
    );
  },
};

$('#wizStart').addEventListener('click', () => wizard.start());
wizSkip.addEventListener('click', () => wizard.skip());
wizBack.addEventListener('click', () => wizard.back());

// ---------------------------------------------------------------------------
// Manual checks and report
// ---------------------------------------------------------------------------
const CHECKS = [
  ['native', 'Enter native mode: pads go dark / under app control'],
  ['fill', 'All red / green / blue / white light all 16 pads in the right colour'],
  ['walk', 'Walk lights pads 1→16 from bottom-left, left to right, row by row up to top-right'],
  ['rgb', 'Custom RGB colours look right; brightness cap visibly dims'],
  ['state1', 'State 1 makes pads blink in hardware'],
  ['state2', 'State 2 makes pads breathe in hardware'],
  ['state64', 'State 64 turns pads off (only 127 lights)'],
  ['minimal', 'Minimal diff mode: colour changes on lit pads still apply correctly'],
  ['anim30', 'Rainbow 30 fps runs smoothly; pad hits still respond instantly'],
  ['anim60', 'Rainbow 60 fps runs smoothly; pad hits still respond instantly'],
  ['hit', 'LED hit feedback feels instant'],
  ['btnLed', 'All button LEDs toggle bright/dim (note exceptions)'],
  ['btnRgb', 'Preset, Bank, Play show RGB colours; other buttons ignore RGB'],
  ['hide', 'Switching tab/app away returns the ATOM to factory mode'],
  ['show', 'Returning re-enters native mode and restores pad colours'],
  ['replug', 'Unplug/replug: status updates, native mode + LEDs restored'],
  ['poly', 'Per-pad pressure works for several pads held at once'],
] as const;

const checkBoxes = new Map<string, HTMLInputElement>();
for (const [id, text] of CHECKS) {
  const box = h('input', { type: 'checkbox' });
  checkBoxes.set(id, box);
  $('#checks').append(h('label', {}, box, h('span', { textContent: text })));
}
const notes = h('textarea', { rows: 3, placeholder: 'Notes (exceptions, oddities, port names…)' });
notes.style.cssText = 'width:100%;font:inherit;background:#0b0d10;color:inherit;border:1px solid var(--line);border-radius:7px;padding:6px';
$('#checks').append(notes);

function report(): object {
  return {
    date: new Date().toISOString(),
    device: ($('#deviceName') as HTMLInputElement).value,
    userAgent: deviceSummary(),
    ports: { current: { input: input?.name ?? null, output: output?.name ?? null }, seen: [...portsSeen] },
    audio: synth?.latencyInfo() ?? null,
    settings: { hitMode: hitMode(), brightness: writer.brightness, diffMode: writer.mode },
    buttonsWithRgb: BUTTONS.filter((b) => buttonRgbWorks.get(b.cc)?.checked).map((b) => `${b.label} (CC ${b.cc})`),
    pressureMode,
    handlerLagMs: { mean: lag.n ? +(lag.sum / lag.n).toFixed(2) : null, max: +lag.max.toFixed(2), samples: lag.n, zeroOrFutureTimestamps: lag.zeroOrFuture },
    encoderMaxDelta,
    unknownMessages: Object.fromEntries(unknownSeen),
    mapping: wizard.results,
    checks: Object.fromEntries([...checkBoxes].map(([id, box]) => [id, box.checked])),
    notes: notes.value,
  };
}

$('#export').addEventListener('click', () => {
  const name = (($('#deviceName') as HTMLInputElement).value || 'device').replace(/[^\w-]+/g, '_');
  download(`atom-report-${name}.json`, JSON.stringify(report(), null, 2));
});
$('#copy').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(report(), null, 2));
  logLine('Report copied to clipboard');
});

// state-first hit mode: RGB for a white hit is preloaded on dark pads with no state
// message, so a hit only needs the 1-message "state on". Whether RGB on an unlit pad
// stays dark is itself something to check on the hardware.
function isDark(c: Rgb): boolean {
  return !(c.r || c.g || c.b);
}

/** Puts white RGB on a dark pad and switches its state off. The writer isn't told. */
function preloadPad(pad: number): void {
  if (!isDark(base[pad]!) || !output) return;
  const v = Math.round(127 * writer.brightness);
  const note = padToNote(pad);
  sendAll(output, [
    [NOTE_ON | PAD_LED_RED_CHANNEL, note, v],
    [NOTE_ON | PAD_LED_GREEN_CHANNEL, note, v],
    [NOTE_ON | PAD_LED_BLUE_CHANNEL, note, v],
    [NOTE_ON | PAD_LED_STATE_CHANNEL, note, PAD_LED_STATE.off],
  ]);
}

hitModeSel.addEventListener('change', () => {
  writer.flushNow();
  if (hitMode() === 'stateFirst') {
    for (let pad = 0; pad < PAD_COUNT; pad++) preloadPad(pad);
    logLine('state-first: preloaded white RGB on dark pads (they should stay dark)');
  } else {
    writer.invalidate(); // clear preloads
  }
});

renderStatus();
