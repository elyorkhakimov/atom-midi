/**
 * Velocity shaping, applied in this order:
 *   per-pad calibration -> ghost-hit threshold -> response curve.
 * Pure functions; no browser APIs.
 */

/** Raw velocities measured for one pad in the calibration wizard. */
export interface PadCalibration {
  soft: number;
  hard: number;
}

/** Calibrated velocity for a soft hit. A hard hit maps to 127. */
export const SOFT_TARGET = 20;

const clampVel = (v: number) => Math.max(1, Math.min(127, Math.round(v)));

/** Maps raw velocity so this pad's soft ≈ 20 and hard = 127, piecewise linear. */
export function calibrateVelocity(raw: number, cal: PadCalibration | null | undefined): number {
  if (!cal || cal.hard <= cal.soft) return clampVel(raw);
  if (raw <= cal.soft) return clampVel((raw / cal.soft) * SOFT_TARGET);
  return clampVel(SOFT_TARGET + ((raw - cal.soft) / (cal.hard - cal.soft)) * (127 - SOFT_TARGET));
}

export type CurveName = 'linear' | 'soft' | 'hard';

/** Exponents: < 1 lifts soft hits (good for kids), > 1 needs harder hits. */
export const CURVE_GAMMA: Record<CurveName, number> = { linear: 1, soft: 0.6, hard: 1.6 };

export function applyCurve(v: number, gamma: number): number {
  return clampVel(127 * (v / 127) ** gamma);
}

/**
 * Ignores a second PadDown on the same pad within `windowMs` unless it is louder.
 * Uses event timestamps, so it's independent of handler timing.
 */
export class DoubleTriggerGuard {
  private readonly last = new Map<number, { t: number; velocity: number }>();

  accept(pad: number, velocity: number, t: number, windowMs: number): boolean {
    const prev = this.last.get(pad);
    if (prev && t - prev.t < windowMs && velocity <= prev.velocity) return false;
    this.last.set(pad, { t, velocity });
    return true;
  }
}
