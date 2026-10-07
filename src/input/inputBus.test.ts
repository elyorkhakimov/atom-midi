import { describe, expect, it } from 'vitest';
import type { InputEvent } from './events';
import { InputBus, type InputShaping } from './inputBus';

function setup(shaping: Partial<InputShaping> = {}) {
  const bus = new InputBus(() => ({ calibration: [], threshold: 5, curveGamma: 1, doubleTriggerMs: 25, ...shaping }));
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

  it('applies calibration then curve, keeping raw and the MIDI timestamp', () => {
    const cal = Array(16).fill(null);
    cal[2] = { soft: 40, hard: 110 };
    const { bus, got } = setup({ calibration: cal });
    bus.feed({ type: 'padDown', pad: 2, velocity: 110, t: 1234.5 });
    expect(got[0]).toEqual({ type: 'padDown', pad: 2, velocity: 127, raw: 110, t: 1234.5 });
  });

  it('bypassShaping passes raw velocities', () => {
    const { bus, got } = setup({ calibration: Array(16).fill({ soft: 40, hard: 110 }) });
    bus.bypassShaping = true;
    bus.feed({ type: 'padDown', pad: 0, velocity: 2, t: 1 });
    expect(got[0]).toMatchObject({ velocity: 2, raw: 2 });
  });

  it('maps buttons to actions and tracks held buttons', () => {
    const { bus, got } = setup();
    bus.feed({ type: 'button', id: 'shift', down: true, t: 1 });
    expect(bus.isButtonHeld('shift')).toBe(true);
    bus.feed({ type: 'button', id: 'play', down: true, t: 2 });
    expect(got[1]).toMatchObject({ action: 'start' });
  });

  it('delivers only to the top of the stack, monitors see everything', () => {
    const bus = new InputBus(() => ({ calibration: [], threshold: 0, curveGamma: 1, doubleTriggerMs: 0 }));
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
