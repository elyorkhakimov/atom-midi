import { nativeBridge } from '../native/bridge';
import { nativeMidiAccess } from '../native/nativeMidi';
import { isAtomPortName, type MidiBytes } from './atomMap';

export function webMidiSupported(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}

/** No SysEx: the ATOM's native mode only needs channel messages. */
export async function requestMidi(): Promise<MIDIAccess> {
  // Android app: the ATOM is opened natively (Android WebView has no Web MIDI).
  if (nativeBridge) return nativeMidiAccess(nativeBridge);
  // Checked first: Chrome hides requestMIDIAccess entirely on insecure origins
  // (e.g. http://192.168.x.x), which otherwise looks like "browser unsupported".
  if (!window.isSecureContext) {
    throw new Error(
      `Web MIDI needs a secure context, and ${location.origin} isn't one. ` +
        'Open the page as https://… or http://localhost (on a phone: adb reverse tcp:5173 tcp:5173, then localhost:5173).',
    );
  }
  if (!webMidiSupported()) {
    throw new Error('Web MIDI is not available in this browser. Use Chrome or Edge (Safari is unsupported).');
  }
  return navigator.requestMIDIAccess({ sysex: false });
}

export function listInputs(access: MIDIAccess): MIDIInput[] {
  return [...access.inputs.values()];
}

export function listOutputs(access: MIDIAccess): MIDIOutput[] {
  return [...access.outputs.values()];
}

export interface AtomPorts {
  input: MIDIInput;
  output: MIDIOutput;
}

/** First connected input/output pair whose names look like an ATOM. */
export function findAtomPorts(access: MIDIAccess): AtomPorts | null {
  const input = listInputs(access).find((p) => p.state === 'connected' && isAtomPortName(p.name));
  const output = listOutputs(access).find((p) => p.state === 'connected' && isAtomPortName(p.name));
  return input && output ? { input, output } : null;
}

/** Sends several complete messages in one `send()` call (allowed by the Web MIDI spec). */
export function sendAll(output: MIDIOutput, messages: readonly MidiBytes[]): void {
  if (messages.length) output.send(messages.flat());
}

export function portLabel(p: MIDIPort): string {
  return `${p.name ?? '(unnamed)'}${p.manufacturer ? ` — ${p.manufacturer}` : ''}`;
}
