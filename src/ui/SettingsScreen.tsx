import { useEffect, useState } from 'preact/hooks';
import { KITS } from '../audio/kit';
import { CURVE_GAMMA, type CurveName } from '../input/velocity';
import type { Settings } from '../storage/settings';
import { useInput } from './hooks';
import { go } from './router';
import { bests, getRuntime, loadKit, settings, updateSettings } from './runtime';

interface ValueRow {
  kind: 'value';
  label: string;
  value: (s: Settings) => string;
  /** Apply one step in direction d (−1 / +1). */
  step: (s: Settings, d: number) => Partial<Settings>;
}

interface ActionRow {
  kind: 'action';
  label: string;
  detail: () => string;
  run: () => void;
}

type Row = ValueRow | ActionRow;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const pct = (v: number) => `${Math.round(v * 100)}%`;
const CURVES: CurveName[] = ['linear', 'soft', 'hard'];

function percentRow(label: string, key: 'masterVolume' | 'metronomeVolume' | 'ledBrightness', min = 0): ValueRow {
  return { kind: 'value', label, value: (s) => pct(s[key]), step: (s, d) => ({ [key]: clamp(Math.round((s[key] + d * 0.05) * 100) / 100, min, 1) }) };
}

export function SettingsScreen() {
  const [focus, setFocus] = useState(0);
  /** Label of the destructive row waiting for a second press, if any. */
  const [confirm, setConfirm] = useState<string | null>(null);
  const s = settings.value;
  useEffect(() => getRuntime().controller.reset(), []);

  /** An action that needs a second press. */
  const confirmRow = (id: string, label: string, detail: () => string, action: () => void): ActionRow => ({
    kind: 'action',
    label: confirm === id ? `Really ${label.charAt(0).toLowerCase()}${label.slice(1)}?` : label,
    detail: () => (confirm === id ? 'press again to confirm' : detail()),
    run: () => {
      if (confirm === id) {
        action();
        getRuntime().audio.playCue('select');
        setConfirm(null);
      } else setConfirm(id);
    },
  });

  const rows: Row[] = [
    percentRow('Master volume', 'masterVolume'),
    percentRow('Metronome volume', 'metronomeVolume'),
    percentRow('Pad brightness', 'ledBrightness', 0.05),
    {
      kind: 'value',
      label: 'Velocity curve',
      value: (s) => `${s.curve} (${s.curveGamma.toFixed(2)})`,
      step: (s, d) => {
        const curve = CURVES[(CURVES.indexOf(s.curve) + d + CURVES.length) % CURVES.length]!;
        return { curve, curveGamma: CURVE_GAMMA[curve] };
      },
    },
    {
      kind: 'value',
      label: 'Curve fine-tune',
      value: (s) => s.curveGamma.toFixed(2),
      step: (s, d) => ({ curveGamma: clamp(Math.round((s.curveGamma + d * 0.05) * 100) / 100, 0.3, 2.5) }),
    },
    { kind: 'value', label: 'Ignore hits softer than', value: (s) => String(s.velocityThreshold), step: (s, d) => ({ velocityThreshold: clamp(s.velocityThreshold + d, 0, 40) }) },
    { kind: 'value', label: 'Double-hit guard', value: (s) => `${s.doubleTriggerMs} ms`, step: (s, d) => ({ doubleTriggerMs: clamp(s.doubleTriggerMs + d * 5, 0, 80) }) },
    {
      kind: 'value',
      label: 'Kit',
      value: (s) => KITS.find((k) => k.id === s.kitId)?.name ?? s.kitId,
      step: (s, d) => {
        const i = KITS.findIndex((k) => k.id === s.kitId);
        const kitId = KITS[(i + d + KITS.length) % KITS.length]!.id;
        if (kitId !== s.kitId) void loadKit(kitId);
        return { kitId };
      },
    },
    { kind: 'value', label: 'Kid mode (fewer words)', value: (s) => (s.kidUi ? 'on' : 'off'), step: (s) => ({ kidUi: !s.kidUi }) },
    {
      kind: 'action',
      label: 'Calibrate timing',
      detail: () => (s.latencyCalibrated ? `offset ${s.latencyOffsetMs >= 0 ? '+' : ''}${Math.round(s.latencyOffsetMs)} ms` : 'not calibrated'),
      run: () => go({ name: 'calLatency', back: 'settings' }),
    },
    confirmRow('clearTiming', 'Clear timing calibration', () => (s.latencyCalibrated ? 'back to no correction (0 ms)' : 'nothing to clear'), () =>
      updateSettings({ latencyOffsetMs: 0, latencyCalibrated: false }),
    ),
    confirmRow('resetBests', 'Reset best scores', () => `${Object.keys(bests.value).length} records`, () => {
      bests.value = {};
    }),
  ];

  const change = (i: number, d: number) => {
    const row = rows[i];
    if (row?.kind !== 'value') return;
    updateSettings(row.step(settings.value, d));
    getRuntime().audio.playCue('tick');
  };

  const activate = (i: number) => {
    const row = rows[i];
    if (row?.kind === 'action') row.run();
    else change(i, 1);
  };

  const moveFocus = (d: number) => {
    setFocus((f) => clamp(f + d, 0, rows.length - 1));
    setConfirm(null);
  };

  useInput((e) => {
    if (e.type === 'encoder') {
      if (e.id === 0) moveFocus(Math.sign(e.delta));
      else change(focus, Math.sign(e.delta));
      return;
    }
    if (e.type !== 'button' || !e.down) return;
    switch (e.action) {
      case 'up':
        return moveFocus(-1);
      case 'down':
        return moveFocus(1);
      case 'prev':
        return change(focus, -1);
      case 'next':
        return change(focus, 1);
      case 'start':
      case 'select':
        return activate(focus);
      case 'back':
        return go({ name: 'menu' });
    }
  });

  return (
    <div class="screen">
      <h2>Settings</h2>
      <p class="muted small">Knob 1 or ▲▼ choose · knob 2 or ◀▶ change · ▶ select · ■ back</p>
      <div class="settings-list">
        {rows.map((row, i) => (
          <div class={`setting ${focus === i ? 'focus' : ''}`} key={row.label} onClick={() => setFocus(i)}>
            <span class="label">{row.label}</span>
            {row.kind === 'value' ? (
              <span class="control">
                <button onClick={() => change(i, -1)} aria-label="decrease">−</button>
                <span class="value">{row.value(s)}</span>
                <button onClick={() => change(i, 1)} aria-label="increase">+</button>
              </span>
            ) : (
              <span class="control">
                <span class="value muted">{row.detail()}</span>
                <button onClick={() => row.run()}>Go</button>
              </span>
            )}
          </div>
        ))}
      </div>
      <div class="row">
        <button class="back" onClick={() => go({ name: 'menu' })}>
          ← Menu
        </button>
        <a class="muted small" href={`${import.meta.env.BASE_URL}tools/atom-test/`}>ATOM test tools</a>
        <a class="muted small" href={`${import.meta.env.BASE_URL}tools/latency-test/`}>Audio latency test</a>
      </div>
    </div>
  );
}
