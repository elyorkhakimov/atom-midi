/** Generic, controller-independent MIDI message formatting (for monitors and logs). */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteName(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 1}`;
}

export function toHex(data: ArrayLike<number>): string {
  return Array.from(data, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

/** Human-readable description; channels shown 1-based as on hardware. */
export function describeMidi(data: ArrayLike<number>): string {
  const status = data[0] ?? 0;
  const d1 = data[1] ?? 0;
  const d2 = data[2] ?? 0;
  const ch = (status & 0x0f) + 1;
  switch (status & 0xf0) {
    case 0x80:
      return `Note Off  ch${ch} note ${d1} (${noteName(d1)}) vel ${d2}`;
    case 0x90:
      return d2 === 0
        ? `Note On   ch${ch} note ${d1} (${noteName(d1)}) vel 0 (=off)`
        : `Note On   ch${ch} note ${d1} (${noteName(d1)}) vel ${d2}`;
    case 0xa0:
      return `Poly AT   ch${ch} note ${d1} (${noteName(d1)}) pressure ${d2}`;
    case 0xb0:
      return `CC        ch${ch} cc ${d1} value ${d2}`;
    case 0xc0:
      return `Program   ch${ch} ${d1}`;
    case 0xd0:
      return `Chan AT   ch${ch} pressure ${d1}`;
    case 0xe0:
      return `Pitch     ch${ch} ${((d2 << 7) | d1) - 8192}`;
    case 0xf0:
      return systemName(status);
    default:
      return 'Data (running status?)';
  }
}

function systemName(status: number): string {
  switch (status) {
    case 0xf0: return 'SysEx';
    case 0xf8: return 'Clock';
    case 0xfa: return 'Start';
    case 0xfb: return 'Continue';
    case 0xfc: return 'Stop';
    case 0xfe: return 'Active Sensing';
    case 0xff: return 'Reset';
    default: return `System 0x${status.toString(16)}`;
  }
}
