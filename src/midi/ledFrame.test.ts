import { describe, expect, it } from 'vitest';
import type { MidiBytes } from './atomMap';
import { LedFrameWriter, diffPadFrame, emptyFrame } from './ledFrame';

describe('diffPadFrame', () => {
  it('sends all pads when nothing was sent before', () => {
    expect(diffPadFrame(null, emptyFrame())).toHaveLength(16 * 4);
  });

  it('sends nothing for an unchanged frame', () => {
    const f = emptyFrame();
    f[3] = { r: 10, g: 20, b: 30 };
    expect(diffPadFrame(f, f.map((c) => ({ ...c })))).toEqual([]);
  });

  it('ignores sub-step changes that quantize to the same value', () => {
    const a = emptyFrame();
    const b = emptyFrame();
    a[0] = { r: 10.1, g: 0, b: 0 };
    b[0] = { r: 10.3, g: 0, b: 0 };
    expect(diffPadFrame(a, b)).toEqual([]);
  });

  it('full mode sends 4 messages per changed pad', () => {
    const next = emptyFrame();
    next[5] = { r: 127, g: 0, b: 0 };
    expect(diffPadFrame(emptyFrame(), next)).toEqual([
      [0x91, 41, 127],
      [0x92, 41, 0],
      [0x93, 41, 0],
      [0x90, 41, 127],
    ]);
  });

  it('minimal mode sends only changed components, plus state on on/off', () => {
    const lit = emptyFrame();
    lit[0] = { r: 100, g: 0, b: 0 };
    const recolored = emptyFrame();
    recolored[0] = { r: 100, g: 50, b: 0 };
    expect(diffPadFrame(lit, recolored, 'minimal')).toEqual([[0x92, 36, 50]]);
    expect(diffPadFrame(emptyFrame(), lit, 'minimal')).toEqual([
      [0x91, 36, 100],
      [0x90, 36, 127],
    ]);
    expect(diffPadFrame(lit, emptyFrame(), 'minimal')).toEqual([
      [0x91, 36, 0],
      [0x90, 36, 0],
    ]);
  });
});

describe('LedFrameWriter', () => {
  function setup() {
    const sent: MidiBytes[] = [];
    const queue: (() => void)[] = [];
    const w = new LedFrameWriter((m) => sent.push(m), (cb) => queue.push(cb));
    const runFrame = () => queue.splice(0).forEach((cb) => cb());
    return { w, sent, queue, runFrame };
  }

  it('coalesces many changes into one flush per frame', () => {
    const { w, sent, queue, runFrame } = setup();
    w.flushNow(); // initial full sync
    sent.length = 0;
    w.setPad(0, { r: 10, g: 0, b: 0 });
    w.setPad(0, { r: 20, g: 0, b: 0 });
    w.setPad(1, { r: 0, g: 5, b: 0 });
    expect(queue).toHaveLength(1);
    expect(sent).toHaveLength(0);
    runFrame();
    expect(sent).toHaveLength(8);
    expect(sent[0]).toEqual([0x91, 36, 20]);
  });

  it('applies the brightness cap', () => {
    const { w, sent } = setup();
    w.brightness = 0.5;
    w.setPad(0, { r: 127, g: 0, b: 0 });
    w.flushNow();
    expect(sent[0]).toEqual([0x91, 36, 64]);
  });

  it('invalidate resends everything', () => {
    const { w, sent, runFrame } = setup();
    w.flushNow();
    sent.length = 0;
    w.invalidate();
    runFrame();
    expect(sent).toHaveLength(64);
  });
});
