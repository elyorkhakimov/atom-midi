import { useInput } from './hooks';
import { go } from './router';
import { settings, updateSettings } from './runtime';

/** First run: offer the timing calibration. */
export function SetupPrompt() {
  const done = () => {
    updateSettings({ setupPromptSeen: true });
    go({ name: 'menu' });
  };
  const timing = () => {
    updateSettings({ setupPromptSeen: true });
    go({ name: 'calLatency', back: 'menu' });
  };
  useInput((e) => {
    if (e.type !== 'button' || !e.down) return;
    if (e.action === 'start' || e.action === 'select') timing();
    else if (e.action === 'back') done();
  });

  return (
    <div class="screen center">
      <h2>Let’s set up</h2>
      <p>One quick check makes the rhythm games fair on this device: tap along with a beat for 10 seconds.</p>
      <div class="stack">
        <button class="big" onClick={timing}>
          Calibrate timing {settings.value.latencyCalibrated ? '✓' : ''}
        </button>
        <button onClick={done}>Skip for now</button>
      </div>
      <p class="muted small">▶ Play = calibrate · ■ Stop = skip. Also in Settings.</p>
    </div>
  );
}
