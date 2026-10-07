import { isAtomPortName, nativeModeMessage, parseAtomMessage, type AtomMessage } from '../../src/midi/atomMap';
import { describeMidi, toHex } from '../../src/midi/describe';
import { listInputs, listOutputs, requestMidi } from '../../src/midi/webMidi';
import { $, appendLog, deviceSummary, download, h, pill } from '../shared/dom';

interface LoggedEvent {
  t: number;
  lag: number;
  port: string;
  bytes: number[];
}

const log = $('#log');
const statusEl = $('#status');
const statsEl = $('#stats');
const portsTable = $('#ports') as HTMLTableElement;
const nativeBox = $('#native') as HTMLInputElement;
const hidePressure = $('#hidePressure') as HTMLInputElement;
const hideRealtime = $('#hideRealtime') as HTMLInputElement;

let access: MIDIAccess | null = null;
let paused = false;
const events: LoggedEvent[] = [];
let lastT = 0;
const lagStats = { n: 0, sum: 0, max: 0, zeroOrFuture: 0 };

function atomSummary(m: AtomMessage): string {
  switch (m.kind) {
    case 'padDown': return `ATOM pad ${m.pad + 1} down vel ${m.velocity}`;
    case 'padUp': return `ATOM pad ${m.pad + 1} up`;
    case 'padPressure': return `ATOM pad ${m.pad + 1} pressure ${m.value}`;
    case 'channelPressure': return `ATOM channel pressure ${m.value}`;
    case 'ccPressure': return `ATOM CC22 pressure ${m.value}`;
    case 'button': return `ATOM ${m.button.label} ${m.down ? 'down' : 'up'}`;
    case 'encoder': return `ATOM knob ${m.index + 1} ${m.delta > 0 ? '+' : ''}${m.delta}`;
    case 'unknown': return '';
  }
}

function onMessage(port: MIDIInput, e: MIDIMessageEvent): void {
  const now = performance.now();
  const data = e.data;
  if (!data || paused) return;
  const status = data[0] ?? 0;
  if (hideRealtime.checked && (status === 0xf8 || status === 0xfe)) return;
  const type = status & 0xf0;
  if (hidePressure.checked && (type === 0xa0 || type === 0xd0 || (type === 0xb0 && data[1] === 22))) return;

  const t = e.timeStamp;
  const lag = now - t;
  if (t <= 0 || lag < 0) lagStats.zeroOrFuture++;
  else {
    lagStats.n++;
    lagStats.sum += lag;
    lagStats.max = Math.max(lagStats.max, lag);
  }
  const bytes = Array.from(data);
  events.push({ t, lag, port: port.name ?? '', bytes });
  if (events.length > 5000) events.shift();

  const delta = lastT ? t - lastT : 0;
  lastT = t;
  const atom = isAtomPortName(port.name) ? atomSummary(parseAtomMessage(bytes)) : '';
  appendLog(
    log,
    `${t.toFixed(2).padStart(10)}  Δ${delta.toFixed(1).padStart(7)}  lag ${lag.toFixed(1).padStart(5)}  ` +
      `${toHex(bytes).padEnd(9)}  ${describeMidi(bytes).padEnd(44)} ${atom}`,
  );
  renderStats();
}

function renderStats(): void {
  const mean = lagStats.n ? lagStats.sum / lagStats.n : 0;
  statsEl.textContent =
    `events ${lagStats.n + lagStats.zeroOrFuture} · handler lag mean ${mean.toFixed(2)} ms, max ${lagStats.max.toFixed(1)} ms` +
    ` · zero/future timestamps ${lagStats.zeroOrFuture}`;
}

function renderPorts(): void {
  if (!access) return;
  const rows = [...listInputs(access), ...listOutputs(access)].map((p) =>
    h(
      'tr',
      {},
      h('td', { textContent: p.type }),
      h('td', { textContent: p.name ?? '' }),
      h('td', { textContent: p.manufacturer ?? '' }),
      h('td', {}, pill(p.state, p.state === 'connected' ? 'ok' : 'bad')),
      h('td', { textContent: p.connection }),
      h('td', { className: 'mono muted', textContent: p.id }),
    ),
  );
  portsTable.replaceChildren(
    h('tr', {}, ...['Type', 'Name', 'Manufacturer', 'State', 'Connection', 'ID'].map((t) => h('th', { textContent: t }))),
    ...rows,
  );
  if (rows.length === 0) portsTable.replaceChildren(h('tr', {}, h('td', { textContent: 'No MIDI ports found.' })));
}

function attachInputs(): void {
  if (!access) return;
  for (const input of listInputs(access)) {
    input.onmidimessage = (e) => onMessage(input, e);
  }
}

function atomOutputs(): MIDIOutput[] {
  return access ? listOutputs(access).filter((o) => o.state === 'connected' && isAtomPortName(o.name)) : [];
}

function setNative(on: boolean): void {
  for (const o of atomOutputs()) o.send(nativeModeMessage(on) as number[]);
}

$('#connect').addEventListener('click', async () => {
  try {
    access = await requestMidi();
    statusEl.replaceChildren(pill('MIDI ready', 'ok'));
    access.onstatechange = (e) => {
      const p = (e as MIDIConnectionEvent).port;
      if (p) appendLog(log, `--- ${p.type} "${p.name}" ${p.state} / ${p.connection}`);
      attachInputs();
      renderPorts();
      if (p?.state === 'connected' && p.type === 'output' && nativeBox.checked && isAtomPortName(p.name)) setNative(true);
    };
    attachInputs();
    renderPorts();
    if (nativeBox.checked) setNative(true);
  } catch (err) {
    statusEl.replaceChildren(pill(String((err as Error).message ?? err), 'bad'));
  }
});

nativeBox.addEventListener('change', () => setNative(nativeBox.checked));
window.addEventListener('pagehide', () => nativeBox.checked && setNative(false));
document.addEventListener('visibilitychange', () => {
  if (nativeBox.checked) setNative(document.visibilityState === 'visible');
});

$('#pause').addEventListener('click', (e) => {
  paused = !paused;
  (e.target as HTMLButtonElement).textContent = paused ? 'Resume' : 'Pause';
});
$('#clear').addEventListener('click', () => {
  log.replaceChildren();
  events.length = 0;
  Object.assign(lagStats, { n: 0, sum: 0, max: 0, zeroOrFuture: 0 });
  lastT = 0;
  renderStats();
});
$('#export').addEventListener('click', () => {
  download(
    `midi-log-${Date.now()}.json`,
    JSON.stringify({ device: deviceSummary(), lagStats, events }, null, 1),
  );
});
