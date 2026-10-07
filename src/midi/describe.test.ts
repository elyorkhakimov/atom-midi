import { describe, expect, it } from 'vitest';
import { describeMidi, noteName, toHex } from './describe';

describe('describe', () => {
  it('formats hex', () => expect(toHex([0x90, 36, 127])).toBe('90 24 7F'));
  it('names notes', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(36)).toBe('C2');
  });
  it('describes messages with 1-based channels', () => {
    expect(describeMidi([0x8f, 0, 127])).toMatch(/^Note Off\s+ch16 note 0/);
    expect(describeMidi([0xa0, 40, 10])).toMatch(/^Poly AT\s+ch1 note 40/);
    expect(describeMidi([0xe0, 0, 64])).toMatch(/^Pitch\s+ch1 0$/);
  });
});
