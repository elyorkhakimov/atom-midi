import type { ControllerEvent, PadController } from '../midi/padController';
import { buttonAction, type InputEvent } from './events';
import { DoubleTriggerGuard, applyCurve, calibrateVelocity, type PadCalibration } from './velocity';

export interface InputShaping {
  calibration: readonly (PadCalibration | null)[];
  /** Calibrated velocities below this are ghost hits and dropped. */
  threshold: number;
  curveGamma: number;
  doubleTriggerMs: number;
}

type Listener = (e: InputEvent) => void;

/**
 * Turns raw controller (or keyboard) events into normalized InputEvents.
 * Listeners form a stack: only the most recently added one receives events, so a
 * screen or game on top owns the input until it unsubscribes.
 */
export class InputBus {
  private readonly stack: Listener[] = [];
  private readonly monitors = new Set<Listener>();
  private readonly guard = new DoubleTriggerGuard();
  /** Pads whose down was dropped; their up is dropped too. */
  private readonly dropped = new Set<number>();
  private readonly heldButtons = new Set<string>();
  /** Pad calibration needs raw velocities: no calibration, threshold or curve. */
  bypassShaping = false;

  constructor(private readonly shaping: () => InputShaping) {}

  attach(controller: PadController): () => void {
    return controller.onEvent((e) => this.feed(e));
  }

  /** Push a handler; returns a function that removes it. */
  push(listener: Listener): () => void {
    this.stack.push(listener);
    return () => {
      const i = this.stack.lastIndexOf(listener);
      if (i >= 0) this.stack.splice(i, 1);
    };
  }

  /** Receives every event regardless of the stack (status displays, global combos). */
  monitor(listener: Listener): () => void {
    this.monitors.add(listener);
    return () => this.monitors.delete(listener);
  }

  isButtonHeld(id: string): boolean {
    return this.heldButtons.has(id);
  }

  feed(e: ControllerEvent): void {
    const out = this.normalize(e);
    if (!out) return;
    for (const m of this.monitors) m(out);
    this.stack[this.stack.length - 1]?.(out);
  }

  private normalize(e: ControllerEvent): InputEvent | null {
    const s = this.shaping();
    switch (e.type) {
      case 'padDown': {
        if (this.bypassShaping) return { type: 'padDown', pad: e.pad, velocity: e.velocity, raw: e.velocity, t: e.t };
        const calibrated = calibrateVelocity(e.velocity, s.calibration[e.pad]);
        if (calibrated < s.threshold || !this.guard.accept(e.pad, e.velocity, e.t, s.doubleTriggerMs)) {
          this.dropped.add(e.pad);
          return null;
        }
        this.dropped.delete(e.pad);
        return { type: 'padDown', pad: e.pad, velocity: applyCurve(calibrated, s.curveGamma), raw: e.velocity, t: e.t };
      }
      case 'padUp':
        if (this.dropped.delete(e.pad)) return null;
        return e;
      case 'padPressure':
        return this.dropped.has(e.pad) ? null : e;
      case 'button':
        if (e.down) this.heldButtons.add(e.id);
        else this.heldButtons.delete(e.id);
        return { ...e, action: buttonAction(e.id) };
      case 'encoder':
        return e;
    }
  }
}
