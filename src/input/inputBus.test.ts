import { describe, expect, it } from 'vitest';
import { KnobDetents } from './knob';
import type { InputEvent } from './events';
import { InputBus, type InputShaping } from './inputBus';
import { applyCurve } from './velocity';

function setup(shaping: Partial<InputShaping> = {}) {
  const bus = new InputBus(() => ({ threshold: 5, curveGamma: 1, doubleTriggerMs: 25, ...shaping }));
  const got: InputEvent[] = [];
  bus.push((e) => got.push(e));
  return { bus, got };
}

describe('InputBus', () => {
  it('drops ghost hits and their release', () => {
    const { bus, got } = setup();
    bus.feed({ type: 'padDown', pad: 0, velocity: 3, t: 1 });
    bus.feed({ type: 'padUp', pad: 0, t: 2 });
    expect(got).toEqual([]);
  });

  it('applies the curve to the raw velocity, keeping raw and the MIDI timestamp', () => {
    const { bus, got } = setup({ curveGamma: 0.6 });
    bus.feed({ type: 'padDown', pad: 2, velocity: 64, t: 1234.5 });
    expect(got[0]).toEqual({ type: 'padDown', pad: 2, velocity: applyCurve(64, 0.6), raw: 64, t: 1234.5 });
  });

  it('maps buttons to actions and tracks held buttons', () => {
    const { bus, got } = setup();
    bus.feed({ type: 'button', id: 'shift', down: true, t: 1 });
    expect(bus.isButtonHeld('shift')).toBe(true);
    bus.feed({ type: 'button', id: 'play', down: true, t: 2 });
    expect(got[1]).toMatchObject({ action: 'start' });
  });

  it('delivers only to the top of the stack, monitors see everything', () => {
    const bus = new InputBus(() => ({ threshold: 0, curveGamma: 1, doubleTriggerMs: 0 }));
    const a: InputEvent[] = [];
    const b: InputEvent[] = [];
    const m: InputEvent[] = [];
    bus.push((e) => a.push(e));
    const pop = bus.push((e) => b.push(e));
    bus.monitor((e) => m.push(e));
    bus.feed({ type: 'encoder', id: 0, delta: 1, t: 1 });
    pop();
    bus.feed({ type: 'encoder', id: 0, delta: 1, t: 2 });
    expect([a.length, b.length, m.length]).toEqual([1, 1, 2]);
  });
});

describe('knob detents', () => {
  it('needs several ticks per step, per knob, and restarts on reversal', () => {
    const k = new KnobDetents();
    expect([1, 1, 1, 1].map(() => k.step(0, 1, 2))).toEqual([0, 1, 0, 1]);
    expect(k.step(1, 1, 2)).toBe(0); // separate knob
    expect(k.step(0, 1, 2)).toBe(0);
    expect(k.step(0, -1, 2)).toBe(0); // reversal drops the pending tick
    expect(k.step(0, -1, 2)).toBe(-1);
    expect(k.step(0, 9, 4)).toBe(0); // acceleration capped at 2 ticks
  });
});
