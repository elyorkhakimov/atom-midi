/**
 * Velocity shaping, applied in this order: ghost-hit threshold -> response curve.
 * Raw pad velocities are used as-is (no per-pad calibration).
 * Pure functions; no browser APIs.
 */

const clampVel = (v: number) => Math.max(1, Math.min(127, Math.round(v)));

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
