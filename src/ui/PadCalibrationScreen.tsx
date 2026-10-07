import { useEffect, useState } from 'preact/hooks';
import { MIN_TAPS_PER_PHASE, computePadCalibration } from '../calibration/padCalibration';
import type { PadCalibration } from '../input/velocity';
import { PAD_COLS, PAD_COUNT, PAD_ROWS } from '../midi/atomMap';
import type { PadLed } from '../midi/ledFrame';
import { useInput } from './hooks';
import { go, type Route } from './router';
import { getRuntime, padCalibration } from './runtime';

type Phase = 'soft' | 'hard' | 'done';
const empty = () => Array.from({ length: PAD_COUNT }, () => [] as number[]);

const LED: Record<Phase | 'complete', PadLed> = {
  soft: { r: 0, g: 30, b: 127 },
  hard: { r: 127, g: 10, b: 0 },
  complete: { r: 0, g: 60, b: 0 },
  done: { r: 0, g: 127, b: 0 },
};

/** "Tap each pad softly a few times, then hard a few times." */
export function PadCalibrationScreen({ back }: { back: Route['name'] }) {
  const [phase, setPhase] = useState<Phase>('soft');
  const [soft, setSoft] = useState(empty);
  const [hard, setHard] = useState(empty);
  const taps = phase === 'soft' ? soft : hard;
  const complete = (pad: number) => taps[pad]!.length >= MIN_TAPS_PER_PHASE;

  const results: (PadCalibration | null)[] = soft.map((s, pad) => computePadCalibration(s, hard[pad]!));

  useEffect(() => {
    const { input, controller } = getRuntime();
    input.bypassShaping = true;
    controller.reset();
    return () => {
      input.bypassShaping = false;
    };
  }, []);

  useEffect(() => {
    const { controller } = getRuntime();
    controller.setPads(
      Array.from({ length: PAD_COUNT }, (_, pad) =>
        phase === 'done' ? (results[pad] ? LED.done : { ...LED.hard, mode: 'blink' }) : complete(pad) ? LED.complete : LED[phase],
      ),
    );
  });

  const nextPhase = () => {
    if (phase === 'soft') setPhase('hard');
    else if (phase === 'hard') setPhase('done');
  };

  const save = () => {
    const pads = padCalibration.value.pads.map((old, pad) => results[pad] ?? old);
    padCalibration.value = { pads, date: new Date().toISOString() };
    getRuntime().audio.playCue('win');
    go({ name: back } as Route);
  };

  useInput((e) => {
    if (e.type === 'padDown' && phase !== 'done') {
      const update = (prev: number[][]) => prev.map((list, pad) => (pad === e.pad ? [...list, e.velocity] : list));
      if (phase === 'soft') setSoft(update);
      else setHard(update);
      const after = taps.map((list, pad) => (pad === e.pad ? list.length + 1 : list.length));
      if (after.every((n) => n >= MIN_TAPS_PER_PHASE)) {
        getRuntime().audio.playCue('select');
        nextPhase();
      }
      return;
    }
    if (e.type !== 'button' || !e.down) return;
    if (e.action === 'back') go({ name: back } as Route);
    else if (e.action === 'start' || e.action === 'select') {
      if (phase === 'done') save();
      else nextPhase();
    }
  });

  const good = results.filter(Boolean).length;
  return (
    <div class="screen">
      <h2>Calibrate pads</h2>
      {phase === 'soft' && <p class="lead">Tap <b>every pad softly</b>, {MIN_TAPS_PER_PHASE} times each — as gently as you'd ever play.</p>}
      {phase === 'hard' && <p class="lead">Now hit <b>every pad hard</b>, {MIN_TAPS_PER_PHASE} times each.</p>}
      {phase === 'done' && (
        <p class="lead">
          {good} of 16 pads calibrated.{good < 16 && ' Blinking pads need softer/harder taps — they keep their old setting.'}
        </p>
      )}
      <div class="calgrid">
        {Array.from({ length: PAD_ROWS }, (_, r) =>
          Array.from({ length: PAD_COLS }, (_, c) => {
            const pad = (PAD_ROWS - 1 - r) * PAD_COLS + c;
            const res = results[pad];
            return (
              <div class={`calpad ${phase !== 'done' && complete(pad) ? 'ok' : ''} ${phase === 'done' ? (res ? 'ok' : 'bad') : ''}`} key={pad}>
                <span class="num">{pad + 1}</span>
                {phase === 'done' ? (
                  <span class="small">{res ? `${res.soft}–${res.hard}` : '—'}</span>
                ) : (
                  <span class="small">
                    {taps[pad]!.length}/{MIN_TAPS_PER_PHASE}
                    {taps[pad]!.length ? ` · ${taps[pad]!.at(-1)}` : ''}
                  </span>
                )}
              </div>
            );
          }),
        )}
      </div>
      <div class="row">
        {phase === 'done' ? (
          <button class="big" onClick={save}>Save</button>
        ) : (
          <button onClick={nextPhase}>{phase === 'soft' ? 'Next: hard taps' : 'Finish'}</button>
        )}
        <button onClick={() => go({ name: back } as Route)}>Cancel</button>
      </div>
      <p class="muted small">▶ Play = {phase === 'done' ? 'save' : 'next step'} · ■ Stop = cancel</p>
    </div>
  );
}
