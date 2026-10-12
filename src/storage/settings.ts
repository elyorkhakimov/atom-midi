import type { ReactionCue, ReactionMode } from '../games/reaction/logic';
import { DEFAULT_CUSTOM_PATCH, type SynthPatch } from '../audio/synth';
import type { CurveName } from '../input/velocity';

export interface Settings {
  masterVolume: number; // 0..1
  metronomeVolume: number; // 0..1
  ledBrightness: number; // 0..1 cap; ~35% saves phone battery
  curve: CurveName;
  curveGamma: number;
  velocityThreshold: number; // raw velocity below this is a ghost hit
  doubleTriggerMs: number;
  kitId: string;
  kidUi: boolean;
  /** Measured by the timing calibration; subtracted from every hit time. Per device. */
  latencyOffsetMs: number;
  latencyCalibrated: boolean;
  bluetoothWarningSeen: boolean;
  /** Rhythm copy: metronome during the demo and while playing (the count-in always clicks). */
  rhythmMetronome: boolean;
  reactionMode: ReactionMode;
  reactionCue: ReactionCue;
  /** Free Jam: last page (drums, synth presets, custom synth). */
  jamPage: number;
  synthCustom: SynthPatch;
  /** Velocity every pad plays at while the ATOM's Full Level button is on. */
  fullLevelVelocity: number;
  /** Free Jam synth pages: key change in semitones, and a filter multiplier (1 = as designed). */
  jamTranspose: number;
  jamTone: number;
  /** Beat maker: metronome while looping (the count-in always clicks). */
  beatClick: boolean;
  /** Beat maker: playing a synth (Free Jam's Pluck, Warm pad or Make) instead of the kit. */
  beatSynth: '' | 'pluck' | 'pad' | 'custom';
  setupPromptSeen: boolean;
}

export const SETTINGS_KEY = 'padgames.settings.v1';
export const BESTS_KEY = 'padgames.bests.v1';

export const DEFAULT_SETTINGS: Settings = {
  masterVolume: 0.8,
  metronomeVolume: 0.6,
  ledBrightness: 0.35,
  curve: 'linear',
  curveGamma: 1,
  velocityThreshold: 4,
  doubleTriggerMs: 25,
  kitId: 'acoustic',
  kidUi: false,
  latencyOffsetMs: 0,
  latencyCalibrated: false,
  bluetoothWarningSeen: false,
  rhythmMetronome: true,
  reactionMode: 'classic',
  reactionCue: 'sound',
  jamPage: 0,
  synthCustom: DEFAULT_CUSTOM_PATCH,
  fullLevelVelocity: 110,
  jamTranspose: 0,
  jamTone: 1,
  beatClick: true,
  beatSynth: '',
  setupPromptSeen: false,
};

/** All-time bests per device. Lower is better for times, higher for percentages. */
export type Bests = Record<string, number>;
