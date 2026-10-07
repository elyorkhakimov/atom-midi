import { ZONE_CUES } from '../../audio/cues';
import type { InputEvent } from '../../input/events';
import { PAD_COLS, PAD_COUNT, PAD_ROWS } from '../../midi/atomMap';
import type { PadLed } from '../../midi/ledFrame';
import { THEME, clear, fitSize, formatMs, ledCss, roundRect, text } from '../draw';
import { Timers, inRect, type Game, type GameContext, type Rect } from '../framework';
import { dim } from '../players';
import { REACTION_MODES, TIMEOUT_MS, judgeHit, pickZone, randomDelayMs, zoneCount, zoneOf, type ReactionMode } from './logic';

type Phase =
  | { name: 'ready' }
  | { name: 'waiting'; goT: number; zone: number; cancelGo: () => void }
  | { name: 'go'; goT: number; zone: number }
  | { name: 'result'; at: number; ms: number | null; falseStart: boolean; tooSlow: boolean; wrongZone: boolean; zone: number; best: boolean };

const WHITE = { r: 70, g: 70, b: 70 };
const GREEN = { r: 0, g: 127, b: 0 };
const RED = { r: 127, g: 0, b: 0 };

/** Look and name of each match zone. Colour is decoration; the sound is what counts. */
const ZONES: readonly { name: string; emoji: string; led: PadLed }[] = [
  { name: 'Boom', emoji: '🥁', led: { r: 0, g: 30, b: 127 } },
  { name: 'Ding', emoji: '🔔', led: { r: 127, g: 90, b: 0 } },
  { name: 'Buzz', emoji: '🐝', led: { r: 127, g: 0, b: 60 } },
  { name: 'Whoop', emoji: '🚀', led: { r: 0, g: 127, b: 40 } },
];

const MODE_LABEL: Record<ReactionMode, string> = { classic: 'Classic', match2: 'Sound match · 2', match4: 'Sound match · 4' };
const bestKey = (mode: ReactionMode) => (mode === 'classic' ? 'reaction.single' : `reaction.${mode}`);

/**
 * Single player. Classic: random wait, audio GO, hit any pad as fast as possible.
 * Sound match: the board is split into 2 or 4 zones, each with its own sound;
 * after the wait one zone's sound plays and the player hits that zone.
 */
export class ReactionGame implements Game {
  private ctx!: GameContext;
  private phase: Phase = { name: 'ready' };
  private readonly timers = new Timers();
  private times: number[] = [];
  private history: number[] = [];
  /** Zone tiles drawn on the ready screen, tappable to hear each sound. */
  private tiles: Rect[] = [];

  private get mode(): ReactionMode {
    return this.ctx.settings().reactionMode;
  }

  private get zones(): number {
    return zoneCount(this.mode);
  }

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.toReady();
  }

  stop(): void {
    this.timers.clear();
    if (this.phase.name === 'waiting') this.phase.cancelGo();
  }

  // -------------------------------------------------------------------------
  // LEDs and sounds
  // -------------------------------------------------------------------------
  private fill(led: PadLed, mode?: 'blink' | 'breathe'): void {
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, () => ({ ...led, mode })));
  }

  /** Each zone in its colour; `highlight` blinks one zone and dims the rest. */
  private showZones(k = 1, highlight?: number): void {
    this.ctx.controller.setPads(
      Array.from({ length: PAD_COUNT }, (_, pad) => {
        const z = zoneOf(pad, this.zones);
        const led = ZONES[z]!.led;
        if (highlight === undefined) return dim(led, k);
        return z === highlight ? { ...led, mode: 'blink' } : dim(led, 0.15);
      }),
    );
  }

  private playZone(zone: number, when?: number): { cancel(): void } {
    return this.ctx.audio.playCue(ZONE_CUES[zone]!, when);
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------
  private toReady(): void {
    this.timers.clear();
    this.phase = { name: 'ready' };
    if (this.mode === 'classic') this.fill(WHITE, 'breathe');
    else this.showZones(0.6);
  }

  private changeMode(d: number): void {
    const i = REACTION_MODES.indexOf(this.mode);
    const mode = REACTION_MODES[(i + d + REACTION_MODES.length) % REACTION_MODES.length]!;
    this.ctx.updateSettings({ reactionMode: mode });
    this.times = [];
    this.history = [];
    this.ctx.audio.playCue('tick');
    this.toReady();
  }

  private startRound(): void {
    const { audio } = this.ctx;
    this.fill({ r: 0, g: 0, b: 0 });
    const goAudio = audio.ctx.currentTime + randomDelayMs() / 1000;
    const classic = this.mode === 'classic';
    const zone = classic ? 0 : pickZone(this.zones, this.history);
    if (!classic) this.history = [...this.history.slice(-4), zone];
    const cue = classic ? audio.playCue('go', goAudio) : this.playZone(zone, goAudio);
    const goT = audio.clock.audioToPerf(goAudio);
    this.phase = { name: 'waiting', goT, zone, cancelGo: () => cue.cancel() };
    // Secondary cues at the same moment as the (precisely scheduled) sound.
    // In match mode every zone lights up, so the lights don't give the answer away.
    this.timers.at(goT, () => {
      if (this.phase.name !== 'waiting') return;
      this.phase = { name: 'go', goT, zone };
      if (classic) this.fill(GREEN);
      else this.showZones();
    });
  }

  private finish(ms: number | null, how: { falseStart?: boolean; tooSlow?: boolean; wrongZone?: boolean } = {}): void {
    const p = this.phase;
    const zone = p.name === 'waiting' || p.name === 'go' ? p.zone : 0;
    this.timers.clear();
    if (p.name === 'waiting') p.cancelGo();
    let best = false;
    if (ms !== null) {
      this.times.push(ms);
      best = this.ctx.bests.record(bestKey(this.mode), ms, 'lower').sessionBest;
    }
    this.ctx.audio.playCue(ms === null ? 'fail' : best ? 'record' : 'select');
    if (how.wrongZone) this.showZones(1, zone);
    else this.fill(ms === null ? RED : GREEN, ms === null ? 'blink' : undefined);
    this.phase = {
      name: 'result',
      at: performance.now(),
      ms,
      falseStart: !!how.falseStart,
      tooSlow: !!how.tooSlow,
      wrongZone: !!how.wrongZone,
      zone,
      best,
    };
  }

  onInput(e: InputEvent): void {
    const p = this.phase;
    const idle = p.name === 'ready' || p.name === 'result';
    if (e.type === 'encoder') {
      if (idle) this.changeMode(Math.sign(e.delta));
      return;
    }
    if (e.type === 'button' && e.down) {
      if (e.action === 'back') {
        if (p.name === 'waiting' || p.name === 'go') {
          this.stop();
          this.toReady();
        } else this.ctx.exit();
      } else if ((e.action === 'start' || e.action === 'select') && idle) {
        this.startRound();
      } else if ((e.action === 'next' || e.action === 'prev') && idle) {
        this.changeMode(e.action === 'next' ? 1 : -1);
      }
      return;
    }
    if (e.type !== 'padDown') return;
    const classic = this.mode === 'classic';
    if (idle) {
      // Match modes: pads are for learning the sounds; ▶ Play starts.
      if (!classic) {
        this.playZone(zoneOf(e.pad, this.zones));
        return;
      }
      if (p.name === 'ready') return this.startRound();
      // Short pause so the hit that ended the round can't start the next one.
      if (performance.now() - p.at > 800) this.startRound();
      return;
    }
    const j = judgeHit(this.ctx.adjust(e.t), p.goT);
    if (j.kind === 'falseStart') this.finish(null, { falseStart: true });
    else if (!classic && zoneOf(e.pad, this.zones) !== p.zone) this.finish(null, { wrongZone: true });
    else this.finish(j.ms);
  }

  onTap(x: number, y: number): void {
    if (this.phase.name !== 'ready' && this.phase.name !== 'result') return;
    const i = this.tiles.findIndex((r) => inRect(r, x, y));
    if (i >= 0) this.playZone(i);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    const p = this.phase;
    if (p.name === 'go' && now - p.goT > TIMEOUT_MS) this.finish(null, { tooSlow: true });

    const kid = this.ctx.settings().kidUi;
    const big = Math.min(w, h) * 0.22;
    const cx = w / 2;
    const cy = h / 2;
    const classic = this.mode === 'classic';
    this.tiles = [];

    switch (p.name) {
      case 'ready':
        clear(g, w, h);
        text(g, `◀  ${MODE_LABEL[this.mode]}  ▶`, cx, big * 0.35, big * 0.2, THEME.accent);
        if (classic) {
          text(g, '⚡', cx, cy - big * 0.9, big);
          text(g, kid ? 'Hit a pad!' : 'Hit a pad to start', cx, cy + big * 0.2, big * 0.35);
          if (!kid) text(g, 'Wait for the GO sound, then hit any pad as fast as you can', cx, cy + big * 0.7, big * 0.14, THEME.muted, 'center', 500);
        } else {
          if (!kid) text(g, 'Try each part to learn its sound. Then hit the part you hear!', cx, big * 0.7, big * 0.14, THEME.muted, 'center', 500);
          const size = Math.min(w * 0.92, h * 0.56);
          this.drawZoneMap(g, cx - size / 2, big * 0.95, size, size * (PAD_ROWS / PAD_COLS), kid);
          text(g, kid ? '▶' : '▶ Play to start', cx, h - big * 0.3, big * 0.2);
        }
        if (!kid) text(g, 'knob or ◀ ▶ changes the game', cx, h - big * 0.08, big * 0.11, THEME.muted, 'center', 500);
        break;
      case 'waiting':
        clear(g, w, h);
        text(g, kid ? '🤫' : classic ? 'Wait for it…' : 'Listen…', cx, cy, kid ? big : big * 0.4, THEME.muted);
        break;
      case 'go':
        clear(g, w, h, classic ? '#0f5f2c' : '#1d2a44');
        text(g, classic ? 'GO!' : '?', cx, cy, big * 1.3);
        break;
      case 'result': {
        const failed = p.ms === null;
        clear(g, w, h, failed ? '#3a1414' : THEME.bg);
        if (failed) {
          const msg = p.wrongZone ? 'Wrong one!' : p.tooSlow ? 'Too slow!' : 'Too early!';
          text(g, msg, cx, cy - big * 0.3, fitSize(g, msg, w * 0.9, big * 0.7), THEME.bad);
          if (!classic && !p.falseStart) {
            const z = ZONES[p.zone]!;
            text(g, `It was ${z.emoji} ${z.name}`, cx, cy + big * 0.45, big * 0.25);
          }
        } else {
          const s = formatMs(p.ms!);
          text(g, s, cx, cy - big * 0.3, fitSize(g, s, w * 0.9, big), p.best ? THEME.good : THEME.text);
          if (p.best) text(g, '★ Best this session!', cx, cy + big * 0.45, big * 0.22, THEME.good);
        }
        this.drawStats(g, w, h, big);
        text(g, kid ? '▶' : classic ? 'Hit a pad or ▶ to go again · ■ menu' : '▶ to go again · pads replay sounds · ■ menu', cx, h - big * 0.3, big * 0.13, THEME.muted, 'center', 500);
        break;
      }
    }
  }

  /** The pad grid with zones coloured and labelled; each zone is a tap target. */
  private drawZoneMap(g: CanvasRenderingContext2D, x: number, y: number, size: number, height: number, kid: boolean): void {
    const cell = size / PAD_COLS;
    const rowH = height / PAD_ROWS;
    const bounds: (Rect | null)[] = Array(this.zones).fill(null);
    for (let row = 0; row < PAD_ROWS; row++) {
      for (let col = 0; col < PAD_COLS; col++) {
        const pad = row * PAD_COLS + col;
        const z = zoneOf(pad, this.zones);
        const px = x + col * cell;
        const py = y + (PAD_ROWS - 1 - row) * rowH; // row 0 is the bottom of the ATOM
        roundRect(g, px + 3, py + 3, cell - 6, rowH - 6, 8, ledCss(ZONES[z]!.led, 0.75));
        const b = bounds[z];
        bounds[z] = b ? { x: Math.min(b.x, px), y: Math.min(b.y, py), w: Math.max(b.x + b.w, px + cell) - Math.min(b.x, px), h: Math.max(b.y + b.h, py + rowH) - Math.min(b.y, py) } : { x: px, y: py, w: cell, h: rowH };
      }
    }
    bounds.forEach((b, z) => {
      if (!b) return;
      const zone = ZONES[z]!;
      text(g, zone.emoji, b.x + b.w / 2, b.y + b.h / 2 - (kid ? 0 : cell * 0.18), cell * 0.55);
      if (!kid) text(g, zone.name, b.x + b.w / 2, b.y + b.h / 2 + cell * 0.38, cell * 0.24);
    });
    this.tiles = bounds.filter((b): b is Rect => b !== null);
  }

  private drawStats(g: CanvasRenderingContext2D, w: number, h: number, big: number): void {
    const key = bestKey(this.mode);
    const session = this.ctx.bests.sessionBest(key);
    const allTime = this.ctx.bests.allTimeBest(key);
    const avg = this.times.length ? this.times.reduce((a, b) => a + b, 0) / this.times.length : null;
    const parts = [
      session !== undefined ? `Best today ${formatMs(session)}` : null,
      allTime !== undefined ? `Record ${formatMs(allTime)}` : null,
      avg !== null && this.times.length > 1 ? `Average ${formatMs(avg)}` : null,
    ].filter(Boolean) as string[];
    text(g, parts.join('   ·   '), w / 2, h / 2 + big * 0.95, Math.min(big * 0.18, (w * 0.9) / Math.max(1, parts.join('   ·   ').length) * 1.9), THEME.muted, 'center', 600);
  }
}
