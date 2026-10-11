import { KITS } from '../../audio/kit';
import { Metronome } from '../../audio/metronome';
import { PARAM_ROWS, SYNTH_PRESETS, isRoot, padSemitone, sanitizePatch, stepParam, type ParamDef, type SynthPatch } from '../../audio/synth';
import type { InputEvent } from '../../input/events';
import { KnobDetents } from '../../input/knob';
import { PAD_COLS, PAD_COUNT, PAD_ROWS } from '../../midi/atomMap';
import { THEME, clear, fitSize, ledCss, roundRect, text } from '../draw';
import { inRect, type Game, type GameContext, type Rect } from '../framework';

const MIN_BPM = 40;
const MAX_BPM = 220;
/** Seconds a pad glows on screen after a hit. */
const GLOW_S = 0.35;
/** Knob ticks per step: lists (wave, scale, kit) move slower than values. */
const TICKS_LIST = 4;
const TICKS_VALUE = 2;
/** Text caps in CSS px, so big screens don't get giant lettering. */
const FONT = { tab: 20, title: 24, label: 15, value: 22, status: 16 };

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

interface KnobFn {
  label: string;
  ticks: number;
  value(): string;
  turn(steps: number): void;
}
const NO_KNOB: KnobFn = { label: '', ticks: 1, value: () => '', turn: () => {} };
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const formatTranspose = (n: number) => (n === 0 ? '0' : `${n > 0 ? '+' : '−'}${Math.abs(n)}`);

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
  private readonly knobs = new KnobDetents();
  private readonly held = new Set<'shift' | 'click'>();
  /** Whether a knob was turned while Click was held (then releasing Click doesn't toggle the metronome). */
  private clickUsed = false;
  private fullLevel = false;

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
    this.ctx.audio.setLivePads(0);
    this.metronome.stop();
    this.ctx.audio.stopAll();
    this.ctx.controller.setButtonLight('fullLevel', false);
  }

  private get page(): Page {
    return PAGES[this.pageIndex]!;
  }

  private patch(): SynthPatch | null {
    const id = this.page.id;
    if (id === 'drums') return null;
    const patch = id === 'custom' ? sanitizePatch(this.ctx.settings().synthCustom) : SYNTH_PRESETS[id].patch;
    const tone = this.ctx.settings().jamTone;
    return tone === 1 ? patch : { ...patch, cutoff: patch.cutoff * tone };
  }

  private padColor(pad: number): Rgb {
    const patch = this.patch();
    if (!patch) return this.ctx.audio.padColor(pad) ?? { r: 30, g: 30, b: 30 };
    return isRoot(pad, patch.scale) ? this.page.root! : this.page.note!;
  }

  /** Android app: every page plays natively on the hit, the kit or the page's synth patch. */
  private syncLivePads(): void {
    const patch = this.patch();
    this.ctx.audio.setLivePads(0xffff, {
      fixedVelocity: this.fullLevel ? this.ctx.settings().fullLevelVelocity : 0,
      synth: patch ? { patch, transpose: this.ctx.settings().jamTranspose } : undefined,
    });
  }

  private lightPads(): void {
    this.syncLivePads();
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, (_, pad) => this.padColor(pad)));
    this.ctx.controller.setButtonLight('click', this.metronome.running);
    this.ctx.controller.setButtonLight('fullLevel', this.fullLevel);
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

  /** What the four knobs do right now: Shift layer, Click layer, or the page's own. */
  private knobLayer(): KnobFn[] {
    const s = this.ctx.settings();
    const synth = this.page.id !== 'drums';
    const volume: KnobFn = {
      label: 'Volume',
      ticks: TICKS_VALUE,
      value: () => `${Math.round(this.ctx.settings().masterVolume * 100)}%`,
      turn: (n) => this.ctx.updateSettings({ masterVolume: clamp(this.ctx.settings().masterVolume + n * 0.02, 0, 1) }),
    };
    const tempo: KnobFn = {
      label: 'Tempo',
      ticks: TICKS_VALUE,
      value: () => `${this.bpm} BPM`,
      turn: (n) => {
        this.bpm = clamp(this.bpm + n, MIN_BPM, MAX_BPM);
        this.metronome.bpm = this.bpm;
      },
    };
    const metronomeVolume: KnobFn = {
      label: 'Click volume',
      ticks: TICKS_VALUE,
      value: () => `${Math.round(this.ctx.settings().metronomeVolume * 100)}%`,
      turn: (n) => this.ctx.updateSettings({ metronomeVolume: clamp(this.ctx.settings().metronomeVolume + n * 0.02, 0, 1) }),
    };
    if (this.held.has('shift')) {
      return [
        volume,
        {
          label: 'Full level',
          ticks: TICKS_VALUE,
          value: () => `${this.ctx.settings().fullLevelVelocity}${this.fullLevel ? '' : ' (off)'}`,
          turn: (n) => this.ctx.updateSettings({ fullLevelVelocity: clamp(this.ctx.settings().fullLevelVelocity + n * 2, 40, 127) }),
        },
        {
          label: 'Transpose',
          ticks: TICKS_LIST,
          value: () => (synth ? formatTranspose(this.ctx.settings().jamTranspose) : 'synths only'),
          turn: (n) => {
            if (!synth) return;
            this.ctx.audio.synth.stopAll();
            this.ctx.updateSettings({ jamTranspose: clamp(this.ctx.settings().jamTranspose + n, -12, 12) });
          },
        },
        {
          label: 'Tone',
          ticks: TICKS_VALUE,
          value: () => (synth ? `${Math.round(this.ctx.settings().jamTone * 100)}%` : 'synths only'),
          turn: (n) => {
            if (synth) this.ctx.updateSettings({ jamTone: +clamp(this.ctx.settings().jamTone * 1.08 ** n, 0.1, 3).toFixed(3) });
          },
        },
      ];
    }
    if (this.held.has('click')) return [tempo, metronomeVolume, volume, NO_KNOB];
    if (this.page.id === 'custom') {
      return PARAM_ROWS[this.paramRow]!.map((def) => ({
        label: def.label,
        ticks: def.kind === 'choice' || def.key === 'octave' ? TICKS_LIST : TICKS_VALUE,
        value: () => formatParam(def, sanitizePatch(this.ctx.settings().synthCustom)),
        turn: (n) => this.tweak(def, n),
      }));
    }
    const kit: KnobFn = {
      label: 'Kit',
      ticks: TICKS_LIST,
      value: () => KITS.find((k) => k.id === this.ctx.settings().kitId)?.name ?? '',
      turn: (n) => {
        const i = KITS.findIndex((k) => k.id === s.kitId);
        const next = KITS[(i + Math.sign(n) + KITS.length) % KITS.length]!;
        if (next.id === s.kitId) return;
        this.ctx.updateSettings({ kitId: next.id });
        void this.ctx.audio.loadKit(next.id).then(() => this.lightPads());
      },
    };
    return [this.page.id === 'drums' ? kit : NO_KNOB, volume, tempo, metronomeVolume];
  }

  private velocity(v: number): number {
    return this.fullLevel ? this.ctx.settings().fullLevelVelocity : v;
  }

  onInput(e: InputEvent): void {
    if (e.type === 'padDown') {
      const velocity = this.velocity(e.velocity);
      const patch = this.patch();
      if (patch) this.ctx.audio.synth.noteOn(e.pad, velocity, patch, this.ctx.settings().jamTranspose);
      else this.ctx.audio.playPad(e.pad, velocity);
      this.lastHit[e.pad] = { t: performance.now(), velocity };
      return;
    }
    this.onControl(e);
    // Page, Full level or its velocity knob may have changed.
    this.syncLivePads();
  }

  private onControl(e: InputEvent): void {
    if (e.type === 'padUp') {
      if (this.page.id !== 'drums') this.ctx.audio.synth.noteOff(e.pad);
      return;
    }
    if (e.type === 'encoder') {
      const layer = this.held.has('shift') ? 'shift' : this.held.has('click') ? 'click' : 'page';
      const fn = this.knobLayer()[e.id];
      if (!fn || fn === NO_KNOB) return;
      // Separate tick counts per layer, so leftovers don't leak between them.
      const steps = this.knobs.step(e.id + (layer === 'shift' ? 10 : layer === 'click' ? 20 : 0), e.delta, fn.ticks);
      if (!steps) return;
      if (this.held.has('click')) this.clickUsed = true;
      fn.turn(steps);
      if (this.page.id !== 'custom' || layer !== 'page') this.say(`${fn.label}: ${fn.value()}`);
      return;
    }
    if (e.type !== 'button') return;
    if (e.id === 'shift' || e.id === 'click') {
      if (e.down) {
        this.held.add(e.id);
        if (e.id === 'click') this.clickUsed = false;
      } else {
        this.held.delete(e.id);
        // Tap Click = metronome on/off; hold Click and turn a knob = tempo, without toggling.
        if (e.id === 'click' && !this.clickUsed) this.toggleMetronome();
      }
      return;
    }
    if (!e.down) return;
    if (e.id === 'fullLevel') {
      this.fullLevel = !this.fullLevel;
      this.ctx.controller.setButtonLight('fullLevel', this.fullLevel);
      this.say(this.fullLevel ? `Full level on · every hit plays at ${this.ctx.settings().fullLevelVelocity}` : 'Full level off');
    } else if (e.action === 'start') this.toggleMetronome();
    else if (e.action === 'back') this.ctx.exit();
    else if (e.action === 'next') this.goToPage(this.pageIndex + 1);
    else if (e.action === 'prev') this.goToPage(this.pageIndex - 1);
    else if (this.page.id === 'custom' && (e.action === 'up' || e.action === 'down')) {
      this.paramRow = (this.paramRow + (e.action === 'down' ? 1 : -1) + PARAM_ROWS.length) % PARAM_ROWS.length;
      this.say(`Knobs: ${PARAM_ROWS[this.paramRow]!.map((d) => d.label).join(' · ')}`);
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
      text(g, label, w / 2, top + header * 0.3, Math.min(FONT.title, header * 0.42), THEME.muted, 'center', 600);
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
          ? `Knobs edit the highlighted row · ▲▼ row · tap − / + · ◀▶ page · hold Shift or Click for more`
          : `Vol ${Math.round(s.masterVolume * 100)}% · ${this.bpm} BPM · metronome ${this.metronome.running ? 'on' : 'off'} (Click)${this.fullLevel ? ' · full level' : ''} · ◀▶ page · hold Shift or Click for more`;
    if (this.held.size) this.drawKnobOverlay(g, w, h - footer, header);
    text(g, status, w / 2, h - footer / 2, fitSize(g, status, w * 0.94, Math.min(FONT.status, header * 0.38), 600), THEME.muted, 'center', 600);
  }

  /** While Shift or Click is held: what each knob does now, with its value. */
  private drawKnobOverlay(g: CanvasRenderingContext2D, w: number, bottom: number, header: number): void {
    const fns = this.knobLayer();
    const title = this.held.has('shift') ? 'Shift + knob' : 'Click + knob';
    const pw = Math.min(w * 0.96, 760);
    const cellH = Math.max(54, Math.min(header * 1.1, 64));
    const ph = cellH + 34;
    const x0 = (w - pw) / 2;
    const y0 = bottom - ph - 8;
    roundRect(g, x0, y0, pw, ph, 14, 'rgba(26,32,41,0.96)');
    text(g, title, x0 + 14, y0 + 16, 14, THEME.accent, 'left');
    const gap = 8;
    const cw = (pw - 28 - gap * 3) / 4;
    fns.forEach((fn, i) => {
      const x = x0 + 14 + i * (cw + gap);
      const y = y0 + 28;
      roundRect(g, x, y, cw, cellH - 6, 10, THEME.bg);
      if (fn === NO_KNOB) return;
      const label = `${i + 1} · ${fn.label}`;
      text(g, label, x + cw / 2, y + (cellH - 6) * 0.3, fitSize(g, label, cw * 0.9, 13, 600), THEME.muted, 'center', 600);
      const v = fn.value();
      text(g, v, x + cw / 2, y + (cellH - 6) * 0.7, fitSize(g, v, cw * 0.9, 17), THEME.text);
    });
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
      text(g, p.tab, r.x + r.w / 2, r.y + r.h / 2, fitSize(g, p.tab, r.w * 0.86, Math.min(FONT.tab, tabH * 0.45)), on ? THEME.text : THEME.muted);
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

    text(g, 'Make your own sound', area.x, area.y + titleH * 0.45, fitSize(g, 'Make your own sound', area.w * 0.65, Math.min(FONT.title, titleH * 0.62)), THEME.text, 'left');
    const rw = area.w * 0.22;
    this.resetRect = { x: area.x + area.w - rw, y: area.y, w: rw, h: titleH * 0.9 };
    roundRect(g, this.resetRect.x, this.resetRect.y, rw, this.resetRect.h, this.resetRect.h / 2, THEME.panel);
    text(g, '↺ Reset', this.resetRect.x + rw / 2, this.resetRect.y + this.resetRect.h / 2, fitSize(g, '↺ Reset', rw * 0.8, Math.min(FONT.label, titleH * 0.45)), THEME.muted);

    // One label size and one value size for every tile, fitted to the longest text.
    const labelOf = (def: ParamDef, col: number, row: number) => (row === this.paramRow ? `${col + 1} · ${def.label}` : def.label);
    let labelSize = Math.min(FONT.label, tileH * 0.2);
    let valueSize = Math.min(FONT.value, tileH * 0.3);
    PARAM_ROWS.forEach((defs, row) =>
      defs.forEach((def, col) => {
        labelSize = Math.min(labelSize, fitSize(g, labelOf(def, col, row), tileW * 0.9, labelSize, 600));
        valueSize = Math.min(valueSize, fitSize(g, formatParam(def, patch), tileW * 0.66, valueSize));
      }),
    );
    PARAM_ROWS.forEach((defs, row) => {
      const y = area.y + titleH + row * (tileH + gap);
      const active = row === this.paramRow;
      if (active) roundRect(g, area.x - gap / 2, y - gap / 2, area.w + gap, tileH + gap, gap, 'rgba(74,163,255,0.22)');
      defs.forEach((def, col) => {
        const r = { x: area.x + col * (tileW + gap), y, w: tileW, h: tileH };
        this.paramRects.push({ rect: r, row, def });
        roundRect(g, r.x, r.y, r.w, r.h, Math.min(r.w, r.h) * 0.12, THEME.panel);
        const value = formatParam(def, patch);
        text(g, labelOf(def, col, row), r.x + r.w / 2, r.y + r.h * 0.3, labelSize, THEME.muted, 'center', 600);
        text(g, value, r.x + r.w / 2, r.y + r.h * 0.64, valueSize, THEME.text);
        const side = valueSize;
        text(g, '−', r.x + r.w * 0.07, r.y + r.h * 0.62, side, THEME.muted);
        text(g, '+', r.x + r.w * 0.93, r.y + r.h * 0.62, side, THEME.muted);
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
        const semi = padSemitone(pad, patch.scale) + this.ctx.settings().jamTranspose + 12;
        name = `${NOTE_NAMES[semi % 12]}${patch.octave - 1 + Math.floor(semi / 12)}`;
      } else {
        const id = kit?.pads[pad];
        name = id ? kit?.instruments[id]?.name ?? '' : '';
      }
      text(g, name, x + cell / 2, y + cell / 2, Math.min(20, cell * 0.16, (cell * 1.6) / Math.max(4, name.length)), THEME.text, 'center', 600);
    }
  }
}

function formatParam(def: ParamDef, patch: SynthPatch): string {
  if (def.kind === 'choice') return patch[def.key];
  return def.format(patch[def.key]);
}
