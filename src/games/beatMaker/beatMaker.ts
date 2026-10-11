import { KITS } from '../../audio/kit';
import type { InputEvent } from '../../input/events';
import { KnobDetents } from '../../input/knob';
import { PAD_COUNT } from '../../midi/atomMap';
import type { PadLed } from '../../midi/ledFrame';
import { loadBeats, saveBeats } from '../../storage/beats';
import { THEME, clear, fitSize, ledCss, roundRect, text } from '../draw';
import { Timers, inRect, type Game, type GameContext, type Rect } from '../framework';
import {
  BAR_CHOICES,
  BEATS_PER_BAR,
  DEFAULT_GRID,
  GRIDS,
  hitPosition,
  nextBeatName,
  quantize,
  resizeLoop,
  sortNotes,
  wrap,
  type BeatNote,
  type CustomBeat,
} from './beat';

const MIN_BPM = 40;
const MAX_BPM = 220;
const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.12;
/** Time from pressing Play/Record to the first click. */
const START_DELAY_S = 0.1;
const CONFIRM_MS = 3000;
const TICKS_VALUE = 2;
const TICKS_LIST = 4;
const FONT = { tab: 20, label: 14, value: 20, status: 26, button: 17, hint: 15 };

interface RecNote extends BeatNote {
  /** Record pass it came from, for Undo. */
  take: number;
  /** Not played back before this audio time: the player just played it. */
  quietUntil?: number;
}

interface Transport {
  /** Audio time of beat 1 of the first pass. */
  origin: number;
  /** Beats (from origin) scheduled so far; negative during the count-in. */
  cursor: number;
}

type View = 'record' | 'list';
interface Button {
  rect: Rect;
  label: string;
  on?: boolean;
  run(): void;
}

/**
 * Record your own beat over a click, then press Nudge to snap it onto the grid, and save it
 * under My beats (also playable in Rhythm copy). The loop keeps going while recording, so
 * each pass layers on top of the last one.
 *
 * Record = count-in, then record (again = stop recording) · Play = loop on/off · Nudge = snap
 * on/off · Shift+Nudge = grid · Select = save (Shift = save as new) · Shift+Record = undo
 * the last take · Shift+Stop = clear · Click = metronome · ◀▶ = Record / My beats.
 * Knobs: tempo, length, grid, kit.
 */
export class BeatMakerGame implements Game {
  private ctx!: GameContext;
  private view: View = 'record';
  private bpm = 100;
  private bars = 1;
  private gridIndex = DEFAULT_GRID;
  private snap = false;
  private notes: RecNote[] = [];
  private take = 0;
  private recording = false;
  private transport: Transport | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly timers = new Timers();
  private readonly knobs = new KnobDetents();
  private shift = false;
  /** Saved beat being edited (Select overwrites it), and whether there are unsaved changes. */
  private editingId: string | null = null;
  private dirty = false;
  private beats: CustomBeat[] = [];
  private listIndex = 0;
  /** An action that needs a second press within CONFIRM_MS (leave unsaved, delete). */
  private confirm: { what: 'exit' | 'delete'; until: number } | null = null;
  private message: { text: string; until: number } | null = null;
  private tabRects: Rect[] = [];
  private tiles: { rect: Rect; turn(n: number): void }[] = [];
  private buttons: Button[] = [];
  private rowRects: Rect[] = [];

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.beats = loadBeats();
    // Hits sound straight from the MIDI thread in the Android app.
    ctx.audio.setLivePads(0xffff);
    this.timer = setInterval(() => this.tick(), LOOKAHEAD_MS);
    this.lightPads();
    this.lightButtons();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timers.clear();
    this.ctx.audio.setLivePads(0);
    this.ctx.audio.stopAll();
  }

  // -------------------------------------------------------------------------
  // What plays
  // -------------------------------------------------------------------------
  private get grid() {
    return GRIDS[this.gridIndex]!;
  }

  private get loopBeats(): number {
    return this.bars * BEATS_PER_BAR;
  }

  private get selectedBeat(): CustomBeat | undefined {
    return this.beats[this.listIndex];
  }

  /** The draft as you hear it: snapped to the grid while Nudge is on. */
  private heard(): RecNote[] {
    return this.snap ? quantize(this.notes, this.grid.div, this.loopBeats) : this.notes;
  }

  /** The loop the transport plays: the draft, or the saved beat picked in My beats. */
  private source(): { notes: readonly (BeatNote & { quietUntil?: number })[]; bpm: number; loopBeats: number } {
    if (this.view === 'list') {
      const b = this.selectedBeat;
      return { notes: b?.notes ?? [], bpm: b?.bpm ?? this.bpm, loopBeats: (b?.bars ?? 1) * BEATS_PER_BAR };
    }
    return { notes: this.heard(), bpm: this.bpm, loopBeats: this.loopBeats };
  }

  private get clickOn(): boolean {
    return this.ctx.settings().beatClick;
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------
  /** Schedules clicks and notes a little ahead on the audio clock (like Metronome). */
  private tick(): void {
    const t = this.transport;
    if (!t) return;
    const { audio, controller } = this.ctx;
    const { notes, bpm, loopBeats } = this.source();
    const beatDur = 60 / bpm;
    const from = t.cursor;
    const to = (audio.clock.now + SCHEDULE_AHEAD_S - t.origin) / beatDur;
    if (to <= from) return;
    t.cursor = to;

    for (let b = Math.ceil(from); b < to; b++) {
      // The count-in (negative beats) always clicks, every click accented.
      if (b < 0) audio.click(true, t.origin + b * beatDur);
      else if (this.clickOn) audio.click(b % BEATS_PER_BAR === 0, t.origin + b * beatDur);
    }
    if (to <= 0) return;
    for (let pass = Math.floor(Math.max(0, from) / loopBeats); pass * loopBeats < to; pass++) {
      for (const n of notes) {
        const x = pass * loopBeats + n.pos;
        if (x < from || x >= to || x < 0) continue;
        const at = t.origin + x * beatDur;
        if (n.quietUntil !== undefined && at < n.quietUntil) continue;
        audio.playPad(n.pad, n.velocity, at);
        // Secondary visual cue: flash the pad as it plays.
        const heardAt = audio.clock.audioToPerf(at);
        this.timers.at(heardAt, () => controller.setPad(n.pad, { r: 127, g: 127, b: 127 }));
        this.timers.at(heardAt + 90, () => controller.setPad(n.pad, this.padLed(n.pad)));
      }
    }
  }

  private play(countIn: boolean): void {
    const beatDur = 60 / this.source().bpm;
    const first = this.ctx.audio.clock.now + START_DELAY_S;
    const cursor = countIn ? -BEATS_PER_BAR : 0;
    this.transport = { origin: first - cursor * beatDur, cursor };
    this.tick();
    this.lightButtons();
  }

  private stopTransport(): void {
    this.transport = null;
    this.recording = false;
    this.timers.clear();
    this.lightPads();
    this.lightButtons();
  }

  /** Changes tempo without jumping: the current beat stays where it is. */
  private setBpm(bpm: number): void {
    const t = this.transport;
    if (t) {
      const now = this.ctx.audio.clock.now;
      const beat = (now - t.origin) / (60 / this.bpm);
      t.origin = now - beat * (60 / bpm);
    }
    this.bpm = bpm;
  }

  private toggleRecord(): void {
    if (this.view !== 'record') this.setView('record');
    if (this.recording) {
      this.recording = false;
      this.say('Recording off · still looping');
      this.lightButtons();
      return;
    }
    this.take++;
    this.recording = true;
    if (!this.transport) this.play(true);
    this.say('● Recording');
    this.lightButtons();
  }

  private togglePlay(): void {
    if (this.transport) return this.stopTransport();
    if (this.view === 'list' && !this.selectedBeat) return this.say('No saved beats yet');
    this.play(false);
  }

  private onPad(pad: number, velocity: number, t: number): void {
    const tr = this.transport;
    if (!this.recording || !tr || this.view !== 'record') return;
    const { audio } = this.ctx;
    const heard = audio.clock.perfToAudio(this.ctx.adjust(t));
    const beatDur = 60 / this.bpm;
    const pos = hitPosition(heard, tr.origin, beatDur, this.loopBeats);
    if (pos === null) return;
    // Its next play-back is the next pass, not the grid line it may snap to right after the hit.
    this.notes.push({ pos, pad, velocity, take: this.take, quietUntil: heard + (this.loopBeats * beatDur) / 2 });
    sortNotes(this.notes);
    this.dirty = true;
  }

  // -------------------------------------------------------------------------
  // Editing
  // -------------------------------------------------------------------------
  private toggleNudge(): void {
    this.snap = !this.snap;
    this.dirty = true;
    this.lightButtons();
    this.say(this.snap ? `Nudged onto the ${this.grid.label} grid` : 'Nudge off · as you played it');
  }

  private changeGrid(delta: number): void {
    this.gridIndex = (this.gridIndex + delta + GRIDS.length) % GRIDS.length;
    if (this.snap) this.dirty = true;
    this.say(`Grid: ${this.grid.label}`);
  }

  private changeBars(delta: number): void {
    const i = BAR_CHOICES.indexOf(this.bars as (typeof BAR_CHOICES)[number]);
    const next = BAR_CHOICES[Math.max(0, Math.min(BAR_CHOICES.length - 1, i + delta))]!;
    if (next === this.bars) return;
    const before = this.loopBeats;
    this.bars = next;
    if (this.notes.length) {
      this.notes = resizeLoop(this.notes, before, this.loopBeats);
      this.dirty = true;
    }
    this.say(`Length: ${next} bar${next > 1 ? 's' : ''}${this.notes.length && next * BEATS_PER_BAR > before ? ' · groove repeated' : ''}`);
  }

  private changeKit(delta: number): void {
    const current = this.ctx.settings().kitId;
    const i = KITS.findIndex((k) => k.id === current);
    this.selectKit(KITS[(i + delta + KITS.length) % KITS.length]!.id);
  }

  private selectKit(id: string): void {
    if (id === this.ctx.settings().kitId || !KITS.some((k) => k.id === id)) return;
    this.ctx.updateSettings({ kitId: id });
    void this.ctx.audio.loadKit(id).then(() => this.lightPads());
    this.say(`Kit: ${KITS.find((k) => k.id === id)?.name ?? id}`);
  }

  private undo(): void {
    if (!this.notes.length) return this.say('Nothing to undo');
    const last = Math.max(...this.notes.map((n) => n.take));
    this.notes = this.notes.filter((n) => n.take !== last);
    this.dirty = true;
    this.say('Last take removed');
  }

  private clearAll(): void {
    if (!this.notes.length) return;
    this.notes = [];
    this.dirty = true;
    this.say('Cleared');
  }

  private save(asNew: boolean): void {
    const notes = this.heard().map(({ pos, pad, velocity }) => ({ pos: Math.round(pos * 1e4) / 1e4, pad, velocity }));
    if (!notes.length) return this.say('Record something first');
    const existing = !asNew && this.editingId ? this.beats.findIndex((b) => b.id === this.editingId) : -1;
    const beat: CustomBeat = {
      id: existing >= 0 ? this.editingId! : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name: existing >= 0 ? this.beats[existing]!.name : nextBeatName(this.beats),
      bpm: this.bpm,
      bars: this.bars,
      kitId: this.ctx.settings().kitId,
      notes,
      savedAt: Date.now(),
    };
    if (existing >= 0) this.beats[existing] = beat;
    else this.beats.push(beat);
    saveBeats(this.beats);
    this.editingId = beat.id;
    this.dirty = false;
    this.ctx.audio.playCue('record');
    this.say(`Saved “${beat.name}” in My beats`);
  }

  /** Opens a saved beat in the recorder. */
  private edit(beat: CustomBeat): void {
    this.stopTransport();
    this.bpm = Math.max(MIN_BPM, Math.min(MAX_BPM, Math.round(beat.bpm)));
    this.bars = beat.bars;
    this.notes = sortNotes(beat.notes.map((n) => ({ ...n, take: 0 })));
    this.take = 0;
    this.snap = false;
    this.editingId = beat.id;
    this.dirty = false;
    this.selectKit(beat.kitId);
    this.setView('record');
    this.say(`Editing “${beat.name}” · Select saves over it, Shift+Select saves a copy`);
  }

  private deleteSelected(): void {
    const beat = this.selectedBeat;
    if (!beat) return;
    if (!this.confirmed('delete')) return this.say(`Delete “${beat.name}”? Press again to delete`);
    this.stopTransport();
    this.beats = this.beats.filter((b) => b !== beat);
    saveBeats(this.beats);
    if (this.editingId === beat.id) this.editingId = null;
    this.listIndex = Math.min(this.listIndex, Math.max(0, this.beats.length - 1));
    this.say(`Deleted “${beat.name}”`);
  }

  /** True on the second press of the same action within CONFIRM_MS. */
  private confirmed(what: 'exit' | 'delete'): boolean {
    const now = performance.now();
    if (this.confirm?.what === what && now < this.confirm.until) {
      this.confirm = null;
      return true;
    }
    this.confirm = { what, until: now + CONFIRM_MS };
    return false;
  }

  private back(): void {
    if (this.transport) return this.stopTransport();
    if (this.view === 'record' && this.dirty && this.notes.length && !this.confirmed('exit')) {
      return this.say('Not saved · Select saves · press Stop again to leave');
    }
    this.ctx.exit();
  }

  private setView(view: View): void {
    if (view === this.view) return;
    this.stopTransport();
    this.view = view;
    if (view === 'list') this.beats = loadBeats();
    this.lightButtons();
  }

  private moveList(delta: number): void {
    if (!this.beats.length) return;
    const playing = Boolean(this.transport);
    this.stopTransport();
    this.listIndex = (this.listIndex + delta + this.beats.length) % this.beats.length;
    this.ctx.audio.playCue('tick');
    if (playing) this.play(false);
  }

  // -------------------------------------------------------------------------
  // Lights and messages
  // -------------------------------------------------------------------------
  private padLed(pad: number): PadLed {
    return this.ctx.audio.padColor(pad) ?? { r: 20, g: 20, b: 20 };
  }

  private lightPads(): void {
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, (_, pad) => this.padLed(pad)));
  }

  private lightButtons(): void {
    const c = this.ctx.controller;
    c.setButtonLight('record', this.recording);
    c.setButtonLight('nudge', this.view === 'record' && this.snap);
    c.setButtonLight('click', this.clickOn);
    c.setButtonLight('play', this.transport ? { r: 0, g: 127, b: 0 } : { r: 0, g: 25, b: 0 });
    c.setButtonLight('select', this.view === 'record' ? { r: 0, g: 40, b: 127 } : { r: 0, g: 0, b: 0 });
  }

  private say(s: string): void {
    this.message = { text: s, until: performance.now() + 2200 };
  }

  // -------------------------------------------------------------------------
  // Input
  // -------------------------------------------------------------------------
  onInput(e: InputEvent): void {
    if (e.type === 'padDown') {
      this.ctx.audio.playPad(e.pad, e.velocity);
      this.onPad(e.pad, e.velocity, e.t);
      return;
    }
    if (e.type === 'encoder') return this.onKnob(e.id, e.delta);
    if (e.type !== 'button') return;
    if (e.id === 'shift') {
      this.shift = e.down;
      return;
    }
    if (!e.down) return;
    const shift = this.shift;
    switch (e.id) {
      case 'record':
        return shift ? this.undo() : this.toggleRecord();
      case 'nudge':
        if (this.view !== 'record') return;
        return shift ? this.changeGrid(1) : this.toggleNudge();
      case 'play':
        return this.togglePlay();
      case 'stop':
        if (shift) return this.view === 'record' ? this.clearAll() : this.deleteSelected();
        return this.back();
      case 'select':
        if (this.view === 'record') return this.save(shift);
        if (this.selectedBeat) this.edit(this.selectedBeat);
        return;
      case 'click':
        this.ctx.updateSettings({ beatClick: !this.clickOn });
        this.lightButtons();
        return this.say(this.clickOn ? 'Click on' : 'Click off (the count-in still clicks)');
      case 'left':
      case 'right':
        return this.setView(this.view === 'record' ? 'list' : 'record');
      case 'up':
      case 'down':
        if (this.view === 'list') this.moveList(e.id === 'down' ? 1 : -1);
        return;
    }
  }

  private onKnob(id: number, delta: number): void {
    if (this.view === 'list') {
      const steps = this.knobs.step(10 + id, delta, TICKS_LIST);
      if (steps) this.moveList(Math.sign(steps));
      return;
    }
    const steps = this.knobs.step(id, delta, id === 0 ? TICKS_VALUE : TICKS_LIST);
    if (steps) this.knobTurns()[id]?.(steps);
  }

  /** Knobs 1–4 and the matching on-screen tiles: tempo, length, grid, kit. */
  private knobTurns(): ((n: number) => void)[] {
    return [
      (n) => {
        this.setBpm(Math.max(MIN_BPM, Math.min(MAX_BPM, this.bpm + n)));
        this.say(`Tempo: ${this.bpm} BPM`);
      },
      (n) => this.changeBars(Math.sign(n)),
      (n) => this.changeGrid(Math.sign(n)),
      (n) => this.changeKit(Math.sign(n)),
    ];
  }

  onTap(x: number, y: number): void {
    const tab = this.tabRects.findIndex((r) => inRect(r, x, y));
    if (tab >= 0) return this.setView(tab === 0 ? 'record' : 'list');
    for (const t of this.tiles) if (inRect(t.rect, x, y)) return t.turn(x < t.rect.x + t.rect.w / 2 ? -1 : 1);
    for (const b of this.buttons) if (inRect(b.rect, x, y)) return b.run();
    const row = this.rowRects.findIndex((r) => inRect(r, x, y));
    if (row >= 0 && row !== this.listIndex) this.moveList(row - this.listIndex);
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    clear(g, w, h);
    const unit = Math.min(w, h) * 0.09;
    this.tiles = [];
    this.buttons = [];
    this.rowRects = [];

    // Beat pulse
    const t = this.transport;
    const { bpm } = this.source();
    const heardBeat = t ? (this.ctx.audio.clock.perfToAudio(now) - t.origin) / (60 / bpm) : null;
    if (heardBeat !== null && heardBeat > -BEATS_PER_BAR && heardBeat - Math.floor(heardBeat) < 0.12 * (bpm / 60)) {
      const accent = Math.floor(heardBeat) % BEATS_PER_BAR === 0;
      g.fillStyle = this.recording ? `rgba(255,77,77,${accent ? 0.22 : 0.12})` : `rgba(74,163,255,${accent ? 0.22 : 0.12})`;
      g.fillRect(0, 0, w, h);
    }

    this.drawTabs(g, w, unit);
    const top = unit * 1.3;
    const footer = unit * 0.9;
    const btnH = Math.max(44, Math.min(unit * 0.9, 64));
    const btnY = h - footer - btnH - unit * 0.15;
    if (this.view === 'record') this.drawRecord(g, w, top, btnY, heardBeat, unit);
    else this.drawList(g, w, top, btnY, heardBeat, unit);
    this.drawButtons(g, w, btnY, btnH);

    const status =
      this.message && now < this.message.until
        ? this.message.text
        : this.view === 'record'
          ? '● Record · ▶ loop · Nudge snaps to the grid · Select saves · Shift+● undo · Shift+■ clear · ◀▶ My beats'
          : '▲▼ or knob choose · ▶ listen · Select edit · Shift+■ delete · ◀▶ Record';
    text(g, status, w / 2, h - footer / 2, fitSize(g, status, w * 0.94, Math.min(FONT.hint, unit * 0.32), 600), THEME.muted, 'center', 600);
  }

  private drawTabs(g: CanvasRenderingContext2D, w: number, unit: number): void {
    const tabs = ['● Record', `★ My beats (${this.beats.length})`];
    const gap = w * 0.015;
    const tabW = (w * 0.96 - gap) / 2;
    const tabH = unit * 0.8;
    this.tabRects = tabs.map((label, i) => {
      const r = { x: w * 0.02 + i * (tabW + gap), y: unit * 0.25, w: tabW, h: tabH };
      const on = (i === 0) === (this.view === 'record');
      roundRect(g, r.x, r.y, r.w, r.h, tabH / 2, on ? '#24405e' : THEME.panel);
      text(g, label, r.x + r.w / 2, r.y + r.h / 2, fitSize(g, label, r.w * 0.86, Math.min(FONT.tab, tabH * 0.45)), on ? THEME.text : THEME.muted);
      return r;
    });
  }

  private drawRecord(g: CanvasRenderingContext2D, w: number, top: number, bottom: number, heardBeat: number | null, unit: number): void {
    // Settings tiles (knobs 1–4): tap the left half to lower, the right half to raise.
    const kit = KITS.find((k) => k.id === this.ctx.settings().kitId)?.name ?? '';
    const tiles = [
      ['Tempo', `${this.bpm} BPM`],
      ['Length', `${this.bars} bar${this.bars > 1 ? 's' : ''}`],
      ['Grid', this.grid.label],
      ['Kit', kit],
    ];
    const turns = this.knobTurns();
    const gap = w * 0.015;
    const tileW = (w * 0.96 - gap * 3) / 4;
    const tileH = Math.max(52, Math.min(unit * 1.1, 72));
    tiles.forEach(([label, value], i) => {
      const r = { x: w * 0.02 + i * (tileW + gap), y: top, w: tileW, h: tileH };
      this.tiles.push({ rect: r, turn: turns[i]! });
      roundRect(g, r.x, r.y, r.w, r.h, 10, THEME.panel);
      const l = `${i + 1} · ${label}`;
      text(g, l, r.x + r.w / 2, r.y + r.h * 0.3, fitSize(g, l, r.w * 0.8, FONT.label, 600), THEME.muted, 'center', 600);
      text(g, value!, r.x + r.w / 2, r.y + r.h * 0.68, fitSize(g, value!, r.w * 0.7, FONT.value), THEME.text);
      text(g, '−', r.x + r.w * 0.08, r.y + r.h * 0.66, FONT.value, THEME.muted);
      text(g, '+', r.x + r.w * 0.92, r.y + r.h * 0.66, FONT.value, THEME.muted);
    });

    // Status
    const statusY = top + tileH + unit * 0.55;
    let status: string;
    let color = THEME.text;
    if (heardBeat !== null && heardBeat < 0) {
      status = `Get ready… ${Math.ceil(-heardBeat)}`;
      color = THEME.warn;
    } else if (this.recording) {
      status = '● Recording';
      color = THEME.bad;
    } else if (this.transport) {
      status = '▶ Playing';
      color = THEME.good;
    } else status = this.notes.length ? 'Stopped' : 'Press ● Record and play along with the click';
    const name = this.editingId ? this.beats.find((b) => b.id === this.editingId)?.name : null;
    const suffix = `${this.snap ? ` · 🧲 nudged to ${this.grid.label}` : ''}${name ? ` · ${name}${this.dirty ? ' *' : ''}` : ''}`;
    const line = status + suffix;
    text(g, line, w / 2, statusY, fitSize(g, line, w * 0.94, Math.min(FONT.status, unit * 0.5)), color);

    const area = { x: w * 0.03, y: statusY + unit * 0.5, w: w * 0.94, h: bottom - statusY - unit * 0.75 };
    const pos = heardBeat !== null && heardBeat >= 0 ? wrap(heardBeat, this.loopBeats) : null;
    this.drawTimeline(g, area, this.notes, this.loopBeats, pos, this.snap ? this.grid.div : null);
  }

  /**
   * Lanes, one per pad used, higher pads on top. With a grid, each note is drawn where it
   * snaps, with a faint ghost and a line back to where it was played.
   */
  private drawTimeline(g: CanvasRenderingContext2D, area: Rect, notes: readonly BeatNote[], loopBeats: number, playhead: number | null, snapDiv: number | null): void {
    roundRect(g, area.x, area.y, area.w, area.h, 10, '#12161c');
    const div = snapDiv ?? this.grid.div;
    const xOf = (pos: number) => area.x + (pos / loopBeats) * area.w;
    for (let i = 0; i <= loopBeats * div; i++) {
      const beat = i / div;
      const bar = beat % BEATS_PER_BAR === 0;
      const onBeat = Number.isInteger(beat);
      g.fillStyle = bar ? 'rgba(255,255,255,0.35)' : onBeat ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.06)';
      g.fillRect(xOf(beat) - (bar ? 1 : 0.5), area.y, bar ? 2 : 1, area.h);
    }
    const pads = [...new Set(notes.map((n) => n.pad))].sort((a, b) => b - a);
    if (!pads.length) {
      text(g, 'Your beat shows up here', area.x + area.w / 2, area.y + area.h / 2, Math.min(18, area.h * 0.12), THEME.muted, 'center', 600);
    }
    const laneH = pads.length ? Math.min(area.h / pads.length, 56) : 0;
    const y0 = area.y + (area.h - laneH * pads.length) / 2;
    for (const n of notes) {
      const lane = pads.indexOf(n.pad);
      const cy = y0 + lane * laneH + laneH / 2;
      const r = Math.max(3, Math.min(laneH * 0.32, area.w / (loopBeats * 8)) * (0.55 + (0.45 * n.velocity) / 127));
      const color = this.padLed(n.pad);
      let x = xOf(n.pos);
      if (snapDiv) {
        const snapped = wrap(Math.round(n.pos * snapDiv) / snapDiv, loopBeats);
        const sx = xOf(snapped);
        g.beginPath();
        g.arc(x, cy, r, 0, Math.PI * 2);
        g.fillStyle = ledCss(color, 0.22);
        g.fill();
        // Short way round: a hit just before the loop end snaps to the start.
        if (Math.abs(sx - x) < area.w / 2) {
          g.strokeStyle = ledCss(color, 0.5);
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(x, cy);
          g.lineTo(sx, cy);
          g.stroke();
        }
        x = sx;
      }
      g.beginPath();
      g.arc(x, cy, r, 0, Math.PI * 2);
      g.fillStyle = ledCss(color, 0.95);
      g.fill();
    }
    if (playhead !== null) {
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillRect(xOf(playhead) - 1.5, area.y, 3, area.h);
    }
  }

  private drawList(g: CanvasRenderingContext2D, w: number, top: number, bottom: number, heardBeat: number | null, unit: number): void {
    if (!this.beats.length) {
      text(g, 'No saved beats yet', w / 2, top + (bottom - top) * 0.4, Math.min(26, unit * 0.5));
      text(g, 'Record one, then press Select to save it here', w / 2, top + (bottom - top) * 0.4 + unit * 0.7, Math.min(17, unit * 0.34), THEME.muted, 'center', 600);
      return;
    }
    const rowH = Math.max(56, Math.min(unit * 1.25, 84));
    const visible = Math.max(1, Math.floor((bottom - top - unit * 0.2) / (rowH + 8)));
    const first = Math.max(0, Math.min(this.listIndex - Math.floor(visible / 2), this.beats.length - visible));
    for (let i = first; i < Math.min(this.beats.length, first + visible); i++) {
      const b = this.beats[i]!;
      const r = { x: w * 0.03, y: top + (i - first) * (rowH + 8), w: w * 0.94, h: rowH };
      this.rowRects[i] = r;
      const on = i === this.listIndex;
      roundRect(g, r.x, r.y, r.w, r.h, 12, on ? '#24405e' : THEME.panel);
      const infoW = r.w * 0.36;
      text(g, b.name, r.x + 14, r.y + r.h * 0.34, fitSize(g, b.name, infoW - 20, Math.min(20, rowH * 0.3)), THEME.text, 'left');
      const kit = KITS.find((k) => k.id === b.kitId)?.name ?? b.kitId;
      const info = `${b.bpm} BPM · ${b.bars} bar${b.bars > 1 ? 's' : ''} · ${kit}`;
      text(g, info, r.x + 14, r.y + r.h * 0.7, fitSize(g, info, infoW - 20, Math.min(14, rowH * 0.22), 600), THEME.muted, 'left', 600);
      const loopBeats = b.bars * BEATS_PER_BAR;
      const pos = on && heardBeat !== null && heardBeat >= 0 ? wrap(heardBeat, loopBeats) : null;
      this.drawTimeline(g, { x: r.x + infoW, y: r.y + 6, w: r.w - infoW - 8, h: r.h - 12 }, b.notes, loopBeats, pos, null);
    }
  }

  private drawButtons(g: CanvasRenderingContext2D, w: number, y: number, h: number): void {
    const playing = Boolean(this.transport);
    const list: Omit<Button, 'rect'>[] =
      this.view === 'record'
        ? [
            { label: this.recording ? '● Stop rec' : '● Rec', on: this.recording, run: () => this.toggleRecord() },
            { label: playing ? '■ Stop' : '▶ Play', on: playing, run: () => this.togglePlay() },
            { label: '🧲 Nudge', on: this.snap, run: () => this.toggleNudge() },
            { label: '↶ Undo', run: () => this.undo() },
            { label: '✕ Clear', run: () => this.clearAll() },
            { label: '💾 Save', run: () => this.save(false) },
          ]
        : [
            { label: playing ? '■ Stop' : '▶ Listen', on: playing, run: () => this.togglePlay() },
            { label: '✎ Edit', run: () => this.selectedBeat && this.edit(this.selectedBeat) },
            { label: this.confirm?.what === 'delete' && performance.now() < this.confirm.until ? '🗑 Sure?' : '🗑 Delete', run: () => this.deleteSelected() },
          ];
    const gap = w * 0.012;
    const bw = (w * 0.96 - gap * (list.length - 1)) / list.length;
    let size = Math.min(FONT.button, h * 0.38);
    for (const b of list) size = Math.min(size, fitSize(g, b.label, bw * 0.86, size));
    list.forEach((b, i) => {
      const rect = { x: w * 0.02 + i * (bw + gap), y, w: bw, h };
      this.buttons.push({ ...b, rect });
      const recOn = b.on && b.label.startsWith('●');
      roundRect(g, rect.x, rect.y, rect.w, rect.h, 12, b.on ? (recOn ? '#4a1f24' : '#1f3b2a') : THEME.panel);
      text(g, b.label, rect.x + rect.w / 2, rect.y + rect.h / 2, size, b.on ? (recOn ? THEME.bad : THEME.good) : THEME.text);
    });
  }
}
