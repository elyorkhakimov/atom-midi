import { BeatMakerGame } from './beatMaker/beatMaker';
import type { GameInfo } from './framework';
import { FreeJamGame } from './freeJam/freeJam';
import { ReactionGame } from './reaction/reaction';
import { ReactionBattleGame } from './reactionBattle/reactionBattle';
import { RhythmCopyGame } from './rhythmCopy/rhythmCopy';

export const GAMES: readonly GameInfo[] = [
  { id: 'reaction', title: 'Reaction', emoji: '⚡', players: '1 player', blurb: 'Hit a pad the moment you hear GO', create: () => new ReactionGame() },
  { id: 'battle', title: 'Reaction battle', emoji: '🏁', players: '2–4 players', blurb: 'Who hits their pad first after GO?', create: () => new ReactionBattleGame() },
  { id: 'rhythm', title: 'Rhythm copy', emoji: '🥁', players: '1 player', blurb: 'Listen to a beat, then play it back', create: () => new RhythmCopyGame() },
  { id: 'jam', title: 'Free jam', emoji: '🎶', players: 'Anyone', blurb: 'Play drums or synths, and make your own sound', create: () => new FreeJamGame() },
  { id: 'beats', title: 'Beat maker', emoji: '🎚️', players: 'Anyone', blurb: 'Record a beat over the click, Nudge it onto the grid, save it', create: () => new BeatMakerGame() },
];

export function gameById(id: string): GameInfo | undefined {
  return GAMES.find((g) => g.id === id);
}
