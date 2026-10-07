import type { InputEvent } from '../../input/events';
import { PAD_COUNT } from '../../midi/atomMap';
import type { PadLed } from '../../midi/ledFrame';
import { THEME, clear, fitSize, formatMs, roundRect, text } from '../draw';
import { Timers, type Game, type GameContext } from '../framework';
import { PLAYERS, dim, playerOfPad, playerPads } from '../players';
import { TIMEOUT_MS, judgeHit, randomDelayMs, resolveBattle, type BattleHit, type BattleResult } from '../reaction/logic';

type Phase =
  | { name: 'setup' }
  | { name: 'waiting'; goT: number; cancelGo: () => void }
  | { name: 'go'; goT: number; firstValidAt: number | null }
  | { name: 'roundResult'; result: BattleResult; at: number }
  | { name: 'final' };

/** After the first clean hit, wait this long for others before declaring the winner. */
const RESOLVE_GRACE_MS = 150;
const BEST_KEY = 'reaction.battle';

/** 2–4 players race to hit their own pads first after the audio GO. */
export class ReactionBattleGame implements Game {
  private ctx!: GameContext;
  private players = 2;
  private layout: number[][] = playerPads(2);
  private phase: Phase = { name: 'setup' };
  private hits: BattleHit[] = [];
  private wins: number[] = [0, 0, 0, 0];
  private round = 0;
  private readonly timers = new Timers();

  start(ctx: GameContext): void {
    this.ctx = ctx;
    this.toSetup();
  }

  stop(): void {
    this.timers.clear();
    if (this.phase.name === 'waiting') this.phase.cancelGo();
  }

  // -------------------------------------------------------------------------
  // LEDs
  // -------------------------------------------------------------------------
  private showAreas(k: number, modes: (PadLed['mode'] | 'off')[] = []): void {
    const leds: PadLed[] = Array.from({ length: PAD_COUNT }, () => ({ r: 0, g: 0, b: 0 }));
    this.layout.forEach((pads, p) => {
      const mode = modes[p];
      for (const pad of pads) leds[pad] = mode === 'off' ? { r: 0, g: 0, b: 0 } : { ...dim(PLAYERS[p]!.led, k), mode };
    });
    this.ctx.controller.setPads(leds);
    this.layout.forEach((pads, p) => {
      for (const pad of pads) this.ctx.controller.setHitLight(pad, PLAYERS[p]!.led);
    });
  }

  private setPlayers(n: number): void {
    this.players = Math.max(2, Math.min(4, n));
    this.layout = playerPads(this.players);
    this.ctx.controller.setAllHitLights('none');
    this.showAreas(1);
  }

  // -------------------------------------------------------------------------
  // Flow
  // -------------------------------------------------------------------------
  private toSetup(): void {
    this.phase = { name: 'setup' };
    this.wins = [0, 0, 0, 0];
    this.round = 0;
    this.setPlayers(this.players);
  }

  private startRound(): void {
    const { audio } = this.ctx;
    this.round++;
    this.hits = [];
    this.showAreas(0.25);
    const goAudio = audio.ctx.currentTime + randomDelayMs() / 1000;
    const cue = audio.playCue('go', goAudio);
    const goT = audio.clock.audioToPerf(goAudio);
    this.phase = { name: 'waiting', goT, cancelGo: () => cue.cancel() };
    this.timers.at(goT, () => {
      if (this.phase.name !== 'waiting') return;
      this.phase = { name: 'go', goT, firstValidAt: null };
      this.showAreas(1, this.disqualifiedModes());
    });
  }

  private disqualifiedModes(): ('off' | undefined)[] {
    const goT = this.phase.name === 'waiting' || this.phase.name === 'go' ? this.phase.goT : 0;
    const r = resolveBattle(this.hits, this.players, goT);
    return r.disqualified.map((dq) => (dq ? 'off' : undefined));
  }

  private resolve(): void {
    const p = this.phase;
    if (p.name !== 'waiting' && p.name !== 'go') return;
    this.timers.clear();
    if (p.name === 'waiting') p.cancelGo();
    const result = resolveBattle(this.hits, this.players, p.goT);
    if (result.winner !== null) {
      this.wins[result.winner]!++;
      this.ctx.bests.record(BEST_KEY, result.reaction[result.winner]!, 'lower');
      this.ctx.audio.playCue('win');
      this.showAreas(1, result.reaction.map((_, i) => (i === result.winner ? 'breathe' : 'off')));
    } else {
      this.ctx.audio.playCue('fail');
      this.showAreas(0.3);
    }
    this.phase = { name: 'roundResult', result, at: performance.now() };
  }

  onInput(e: InputEvent): void {
    const p = this.phase;
    if (e.type === 'encoder' && p.name === 'setup') {
      this.setPlayers(this.players + Math.sign(e.delta));
      this.ctx.audio.playCue('tick');
      return;
    }
    if (e.type === 'button' && e.down) {
      switch (e.action) {
        case 'up':
        case 'next':
          if (p.name === 'setup') this.setPlayers(this.players + 1);
          return;
        case 'down':
        case 'prev':
          if (p.name === 'setup') this.setPlayers(this.players - 1);
          return;
        case 'start':
        case 'select':
          if (p.name === 'setup' || (p.name === 'roundResult' && performance.now() - p.at > 500)) this.startRound();
          else if (p.name === 'final') this.toSetup();
          return;
        case 'back':
          if (p.name === 'waiting' || p.name === 'go') {
            this.stop();
            this.round--;
            this.showAreas(1);
            this.phase = { name: 'setup' };
          } else if (p.name === 'roundResult' && this.round > 0) this.phase = { name: 'final' };
          else this.ctx.exit();
          return;
      }
      return;
    }
    if (e.type !== 'padDown') return;
    if (p.name !== 'waiting' && p.name !== 'go') return;
    const player = playerOfPad(this.layout, e.pad);
    if (player < 0 || this.hits.some((h) => h.player === player)) return;

    const t = this.ctx.adjust(e.t);
    this.hits.push({ player, t });
    const j = judgeHit(t, p.goT);
    if (j.kind === 'falseStart') {
      this.ctx.audio.playCue('fail', undefined, 0.6);
      for (const pad of this.layout[player]!) this.ctx.controller.setPad(pad, { r: 127, g: 0, b: 0, mode: 'blink' });
      const r = resolveBattle(this.hits, this.players, p.goT);
      if (r.disqualified.every(Boolean)) this.resolve();
      return;
    }
    this.ctx.audio.playPad(e.pad, e.velocity);
    // A clean hit proves GO has passed even if the visual timer hasn't fired yet.
    const go = p.name === 'go' ? p : { name: 'go' as const, goT: p.goT, firstValidAt: null };
    this.phase = go;
    if (go.firstValidAt === null) {
      go.firstValidAt = performance.now();
      this.timers.clear();
      this.timers.after(RESOLVE_GRACE_MS, () => this.resolve());
    }
    if (this.hits.length === this.players) this.resolve();
  }

  // -------------------------------------------------------------------------
  // Drawing
  // -------------------------------------------------------------------------
  draw(g: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    const p = this.phase;
    if (p.name === 'go' && now - p.goT > TIMEOUT_MS) this.resolve();
    const kid = this.ctx.settings().kidUi;
    const unit = Math.min(w, h) * 0.1;
    clear(g, w, h, p.name === 'go' ? '#0f3d22' : THEME.bg);

    switch (p.name) {
      case 'setup': {
        text(g, '🏁 Reaction battle', w / 2, unit * 1.2, unit * 0.7);
        this.drawPlayers(g, w, h, unit, () => '');
        text(g, `${this.players} players`, w / 2, h - unit * 2.2, unit * 0.7);
        text(g, kid ? '◀ ▶  then ▶ Play' : 'Turn a knob or ▲▼ to change players · ▶ Play to start · ■ back', w / 2, h - unit, unit * 0.32, THEME.muted, 'center', 500);
        break;
      }
      case 'waiting':
      case 'go': {
        text(g, p.name === 'go' ? 'GO!' : kid ? '🤫' : 'Wait for it…', w / 2, unit * 1.4, unit * (p.name === 'go' ? 1.2 : 0.8), p.name === 'go' ? THEME.text : THEME.muted);
        const r = resolveBattle(this.hits, this.players, p.goT);
        this.drawPlayers(g, w, h, unit, (i) => (r.disqualified[i] ? '✗ early' : r.reaction[i] !== null ? '✓' : ''));
        break;
      }
      case 'roundResult': {
        const { winner, reaction, disqualified } = p.result;
        const title = winner === null ? 'No winner' : `${PLAYERS[winner]!.name} wins!`;
        text(g, title, w / 2, unit * 1.4, fitSize(g, title, w * 0.9, unit * 1.1), winner === null ? THEME.muted : PLAYERS[winner]!.css);
        this.drawPlayers(g, w, h, unit, (i) => (disqualified[i] ? 'early' : reaction[i] !== null ? formatMs(reaction[i]!) : '—'), winner);
        text(g, kid ? '▶' : `Round ${this.round} · ▶ next round · ■ finish`, w / 2, h - unit, unit * 0.32, THEME.muted, 'center', 500);
        break;
      }
      case 'final': {
        const max = Math.max(...this.wins.slice(0, this.players));
        const leaders = this.wins.slice(0, this.players).flatMap((n, i) => (n === max ? [i] : []));
        const title = max === 0 ? 'Nobody won a round' : leaders.length > 1 ? "It's a tie!" : `${PLAYERS[leaders[0]!]!.name} is the champion!`;
        text(g, title, w / 2, unit * 1.4, fitSize(g, title, w * 0.9, unit), leaders.length === 1 && max > 0 ? PLAYERS[leaders[0]!]!.css : THEME.text);
        this.drawPlayers(g, w, h, unit, () => '', leaders.length === 1 && max > 0 ? leaders[0]! : null);
        const fastest = this.ctx.bests.sessionBest(BEST_KEY);
        if (fastest !== undefined) text(g, `Fastest today: ${formatMs(fastest)}`, w / 2, h - unit * 2, unit * 0.4, THEME.muted, 'center', 600);
        text(g, kid ? '▶' : '▶ new match · ■ menu', w / 2, h - unit, unit * 0.32, THEME.muted, 'center', 500);
        break;
      }
    }
  }

  /** One card per player: colour, wins, and a status line. */
  private drawPlayers(g: CanvasRenderingContext2D, w: number, h: number, unit: number, status: (i: number) => string, highlight: number | null = null): void {
    const n = this.players;
    const gap = unit * 0.3;
    const top = unit * 2.4;
    const bottom = h - unit * 3;
    const cols = w > h ? n : 2;
    const rows = Math.ceil(n / cols);
    const cw = (w - gap * (cols + 1)) / cols;
    const ch = Math.max(unit * 1.5, (bottom - top - gap * (rows - 1)) / rows);
    for (let i = 0; i < n; i++) {
      const x = gap + (i % cols) * (cw + gap);
      const y = top + Math.floor(i / cols) * (ch + gap);
      const player = PLAYERS[i]!;
      roundRect(g, x, y, cw, ch, unit * 0.3, i === highlight ? player.css : THEME.panel);
      g.lineWidth = 4;
      g.strokeStyle = player.css;
      g.stroke();
      const fg = i === highlight ? '#000' : THEME.text;
      text(g, player.name, x + cw / 2, y + ch * 0.25, Math.min(unit * 0.55, cw / 6), i === highlight ? '#000' : player.css);
      text(g, `${this.wins[i]} ${this.wins[i] === 1 ? 'win' : 'wins'}`, x + cw / 2, y + ch * 0.52, Math.min(unit * 0.6, cw / 5), fg);
      const s = status(i);
      if (s) text(g, s, x + cw / 2, y + ch * 0.78, Math.min(unit * 0.5, cw / 6), s.includes('early') || s.startsWith('✗') ? THEME.bad : fg);
    }
  }
}
