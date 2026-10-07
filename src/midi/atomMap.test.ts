import { describe, expect, it } from 'vitest';
import {
  BUTTONS,
  CORNER_PADS,
  buttonColorMessages,
  encoderDelta,
  isAtomPortName,
  nativeModeMessage,
  noteToPad,
  padAt,
  padColorMessages,
  padPosition,
  padToNote,
  parseAtomMessage,
} from './atomMap';

describe('native mode', () => {
  it('enter/exit is Note Off ch16 note 0 vel 127/0', () => {
    expect(nativeModeMessage(true)).toEqual([0x8f, 0, 127]);
    expect(nativeModeMessage(false)).toEqual([0x8f, 0, 0]);
  });
});

describe('pad mapping', () => {
  it('maps pads 0..15 to notes 36..51 and back', () => {
    for (let pad = 0; pad < 16; pad++) expect(noteToPad(padToNote(pad))).toBe(pad);
    expect(padToNote(0)).toBe(36);
    expect(padToNote(15)).toBe(51);
    expect(noteToPad(35)).toBeNull();
    expect(noteToPad(52)).toBeNull();
  });

  it('pad 0 is bottom-left, pad 15 is top-right', () => {
    expect(padPosition(0)).toEqual({ row: 0, col: 0 });
    expect(padPosition(3)).toEqual({ row: 0, col: 3 });
    expect(padPosition(15)).toEqual({ row: 3, col: 3 });
    expect(padAt(3, 0)).toBe(12);
  });

  it('corner pads are the four corners', () => {
    expect([...CORNER_PADS].sort((a, b) => a - b)).toEqual([0, 3, 12, 15]);
  });
});

describe('pad LED messages', () => {
  it('sends R, G, B on ch2/3/4 then state 127 on ch1', () => {
    expect(padColorMessages(0, { r: 127, g: 64, b: 0 })).toEqual([
      [0x91, 36, 127],
      [0x92, 36, 64],
      [0x93, 36, 0],
      [0x90, 36, 127],
    ]);
  });

  it('black turns the pad off and values are clamped', () => {
    const msgs = padColorMessages(15, { r: -5, g: 0, b: 0 });
    expect(msgs[0]).toEqual([0x91, 51, 0]);
    expect(msgs[3]).toEqual([0x90, 51, 0]);
    expect(padColorMessages(1, { r: 300, g: 0, b: 0 })[0]).toEqual([0x91, 37, 127]);
  });

  it('accepts an explicit state value', () => {
    expect(padColorMessages(2, { r: 10, g: 10, b: 10 }, 1)[3]).toEqual([0x90, 38, 1]);
  });
});

describe('buttons', () => {
  it('has 20 buttons with unique CCs', () => {
    expect(BUTTONS).toHaveLength(20);
    expect(new Set(BUTTONS.map((b) => b.cc)).size).toBe(20);
  });

  it('rgb button colour uses CC on ch2/3/4 then bright', () => {
    expect(buttonColorMessages(109, { r: 0, g: 0, b: 127 })).toEqual([
      [0xb1, 109, 0],
      [0xb2, 109, 0],
      [0xb3, 109, 127],
      [0xb0, 109, 127],
    ]);
  });
});

describe('encoders', () => {
  it('decodes relative values', () => {
    expect(encoderDelta(1)).toBe(1);
    expect(encoderDelta(6)).toBe(6);
    expect(encoderDelta(63)).toBe(63);
    expect(encoderDelta(65)).toBe(-1);
    expect(encoderDelta(70)).toBe(-6);
    expect(encoderDelta(127)).toBe(-63);
  });
});

describe('parseAtomMessage', () => {
  it('pad down / up (note off and note on vel 0)', () => {
    expect(parseAtomMessage([0x90, 36, 100])).toEqual({ kind: 'padDown', pad: 0, velocity: 100 });
    expect(parseAtomMessage([0x90, 51, 0])).toEqual({ kind: 'padUp', pad: 15 });
    expect(parseAtomMessage([0x80, 40, 64])).toEqual({ kind: 'padUp', pad: 4 });
  });

  it('pressure variants', () => {
    expect(parseAtomMessage([0xa0, 37, 90])).toEqual({ kind: 'padPressure', pad: 1, value: 90 });
    expect(parseAtomMessage([0xd0, 55])).toEqual({ kind: 'channelPressure', value: 55 });
    expect(parseAtomMessage([0xb0, 22, 33])).toEqual({ kind: 'ccPressure', value: 33 });
  });

  it('buttons and encoders', () => {
    const play = parseAtomMessage([0xb0, 109, 127]);
    expect(play.kind === 'button' && play.button.id === 'play' && play.down).toBe(true);
    const up = parseAtomMessage([0xb0, 109, 0]);
    expect(up.kind === 'button' && !up.down).toBe(true);
    expect(parseAtomMessage([0xb0, 16, 66])).toEqual({ kind: 'encoder', index: 2, delta: -2 });
  });

  it('unknown messages', () => {
    expect(parseAtomMessage([0x90, 60, 100])).toEqual({ kind: 'unknown' });
    expect(parseAtomMessage([0xb0, 1, 1])).toEqual({ kind: 'unknown' });
    expect(parseAtomMessage([0xf8])).toEqual({ kind: 'unknown' });
  });
});

describe('isAtomPortName', () => {
  it('matches ATOM but not ATOM SQ or others', () => {
    expect(isAtomPortName('ATOM')).toBe(true);
    expect(isAtomPortName('ATOM MIDI 1')).toBe(true);
    expect(isAtomPortName('PreSonus ATOM')).toBe(true);
    expect(isAtomPortName('ATOM SQ')).toBe(false);
    expect(isAtomPortName('Atomic Synth')).toBe(false);
    expect(isAtomPortName(null)).toBe(false);
  });
});
