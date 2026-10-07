import type { ReactionMode } from '../games/reaction/logic';
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
  setupPromptSeen: false,
};

/** All-time bests per device. Lower is better for times, higher for percentages. */
export type Bests = Record<string, number>;
