import {
  BUTTONS,
  PAD_COLS,
  PAD_COUNT,
  PAD_ROWS,
  buttonColorMessages,
  buttonLedMessage,
  isAtomPortName,
  nativeModeMessage,
  parseAtomMessage,
  type ButtonDef,
  type ButtonId,
  type Rgb,
} from './atomMap';
import { LedFrameWriter, emptyFrame, type PadLed } from './ledFrame';
import type { ControllerEvent, ControllerStatus, HitLight, PadController } from './padController';
import { splitMidiMessages } from './split';
import { listInputs, listOutputs, sendAll } from './webMidi';

const BUTTON_BY_ID = new Map(BUTTONS.map((b) => [b.id, b]));

/** Automatic hit flash: white on a dark pad, otherwise the base colour pushed towards white. */
export function autoHitLight(base: PadLed): PadLed {
  if (!(base.r || base.g || base.b)) return { r: 110, g: 110, b: 110 };
  const k = 0.6;
  return { r: base.r + (127 - base.r) * k, g: base.g + (127 - base.g) * k, b: base.b + (127 - base.b) * k };
}

/**
 * PreSonus ATOM in native control mode: port discovery, hot-plug, native mode
 * enter/exit around page visibility, LED output and decoded input.
 */
export class AtomDriver implements PadController {
  readonly rows = PAD_ROWS;
  readonly cols = PAD_COLS;
  status: ControllerStatus = { connected: false, native: false, nativeConfirmed: false, portName: null };

  private input: MIDIInput | null = null;
  private output: MIDIOutput | null = null;
  private readonly writer: LedFrameWriter;
  private base: PadLed[] = emptyFrame();
  private hit: HitLight[] = Array.from({ length: PAD_COUNT }, () => 'auto' as HitLight);
  private readonly held = new Set<number>();
  private setupHeld = false;
  private readonly buttonLights = new Map<ButtonId, boolean | Rgb>();
  private brightness = 1;
  private readonly eventListeners = new Set<(e: ControllerEvent) => void>();
  private readonly statusListeners = new Set<(s: ControllerStatus) => void>();

  constructor(private readonly access: MIDIAccess | null) {
    this.writer = new LedFrameWriter((batch) => {
      if (this.output) sendAll(this.output, batch);
    });
    this.writer.mode = 'minimal';
    if (!access) return;

    access.addEventListener('statechange', () => this.bind());
    window.addEventListener('pagehide', () => this.setNative(false));
    window.addEventListener('pageshow', () => this.setNative(true));
    document.addEventListener('visibilitychange', () => this.setNative(document.visibilityState === 'visible'));
    this.bind();
  }

  onEvent(cb: (e: ControllerEvent) => void): () => void {
    this.eventListeners.add(cb);
    return () => this.eventListeners.delete(cb);
  }

  onStatus(cb: (s: ControllerStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => this.statusListeners.delete(cb);
  }

  // -------------------------------------------------------------------------
  // LEDs
  // -------------------------------------------------------------------------
  setPad(pad: number, led: PadLed): void {
    this.base[pad] = { ...led };
    if (!this.held.has(pad)) this.writer.setPad(pad, led);
  }

  setPads(leds: readonly PadLed[]): void {
    leds.forEach((led, pad) => this.setPad(pad, led));
  }

  setHitLight(pad: number, light: HitLight): void {
    this.hit[pad] = light;
  }

  setAllHitLights(light: HitLight): void {
    this.hit.fill(light);
  }

  setButtonLight(id: ButtonId, light: boolean | Rgb): void {
    this.buttonLights.set(id, light);
    const def = BUTTON_BY_ID.get(id);
    if (def) this.sendButtonLight(def, light);
  }

  setBrightness(k: number): void {
    this.brightness = k;
    this.writer.brightness = k;
    this.writer.setFrame(this.currentFrame());
  }

  reset(): void {
    this.base = emptyFrame();
    this.hit.fill('auto');
    this.writer.setFrame(this.currentFrame());
    for (const b of BUTTONS) this.setButtonLight(b.id, false);
  }

  private currentFrame(): PadLed[] {
    return this.base.map((b, pad) => (this.held.has(pad) ? this.hitLed(pad) ?? b : b));
  }

  private hitLed(pad: number): PadLed | null {
    const h = this.hit[pad]!;
    if (h === 'none') return null;
    return h === 'auto' ? autoHitLight(this.base[pad]!) : h;
  }

  private sendButtonLight(def: ButtonDef, light: boolean | Rgb): void {
    if (!this.output) return;
    if (typeof light === 'boolean') {
      // RGB buttons hold their last colour; clear it when going plain bright/dim.
      if (def.led === 'rgb') sendAll(this.output, buttonColorMessages(def.cc, light ? { r: 127, g: 127, b: 127 } : { r: 0, g: 0, b: 0 }));
      else this.output.send(buttonLedMessage(def.cc, light) as number[]);
    } else if (def.led === 'rgb') {
      const k = Math.max(this.brightness, 0.5); // button LEDs are small; keep them readable
      sendAll(this.output, buttonColorMessages(def.cc, { r: light.r * k, g: light.g * k, b: light.b * k }));
    } else {
      this.output.send(buttonLedMessage(def.cc, true) as number[]);
    }
  }

  // -------------------------------------------------------------------------
  // Ports and native mode
  // -------------------------------------------------------------------------
  private bind(): void {
    if (!this.access) return;
    const input = listInputs(this.access).find((p) => p.state === 'connected' && isAtomPortName(p.name)) ?? null;
    const output = listOutputs(this.access).find((p) => p.state === 'connected' && isAtomPortName(p.name)) ?? null;
    if (input !== this.input) {
      if (this.input) this.input.onmidimessage = null;
      this.input = input;
      if (input) input.onmidimessage = (e) => this.onMidi(e);
    }
    const outputChanged = output !== this.output;
    this.output = output;
    const connected = Boolean(input && output);
    if (!connected) {
      this.held.clear();
      this.setupHeld = false;
    }
    this.update({ connected, portName: input?.name ?? null, ...(outputChanged ? { native: false, nativeConfirmed: false } : {}) });
    if (connected && outputChanged && document.visibilityState === 'visible') this.setNative(true);
  }

  private setNative(on: boolean): void {
    if (!this.output || this.status.native === on) return;
    this.output.send(nativeModeMessage(on) as number[]);
    this.update({ native: on, nativeConfirmed: false });
    if (on) {
      // The device's LED state is unknown after (re-)entering: resend everything.
      this.writer.invalidate();
      for (const [id, light] of this.buttonLights) {
        const def = BUTTON_BY_ID.get(id);
        if (def) this.sendButtonLight(def, light);
      }
    }
  }

  private update(patch: Partial<ControllerStatus>): void {
    this.status = { ...this.status, ...patch };
    for (const cb of this.statusListeners) cb(this.status);
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  private onMidi(e: MIDIMessageEvent): void {
    if (!e.data) return;
    for (const m of splitMidiMessages(e.data)) this.handle(m, e.timeStamp);
  }

  private handle(data: number[], t: number): void {
    if (data[0] === 0xbf && data[1] === 0x7f) {
      // Most likely the native-mode acknowledgement (docs/atom-protocol.md, 4a).
      this.update({ nativeConfirmed: data[2] === 0x7f });
      return;
    }
    const msg = parseAtomMessage(data);
    switch (msg.kind) {
      case 'padDown': {
        if (this.setupHeld) return; // the device's own settings menu
        this.held.add(msg.pad);
        // LED feedback first, before anything else runs.
        const led = this.hitLed(msg.pad);
        if (led) {
          this.writer.setPad(msg.pad, led);
          this.writer.flushNow();
        }
        this.emit({ type: 'padDown', pad: msg.pad, velocity: msg.velocity, t });
        return;
      }
      case 'padUp':
        // Only real releases: the Setup button flushes note-offs for all 16 pads.
        if (!this.held.delete(msg.pad)) return;
        this.writer.setPad(msg.pad, this.base[msg.pad]!);
        this.emit({ type: 'padUp', pad: msg.pad, t });
        return;
      case 'padPressure':
        if (this.held.has(msg.pad)) this.emit({ type: 'padPressure', pad: msg.pad, value: msg.value, t });
        return;
      case 'channelPressure':
      case 'ccPressure':
        for (const pad of this.held) this.emit({ type: 'padPressure', pad, value: msg.value, t });
        return;
      case 'button':
        if (msg.button.id === 'setup') this.setupHeld = msg.down;
        this.emit({ type: 'button', id: msg.button.id, down: msg.down, t });
        return;
      case 'encoder':
        this.emit({ type: 'encoder', id: msg.index, delta: msg.delta, t });
        return;
      case 'unknown':
        return;
    }
  }

  private emit(e: ControllerEvent): void {
    for (const cb of this.eventListeners) cb(e);
  }
}
