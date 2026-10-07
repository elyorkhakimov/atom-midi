import { isAtomPortName, type MidiBytes } from './atomMap';

export function webMidiSupported(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}

/** No SysEx: the ATOM's native mode only needs channel messages. */
export async function requestMidi(): Promise<MIDIAccess> {
  if (!webMidiSupported()) {
    throw new Error('Web MIDI is not available in this browser. Use Chrome or Edge (Safari is unsupported).');
  }
  if (!window.isSecureContext) {
    throw new Error('Web MIDI needs a secure context (https or localhost).');
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

export function sendAll(output: MIDIOutput, messages: readonly MidiBytes[]): void {
  for (const m of messages) output.send(m as number[]);
}

export function portLabel(p: MIDIPort): string {
  return `${p.name ?? '(unnamed)'}${p.manufacturer ? ` — ${p.manufacturer}` : ''}`;
}
