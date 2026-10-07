import { KITS } from '../../audio/kit';
import { Metronome } from '../../audio/metronome';
import type { InputEvent } from '../../input/events';
import { PAD_COLS, PAD_COUNT, PAD_ROWS } from '../../midi/atomMap';
import { THEME, clear, ledCss, roundRect, text } from '../draw';
import type { Game, GameContext } from '../framework';

const MIN_BPM = 40;
const MAX_BPM = 220;
/** Seconds a pad glows on screen after a hit. */
const GLOW_S = 0.35;

/**
 * Play the kit. Knob 1 = kit, knob 2 = volume, knob 3 = tempo, knob 4 = metronome volume.
 * Click (or Play) toggles the metronome.
 */
export class FreeJamGame implements Game {
  private ctx!: GameContext;
  private metronome!: Metronome;
  private readonly lastHit: { t: number; velocity: number }[] = Array.from({ length: PAD_COUNT }, () => ({ t: -1e9, velocity: 0 }));
  private beats: { at: number; accent: boolean }[] = [];
  private bpm = 100;
  private message: { text: string; until: number } | null = null;

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.metronome = new Metronome(ctx.audio, (beat, at) => {
      this.beats.push({ at, accent: beat % 4 === 0 });
      if (this.beats.length > 8) this.beats.shift();
    });
    this.metronome.bpm = this.bpm;
    this.lightKit();
  }

  stop(): void {
    this.metronome.stop();
    this.ctx.audio.stopAll();
  }

  private lightKit(): void {
    this.ctx.controller.setPads(Array.from({ length: PAD_COUNT }, (_, pad) => this.ctx.audio.padColor(pad) ?? { r: 30, g: 30, b: 30 }));
    this.ctx.controller.setButtonLight('click', this.metronome.running);
  }

  private say(s: string): void {
    this.message = { text: s, until: performance.now() + 1200 };
  }

  private toggleMetronome(): void {
    if (this.metronome.running) this.metronome.stop();
    else this.metronome.start();
    this.ctx.controller.setButtonLight('click', this.metronome.running);
    this.say(this.metronome.running ? `Metronome on · ${this.bpm} BPM` : 'Metronome off');
  }

  onInput(e: InputEvent): void {
    if (e.type === 'padDown') {
      this.ctx.audio.playPad(e.pad, e.velocity);
      this.lastHit[e.pad] = { t: performance.now(), velocity: e.velocity };
      return;
    }
    if (e.type === 'encoder') {
      const s = this.ctx.settings();
      const step = Math.sign(e.delta) * Math.min(4, Math.abs(e.delta));
      switch (e.id) {
        case 0: {
          const i = KITS.findIndex((k) => k.id === s.kitId);
          const next = KITS[(i + Math.sign(e.delta) + KITS.length) % KITS.length]!;
          if (next.id !== s.kitId) {
            this.ctx.updateSettings({ kitId: next.id });
            void this.ctx.audio.loadKit(next.id).then(() => this.lightKit());
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
    }
  }

  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    clear(g, w, h);
    const kid = this.ctx.settings().kidUi;
    const kit = this.ctx.audio.kit?.json;
    const header = Math.min(w, h) * 0.09;
    text(g, `🎶 ${kit?.name ?? 'Loading kit…'}`, w / 2, header * 0.8, header * 0.6);

    // Metronome pulse
    const audioNow = this.ctx.audio.clock.perfToAudio(now);
    const beat = [...this.beats].reverse().find((b) => b.at <= audioNow);
    if (this.metronome.running && beat && audioNow - beat.at < 0.12) {
      g.fillStyle = beat.accent ? 'rgba(74,163,255,0.35)' : 'rgba(74,163,255,0.18)';
      g.fillRect(0, 0, w, h);
    }

    const footer = header * 1.2;
    const size = Math.min(w * 0.94, h - header * 1.6 - footer);
    const gap = size * 0.03;
    const cell = (size - gap * (PAD_COLS - 1)) / PAD_COLS;
    const x0 = (w - size) / 2;
    const y0 = header * 1.5;
    for (let pad = 0; pad < PAD_COUNT; pad++) {
      const row = PAD_ROWS - 1 - Math.floor(pad / PAD_COLS);
      const col = pad % PAD_COLS;
      const x = x0 + col * (cell + gap);
      const y = y0 + row * (cell + gap);
      const color = this.ctx.audio.padColor(pad) ?? { r: 40, g: 40, b: 40 };
      const age = (now - this.lastHit[pad]!.t) / 1000;
      const glow = age < GLOW_S ? (1 - age / GLOW_S) * (0.4 + (0.6 * this.lastHit[pad]!.velocity) / 127) : 0;
      roundRect(g, x, y, cell, cell, cell * 0.12, ledCss(color, 0.25 + 0.75 * glow));
      if (!kid) {
        const id = kit?.pads[pad];
        const name = id ? kit?.instruments[id]?.name ?? '' : '';
        text(g, name, x + cell / 2, y + cell / 2, Math.min(cell * 0.16, (cell * 1.6) / Math.max(4, name.length)), THEME.text, 'center', 600);
      }
    }

    const s = this.ctx.settings();
    const status = this.message && now < this.message.until
      ? this.message.text
      : kid
        ? `${this.metronome.running ? '🔔' : ''}`
        : `Vol ${Math.round(s.masterVolume * 100)}% · ${this.bpm} BPM · metronome ${this.metronome.running ? 'on' : 'off'} (Click) · ■ menu`;
    text(g, status, w / 2, h - footer / 2, header * 0.38, THEME.muted, 'center', 600);
  }
}
