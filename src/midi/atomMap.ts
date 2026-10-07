/**
 * PreSonus ATOM (original, not ATOM SQ) — native control mode protocol map.
 *
 * Sources: gregsadetsky/atompad (verified on fw 3.00), uermel/padbound,
 * EMATech/AtomCtrl, kmitch95120/Reaper-ATOM-Integration.
 * Status of each fact (verified on our hardware or not) lives in docs/atom-protocol.md.
 *
 * Channels below are 0-based (0 = "MIDI channel 1"). Pure data and functions only,
 * no Web MIDI calls, so this is unit-testable and portable.
 */

export type MidiBytes = readonly number[];

// ---------------------------------------------------------------------------
// Status bytes
// ---------------------------------------------------------------------------
export const NOTE_OFF = 0x80;
export const NOTE_ON = 0x90;
export const POLY_AFTERTOUCH = 0xa0;
export const CONTROL_CHANGE = 0xb0;
export const CHANNEL_AFTERTOUCH = 0xd0;

// ---------------------------------------------------------------------------
// Native control mode: Note Off, channel 16 (0-based 15), note 0.
// ---------------------------------------------------------------------------
export const NATIVE_MODE_CHANNEL = 15;
export const NATIVE_MODE_NOTE = 0;

export function nativeModeMessage(enter: boolean): MidiBytes {
  return [NOTE_OFF | NATIVE_MODE_CHANNEL, NATIVE_MODE_NOTE, enter ? 127 : 0];
}

// ---------------------------------------------------------------------------
// Pads: 16 notes, 36..51. Pad index 0 = bottom-left, 15 = top-right, row-major
// from the bottom (index = row * 4 + col, row 0 = bottom row).
// ---------------------------------------------------------------------------
export const PAD_COUNT = 16;
export const PAD_COLS = 4;
export const PAD_ROWS = 4;
export const FIRST_PAD_NOTE = 36;

export function padToNote(pad: number): number {
  return FIRST_PAD_NOTE + pad;
}

/** Returns the pad index (0..15) for a note, or null if the note isn't a pad. */
export function noteToPad(note: number): number | null {
  const pad = note - FIRST_PAD_NOTE;
  return pad >= 0 && pad < PAD_COUNT ? pad : null;
}

/** row 0 = bottom, col 0 = left. */
export function padPosition(pad: number): { row: number; col: number } {
  return { row: Math.floor(pad / PAD_COLS), col: pad % PAD_COLS };
}

export function padAt(row: number, col: number): number {
  return row * PAD_COLS + col;
}

/** Corner pads for 3–4 player games, in player order (red, blue, green, yellow). */
export const CORNER_PADS = [
  padAt(3, 0), // top-left
  padAt(3, 3), // top-right
  padAt(0, 0), // bottom-left
  padAt(0, 3), // bottom-right
] as const;

// ---------------------------------------------------------------------------
// Pad LEDs. The channel selects the component, velocity carries the value.
// ---------------------------------------------------------------------------
export const PAD_LED_STATE_CHANNEL = 0;
export const PAD_LED_RED_CHANNEL = 1;
export const PAD_LED_GREEN_CHANNEL = 2;
export const PAD_LED_BLUE_CHANNEL = 3;

/**
 * Values for the state message (ch 0). Hardware blink (1) and breathe (2) confirmed
 * on our unit (2026-10-07); other values 1–126 are off. atompad's fw 3.00 note differs.
 */
export const PAD_LED_STATE = {
  off: 0,
  blink: 1,
  breathe: 2,
  solid: 127,
} as const;

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export function clamp7(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

/** R, G, B and then the on/off state message (atompad order, verified on fw 3.00). */
export function padColorMessages(pad: number, { r, g, b }: Rgb, state?: number): MidiBytes[] {
  const note = padToNote(pad);
  const rr = clamp7(r);
  const gg = clamp7(g);
  const bb = clamp7(b);
  const s = state ?? (rr || gg || bb ? PAD_LED_STATE.solid : PAD_LED_STATE.off);
  return [
    [NOTE_ON | PAD_LED_RED_CHANNEL, note, rr],
    [NOTE_ON | PAD_LED_GREEN_CHANNEL, note, gg],
    [NOTE_ON | PAD_LED_BLUE_CHANNEL, note, bb],
    [NOTE_ON | PAD_LED_STATE_CHANNEL, note, s],
  ];
}

// ---------------------------------------------------------------------------
// Buttons: CC on channel 0, 127 = down, 0 = up. LEDs: same CC out,
// 127 = bright, 0 = dim. RGB buttons take R/G/B via the same CC on ch 1/2/3.
// ---------------------------------------------------------------------------
export type ButtonLed = 'mono' | 'rgb' | 'none';

export interface ButtonDef {
  id: ButtonId;
  cc: number;
  label: string;
  side: 'left' | 'right';
  led: ButtonLed;
}

export type ButtonId =
  | 'setup' | 'setLoop' | 'editor' | 'nudge' | 'showHide'
  | 'preset' | 'bank' | 'fullLevel' | 'noteRepeat' | 'shift'
  | 'up' | 'down' | 'left' | 'right' | 'select' | 'zoom'
  | 'click' | 'record' | 'play' | 'stop';

/**
 * In physical order, top to bottom: left column, then right column.
 * `led: 'rgb'` follows atompad; hardware shows more buttons accept RGB (list pending).
 */
export const BUTTONS: readonly ButtonDef[] = [
  { id: 'setup', cc: 86, label: 'Setup', side: 'left', led: 'mono' },
  { id: 'setLoop', cc: 85, label: 'Set Loop', side: 'left', led: 'mono' },
  { id: 'editor', cc: 31, label: 'Editor', side: 'left', led: 'mono' },
  { id: 'nudge', cc: 30, label: 'Nudge', side: 'left', led: 'mono' },
  { id: 'showHide', cc: 29, label: 'Show/Hide', side: 'left', led: 'mono' },
  { id: 'preset', cc: 27, label: 'Preset', side: 'left', led: 'rgb' },
  { id: 'bank', cc: 26, label: 'Bank', side: 'left', led: 'rgb' },
  { id: 'fullLevel', cc: 25, label: 'Full Level', side: 'left', led: 'mono' },
  { id: 'noteRepeat', cc: 24, label: 'Note Repeat', side: 'left', led: 'mono' },
  { id: 'shift', cc: 32, label: 'Shift', side: 'left', led: 'none' },
  { id: 'up', cc: 87, label: 'Up', side: 'right', led: 'mono' },
  { id: 'down', cc: 89, label: 'Down', side: 'right', led: 'mono' },
  { id: 'left', cc: 90, label: 'Left', side: 'right', led: 'mono' },
  { id: 'right', cc: 102, label: 'Right', side: 'right', led: 'mono' },
  { id: 'select', cc: 103, label: 'Select', side: 'right', led: 'mono' },
  { id: 'zoom', cc: 104, label: 'Zoom', side: 'right', led: 'mono' },
  { id: 'click', cc: 105, label: 'Click', side: 'right', led: 'mono' },
  { id: 'record', cc: 107, label: 'Record', side: 'right', led: 'mono' },
  { id: 'play', cc: 109, label: 'Play', side: 'right', led: 'rgb' },
  { id: 'stop', cc: 111, label: 'Stop', side: 'right', led: 'mono' },
];

const BUTTON_BY_CC = new Map(BUTTONS.map((b) => [b.cc, b]));

export function buttonByCc(cc: number): ButtonDef | undefined {
  return BUTTON_BY_CC.get(cc);
}

export function buttonLedMessage(cc: number, bright: boolean): MidiBytes {
  return [CONTROL_CHANGE, cc, bright ? 127 : 0];
}

export function buttonColorMessages(cc: number, { r, g, b }: Rgb): MidiBytes[] {
  const rr = clamp7(r);
  const gg = clamp7(g);
  const bb = clamp7(b);
  return [
    [CONTROL_CHANGE | 1, cc, rr],
    [CONTROL_CHANGE | 2, cc, gg],
    [CONTROL_CHANGE | 3, cc, bb],
    buttonLedMessage(cc, Boolean(rr || gg || bb)),
  ];
}

// ---------------------------------------------------------------------------
// Encoders: CC 14..17 on ch 0, relative with acceleration.
// 1..63 = +n steps (clockwise), 65..127 = -(value - 64) steps.
// ---------------------------------------------------------------------------
export const ENCODER_CCS = [14, 15, 16, 17] as const;

export function encoderIndex(cc: number): number | null {
  const i = cc - ENCODER_CCS[0];
  return i >= 0 && i < ENCODER_CCS.length ? i : null;
}

export function encoderDelta(value: number): number {
  return value < 64 ? value : 64 - value;
}

/** Pressure arrives as CC 22 when the device's pressure type is set to "CC". */
export const PRESSURE_CC = 22;

// ---------------------------------------------------------------------------
// Incoming message decoding
// ---------------------------------------------------------------------------
export type AtomMessage =
  | { kind: 'padDown'; pad: number; velocity: number }
  | { kind: 'padUp'; pad: number }
  | { kind: 'padPressure'; pad: number; value: number }
  | { kind: 'channelPressure'; value: number }
  | { kind: 'ccPressure'; value: number }
  | { kind: 'button'; button: ButtonDef; down: boolean }
  | { kind: 'encoder'; index: number; delta: number }
  | { kind: 'unknown' };

/** Decodes one incoming native-mode message. Pads are accepted on any channel. */
export function parseAtomMessage(data: ArrayLike<number>): AtomMessage {
  const status = data[0] ?? 0;
  const type = status & 0xf0;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;

  switch (type) {
    case NOTE_ON:
    case NOTE_OFF: {
      const pad = noteToPad(d1);
      if (pad === null) return { kind: 'unknown' };
      return type === NOTE_ON && d2 > 0 ? { kind: 'padDown', pad, velocity: d2 } : { kind: 'padUp', pad };
    }
    case POLY_AFTERTOUCH: {
      const pad = noteToPad(d1);
      return pad === null ? { kind: 'unknown' } : { kind: 'padPressure', pad, value: d2 };
    }
    case CHANNEL_AFTERTOUCH:
      return { kind: 'channelPressure', value: d1 };
    case CONTROL_CHANGE: {
      const enc = encoderIndex(d1);
      if (enc !== null) return { kind: 'encoder', index: enc, delta: encoderDelta(d2) };
      if (d1 === PRESSURE_CC) return { kind: 'ccPressure', value: d2 };
      const button = buttonByCc(d1);
      if (button) return { kind: 'button', button, down: d2 > 0 };
      return { kind: 'unknown' };
    }
    default:
      return { kind: 'unknown' };
  }
}

/** Port name match. Chrome on macOS reports "ATOM"; Android/ChromeOS names may differ. */
export function isAtomPortName(name: string | null | undefined): boolean {
  return Boolean(name && /\batom\b/i.test(name) && !/\bsq\b/i.test(name));
}
