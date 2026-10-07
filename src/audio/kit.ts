/** kit.json format (public/kits/<id>/kit.json). Pure types and selection logic. */
export interface KitLayer {
  minVelocity: number;
  maxVelocity: number;
  samples: string[];
}

export interface KitInstrument {
  name: string;
  /** Pad colour, 0–127 RGB. */
  color: [number, number, number];
  chokeGroup?: string;
  /** Velocity width of the equal-power crossfade at layer boundaries (0 = hard switch). */
  crossfade?: number;
  /** Velocity-driven low-pass, for single-layer instruments. */
  velocityFilter?: boolean;
  layers: KitLayer[];
}

export interface KitJson {
  id: string;
  name: string;
  description?: string;
  license: string;
  source: string;
  /** Instrument id per pad, pad 0 = bottom-left. */
  pads: string[];
  instruments: Record<string, KitInstrument>;
}

export const KITS = [{ id: 'electro', name: 'Electro' }] as const;

/** Default gain curve from the spec: (v/127)^2. */
export function velocityGain(v: number): number {
  return (Math.max(0, Math.min(127, v)) / 127) ** 2;
}

/**
 * Which layer(s) to play for a velocity, with gains. Near a boundary (within
 * crossfade/2) both neighbours play with an equal-power crossfade.
 */
export function selectLayers(layers: readonly KitLayer[], velocity: number, crossfade = 0): { index: number; gain: number }[] {
  const v = Math.max(1, Math.min(127, velocity));
  // Layers are ordered soft -> hard; the first whose top covers v wins (no gaps possible).
  let index = layers.findIndex((l) => v <= l.maxVelocity);
  if (index < 0) index = layers.length - 1;
  if (crossfade <= 0) return [{ index, gain: 1 }];

  const half = crossfade / 2;
  const checks: [number, number][] = [];
  if (index > 0) checks.push([index - 1, index]);
  if (index < layers.length - 1) checks.push([index, index + 1]);
  for (const [lo, hi] of checks) {
    const boundary = layers[lo]!.maxVelocity + 0.5;
    if (Math.abs(v - boundary) < half) {
      const x = (v - (boundary - half)) / crossfade; // 0 at the lower edge, 1 at the upper
      return [
        { index: lo, gain: Math.cos((x * Math.PI) / 2) },
        { index: hi, gain: Math.sin((x * Math.PI) / 2) },
      ];
    }
  }
  return [{ index, gain: 1 }];
}

/** Cycles through sample variants per key ("instrument/layer"). */
export class RoundRobin {
  private readonly next = new Map<string, number>();

  pick(key: string, count: number): number {
    const i = (this.next.get(key) ?? 0) % Math.max(1, count);
    this.next.set(key, i + 1);
    return i;
  }
}
