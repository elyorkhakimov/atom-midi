import { describe, expect, it } from 'vitest';
import { DoubleTriggerGuard, SOFT_TARGET, applyCurve, calibrateVelocity } from './velocity';

describe('calibrateVelocity', () => {
  const cal = { soft: 40, hard: 110 };
  it('maps soft to 20 and hard to 127', () => {
    expect(calibrateVelocity(40, cal)).toBe(SOFT_TARGET);
    expect(calibrateVelocity(110, cal)).toBe(127);
    expect(calibrateVelocity(127, cal)).toBe(127);
  });
  it('is linear between and below the references', () => {
    expect(calibrateVelocity(75, cal)).toBe(Math.round(20 + (35 / 70) * 107));
    expect(calibrateVelocity(20, cal)).toBe(10);
    expect(calibrateVelocity(1, cal)).toBe(1);
  });
  it('makes two differently sensitive pads agree', () => {
    const lively = { soft: 60, hard: 120 };
    const dull = { soft: 25, hard: 90 };
    expect(calibrateVelocity(60, lively)).toBe(calibrateVelocity(25, dull));
    expect(calibrateVelocity(120, lively)).toBe(calibrateVelocity(90, dull));
  });
  it('passes raw through without calibration', () => {
    expect(calibrateVelocity(64, null)).toBe(64);
    expect(calibrateVelocity(64, { soft: 50, hard: 50 })).toBe(64);
  });
});

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
