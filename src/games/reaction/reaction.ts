import type { InputEvent } from '../../input/events';
import { PAD_COUNT } from '../../midi/atomMap';
import { THEME, clear, fitSize, formatMs, text } from '../draw';
import { Timers, type Game, type GameContext } from '../framework';
import { TIMEOUT_MS, judgeHit, randomDelayMs } from './logic';

type Phase =
  | { name: 'ready' }
  | { name: 'waiting'; goT: number; cancelGo: () => void }
  | { name: 'go'; goT: number }
  | { name: 'result'; at: number; ms: number | null; falseStart: boolean; tooSlow: boolean; best: boolean };

const BEST_KEY = 'reaction.single';
const WHITE = { r: 70, g: 70, b: 70 };
const GREEN = { r: 0, g: 127, b: 0 };
const RED = { r: 127, g: 0, b: 0 };

/** Single player: random wait, audio GO, hit any pad as fast as possible. */
export class ReactionGame implements Game {
  private ctx!: GameContext;
  private phase: Phase = { name: 'ready' };
  private readonly timers = new Timers();
  private times: number[] = [];

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.toReady();
  }

  stop(): void {
    this.timers.clear();
    if (this.phase.name === 'waiting') this.phase.cancelGo();
  }

  private fill(led: { r: number; g: number; b: number }, mode?: 'blink' | 'breathe'): void {
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, () => ({ ...led, mode })));
  }

  private toReady(): void {
    this.phase = { name: 'ready' };
    this.fill(WHITE, 'breathe');
  }

  private startRound(): void {
    const { audio } = this.ctx;
    this.fill({ r: 0, g: 0, b: 0 });
    const goAudio = audio.ctx.currentTime + randomDelayMs() / 1000;
    const cue = audio.playCue('go', goAudio);
    const goT = audio.clock.audioToPerf(goAudio);
    this.phase = { name: 'waiting', goT, cancelGo: () => cue.cancel() };
    // Secondary cues at the same moment as the (precisely scheduled) sound.
    this.timers.at(goT, () => {
      if (this.phase.name !== 'waiting') return;
      this.phase = { name: 'go', goT };
      this.fill(GREEN);
    });
  }

  private finish(ms: number | null, falseStart: boolean, tooSlow: boolean): void {
    this.timers.clear();
    if (this.phase.name === 'waiting') this.phase.cancelGo();
    let best = false;
    if (ms !== null) {
      this.times.push(ms);
      best = this.ctx.bests.record(BEST_KEY, ms, 'lower').sessionBest;
    }
    this.ctx.audio.playCue(ms === null ? 'fail' : best ? 'win' : 'select');
    this.fill(ms === null ? RED : GREEN, ms === null ? 'blink' : undefined);
    this.phase = { name: 'result', at: performance.now(), ms, falseStart, tooSlow, best };
  }

  onInput(e: InputEvent): void {
    const p = this.phase;
    if (e.type === 'button' && e.down) {
      if (e.action === 'back') {
        if (p.name === 'waiting' || p.name === 'go') {
          this.stop();
          this.toReady();
        } else this.ctx.exit();
      } else if ((e.action === 'start' || e.action === 'select') && (p.name === 'ready' || p.name === 'result')) {
        this.startRound();
      }
      return;
    }
    if (e.type !== 'padDown') return;
    if (p.name === 'ready') return this.startRound();
    if (p.name === 'result') {
      // Short pause so the hit that ended the round can't start the next one.
      if (performance.now() - p.at > 800) this.startRound();
      return;
    }
    const j = judgeHit(this.ctx.adjust(e.t), p.goT);
    if (j.kind === 'falseStart') this.finish(null, true, false);
    else this.finish(j.ms, false, false);
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    const p = this.phase;
    if (p.name === 'go' && now - p.goT > TIMEOUT_MS) this.finish(null, false, true);

    const kid = this.ctx.settings().kidUi;
    const big = Math.min(w, h) * 0.22;
    const cx = w / 2;
    const cy = h / 2;

    switch (p.name) {
      case 'ready':
        clear(g, w, h);
        text(g, '⚡', cx, cy - big * 0.9, big);
        text(g, kid ? 'Hit a pad!' : 'Hit a pad to start', cx, cy + big * 0.2, big * 0.35);
        if (!kid) text(g, 'Wait for the GO sound, then hit any pad as fast as you can', cx, cy + big * 0.7, big * 0.14, THEME.muted, 'center', 500);
        break;
      case 'waiting':
        clear(g, w, h);
        text(g, kid ? '🤫' : 'Wait for it…', cx, cy, kid ? big : big * 0.4, THEME.muted);
        break;
      case 'go':
        clear(g, w, h, '#0f5f2c');
        text(g, 'GO!', cx, cy, big * 1.3);
        break;
      case 'result': {
        clear(g, w, h, p.ms === null ? '#3a1414' : THEME.bg);
        if (p.ms === null) {
          const msg = p.tooSlow ? 'Too slow!' : 'Too early!';
          text(g, msg, cx, cy - big * 0.3, fitSize(g, msg, w * 0.9, big * 0.7), THEME.bad);
        } else {
          const s = formatMs(p.ms);
          text(g, s, cx, cy - big * 0.3, fitSize(g, s, w * 0.9, big), p.best ? THEME.good : THEME.text);
          if (p.best) text(g, '★ Best this session!', cx, cy + big * 0.45, big * 0.22, THEME.good);
        }
        this.drawStats(g, w, h, big);
        text(g, kid ? '▶' : 'Hit a pad or ▶ to go again · ■ menu', cx, h - big * 0.3, big * 0.13, THEME.muted, 'center', 500);
        break;
      }
    }
  }

  private drawStats(g: CanvasRenderingContext2D, w: number, h: number, big: number): void {
    const session = this.ctx.bests.sessionBest(BEST_KEY);
    const allTime = this.ctx.bests.allTimeBest(BEST_KEY);
    const avg = this.times.length ? this.times.reduce((a, b) => a + b, 0) / this.times.length : null;
    const parts = [
      session !== undefined ? `Best today ${formatMs(session)}` : null,
      allTime !== undefined ? `Record ${formatMs(allTime)}` : null,
      avg !== null && this.times.length > 1 ? `Average ${formatMs(avg)}` : null,
    ].filter(Boolean) as string[];
    text(g, parts.join('   ·   '), w / 2, h / 2 + big * 0.95, Math.min(big * 0.18, (w * 0.9) / Math.max(1, parts.join('   ·   ').length) * 1.9), THEME.muted, 'center', 600);
  }
}
