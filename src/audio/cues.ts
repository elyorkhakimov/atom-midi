/** UI and game cue sounds, synthesized into AudioBuffers at startup (no files). */
export type CueName = 'click' | 'clickAccent' | 'beep' | 'go' | 'win' | 'fail' | 'tick' | 'select';

type Tone = { f: number; start: number; dur: number; gain?: number; type?: 'sine' | 'square' | 'tri' };

function render(ctx: BaseAudioContext, seconds: number, tones: Tone[]): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(seconds * sr), sr);
  const d = buf.getChannelData(0);
  for (const { f, start, dur, gain = 0.5, type = 'sine' } of tones) {
    const s0 = Math.floor(start * sr);
    const n = Math.floor(dur * sr);
    for (let i = 0; i < n && s0 + i < d.length; i++) {
      const t = i / sr;
      const ph = (f * t) % 1;
      const w = type === 'sine' ? Math.sin(2 * Math.PI * ph) : type === 'square' ? (ph < 0.5 ? 1 : -1) * 0.5 : 1 - 4 * Math.abs(ph - 0.5);
      const attack = Math.min(1, i / (0.002 * sr));
      const release = Math.exp(-t / (dur * 0.35));
      d[s0 + i]! += w * gain * attack * release;
    }
  }
  return buf;
}

export function makeCues(ctx: BaseAudioContext): Record<CueName, AudioBuffer> {
  return {
    click: render(ctx, 0.04, [{ f: 1000, start: 0, dur: 0.035, gain: 0.6 }]),
    clickAccent: render(ctx, 0.05, [{ f: 1600, start: 0, dur: 0.045, gain: 0.8 }]),
    beep: render(ctx, 0.15, [{ f: 660, start: 0, dur: 0.14, gain: 0.5, type: 'tri' }]),
    go: render(ctx, 0.3, [
      { f: 880, start: 0, dur: 0.28, gain: 0.45, type: 'tri' },
      { f: 1320, start: 0, dur: 0.28, gain: 0.3, type: 'tri' },
    ]),
    win: render(ctx, 0.6, [
      { f: 523, start: 0, dur: 0.15, gain: 0.4, type: 'tri' },
      { f: 659, start: 0.12, dur: 0.15, gain: 0.4, type: 'tri' },
      { f: 784, start: 0.24, dur: 0.15, gain: 0.4, type: 'tri' },
      { f: 1047, start: 0.36, dur: 0.24, gain: 0.4, type: 'tri' },
    ]),
    fail: render(ctx, 0.45, [
      { f: 220, start: 0, dur: 0.2, gain: 0.3, type: 'square' },
      { f: 165, start: 0.2, dur: 0.25, gain: 0.3, type: 'square' },
    ]),
    tick: render(ctx, 0.02, [{ f: 2400, start: 0, dur: 0.015, gain: 0.3 }]),
    select: render(ctx, 0.12, [
      { f: 784, start: 0, dur: 0.06, gain: 0.35, type: 'tri' },
      { f: 1175, start: 0.05, dur: 0.07, gain: 0.35, type: 'tri' },
    ]),
  };
}
