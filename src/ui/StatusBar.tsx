import { audioRunning, controllerStatus, kitState, midiError, settings } from './runtime';

function Chip({ ok, label, title }: { ok: boolean | null; label: string; title?: string }) {
  return <span class={`chip ${ok === null ? '' : ok ? 'ok' : 'bad'}`} title={title}>{label}</span>;
}

export function StatusBar() {
  const s = controllerStatus.value;
  const set = settings.value;
  return (
    <div class="statusbar">
      <Chip ok={s.connected} label={s.connected ? 'ATOM' : 'No ATOM'} title={midiError.value ?? s.portName ?? 'Plug in the ATOM'} />
      <Chip ok={s.connected ? s.native : null} label={s.nativeConfirmed ? 'Native ✓' : 'Native'} title="Native control mode" />
      <Chip ok={audioRunning.value} label="Audio" />
      <Chip ok={kitState.value === 'ready' ? true : kitState.value === 'error' ? false : null} label={kitState.value === 'loading' ? 'Kit…' : 'Kit'} />
      <Chip ok={set.latencyCalibrated ? true : null} label={`${set.latencyOffsetMs >= 0 ? '+' : ''}${Math.round(set.latencyOffsetMs)} ms`} title="Latency offset" />
    </div>
  );
}
