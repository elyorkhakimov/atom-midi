import type { ButtonId, Rgb } from './atomMap';
import type { PadLed } from './ledFrame';

/**
 * Raw controller events, before calibration. `t` is the MIDI event timestamp
 * (performance.now() domain), never the time the handler ran.
 */
export type ControllerEvent =
  | { type: 'padDown'; pad: number; velocity: number; t: number }
  | { type: 'padUp'; pad: number; t: number }
  | { type: 'padPressure'; pad: number; value: number; t: number }
  | { type: 'button'; id: ButtonId; down: boolean; t: number }
  | { type: 'encoder'; id: number; delta: number; t: number };

export interface ControllerStatus {
  connected: boolean;
  /** Native mode requested (enter message sent). */
  native: boolean;
  /** Device answered the enter message (BF 7F 7F seen). */
  nativeConfirmed: boolean;
  portName: string | null;
}

/** What a pad shows while pressed: a colour, the automatic flash, or no change. */
export type HitLight = PadLed | 'auto' | 'none';

/**
 * A pad controller with a 4x4 RGB grid, buttons and encoders. The ATOM is the only
 * implementation for now; others (MPD218, Maschine via WebHID) can be added later.
 */
export interface PadController {
  readonly rows: number;
  readonly cols: number;
  readonly status: ControllerStatus;
  onEvent(cb: (e: ControllerEvent) => void): () => void;
  onStatus(cb: (s: ControllerStatus) => void): () => void;
  /** Base light of a pad (shown when not pressed). */
  setPad(pad: number, led: PadLed): void;
  setPads(leds: readonly PadLed[]): void;
  /** Light shown while a pad is held; sent before any other work on a hit. */
  setHitLight(pad: number, light: HitLight): void;
  setAllHitLights(light: HitLight): void;
  /** `true`/`false` = bright/dim; a colour lights RGB buttons in that colour. */
  setButtonLight(id: ButtonId, light: boolean | Rgb): void;
  /** 0..1 cap applied to every pad colour. */
  setBrightness(k: number): void;
  /** Base lights off, hit lights back to auto, button lights dim. */
  reset(): void;
}
