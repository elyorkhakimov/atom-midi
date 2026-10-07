import { describe, expect, it } from 'vitest';
import { splitMidiMessages } from './split';

describe('splitMidiMessages', () => {
  it('passes a single message through', () => {
    expect(splitMidiMessages([0xb0, 14, 1])).toEqual([[0xb0, 14, 1]]);
  });
  it('splits packed messages', () => {
    expect(splitMidiMessages([0xb0, 14, 1, 0xb0, 14, 1, 0x90, 36, 100])).toEqual([
      [0xb0, 14, 1],
      [0xb0, 14, 1],
      [0x90, 36, 100],
    ]);
  });
  it('expands running status', () => {
    expect(splitMidiMessages([0xb0, 14, 1, 14, 2, 15, 65])).toEqual([
      [0xb0, 14, 1],
      [0xb0, 14, 2],
      [0xb0, 15, 65],
    ]);
  });
  it('handles 2-byte messages and interleaved real-time bytes', () => {
    expect(splitMidiMessages([0xd0, 40, 0xf8, 50])).toEqual([[0xd0, 40], [0xf8], [0xd0, 50]]);
  });
  it('skips sysex and stray data', () => {
    expect(splitMidiMessages([5, 0xf0, 1, 2, 3, 0xf7, 0x80, 36, 0])).toEqual([[0x80, 36, 0]]);
  });
});
