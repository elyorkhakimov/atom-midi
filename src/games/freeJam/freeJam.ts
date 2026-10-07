import { KITS } from '../../audio/kit';
import { Metronome } from '../../audio/metronome';
import { PARAM_ROWS, SYNTH_PRESETS, isRoot, padSemitone, sanitizePatch, stepParam, type ParamDef, type SynthPatch } from '../../audio/synth';
import type { InputEvent } from '../../input/events';
import { PAD_COLS, PAD_COUNT, PAD_ROWS } from '../../midi/atomMap';
import { THEME, clear, fitSize, ledCss, roundRect, text } from '../draw';
import { inRect, type Game, type GameContext, type Rect } from '../framework';

const MIN_BPM = 40;
const MAX_BPM = 220;
/** Seconds a pad glows on screen after a hit. */
const GLOW_S = 0.35;

type Rgb = { r: number; g: number; b: number };
interface Page {
  id: 'drums' | 'pluck' | 'pad' | 'custom';
  tab: string;
  /** LED colours for synth pages: scale roots, other notes. */
  root?: Rgb;
  note?: Rgb;
}

const PAGES: readonly Page[] = [
  { id: 'drums', tab: '🥁 Drums' },
  { id: 'pluck', tab: `🎹 ${SYNTH_PRESETS.pluck.name}`, root: { r: 90, g: 127, b: 127 }, note: { r: 0, g: 70, b: 90 } },
  { id: 'pad', tab: `🌊 ${SYNTH_PRESETS.pad.name}`, root: { r: 127, g: 90, b: 127 }, note: { r: 55, g: 15, b: 100 } },
  { id: 'custom', tab: '🎛 Make', root: { r: 127, g: 110, b: 60 }, note: { r: 100, g: 45, b: 0 } },
];

const NOTE_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

/**
 * Play the kit or a synth. ◀▶ (or the tabs) switch pages: drums, two synth
 * presets, and a synth you can tweak. Knob 2 = volume, knob 3 = tempo,
 * knob 4 = metronome volume, knob 1 = kit on the drums page. On the tweak page
 * the knobs edit the highlighted row of settings instead; ▲▼ pick the row.
 * Click (or Play) toggles the metronome.
 */
export class FreeJamGame implements Game {
  private ctx!: GameContext;
  private metronome!: Metronome;
  private readonly lastHit: { t: number; velocity: number }[] = Array.from({ length: PAD_COUNT }, () => ({ t: -1e9, velocity: 0 }));
  private beats: { at: number; accent: boolean }[] = [];
  private bpm = 100;
  private message: { text: string; until: number } | null = null;
  private pageIndex = 0;
  private paramRow = 0;
  private tabRects: Rect[] = [];
  /** Tap targets on the tweak page: each tile's left half lowers, right half raises. */
  private paramRects: { rect: Rect; row: number; def: ParamDef }[] = [];
  private resetRect: Rect | null = null;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.metronome = new Metronome(ctx.audio, (beat, at) => {
      this.beats.push({ at, accent: beat % 4 === 0 });
      if (this.beats.length > 8) this.beats.shift();
    });
    this.metronome.bpm = this.bpm;
    const saved = ctx.settings().jamPage;
    this.pageIndex = Number.isInteger(saved) && saved >= 0 && saved < PAGES.length ? saved : 0;
    this.lightPads();
  }

  stop(): void {
    this.metronome.stop();
    this.ctx.audio.stopAll();
  }

  private get page(): Page {
    return PAGES[this.pageIndex]!;
  }

  private patch(): SynthPatch | null {
    const id = this.page.id;
    if (id === 'drums') return null;
    if (id === 'custom') return sanitizePatch(this.ctx.settings().synthCustom);
    return SYNTH_PRESETS[id].patch;
  }

  private padColor(pad: number): Rgb {
    const patch = this.patch();
    if (!patch) return this.ctx.audio.padColor(pad) ?? { r: 30, g: 30, b: 30 };
    return isRoot(pad, patch.scale) ? this.page.root! : this.page.note!;
  }

  private lightPads(): void {
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, (_, pad) => this.padColor(pad)));
    this.ctx.controller.setButtonLight('click', this.metronome.running);
  }

  private say(s: string): void {
    this.message = { text: s, until: performance.now() + 1200 };
  }

  private goToPage(i: number): void {
    const next = (i + PAGES.length) % PAGES.length;
    if (next === this.pageIndex) return;
    this.ctx.audio.stopAll();
    this.pageIndex = next;
    this.ctx.updateSettings({ jamPage: next });
    this.lightPads();
    this.say(this.page.tab);
  }

  private toggleMetronome(): void {
    if (this.metronome.running) this.metronome.stop();
    else this.metronome.start();
    this.ctx.controller.setButtonLight('click', this.metronome.running);
    this.say(this.metronome.running ? `Metronome on · ${this.bpm} BPM` : 'Metronome off');
  }

  private tweak(def: ParamDef, delta: number): void {
    const before = sanitizePatch(this.ctx.settings().synthCustom);
    const after = stepParam(before, def, delta);
    this.ctx.updateSettings({ synthCustom: after });
    if (def.key === 'scale') this.lightPads();
    this.say(`${def.label}: ${formatParam(def, after)}`);
  }

  onInput(e: InputEvent): void {
    if (e.type === 'padDown') {
      const patch = this.patch();
      if (patch) this.ctx.audio.synth.noteOn(e.pad, e.velocity, patch);
      else this.ctx.audio.playPad(e.pad, e.velocity);
      this.lastHit[e.pad] = { t: performance.now(), velocity: e.velocity };
      return;
    }
    if (e.type === 'padUp') {
      if (this.page.id !== 'drums') this.ctx.audio.synth.noteOff(e.pad);
      return;
    }
    if (e.type === 'encoder') {
      if (this.page.id === 'custom') {
        const def = PARAM_ROWS[this.paramRow]?.[e.id];
        if (def) this.tweak(def, Math.sign(e.delta) * Math.min(4, Math.abs(e.delta)));
        return;
      }
      const s = this.ctx.settings();
      const step = Math.sign(e.delta) * Math.min(4, Math.abs(e.delta));
      switch (e.id) {
        case 0: {
          if (this.page.id !== 'drums') break;
          const i = KITS.findIndex((k) => k.id === s.kitId);
          const next = KITS[(i + Math.sign(e.delta) + KITS.length) % KITS.length]!;
          if (next.id !== s.kitId) {
            this.ctx.updateSettings({ kitId: next.id });
            void this.ctx.audio.loadKit(next.id).then(() => this.lightPads());
          }
          this.say(`Kit: ${next.name}`);
          break;
        }
        case 1: {
          const v = Math.max(0, Math.min(1, s.masterVolume + step * 0.02));
          this.ctx.updateSettings({ masterVolume: v });
          this.say(`Volume ${Math.round(v * 100)}%`);
          break;
        }
        case 2:
          this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, this.bpm + step));
          this.metronome.bpm = this.bpm;
          this.say(`Tempo ${this.bpm} BPM`);
          break;
        case 3: {
          const v = Math.max(0, Math.min(1, s.metronomeVolume + step * 0.02));
          this.ctx.updateSettings({ metronomeVolume: v });
          this.say(`Metronome volume ${Math.round(v * 100)}%`);
          break;
        }
      }
      return;
    }
    if (e.type === 'button' && e.down) {
      if (e.action === 'metronome' || e.action === 'start') this.toggleMetronome();
      else if (e.action === 'back') this.ctx.exit();
      else if (e.action === 'next') this.goToPage(this.pageIndex + 1);
      else if (e.action === 'prev') this.goToPage(this.pageIndex - 1);
      else if (this.page.id === 'custom' && (e.action === 'up' || e.action === 'down')) {
        this.paramRow = (this.paramRow + (e.action === 'down' ? 1 : -1) + PARAM_ROWS.length) % PARAM_ROWS.length;
        this.say(`Knobs: ${PARAM_ROWS[this.paramRow]!.map((d) => d.label).join(' · ')}`);
      }
    }
  }

  onTap(x: number, y: number): void {
    const tab = this.tabRects.findIndex((r) => inRect(r, x, y));
    if (tab >= 0) return this.goToPage(tab);
    if (inRect(this.resetRect, x, y)) {
      this.ctx.updateSettings({ synthCustom: sanitizePatch(undefined) });
      this.lightPads();
      this.say('Synth reset');
      return;
    }
    for (const { rect, row, def } of this.paramRects) {
      if (!inRect(rect, x, y)) continue;
      this.paramRow = row;
      this.tweak(def, x < rect.x + rect.w / 2 ? -1 : 1);
      return;
    }
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    clear(g, w, h);
    const kid = this.ctx.settings().kidUi;
    const header = Math.min(w, h) * 0.09;

    // Metronome pulse
    const audioNow = this.ctx.audio.clock.perfToAudio(now);
    const beat = [...this.beats].reverse().find((b) => b.at <= audioNow);
    if (this.metronome.running && beat && audioNow - beat.at < 0.12) {
      g.fillStyle = beat.accent ? 'rgba(74,163,255,0.35)' : 'rgba(74,163,255,0.18)';
      g.fillRect(0, 0, w, h);
    }

    this.drawTabs(g, w, header);

    const footer = header * 1.2;
    const top = header * 1.35;
    const avail = h - top - footer;
    this.paramRects = [];
    this.resetRect = null;
    let grid: Rect;
    if (this.page.id === 'custom') {
      const wide = w > h * 1.15;
      if (wide) {
        const size = Math.min(w * 0.46, avail);
        grid = { x: w * 0.03, y: top + (avail - size) / 2, w: size, h: size };
        this.drawParams(g, { x: grid.x + size + w * 0.03, y: top, w: w - size - w * 0.09, h: avail });
      } else {
        const panelH = Math.min(avail * 0.45, w * 0.62);
        const size = Math.min(w * 0.94, avail - panelH - header * 0.3);
        this.drawParams(g, { x: w * 0.03, y: top, w: w * 0.94, h: panelH });
        grid = { x: (w - size) / 2, y: top + panelH + header * 0.3, w: size, h: size };
      }
    } else {
      const label = this.page.id === 'drums' ? `${this.ctx.audio.kit?.json.name ?? 'Loading kit…'}` : this.page.tab;
      text(g, label, w / 2, top + header * 0.3, header * 0.42, THEME.muted, 'center', 600);
      const size = Math.min(w * 0.94, avail - header * 0.8);
      grid = { x: (w - size) / 2, y: top + header * 0.8, w: size, h: size };
    }
    this.drawPads(g, grid, now, kid);

    const s = this.ctx.settings();
    const status = this.message && now < this.message.until
      ? this.message.text
      : kid
        ? `${this.metronome.running ? '🔔' : ''}`
        : this.page.id === 'custom'
          ? `Knobs edit the highlighted row · ▲▼ row · tap − / + · ◀▶ page`
          : `Vol ${Math.round(s.masterVolume * 100)}% · ${this.bpm} BPM · metronome ${this.metronome.running ? 'on' : 'off'} (Click) · ◀▶ page · ■ menu`;
    text(g, status, w / 2, h - footer / 2, fitSize(g, status, w * 0.94, header * 0.38, 600), THEME.muted, 'center', 600);
  }

  private drawTabs(g: CanvasRenderingContext2D, w: number, header: number): void {
    const gap = w * 0.015;
    const tabW = (w * 0.96 - gap * (PAGES.length - 1)) / PAGES.length;
    const tabH = header * 0.8;
    const y = header * 0.25;
    this.tabRects = PAGES.map((p, i) => {
      const r = { x: w * 0.02 + i * (tabW + gap), y, w: tabW, h: tabH };
      const on = i === this.pageIndex;
      roundRect(g, r.x, r.y, r.w, r.h, tabH / 2, on ? '#24405e' : THEME.panel);
      text(g, p.tab, r.x + r.w / 2, r.y + r.h / 2, fitSize(g, p.tab, r.w * 0.86, tabH * 0.45), on ? THEME.text : THEME.muted);
      return r;
    });
  }

  private drawParams(g: CanvasRenderingContext2D, area: Rect): void {
    const patch = sanitizePatch(this.ctx.settings().synthCustom);
    const rows = PARAM_ROWS.length;
    const titleH = area.h * 0.13;
    const gap = Math.min(area.w, area.h) * 0.025;
    const tileW = (area.w - gap * 3) / 4;
    const tileH = (area.h - titleH - gap * (rows - 1)) / rows;

    text(g, 'Make your own sound', area.x, area.y + titleH * 0.45, fitSize(g, 'Make your own sound', area.w * 0.65, titleH * 0.62), THEME.text, 'left');
    const rw = area.w * 0.22;
    this.resetRect = { x: area.x + area.w - rw, y: area.y, w: rw, h: titleH * 0.9 };
    roundRect(g, this.resetRect.x, this.resetRect.y, rw, this.resetRect.h, this.resetRect.h / 2, THEME.panel);
    text(g, '↺ Reset', this.resetRect.x + rw / 2, this.resetRect.y + this.resetRect.h / 2, fitSize(g, '↺ Reset', rw * 0.8, titleH * 0.45), THEME.muted);

    PARAM_ROWS.forEach((defs, row) => {
      const y = area.y + titleH + row * (tileH + gap);
      const active = row === this.paramRow;
      if (active) roundRect(g, area.x - gap / 2, y - gap / 2, area.w + gap, tileH + gap, gap, 'rgba(74,163,255,0.22)');
      defs.forEach((def, col) => {
        const r = { x: area.x + col * (tileW + gap), y, w: tileW, h: tileH };
        this.paramRects.push({ rect: r, row, def });
        roundRect(g, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.12, THEME.panel);
        const value = formatParam(def, patch);
        const labelSize = fitSize(g, def.label, r.w * 0.9, r.h * 0.22, 600);
        text(g, active ? `${col + 1} · ${def.label}` : def.label, r.x + r.w / 2, r.y + r.h * 0.28, labelSize, THEME.muted, 'center', 600);
        text(g, value, r.x + r.w / 2, r.y + r.h * 0.62, fitSize(g, value, r.w * 0.66, r.h * 0.3), THEME.text);
        const side = Math.min(r.h * 0.3, r.w * 0.14);
        text(g, '−', r.x + r.w * 0.09, r.y + r.h * 0.62, side, THEME.muted);
        text(g, '+', r.x + r.w * 0.91, r.y + r.h * 0.62, side, THEME.muted);
      });
    });
  }

  private drawPads(g: CanvasRenderingContext2D, area: Rect, now: number, kid: boolean): void {
    const kit = this.ctx.audio.kit?.json;
    const patch = this.patch();
    const gap = area.w * 0.03;
    const cell = (area.w - gap * (PAD_COLS - 1)) / PAD_COLS;
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const row = PAD_ROWS - 1 - Math.floor(pad / PAD_COLS);
      const col = pad % PAD_COLS;
      const x = area.x + col * (cell + gap);
      const y = area.y + row * (cell + gap);
      const age = (now - this.lastHit[pad]!.t) / 1000;
      const glow = age < GLOW_S ? (1 - age / GLOW_S) * (0.4 + (0.6 * this.lastHit[pad]!.velocity) / 127) : 0;
      roundRect(g, x, y, cell, cell, cell * 0.12, ledCss(this.padColor(pad), 0.25 + 0.75 * glow));
      if (kid) continue;
      let name = '';
      if (patch) {
        const semi = padSemitone(pad, patch.scale);
        name = `${NOTE_NAMES[semi % 12]}${patch.octave + Math.floor(semi / 12)}`;
      } else {
        const id = kit?.pads[pad];
        name = id ? kit?.instruments[id]?.name ?? '' : '';
      }
      text(g, name, x + cell / 2, y + cell / 2, Math.min(cell * 0.16, (cell * 1.6) / Math.max(4, name.length)), THEME.text, 'center', 600);
    }
  }
}

function formatParam(def: ParamDef, patch: SynthPatch): string {
  if (def.kind === 'choice') return patch[def.key];
  return def.format(patch[def.key]);
}
