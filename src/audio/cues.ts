/**
 * UI and game cue sounds, synthesized into AudioBuffers at startup so the app works
 * offline and before anything loads. Recorded replacements listed in
 * public/sounds/cues.json are swapped in once decoded (AudioEngine.loadCueFiles).
 */
export type CueName = 'click' | 'clickAccent' | 'beep' | 'go' | 'win' | 'fail' | 'tick' | 'select' | 'record' | 'youWin' | ZoneCue;

/** Reaction "sound match" zones: four sounds that are easy to tell apart. */
export type ZoneCue = 'zone0' | 'zone1' | 'zone2' | 'zone3';
export const ZONE_CUES: readonly ZoneCue[] = ['zone0', 'zone1', 'zone2', 'zone3'];

/** `fEnd` glides the pitch exponentially from f to fEnd over the tone. */
type Tone = { f: number; fEnd?: number; start: number; dur: number; gain?: number; type?: 'sine' | 'square' | 'tri' };

function render(ctx: BaseAudioContext, seconds: number, tones: Tone[]): AudioBuffer {
  const sr = ctx.sampleRate;
  const buf = ctx.createBuffer(1, Math.ceil(seconds * sr), sr);
  const d = buf.getChannelData(0);
  for (const { f, fEnd = f, start, dur, gain = 0.5, type = 'sine' } of tones) {
    const s0 = Math.floor(start * sr);
    const n = Math.floor(dur * sr);
    let ph = 0;
    for (let i = 0; i < n && s0 + i < d.length; i++) {
      const t = i / sr;
      ph = (ph + (f * (fEnd / f) ** (i / n)) / sr) % 1;
      const w = type === 'sine' ? Math.sin(2 * Math.PI * ph) : type === 'square' ? (ph < 0.5 ? 1 : -1) * 0.5 : 1 - 4 * Math.abs(ph - 0.5);
      const attack = Math.min(1, i / (0.002 * sr));
      const release = Math.exp(-t / (dur * 0.35));
      d[s0 + i]! += w * gain * attack * release;
    }
  }
  return buf;
}

export function makeCues(ctx: BaseAudioContext): Record<CueName, AudioBuffer> {
  const win = render(ctx, 0.6, [
    { f: 523, start: 0, dur: 0.15, gain: 0.4, type: 'tri' },
    { f: 659, start: 0.12, dur: 0.15, gain: 0.4, type: 'tri' },
    { f: 784, start: 0.24, dur: 0.15, gain: 0.4, type: 'tri' },
    { f: 1047, start: 0.36, dur: 0.24, gain: 0.4, type: 'tri' },
  ]);
  return {
    click: render(ctx, 0.04, [{ f: 1000, start: 0, dur: 0.035, gain: 0.6 }]),
    clickAccent: render(ctx, 0.05, [{ f: 1600, start: 0, dur: 0.045, gain: 0.8 }]),
    beep: render(ctx, 0.15, [{ f: 660, start: 0, dur: 0.14, gain: 0.5, type: 'tri' }]),
    go: render(ctx, 0.3, [
      { f: 880, start: 0, dur: 0.28, gain: 0.45, type: 'tri' },
      { f: 1320, start: 0, dur: 0.28, gain: 0.3, type: 'tri' },
    ]),
    win,
    record: win, // "New high score!" voice once loaded
    youWin: win, // "You win!" voice once loaded
    fail: render(ctx, 0.45, [
      { f: 220, start: 0, dur: 0.2, gain: 0.3, type: 'square' },
      { f: 165, start: 0.2, dur: 0.25, gain: 0.3, type: 'square' },
    ]),
    zone0: render(ctx, 0.4, [{ f: 160, fEnd: 45, start: 0, dur: 0.4, gain: 0.95 }]), // boom
    zone1: render(ctx, 0.6, [
      { f: 1568, start: 0, dur: 0.6, gain: 0.45 }, // ding
      { f: 3136, start: 0, dur: 0.3, gain: 0.15 },
      { f: 4704, start: 0, dur: 0.15, gain: 0.08 },
    ]),
    zone2: render(ctx, 0.3, [
      { f: 147, start: 0, dur: 0.3, gain: 0.35, type: 'square' }, // buzz
      { f: 151, start: 0, dur: 0.3, gain: 0.35, type: 'square' },
    ]),
    zone3: render(ctx, 0.35, [{ f: 450, fEnd: 1800, start: 0, dur: 0.35, gain: 0.5, type: 'tri' }]), // whoop
    tick: render(ctx, 0.02, [{ f: 2400, start: 0, dur: 0.015, gain: 0.3 }]),
    select: render(ctx, 0.12, [
      { f: 784, start: 0, dur: 0.06, gain: 0.35, type: 'tri' },
      { f: 1175, start: 0.05, dur: 0.07, gain: 0.35, type: 'tri' },
    ]),
  };
}
