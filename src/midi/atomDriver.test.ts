import { beforeAll, describe, expect, it } from 'vitest';
import { AtomDriver, autoHitLight } from './atomDriver';
import type { ControllerEvent } from './padController';

beforeAll(() => {
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => setTimeout(() => cb(0), 0)) as typeof requestAnimationFrame;
});

/** Drives the decoder without Web MIDI (no access = no ports). */
function setup() {
  const driver = new AtomDriver(null);
  const events: ControllerEvent[] = [];
  driver.onEvent((e) => events.push(e));
  const send = (bytes: number[], t = 100) => (driver as unknown as { handle(d: number[], t: number): void }).handle(bytes, t);
  return { driver, events, send };
}

describe('AtomDriver input', () => {
  it('ignores the Setup button note-off flush for pads that are not held', () => {
    const { events, send } = setup();
    send([0x90, 36, 100], 10); // pad 0 down
    send([0xb0, 86, 127], 20); // Setup down
    for (let note = 36; note <= 51; note++) send([0x89, note, 0], 21); // flush on ch 10
    expect(events.map((e) => e.type)).toEqual(['padDown', 'button', 'padUp']);
    expect(events[2]).toEqual({ type: 'padUp', pad: 0, t: 21 });
  });

  it('suppresses pad hits while Setup is held (device settings menu)', () => {
    const { events, send } = setup();
    send([0xb0, 86, 127]);
    send([0x90, 42, 90]);
    send([0x80, 42, 0]);
    send([0xb0, 86, 0]);
    send([0x90, 42, 90]);
    expect(events.filter((e) => e.type === 'padDown')).toHaveLength(1);
  });

  it('spreads channel pressure to held pads and keeps poly pressure per pad', () => {
    const { events, send } = setup();
    send([0x90, 36, 100]);
    send([0x90, 37, 100]);
    send([0xd0, 50]);
    send([0xa0, 37, 70]);
    send([0xa0, 40, 70]); // not held: ignored
    expect(events.filter((e) => e.type === 'padPressure')).toEqual([
      { type: 'padPressure', pad: 0, value: 50, t: 100 },
      { type: 'padPressure', pad: 1, value: 50, t: 100 },
      { type: 'padPressure', pad: 1, value: 70, t: 100 },
    ]);
  });

  it('marks native mode confirmed on BF 7F 7F and emits nothing', () => {
    const { driver, events, send } = setup();
    send([0xbf, 0x7f, 0x7f]);
    expect(driver.status.nativeConfirmed).toBe(true);
    expect(events).toEqual([]);
  });

  it('decodes encoders and buttons', () => {
    const { events, send } = setup();
    send([0xb0, 15, 66]);
    send([0xb0, 109, 127]);
    expect(events).toEqual([
      { type: 'encoder', id: 1, delta: -2, t: 100 },
      { type: 'button', id: 'play', down: true, t: 100 },
    ]);
  });
});

describe('autoHitLight', () => {
  it('is white on a dark pad and brighter than a lit base', () => {
    expect(autoHitLight({ r: 0, g: 0, b: 0 })).toEqual({ r: 110, g: 110, b: 110 });
    const hit = autoHitLight({ r: 127, g: 0, b: 0 });
    expect(hit.r).toBe(127);
    expect(hit.g).toBeGreaterThan(0);
  });
});
