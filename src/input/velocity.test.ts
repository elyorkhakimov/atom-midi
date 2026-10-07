import { describe, expect, it } from 'vitest';
import { DoubleTriggerGuard, applyCurve } from './velocity';

describe('applyCurve', () => {
  it('keeps the ends fixed and bends the middle', () => {
    expect(applyCurve(127, 0.6)).toBe(127);
    expect(applyCurve(64, 1)).toBe(64);
    expect(applyCurve(64, 0.6)).toBeGreaterThan(64);
    expect(applyCurve(64, 1.6)).toBeLessThan(64);
    expect(applyCurve(1, 1.6)).toBe(1);
  });
});

describe('DoubleTriggerGuard', () => {
  it('drops a second, not-louder hit within the window', () => {
    const g = new DoubleTriggerGuard();
    expect(g.accept(0, 100, 1000, 25)).toBe(true);
    expect(g.accept(0, 90, 1010, 25)).toBe(false);
    expect(g.accept(0, 100, 1020, 25)).toBe(false);
  });
  it('accepts a louder hit, other pads, and hits after the window', () => {
    const g = new DoubleTriggerGuard();
    g.accept(0, 80, 1000, 25);
    expect(g.accept(0, 110, 1010, 25)).toBe(true);
    expect(g.accept(1, 50, 1011, 25)).toBe(true);
    expect(g.accept(0, 10, 1040, 25)).toBe(true);
  });
});
