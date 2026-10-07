import { useState } from 'preact/hooks';
import { go } from './router';
import { midiError, settings, startRuntime, updateSettings } from './runtime';

export function StartScreen() {
  const [busy, setBusy] = useState(false);
  const showBt = !settings.value.bluetoothWarningSeen;

  const start = async () => {
    if (busy) return;
    setBusy(true);
    await startRuntime();
    updateSettings({ bluetoothWarningSeen: true });
    go(settings.value.setupPromptSeen ? { name: 'menu' } : { name: 'setup' });
  };

  return (
    <div class="screen center">
      <h1 class="title">Pad Games</h1>
      <button class="huge" onClick={start} disabled={busy}>
        {busy ? 'Starting…' : 'Tap to start'}
      </button>
      {showBt && (
        <p class="notice">
          🎧 Use wired headphones or the speaker. <b>Bluetooth audio adds 100–200 ms of delay</b>, which makes games unfair.
        </p>
      )}
      {midiError.value && <p class="notice bad">{midiError.value}</p>}
      <p class="muted small">Plug in the ATOM first. No ATOM? Keys Z X C V / A S D F / Q W E R / 1 2 3 4 are pads.</p>
    </div>
  );
}
