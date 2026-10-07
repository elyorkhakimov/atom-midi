import type { ButtonId } from '../midi/atomMap';
import type { ControllerEvent } from '../midi/padController';

/**
 * Keyboard stand-in for the ATOM (development and testing without hardware).
 * Pads: rows from the bottom  Z X C V / A S D F / Q W E R / 1 2 3 4.
 * Velocity 100; hold Shift for 127, Alt for 35.
 * Buttons: Space = Play, Esc = Stop, Enter = Select, arrows = nav, M = Click.
 * Knobs: [ ] = knob 1, ; ' = knob 2, , . = knob 3, / \ = knob 4.
 */
const PAD_KEYS = ['z', 'x', 'c', 'v', 'a', 's', 'd', 'f', 'q', 'w', 'e', 'r', '1', '2', '3', '4'];
const BUTTON_KEYS: Record<string, ButtonId> = {
  ' ': 'play',
  Escape: 'stop',
  Enter: 'select',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  m: 'click',
};
const KNOB_KEYS: Record<string, [number, number]> = {
  '[': [0, -1], ']': [0, 1], ';': [1, -1], "'": [1, 1], ',': [2, -1], '.': [2, 1], '/': [3, -1], '\\': [3, 1],
};

export function attachKeyboard(feed: (e: ControllerEvent) => void): () => void {
  const isTyping = (e: KeyboardEvent) => {
    const el = e.target as HTMLElement | null;
    return Boolean(el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable));
  };
  const onKey = (e: KeyboardEvent) => {
    if (isTyping(e) || e.metaKey || e.ctrlKey) return;
    const down = e.type === 'keydown';
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const pad = PAD_KEYS.indexOf(e.code.startsWith('Digit') ? e.code.slice(5) : e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : key);
    if (pad >= 0) {
      e.preventDefault();
      if (e.repeat) return;
      const velocity = e.shiftKey ? 127 : e.altKey ? 35 : 100;
      feed(down ? { type: 'padDown', pad, velocity, t: e.timeStamp } : { type: 'padUp', pad, t: e.timeStamp });
      return;
    }
    const button = BUTTON_KEYS[key];
    if (button) {
      e.preventDefault();
      if (!e.repeat) feed({ type: 'button', id: button, down, t: e.timeStamp });
      return;
    }
    const knob = KNOB_KEYS[key];
    if (knob && down) {
      e.preventDefault();
      feed({ type: 'encoder', id: knob[0], delta: knob[1], t: e.timeStamp });
    }
  };
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  return () => {
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
  };
}
