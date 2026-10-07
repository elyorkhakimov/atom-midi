import { useInput } from './hooks';
import { go } from './router';
import { padsCalibrated, settings, updateSettings } from './runtime';

/** First run: offer the calibration wizards. */
export function SetupPrompt() {
  const done = () => {
    updateSettings({ setupPromptSeen: true });
    go({ name: 'menu' });
  };
  const pads = () => {
    updateSettings({ setupPromptSeen: true });
    go({ name: 'calPads', back: 'menu' });
  };
  const timing = () => {
    updateSettings({ setupPromptSeen: true });
    go({ name: 'calLatency', back: 'menu' });
  };
  useInput((e) => {
    if (e.type !== 'button' || !e.down) return;
    if (e.action === 'start' || e.action === 'select') pads();
    else if (e.action === 'back') done();
  });

  return (
    <div class="screen center">
      <h2>Let’s set up</h2>
      <p>Two quick checks make the games fair on this device.</p>
      <div class="stack">
        <button class="big" onClick={pads}>
          1 · Calibrate pads {padsCalibrated.value === 16 ? '✓' : ''}
        </button>
        <button class="big" onClick={timing}>
          2 · Calibrate timing {settings.value.latencyCalibrated ? '✓' : ''}
        </button>
        <button onClick={done}>Skip for now</button>
      </div>
      <p class="muted small">▶ Play = calibrate pads · ■ Stop = skip. Both are also in Settings.</p>
    </div>
  );
}
