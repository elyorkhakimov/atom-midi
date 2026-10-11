import { KITS } from '../../audio/kit';
import type { InputEvent } from '../../input/events';
import { PAD_COUNT } from '../../midi/atomMap';
import type { PadLed } from '../../midi/ledFrame';
import { loadBeats } from '../../storage/beats';
import { beatToPattern } from '../beatMaker/beat';
import { THEME, clear, fitSize, ledCss, roundRect, text } from '../draw';
import { Timers, inRect, type Game, type GameContext, type Rect } from '../framework';
import { dim } from '../players';
import { PATTERNS, patternPads, type Pattern } from './patterns';
import { scoreRhythm, type Note, type RhythmScore } from './scoring';
import { DEMO_LOOPS, PLAY_LOOPS, buildTimeline, type Click, type RhythmTimeline } from './timeline';

type Phase =
  | { name: 'choose' }
  | { name: 'running'; tl: RhythmTimeline; expected: Note[]; playStartT: number; endT: number }
  | { name: 'results'; tl: RhythmTimeline; score: RhythmScore; best: boolean };

const MIN_BPM = 60;
const MAX_BPM = 160;
/** Hits this far outside the playing window are ignored rather than scored as extras. */
const WINDOW_MARGIN_MS = 150;
const LOOKAHEAD_MS = 25;
/** Sounds go to the engine only this far ahead, so a long demo never runs into the voice limit. */
const SCHEDULE_AHEAD_S = 0.15;

/** The app plays a pattern, the player copies it; scored by timing per spec §9. */
export class RhythmCopyGame implements Game {
  private ctx!: GameContext;
  private index = 0;
  /** Built-in patterns, then the custom beats saved in Beat maker. */
  private patterns: readonly Pattern[] = PATTERNS;
  /** Tempo each custom beat was recorded at. */
  private readonly beatBpm = new Map<string, number>();
  private bpm = 120;
  private phase: Phase = { name: 'choose' };
  private hits: Note[] = [];
  private readonly timers = new Timers();
  /** Sounds of the current run not yet handed to the engine, by time. */
  private queue: { at: number; run(): void }[] = [];
  private scheduler: ReturnType<typeof setInterval> | null = null;
  /** Clicks already handed to the engine, so the toggle or Stop can cancel them. */
  private clickHandles: { at: number; handle: { cancel(): void } }[] = [];
  /** On-screen metronome toggle, set by draw(). */
  private clickToggle: Rect | null = null;

  private get pattern(): Pattern {
    return this.patterns[this.index]!;
  }

  start(ctx: GameContext): void {
    this.ctx = ctx;
    const custom = loadBeats()
      .map((b) => ({ beat: b, pattern: beatToPattern(b) }))
      .filter(({ pattern }) => pattern.notes.length);
    for (const { beat, pattern } of custom) this.beatBpm.set(pattern.id, beat.bpm);
    this.patterns = [...PATTERNS, ...custom.map(({ pattern }) => pattern)];
    // Every pad hit plays its kit sound: let the Android app play it straight from the MIDI thread.
    ctx.audio.setLivePads(0xffff);
    this.scheduler = setInterval(() => this.schedule(), LOOKAHEAD_MS);
    this.showMetronome();
    this.toChoose();
  }

  stop(): void {
    this.ctx.audio.setLivePads(0);
    if (this.scheduler) clearInterval(this.scheduler);
    this.timers.clear();
    this.cancelSounds();
    this.ctx.audio.stopAll();
  }

  // -------------------------------------------------------------------------
  // Metronome
  // -------------------------------------------------------------------------
  private get metronomeOn(): boolean {
    return this.ctx.settings().rhythmMetronome;
  }

  private showMetronome(): void {
    this.ctx.controller.setButtonLight('click', this.metronomeOn);
  }

  private toggleMetronome(): void {
    const on = !this.metronomeOn;
    this.ctx.updateSettings({ rhythmMetronome: on });
    this.ctx.audio.playCue('tick');
    this.showMetronome();
    // Clicks still queued follow the setting when they're scheduled; cancel the few already sent.
    if (!on) {
      const soon = this.ctx.audio.clock.now + 0.02;
      for (const c of this.clickHandles) if (c.at > soon) c.handle.cancel();
      this.clickHandles = this.clickHandles.filter((c) => c.at <= soon);
    }
  }

  private queueClicks(clicks: readonly Click[]): void {
    for (const click of clicks) {
      this.queue.push({
        at: click.at,
        run: () => {
          if (!click.countIn && !this.metronomeOn) return;
          this.clickHandles.push({ at: click.at, handle: this.ctx.audio.click(click.accent, click.at) });
        },
      });
    }
  }

  /** Hands the engine whatever plays within SCHEDULE_AHEAD_S (like Metronome). */
  private schedule(): void {
    const horizon = this.ctx.audio.clock.now + SCHEDULE_AHEAD_S;
    while (this.queue.length && this.queue[0]!.at < horizon) this.queue.shift()!.run();
    if (this.clickHandles.length > 64) this.clickHandles = this.clickHandles.slice(-16);
  }

  private cancelSounds(): void {
    this.queue = [];
    for (const c of this.clickHandles) c.handle.cancel();
    this.clickHandles = [];
  }

  // -------------------------------------------------------------------------
  // LEDs
  // -------------------------------------------------------------------------
  private kitLed(pad: number): PadLed {
    return this.ctx.audio.padColor(pad) ?? { r: 60, g: 60, b: 60 };
  }

  private showPatternPads(k = 0.5): void {
    const used = new Set(patternPads(this.pattern));
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, (_, pad) => (used.has(pad) ? dim(this.kitLed(pad), k) : { r: 0, g: 0, b: 0 })));
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------
  private toChoose(): void {
    this.timers.clear();
    this.cancelSounds();
    this.phase = { name: 'choose' };
    this.showPatternPads();
  }

  private changeKit(delta: number): void {
    const current = this.ctx.settings().kitId;
    const i = KITS.findIndex((k) => k.id === current);
    const next = KITS[(i + delta + KITS.length) % KITS.length]!;
    this.ctx.updateSettings({ kitId: next.id });
    this.ctx.audio.playCue('tick');
    void this.ctx.audio.loadKit(next.id).then(() => {
      if (this.phase.name === 'choose') this.showPatternPads();
    });
  }

  private select(delta: number): void {
    this.index = (this.index + delta + this.patterns.length) % this.patterns.length;
    const bpm = this.beatBpm.get(this.pattern.id);
    if (bpm !== undefined) this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(bpm)));
    this.ctx.audio.playCue('tick');
    this.showPatternPads();
  }

  private run(): void {
    const { audio, controller } = this.ctx;
    this.timers.clear();
    this.hits = [];
    const tl = buildTimeline(this.pattern, this.bpm, audio.clock.now + 0.4);
    const snap = audio.clock.snapshot();
    const toPerf = (at: number) => snap.performanceTime + (at - snap.contextTime) * 1000;

    this.cancelSounds();
    this.queueClicks(tl.clicks);
    for (const n of tl.demoNotes) {
      this.queue.push({ at: n.at, run: () => audio.playPad(n.pad, 100, n.at) });
      // Secondary visual cue: flash the pad the demo is playing.
      this.timers.at(toPerf(n.at), () => controller.setPad(n.pad, { r: 127, g: 127, b: 127 }));
      this.timers.at(toPerf(n.at) + 110, () => controller.setPad(n.pad, dim(this.kitLed(n.pad), 0.5)));
    }
    this.queue.sort((a, b) => a.at - b.at);
    this.schedule();
    this.showPatternPads();
    const expected = tl.expected.map((n) => ({ pad: n.pad, t: toPerf(n.at) }));
    this.phase = { name: 'running', tl, expected, playStartT: toPerf(tl.playStart), endT: toPerf(tl.end) };
  }

  private finish(): void {
    const p = this.phase;
    if (p.name !== 'running') return;
    const score = scoreRhythm(p.expected, this.hits);
    const best = this.ctx.bests.record(`rhythm.${this.pattern.id}`, Math.round(score.percent), 'higher').sessionBest;
    this.ctx.audio.playCue(best && score.percent >= 50 ? 'record' : score.percent >= 80 ? 'win' : score.percent >= 50 ? 'select' : 'fail');
    this.phase = { name: 'results', tl: p.tl, score, best };
    this.showPatternPads();
  }

  onInput(e: InputEvent): void {
    const p = this.phase;
    if (e.type === 'encoder') {
      if (p.name !== 'choose') return;
      if (e.id === 1) this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, this.bpm + Math.sign(e.delta) * 5));
      else if (e.id === 2) this.changeKit(Math.sign(e.delta));
      else this.select(Math.sign(e.delta));
      return;
    }
    if (e.type === 'button' && e.down) {
      switch (e.action) {
        case 'metronome':
          return this.toggleMetronome();
        case 'up':
        case 'prev':
          if (p.name === 'choose') this.select(-1);
          return;
        case 'down':
          if (p.name === 'choose') this.select(1);
          return;
        case 'next':
          if (p.name === 'choose') this.select(1);
          else if (p.name === 'results') {
            this.select(1);
            this.run();
          }
          return;
        case 'start':
        case 'select':
          if (p.name !== 'running') this.run();
          return;
        case 'back':
          if (p.name === 'running') {
            this.ctx.audio.stopAll();
            this.toChoose();
          } else if (p.name === 'results') this.toChoose();
          else this.ctx.exit();
          return;
      }
      return;
    }
    if (e.type !== 'padDown') return;
    this.ctx.audio.playPad(e.pad, e.velocity);
    if (p.name !== 'running') return;
    const t = this.ctx.adjust(e.t);
    if (t >= p.playStartT - WINDOW_MARGIN_MS && t <= p.endT + WINDOW_MARGIN_MS) this.hits.push({ pad: e.pad, t });
  }

  onTap(x: number, y: number): void {
    if (inRect(this.clickToggle, x, y)) this.toggleMetronome();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    const p = this.phase;
    if (p.name === 'running' && now > p.endT + WINDOW_MARGIN_MS + 100) this.finish();
    const kid = this.ctx.settings().kidUi;
    const unit = Math.min(w, h) * 0.08;
    clear(g, w, h);
    this.drawMetronomeToggle(g, w, unit);

    const pat = this.pattern;
    text(g, `🥁 ${pat.name}`, w / 2, unit, unit * 0.8);
    const gridTop = unit * 2;
    const gridH = h * 0.45;

    if (p.name === 'choose') {
      const where = this.index < PATTERNS.length ? `${this.index + 1} / ${PATTERNS.length}` : `My beats ${this.index - PATTERNS.length + 1} / ${this.patterns.length - PATTERNS.length}`;
      text(g, `${where}   ·   ${this.bpm} BPM   ·   ${KITS.find((k) => k.id === this.ctx.settings().kitId)?.name ?? ''}`, w / 2, unit * 1.9, unit * 0.4, THEME.muted, 'center', 600);
      this.drawGrid(g, w, gridTop + unit * 0.5, gridH, null, null);
      const hint = kid ? '◀ ▶ pick · ▶ Play' : 'Knob 1 or ▲▼ pattern · knob 2 tempo · knob 3 kit · Click = metronome · ▶ Play · ■ menu';
      text(g, hint, w / 2, h - unit, fitSize(g, hint, w * 0.88, unit * 0.38, 500), THEME.muted, 'center', 500);
      return;
    }

    if (p.name === 'running') {
      const audioNow = this.ctx.audio.clock.perfToAudio(now);
      const { tl } = p;
      let label: string;
      let pos: number | null = null;
      if (audioNow < tl.countInStart) {
        const loop = Math.floor((audioNow - tl.demoStart) / tl.loopDur);
        label = audioNow < tl.demoStart ? 'Listen…' : `Listen ${Math.min(DEMO_LOOPS, loop + 1)}/${DEMO_LOOPS}`;
        pos = audioNow >= tl.demoStart ? ((audioNow - tl.demoStart) % tl.loopDur) / tl.loopDur : null;
      } else if (audioNow < tl.playStart) {
        const beat = Math.floor((audioNow - tl.countInStart) / (tl.stepDur * 4));
        label = `Get ready… ${4 - beat}`;
      } else {
        const loop = Math.floor((audioNow - tl.playStart) / tl.loopDur);
        label = `Your turn! ${Math.min(PLAY_LOOPS, loop + 1)}/${PLAY_LOOPS}`;
        pos = audioNow < tl.end ? ((audioNow - tl.playStart) % tl.loopDur) / tl.loopDur : null;
      }
      text(g, label, w / 2, h - unit * 1.6, unit * 0.9, audioNow >= tl.playStart ? THEME.good : THEME.text);
      this.drawGrid(g, w, gridTop, gridH, pos, null);
      return;
    }

    // Results
    const { score } = p;
    this.drawGrid(g, w, gridTop, gridH, null, score);
    const pct = `${Math.round(score.percent)}%`;
    const color = score.percent >= 80 ? THEME.good : score.percent >= 50 ? THEME.warn : THEME.bad;
    text(g, pct, w / 2, gridTop + gridH + unit * 1.6, unit * 2, color);
    const avg = score.meanAbsErrorMs !== null ? `±${Math.round(score.meanAbsErrorMs)} ms` : '—';
    const tendency =
      score.meanErrorMs === null || Math.abs(score.meanErrorMs) < 10 ? 'right on time' : score.meanErrorMs > 0 ? `${Math.round(score.meanErrorMs)} ms late` : `${Math.round(-score.meanErrorMs)} ms early`;
    const best = this.ctx.bests.allTimeBest(`rhythm.${pat.id}`);
    text(
      g,
      kid ? (p.best ? '★' : '') : `avg ${avg} · ${tendency} · ${score.misses} missed · ${score.extras} extra${best !== undefined ? ` · record ${best}%` : ''}`,
      w / 2,
      gridTop + gridH + unit * 3,
      unit * 0.42,
      THEME.muted,
      'center',
      600,
    );
    text(g, kid ? '▶ again' : '▶ again · ▶▶ next pattern (Right) · ■ choose', w / 2, h - unit * 0.7, unit * 0.36, THEME.muted, 'center', 500);
  }

  /** Top-right pill; tap it (or the ATOM Click button) to switch the metronome. */
  private drawMetronomeToggle(g: CanvasRenderingContext2D, w: number, unit: number): void {
    const on = this.metronomeOn;
    const label = on ? '🔔 Click on' : '🔕 Click off';
    const size = Math.max(13, unit * 0.36);
    g.font = `600 ${Math.round(size)}px ${THEME.font}`;
    const bw = g.measureText(label).width + size * 1.4;
    const bh = size * 2.2;
    const r = { x: w - bw - unit * 0.3, y: unit * 0.25, w: bw, h: bh };
    roundRect(g, r.x, r.y, r.w, r.h, bh / 2, on ? '#1f3b2a' : THEME.panel);
    text(g, label, r.x + r.w / 2, r.y + r.h / 2, size, on ? THEME.good : THEME.muted, 'center', 600);
    this.clickToggle = r;
  }

  /** Steps across, one row per pad used. In results, each cell shows a dot per play-through. */
  private drawGrid(g: CanvasRenderingContext2D, w: number, top: number, height: number, playhead: number | null, score: RhythmScore | null): void {
    const pat = this.pattern;
    const pads = patternPads(pat).reverse(); // higher pads on top, like the hardware
    const steps = pat.bars * 16;
    const left = w * 0.04;
    const width = w * 0.92;
    const cw = width / steps;
    const rh = Math.min(height / pads.length, cw * 3);
    const cellNotes = new Map(pat.notes.map(([step, pad], i) => [`${step}:${pad}`, i]));

    pads.forEach((pad, r) => {
      const y = top + r * rh;
      const color = this.kitLed(pad);
      for (let s = 0; s < steps; s++) {
        const x = left + s * cw;
        const noteIdx = cellNotes.get(`${s}:${pad}`);
        const beatShade = Math.floor(s / 4) % 2 ? '#161b22' : '#1d232c';
        roundRect(g, x + 1, y + 1, cw - 2, rh - 2, Math.min(6, cw / 4), noteIdx !== undefined ? ledCss(color, 0.9) : beatShade);
        if (score && noteIdx !== undefined) {
          for (let loop = 0; loop < PLAY_LOOPS; loop++) {
            const err = score.errors[loop * pat.notes.length + this.sortedIndex(noteIdx)];
            const c = err === null || err === undefined ? '#000' : Math.abs(err) < 30 ? THEME.good : Math.abs(err) < 60 ? THEME.warn : THEME.bad;
            g.beginPath();
            g.arc(x + cw / 2, y + (rh * (loop + 1)) / (PLAY_LOOPS + 1), Math.min(cw, rh) * 0.14, 0, Math.PI * 2);
            g.fillStyle = c;
            g.fill();
          }
        }
      }
    });
    if (playhead !== null) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(left + playhead * width - 2, top - 6, 4, pads.length * rh + 12);
    }
  }

  /** Index of a pattern note within one loop of `tl.expected` (sorted by time). */
  private sortedIndex(noteIdx: number): number {
    const order = this.pattern.notes.map((n, i) => [n[0], i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return order.findIndex(([, i]) => i === noteIdx);
  }
}
