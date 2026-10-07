/**
 * Splits raw MIDI bytes into complete messages. A Web MIDI event should hold exactly
 * one message, but we don't rely on it: Chrome on Android is suspected of packing
 * several (knob steps went missing on a OnePlus 12). Handles running status,
 * interleaved real-time bytes, and skips SysEx.
 */
export function splitMidiMessages(data: ArrayLike<number>): number[][] {
  const out: number[][] = [];
  let running = 0;
  let cur: number[] = [];
  let need = 0;
  let inSysex = false;

  for (let i = 0; i < data.length; i++) {
    const b = data[i]!;
    if (b >= 0xf8) {
      out.push([b]); // real-time: may appear anywhere, doesn't affect running status
      continue;
    }
    if (inSysex) {
      if (b === 0xf7) inSysex = false;
      continue;
    }
    if (b & 0x80) {
      if (b === 0xf0) {
        inSysex = true;
        running = 0;
        cur = [];
        continue;
      }
      cur = [b];
      need = dataLength(b);
      running = b < 0xf0 ? b : 0;
    } else {
      if (cur.length === 0) {
        if (!running) continue; // stray data byte
        cur = [running];
        need = dataLength(running);
      }
      cur.push(b);
    }
    if (cur.length === need + 1) {
      out.push(cur);
      cur = [];
    }
  }
  return out;
}

function dataLength(status: number): number {
  switch (status & 0xf0) {
    case 0xc0:
    case 0xd0:
      return 1;
    case 0xf0:
      return status === 0xf1 || status === 0xf3 ? 1 : status === 0xf2 ? 2 : 0;
    default:
      return 2;
  }
}
