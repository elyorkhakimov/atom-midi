import type { AudioEngine } from '../audio/engine';
import type { InputEvent } from '../input/events';
import type { PadController } from '../midi/padController';
import type { BestTracker } from '../storage/bests';
import type { Settings } from '../storage/settings';

export interface GameContext {
  audio: AudioEngine;
  controller: PadController;
  bests: BestTracker;
  settings(): Settings;
  updateSettings(patch: Partial<Settings>): void;
  /** Hit timestamp corrected by this device's measured latency offset. */
  adjust(t: number): number;
  /** Back to the main menu. */
  exit(): void;
}

/**
 * A game owns the screen (canvas), the pad LEDs and the input while it runs.
 * Lifecycle: start -> (onInput / draw)* -> stop. Phases (ready -> play -> results)
 * live inside each game; draw() is called every animation frame and may advance
 * time-based phases.
 */
export interface Game {
  start(ctx: GameContext): void;
  onInput(e: InputEvent): void;
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void;
  /** Touch/click on the canvas, in the same CSS-pixel coordinates as draw(). */
  onTap?(x: number, y: number): void;
  stop(): void;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function inRect(r: Rect | null | undefined, x: number, y: number): boolean {
  return !!r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h;
}

export interface GameInfo {
  id: string;
  title: string;
  emoji: string;
  blurb: string;
  players: string;
  create(): Game;
}

/** Cancellable setTimeout group, so stop() can clear everything a game scheduled. */
export class Timers {
  private readonly ids = new Set<ReturnType<typeof setTimeout>>();

  at(perfTime: number, fn: () => void): void {
    this.after(perfTime - performance.now(), fn);
  }

  after(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.ids.delete(id);
      fn();
    }, Math.max(0, ms));
    this.ids.add(id);
  }

  clear(): void {
    for (const id of this.ids) clearTimeout(id);
    this.ids.clear();
  }
}
