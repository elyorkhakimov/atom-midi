import type { PadCalibration } from '../input/velocity';
import { median } from './stats';

export const MIN_TAPS_PER_PHASE = 3;
/** Soft and hard must be at least this far apart, or the taps weren't soft/hard enough. */
export const MIN_SPREAD = 10;

/**
 * Soft reference = median of soft taps; hard reference = median of hard taps.
 * Medians ignore the odd accidental tap. Returns null if the data is unusable.
 */
export function computePadCalibration(soft: readonly number[], hard: readonly number[]): PadCalibration | null {
  if (soft.length < MIN_TAPS_PER_PHASE || hard.length < MIN_TAPS_PER_PHASE) return null;
  const s = median(soft);
  const h = median(hard);
  if (h - s < MIN_SPREAD) return null;
  return { soft: Math.round(s), hard: Math.round(h) };
}
