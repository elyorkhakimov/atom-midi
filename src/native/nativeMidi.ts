/**
 * A minimal Web MIDI stand-in backed by the native app, so AtomDriver runs unchanged:
 * one input and one output named after the device, `statechange` on (dis)connect, and
 * `onmidimessage` events whose `timeStamp` is the native timestamp in performance.now() ms.
 * New port objects are created on every connect, so the driver re-enters native mode.
 */
import type { nativeBridge as Bridge } from './bridge';

type NativeBridge = NonNullable<typeof Bridge>;

class NativePort extends EventTarget {
  state: MIDIPortDeviceState = 'connected';
  readonly connection: MIDIPortConnectionState = 'open';
  readonly manufacturer = 'PreSonus';
  readonly version = '';
  constructor(
    readonly id: string,
    readonly name: string,
    readonly type: MIDIPortType,
  ) {
    super();
  }
  open(): Promise<this> {
    return Promise.resolve(this);
  }
  close(): Promise<this> {
    return Promise.resolve(this);
  }
}

class NativeInput extends NativePort {
  onmidimessage: ((e: MIDIMessageEvent) => void) | null = null;
  onstatechange = null;
  deliver(bytes: number[], timeStamp: number): void {
    const e = { data: new Uint8Array(bytes), timeStamp, type: 'midimessage' } as unknown as MIDIMessageEvent;
    this.onmidimessage?.(e);
  }
}

class NativeOutput extends NativePort {
  onstatechange = null;
  constructor(
    id: string,
    name: string,
    private readonly bridge: NativeBridge,
  ) {
    super(id, name, 'output');
  }
  send(data: number[] | Uint8Array): void {
    if (this.state === 'connected' && data.length) this.bridge.api.midiSend(Array.from(data).join(','));
  }
  clear(): void {}
}

export function nativeMidiAccess(bridge: NativeBridge): MIDIAccess {
  const access = new EventTarget() as EventTarget & {
    inputs: Map<string, NativeInput>;
    outputs: Map<string, NativeOutput>;
    sysexEnabled: boolean;
    onstatechange: null;
  };
  access.inputs = new Map();
  access.outputs = new Map();
  access.sysexEnabled = false;
  access.onstatechange = null;
  let serial = 0;
  let input: NativeInput | null = null;

  const setState = (connected: boolean, name: string) => {
    for (const p of [...access.inputs.values(), ...access.outputs.values()]) p.state = 'disconnected';
    access.inputs.clear();
    access.outputs.clear();
    input = null;
    if (connected) {
      serial++;
      input = new NativeInput(`native-in-${serial}`, name || 'ATOM', 'input');
      access.inputs.set(input.id, input);
      const output = new NativeOutput(`native-out-${serial}`, name || 'ATOM', bridge);
      access.outputs.set(output.id, output);
    }
    access.dispatchEvent(new Event('statechange'));
  };

  bridge.onMidi = (bytes, t) => input?.deliver(bytes, t);
  bridge.onMidiState = setState;
  const { midi } = bridge.status();
  if (midi.connected) setState(true, midi.name ?? 'ATOM');
  return access as unknown as MIDIAccess;
}
