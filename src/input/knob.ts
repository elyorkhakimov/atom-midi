/**
 * Turns raw encoder ticks into coarser steps, so a small turn of an ATOM knob
 * doesn't jump several values. Reversing direction starts counting afresh.
 */
export class KnobDetents {
  private readonly acc = new Map<number, number>();

  /** Steps to apply for this event (often 0); `ticksPerStep` ticks make one step. */
  step(knob: number, delta: number, ticksPerStep: number): number {
    const d = Math.sign(delta) * Math.min(2, Math.abs(delta)); // ignore the ATOM's acceleration
    let a = this.acc.get(knob) ?? 0;
    if (Math.sign(a) !== Math.sign(d)) a = 0;
    a += d;
    const steps = Math.trunc(a / ticksPerStep) + 0; // + 0 turns -0 into 0
    this.acc.set(knob, a - steps * ticksPerStep);
    return steps;
  }
}
