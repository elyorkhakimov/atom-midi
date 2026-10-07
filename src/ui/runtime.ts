import { effect, signal } from '@preact/signals';
import { AudioEngine } from '../audio/engine';
import { InputBus } from '../input/inputBus';
import { attachKeyboard } from '../input/keyboard';
import { AtomDriver } from '../midi/atomDriver';
import type { ControllerStatus, PadController } from '../midi/padController';
import { requestMidi } from '../midi/webMidi';
import { BestTracker } from '../storage/bests';
import { load, save } from '../storage/persist';
import { BESTS_KEY, DEFAULT_SETTINGS, SETTINGS_KEY, type Bests, type Settings } from '../storage/settings';

// ---------------------------------------------------------------------------
// Persistent state (per device)
// ---------------------------------------------------------------------------
export const settings = signal<Settings>(load(SETTINGS_KEY, DEFAULT_SETTINGS));
export const bests = signal<Bests>(load(BESTS_KEY, {}));
effect(() => save(SETTINGS_KEY, settings.value));
effect(() => save(BESTS_KEY, bests.value));

export function updateSettings(patch: Partial<Settings>): void {
  settings.value = { ...settings.value, ...patch };
}

// ---------------------------------------------------------------------------
// Live status
// ---------------------------------------------------------------------------
export const controllerStatus = signal<ControllerStatus>({ connected: false, native: false, nativeConfirmed: false, portName: null });
export const audioRunning = signal(false);
export const kitState = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
export const midiError = signal<string | null>(null);

// ---------------------------------------------------------------------------
// Runtime services (created on the first user gesture)
// ---------------------------------------------------------------------------
export interface Runtime {
  audio: AudioEngine;
  controller: PadController;
  input: InputBus;
  bests: BestTracker;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (!runtime) throw new Error('Runtime not started');
  return runtime;
}

export function hasRuntime(): boolean {
  return runtime !== null;
}

/**
 * Must be called from a user gesture: the AudioContext is created and resumed
 * before the first await so the browser allows audio.
 */
export async function startRuntime(): Promise<Runtime> {
  if (runtime) return runtime;
  const audio = new AudioEngine();
  const resumed = audio.resume();
  audio.ctx.addEventListener('statechange', () => (audioRunning.value = audio.running));

  let access: MIDIAccess | null = null;
  try {
    access = await requestMidi();
  } catch (err) {
    midiError.value = err instanceof Error ? err.message : String(err);
  }
  const controller = new AtomDriver(access);
  controller.onStatus((s) => (controllerStatus.value = s));

  const input = new InputBus(() => ({
    threshold: settings.value.velocityThreshold,
    curveGamma: settings.value.curveGamma,
    doubleTriggerMs: settings.value.doubleTriggerMs,
  }));
  input.attach(controller);
  attachKeyboard((e) => input.feed(e));

  const tracker = new BestTracker(
    () => bests.value,
    (b) => (bests.value = b),
  );

  effect(() => {
    const s = settings.value;
    audio.setMasterVolume(s.masterVolume);
    audio.setMetronomeVolume(s.metronomeVolume);
    controller.setBrightness(s.ledBrightness);
  });

  runtime = { audio, controller, input, bests: tracker };
  await resumed.catch(() => undefined);
  audioRunning.value = audio.running;
  void loadKit(settings.value.kitId);
  void audio.loadCueFiles();
  return runtime;
}

export async function loadKit(id: string): Promise<void> {
  const rt = getRuntime();
  kitState.value = 'loading';
  try {
    await rt.audio.loadKit(id);
    kitState.value = 'ready';
  } catch (err) {
    console.error(err);
    kitState.value = 'error';
  }
}

/** Hit time corrected by the measured latency offset. */
export function adjustTime(t: number): number {
  return t - settings.value.latencyOffsetMs;
}
