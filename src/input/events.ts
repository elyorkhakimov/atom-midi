import type { ButtonId } from '../midi/atomMap';

/** Normalized input. Pad velocities are calibrated and curved; `raw` is the device value. */
export type InputEvent =
  | { type: 'padDown'; pad: number; velocity: number; raw: number; t: number }
  | { type: 'padUp'; pad: number; t: number }
  | { type: 'padPressure'; pad: number; value: number; t: number }
  | { type: 'button'; id: ButtonId; action: Action | null; down: boolean; t: number }
  | { type: 'encoder'; id: number; delta: number; t: number };

/** Semantic actions so games don't hard-code ATOM button names. */
export type Action = 'start' | 'back' | 'next' | 'prev' | 'up' | 'down' | 'select' | 'metronome' | 'shift' | 'setup';

const ACTIONS: Partial<Record<ButtonId, Action>> = {
  play: 'start',
  stop: 'back',
  right: 'next',
  left: 'prev',
  up: 'up',
  down: 'down',
  select: 'select',
  click: 'metronome',
  shift: 'shift',
  setup: 'setup',
};

export function buttonAction(id: ButtonId): Action | null {
  return ACTIONS[id] ?? null;
}
