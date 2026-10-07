import { ZONE_CUES } from '../../audio/cues';
import type { InputEvent } from '../../input/events';
import { PAD_COLS, PAD_COUNT, PAD_ROWS } from '../../midi/atomMap';
import type { PadLed } from '../../midi/ledFrame';
import { THEME, clear, fitSize, formatMs, ledCss, roundRect, text } from '../draw';
import { Timers, inRect, type Game, type GameContext, type Rect } from '../framework';
import { dim } from '../players';
import { REACTION_MODES, TIMEOUT_MS, judgeHit, pickZone, randomDelayMs, zoneCount, zoneOf, type ReactionCue, type ReactionMode } from './logic';

type Phase =
  | { name: 'ready' }
  /** In lights mode goT is only the planned time until the lights actually go on. */
  | { name: 'waiting'; goT: number; zone: number; cancelGo: () => void }
  | { name: 'go'; goT: number; zone: number }
  | { name: 'result'; at: number; ms: number | null; earlyMs: number | null; falseStart: boolean; tooSlow: boolean; wrongZone: boolean; zone: number; best: boolean };

const WHITE = { r: 70, g: 70, b: 70 };
const GREEN = { r: 0, g: 127, b: 0 };
const RED = { r: 127, g: 0, b: 0 };

/** Look and name of each match zone. With sound, colour is decoration; with lights only, it's the cue. */
const ZONES: readonly { name: string; emoji: string; colour: string; led: PadLed }[] = [
  { name: 'Boom', emoji: '🥁', colour: 'blue', led: { r: 0, g: 30, b: 127 } },
  { name: 'Ding', emoji: '🔔', colour: 'yellow', led: { r: 127, g: 90, b: 0 } },
  { name: 'Buzz', emoji: '🐝', colour: 'pink', led: { r: 127, g: 0, b: 60 } },
  { name: 'Whoop', emoji: '🚀', colour: 'green', led: { r: 0, g: 127, b: 40 } },
];

function modeLabel(mode: ReactionMode, cue: ReactionCue): string {
  if (mode === 'classic') return 'Classic';
  return `${cue === 'lights' ? 'Light' : 'Sound'} match · ${zoneCount(mode)}`;
}

const bestKey = (mode: ReactionMode, cue: ReactionCue) => `${mode === 'classic' ? 'reaction.single' : `reaction.${mode}`}${cue === 'lights' ? '.lights' : ''}`;

/**
 * Single player. Classic: random wait, GO, hit any pad as fast as possible.
 * Match: the board is split into 2 or 4 zones; after the wait one zone is called
 * and the player hits that zone.
 * GO is a sound (with lights as a secondary cue), or with the "lights" cue only the
 * pad LEDs: all pads in Classic, just the called zone in match modes. No sound plays.
 */
export class ReactionGame implements Game {
  private ctx!: GameContext;
  private phase: Phase = { name: 'ready' };
  private readonly timers = new Timers();
  private times: number[] = [];
  private history: number[] = [];
  /** Zone tiles drawn on the ready screen, tappable to hear each sound. */
  private tiles: Rect[] = [];
  /** On-screen Sound/Lights switch, set by draw(). */
  private cueToggle: Rect | null = null;

  private get mode(): ReactionMode {
    return this.ctx.settings().reactionMode;
  }

  private get cue(): ReactionCue {
    return this.ctx.settings().reactionCue;
  }

  private get lightsOnly(): boolean {
    return this.cue === 'lights';
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

  private toggleCue(): void {
    this.ctx.updateSettings({ reactionCue: this.lightsOnly ? 'sound' : 'lights' });
    this.times = [];
    this.ctx.audio.playCue('tick');
    this.toReady();
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
    if (this.lightsOnly) return this.startLightsRound();
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

  /**
   * GO is the moment the LED message goes out (it reaches the ATOM within a couple of
   * ms), timed from the event clock rather than audio, and hits are compared raw: the
   * timing calibration measures audio delay, which plays no part here.
   */
  private startLightsRound(): void {
    this.fill({ r: 0, g: 0, b: 0 });
    const classic = this.mode === 'classic';
    const zone = classic ? 0 : pickZone(this.zones, this.history);
    if (!classic) this.history = [...this.history.slice(-4), zone];
    const delay = randomDelayMs();
    this.phase = { name: 'waiting', goT: performance.now() + delay, zone, cancelGo: () => undefined };
    this.timers.after(delay, () => {
      if (this.phase.name !== 'waiting') return;
      const goT = performance.now();
      this.phase = { name: 'go', goT, zone };
      if (classic) this.fill(GREEN);
      else
        this.ctx.controller.setPads(
          Array.from({ length: PAD_COUNT }, (_, pad) => (zoneOf(pad, this.zones) === zone ? ZONES[zone]!.led : { r: 0, g: 0, b: 0 })),
        );
    });
  }

  private finish(ms: number | null, how: { falseStart?: boolean; earlyMs?: number; tooSlow?: boolean; wrongZone?: boolean } = {}): void {
    const p = this.phase;
    const zone = p.name === 'waiting' || p.name === 'go' ? p.zone : 0;
    this.timers.clear();
    if (p.name === 'waiting') p.cancelGo();
    let best = false;
    if (ms !== null) {
      this.times.push(ms);
      best = this.ctx.bests.record(bestKey(this.mode, this.cue), ms, 'lower').sessionBest;
    }
    this.ctx.audio.playCue(ms === null ? 'fail' : best ? 'record' : 'select');
    if (how.wrongZone) this.showZones(1, zone);
    else this.fill(ms === null ? RED : GREEN, ms === null ? 'blink' : undefined);
    this.phase = {
      name: 'result',
      at: performance.now(),
      ms,
      earlyMs: how.earlyMs ?? null,
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
      if (!idle) return;
      if (e.id === 1) this.toggleCue();
      else this.changeMode(Math.sign(e.delta));
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
      } else if ((e.action === 'up' || e.action === 'down') && idle) {
        this.toggleCue();
      }
      return;
    }
    if (e.type !== 'padDown') return;
    const classic = this.mode === 'classic';
    if (idle) {
      // Match modes: pads are for learning the sounds (with lights only there's nothing to learn); ▶ Play starts.
      if (!classic) {
        if (!this.lightsOnly) this.playZone(zoneOf(e.pad, this.zones));
        return;
      }
      if (p.name === 'ready') return this.startRound();
      // Short pause so the hit that ended the round can't start the next one.
      if (performance.now() - p.at > 800) this.startRound();
      return;
    }
    if (this.lightsOnly && p.name === 'waiting') {
      this.finish(null, { falseStart: true, earlyMs: e.t - p.goT });
      return;
    }
    const j = judgeHit(this.lightsOnly ? e.t : this.ctx.adjust(e.t), p.goT);
    if (j.kind === 'falseStart') this.finish(null, { falseStart: true, earlyMs: j.ms });
    else if (!classic && zoneOf(e.pad, this.zones) !== p.zone) this.finish(null, { wrongZone: true });
    else this.finish(j.ms);
  }

  onTap(x: number, y: number): void {
    if (this.phase.name !== 'ready' && this.phase.name !== 'result') return;
    if (inRect(this.cueToggle, x, y)) return this.toggleCue();
    const i = this.tiles.findIndex((r) => inRect(r, x, y));
    if (i >= 0 && !this.lightsOnly) this.playZone(i);
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
    const lights = this.lightsOnly;
    this.tiles = [];
    this.cueToggle = null;

    switch (p.name) {
      case 'ready':
        clear(g, w, h);
        text(g, `◀  ${modeLabel(this.mode, this.cue)}  ▶`, cx, big * 0.35, big * 0.2, THEME.accent);
        if (classic) {
          text(g, '⚡', cx, cy - big * 0.9, big);
          text(g, kid ? 'Hit a pad!' : 'Hit a pad to start', cx, cy + big * 0.2, big * 0.35);
          const how = lights ? 'Watch the pads. When they light up, hit any pad as fast as you can' : 'Wait for the GO sound, then hit any pad as fast as you can';
          if (!kid) text(g, how, cx, cy + big * 0.7, fitSize(g, how, w * 0.92, big * 0.14, 500), THEME.muted, 'center', 500);
        } else {
          const how = lights ? 'One part will light up. Hit that part as fast as you can!' : 'Try each part to learn its sound. Then hit the part you hear!';
          if (!kid) text(g, how, cx, big * 0.98, fitSize(g, how, w * 0.92, big * 0.14, 500), THEME.muted, 'center', 500);
          const size = Math.min(w * 0.92, h * 0.52);
          this.drawZoneMap(g, cx - size / 2, big * 1.2, size, size * (PAD_ROWS / PAD_COLS), kid);
          text(g, kid ? '▶' : '▶ Play to start', cx, h - big * 0.3, big * 0.2);
        }
        if (!kid) {
          const hint = 'knob 1 or ◀ ▶ game · knob 2 or ▲▼ sound / lights';
          text(g, hint, cx, h - big * 0.08, fitSize(g, hint, w * 0.92, big * 0.11, 500), THEME.muted, 'center', 500);
        }
        this.drawCueToggle(g, w, big);
        break;
      case 'waiting':
        clear(g, w, h);
        text(g, kid ? '🤫' : lights ? 'Watch the pads…' : classic ? 'Wait for it…' : 'Listen…', cx, cy, kid ? big : big * 0.4, THEME.muted);
        break;
      case 'go':
        // Lights only: the screen stays as it was, the pads are the only cue.
        if (lights) {
          clear(g, w, h);
          text(g, kid ? '🤫' : 'Watch the pads…', cx, cy, kid ? big : big * 0.4, THEME.muted);
          break;
        }
        clear(g, w, h, classic ? '#0f5f2c' : '#1d2a44');
        text(g, classic ? 'GO!' : '?', cx, cy, big * 1.3);
        break;
      case 'result': {
        const failed = p.ms === null;
        clear(g, w, h, failed ? '#3a1414' : THEME.bg);
        if (failed) {
          const msg = p.wrongZone ? 'Wrong one!' : p.tooSlow ? 'Too slow!' : 'Too early!';
          text(g, msg, cx, cy - big * 0.3, fitSize(g, msg, w * 0.9, big * 0.7), THEME.bad);
          if (p.falseStart && p.earlyMs !== null && !kid) {
            // Say how early, so a bad timing calibration is easy to spot.
            const detail = `${Math.max(1, Math.round(-p.earlyMs))} ms before GO`;
            text(g, detail, cx, cy + big * 0.45, big * 0.16, THEME.text, 'center', 500);
            const offset = this.ctx.settings().latencyOffsetMs;
            if (offset > 40 && !lights) text(g, `(timing offset −${Math.round(offset)} ms applied · clear or redo it in Settings if this keeps happening)`, cx, cy + big * 0.7, big * 0.12, THEME.muted, 'center', 500);
          }
          if (!classic && !p.falseStart) {
            const z = ZONES[p.zone]!;
            text(g, lights ? `It was the ${z.colour} part` : `It was ${z.emoji} ${z.name}`, cx, cy + big * 0.45, big * 0.25);
          }
        } else {
          const s = formatMs(p.ms!);
          text(g, s, cx, cy - big * 0.3, fitSize(g, s, w * 0.9, big), p.best ? THEME.good : THEME.text);
          if (p.best) text(g, '★ Best this session!', cx, cy + big * 0.45, big * 0.22, THEME.good);
        }
        this.drawStats(g, w, h, big);
        text(
          g,
          kid ? '▶' : classic ? 'Hit a pad or ▶ to go again · ■ menu' : lights ? '▶ to go again · ■ menu' : '▶ to go again · pads replay sounds · ■ menu',
          cx,
          h - big * 0.3,
          big * 0.13,
          THEME.muted,
          'center',
          500,
        );
        this.drawCueToggle(g, w, big);
        break;
      }
    }
  }

  /** Pill under the title: tap it (or knob 2 / ▲▼) to switch between a sound GO and lights only. */
  private drawCueToggle(g: CanvasRenderingContext2D, w: number, big: number): void {
    const label = this.lightsOnly ? '💡 Lights only' : '🔊 Sound';
    const size = Math.max(13, big * 0.13);
    g.font = `600 ${Math.round(size)}px ${THEME.font}`;
    const bw = g.measureText(label).width + size * 1.4;
    const bh = size * 2.2;
    const r = { x: (w - bw) / 2, y: big * 0.62 - bh / 2, w: bw, h: bh }; // under the title
    roundRect(g, r.x, r.y, r.w, r.h, bh / 2, this.lightsOnly ? '#3a3414' : THEME.panel);
    text(g, label, r.x + r.w / 2, r.y + r.h / 2, size, this.lightsOnly ? THEME.warn : THEME.text, 'center', 600);
    this.cueToggle = r;
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
      if (!b || this.lightsOnly) return; // sound names mean nothing without sound
      const zone = ZONES[z]!;
      text(g, zone.emoji, b.x + b.w / 2, b.y + b.h / 2 - (kid ? 0 : cell * 0.18), cell * 0.55);
      if (!kid) text(g, zone.name, b.x + b.w / 2, b.y + b.h / 2 + cell * 0.38, cell * 0.24);
    });
    this.tiles = bounds.filter((b): b is Rect => b !== null);
  }

  private drawStats(g: CanvasRenderingContext2D, w: number, h: number, big: number): void {
    const key = bestKey(this.mode, this.cue);
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
