import {
  NOTE_ON,
  PAD_COUNT,
  PAD_LED_BLUE_CHANNEL,
  PAD_LED_GREEN_CHANNEL,
  PAD_LED_RED_CHANNEL,
  PAD_LED_STATE,
  PAD_LED_STATE_CHANNEL,
  clamp7,
  padColorMessages,
  padToNote,
  type MidiBytes,
  type Rgb,
} from './atomMap';

/** A pad's LED: colour plus an optional hardware animation (blink/breathe verified on our unit). */
export interface PadLed extends Rgb {
  mode?: 'solid' | 'blink' | 'breathe';
}

export type PadFrame = readonly PadLed[];

export const BLACK: Rgb = { r: 0, g: 0, b: 0 };

export function emptyFrame(): PadLed[] {
  return Array.from({ length: PAD_COUNT }, () => ({ ...BLACK }));
}

function quantize(c: PadLed): Required<PadLed> {
  return { r: clamp7(c.r), g: clamp7(c.g), b: clamp7(c.b), mode: c.mode ?? 'solid' };
}

function stateOf(c: Required<PadLed>): number {
  return c.r || c.g || c.b ? PAD_LED_STATE[c.mode] : PAD_LED_STATE.off;
}

/**
 * Messages that turn `prev` into `next`. Unchanged pads produce nothing.
 *
 * - `full` (default): all 4 messages for every changed pad.
 * - `minimal`: only the changed colour components, plus the state message when the
 *   state changes (on/off/blink/breathe). Verified on hardware 2026-10-07.
 */
export function diffPadFrame(
  prev: PadFrame | null,
  next: PadFrame,
  mode: 'full' | 'minimal' = 'full',
): MidiBytes[] {
  const out: MidiBytes[] = [];
  for (let pad = 0; pad < PAD_COUNT; pad++) {
    const n = quantize(next[pad] ?? BLACK);
    const p = prev ? quantize(prev[pad] ?? BLACK) : null;
    if (p && p.r === n.r && p.g === n.g && p.b === n.b && stateOf(p) === stateOf(n)) continue;

    if (mode === 'full' || !p) {
      out.push(...padColorMessages(pad, n, stateOf(n)));
      continue;
    }
    const note = padToNote(pad);
    if (p.r !== n.r) out.push([NOTE_ON | PAD_LED_RED_CHANNEL, note, n.r]);
    if (p.g !== n.g) out.push([NOTE_ON | PAD_LED_GREEN_CHANNEL, note, n.g]);
    if (p.b !== n.b) out.push([NOTE_ON | PAD_LED_BLUE_CHANNEL, note, n.b]);
    if (stateOf(p) !== stateOf(n)) out.push([NOTE_ON | PAD_LED_STATE_CHANNEL, note, stateOf(n)]);
  }
  return out;
}

/** Scales a colour by a 0..1 brightness cap. */
export function scaleRgb<T extends Rgb>(c: T, k: number): T {
  return { ...c, r: c.r * k, g: c.g * k, b: c.b * k };
}

/**
 * Holds the desired pad colours and flushes only the differences, at most once per
 * scheduled frame. `flushNow()` bypasses the frame wait (use it for hit feedback).
 * Each flush is handed to `send` as one batch so it can go out in a single
 * `MIDIOutput.send()` (one USB packet stream instead of one call per message).
 */
export class LedFrameWriter {
  private sent: PadLed[] | null = null;
  private desired: PadLed[] = emptyFrame();
  private scheduled = false;
  mode: 'full' | 'minimal' = 'full';
  brightness = 1;
  /** Total messages sent, for rate measurement. */
  messageCount = 0;

  constructor(
    private readonly send: (batch: MidiBytes[]) => void,
    private readonly schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(cb),
  ) {}

  setPad(pad: number, color: PadLed): void {
    this.desired[pad] = { ...color };
    this.requestFlush();
  }

  setFrame(frame: PadFrame, flush = true): void {
    this.desired = frame.map((c) => ({ ...c }));
    if (flush) this.requestFlush();
  }

  /** Forget what the device shows (e.g. after reconnect); the next flush resends everything. */
  invalidate(flush = true): void {
    this.sent = null;
    if (flush) this.requestFlush();
  }

  flushNow(): void {
    const target = this.desired.map((c) => quantize(scaleRgb(c, this.brightness)));
    const msgs = diffPadFrame(this.sent, target, this.mode);
    if (msgs.length) this.send(msgs);
    this.messageCount += msgs.length;
    this.sent = target;
  }

  private requestFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flushNow();
    });
  }
}
