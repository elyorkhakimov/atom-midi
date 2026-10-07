import { useEffect, useState } from 'preact/hooks';
import { GAMES } from '../games/registry';
import { PLAYERS } from '../games/players';
import { PAD_COUNT, padAt } from '../midi/atomMap';
import { useHold, useInput } from './hooks';
import { go } from './router';
import { getRuntime, settings } from './runtime';

/** Game i is on top-row pad i (left to right), lit in its colour. */
const GAME_PADS = GAMES.map((_, i) => padAt(3, i));
const SETTINGS_INDEX = GAMES.length;
const HOLD_MS = 1000;

export function MainMenu() {
  const [selected, setSelected] = useState(0);
  const [holding, setHolding] = useState(false);
  const kid = settings.value.kidUi;
  const count = GAMES.length + 1;

  const openSettings = () => go({ name: 'settings' });
  const hold = useHold(HOLD_MS, () => {
    setHolding(false);
    openSettings();
  });

  useEffect(() => {
    const { controller } = getRuntime();
    controller.reset();
    controller.setPads(
      Array.from({ length: PAD_COUNT }, (_, pad) => {
        const i = GAME_PADS.indexOf(pad);
        if (i < 0) return { r: 0, g: 0, b: 0 };
        const led = PLAYERS[i % PLAYERS.length]!.led;
        return { ...led, mode: i === selected ? 'breathe' : undefined };
      }),
    );
    controller.setButtonLight('play', { r: 0, g: 127, b: 0 });
    controller.setButtonLight('stop', true);
  }, [selected]);

  const open = (i: number) => {
    if (i === SETTINGS_INDEX) return; // needs a hold
    getRuntime().audio.playCue('select');
    go({ name: 'game', id: GAMES[i]!.id });
  };

  const move = (d: number) => {
    setSelected((s) => (s + d + count) % count);
    getRuntime().audio.playCue('tick');
  };

  useInput((e) => {
    const { input } = getRuntime();
    if (e.type === 'encoder') return move(Math.sign(e.delta));
    if (e.type === 'padDown') {
      const i = GAME_PADS.indexOf(e.pad);
      if (i >= 0) open(i);
      return;
    }
    if (e.type !== 'button') return;
    // Parent combo: Shift + Setup.
    if (e.down && e.action === 'setup' && input.isButtonHeld('shift')) return openSettings();
    switch (e.action) {
      case 'up':
      case 'prev':
        if (e.down) move(-1);
        return;
      case 'down':
      case 'next':
        if (e.down) move(1);
        return;
      case 'start':
      case 'select':
        if (selected === SETTINGS_INDEX) {
          if (e.down) {
            setHolding(true);
            hold.start();
          } else {
            setHolding(false);
            hold.cancel();
          }
        } else if (e.down) open(selected);
        return;
    }
  });

  return (
    <div class="screen">
      <div class={`menu ${kid ? 'kid' : ''}`}>
        {GAMES.map((g, i) => (
          <button
            key={g.id}
            class={`card ${selected === i ? 'selected' : ''}`}
            style={{ '--player': PLAYERS[i % PLAYERS.length]!.css }}
            onClick={() => open(i)}
            onPointerEnter={() => setSelected(i)}
          >
            <span class="emoji">{g.emoji}</span>
            <span class="name">{g.title}</span>
            {!kid && <span class="blurb">{g.blurb}</span>}
            {!kid && <span class="players">{g.players} · pad {i + 1} on top row</span>}
          </button>
        ))}
        <button
          class={`card settings ${selected === SETTINGS_INDEX ? 'selected' : ''} ${holding ? 'holding' : ''}`}
          onPointerDown={() => {
            setSelected(SETTINGS_INDEX);
            setHolding(true);
            hold.start();
          }}
          onPointerUp={() => {
            setHolding(false);
            hold.cancel();
          }}
          onPointerLeave={() => {
            setHolding(false);
            hold.cancel();
          }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <span class="emoji">⚙️</span>
          <span class="name">Settings</span>
          {!kid && <span class="blurb">Grown-ups: hold to open (or Shift + Setup)</span>}
        </button>
      </div>
      {!kid && <p class="muted small center-text">Hit a lit pad to play · knob or ▲▼ to choose · ▶ Play to open</p>}
    </div>
  );
}
