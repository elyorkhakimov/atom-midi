import { useEffect, useRef, useState } from 'preact/hooks';
import { computeLatencyOffset, type LatencyResult } from '../calibration/latency';
import { PAD_COUNT } from '../midi/atomMap';
import { useInput } from './hooks';
import { go, type Route } from './router';
import { getRuntime, settings, updateSettings } from './runtime';

const BPM = 100;
const COUNT_IN = 4;
const BEATS = 16;
/** Above this spread the taps weren't steady enough to trust. */
const MAX_STDDEV_MS = 45;

type Phase = { name: 'intro' } | { name: 'running'; beats: number[]; countIn: number[]; end: number } | { name: 'result'; result: LatencyResult | null };

/** "Tap along with the beat": measures this device's total input + output latency. */
export function LatencyCalibrationScreen({ back }: { back: Route['name'] }) {
  const [phase, setPhase] = useState<Phase>({ name: 'intro' });
  const [beatIndex, setBeatIndex] = useState(-1);
  const taps = useRef<number[]>([]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };

  useEffect(() => {
    getRuntime().controller.reset();
    return clearTimers;
  }, []);

  const run = () => {
    const { audio, controller } = getRuntime();
    clearTimers();
    taps.current = [];
    const beat = 60 / BPM;
    const start = audio.ctx.currentTime + 0.5;
    const snap = audio.clock.snapshot();
    const toPerf = (at: number) => snap.performanceTime + (at - snap.contextTime) * 1000;
    const countIn: number[] = [];
    const beats: number[] = [];
    for (let i = 0; i < COUNT_IN + BEATS; i++) {
      const at = start + i * beat;
      audio.click(i < COUNT_IN || (i - COUNT_IN) % 4 === 0, at);
      const t = toPerf(at);
      (i < COUNT_IN ? countIn : beats).push(t);
      // Visual pulse on screen and pads (secondary to the click).
      timers.current.push(
        setTimeout(() => {
          setBeatIndex(i);
          const on = i < COUNT_IN ? { r: 127, g: 60, b: 0 } : { r: 0, g: 60, b: 127 };
          controller.setPads(Array.from({ length: PAD_COUNT }, () => on));
          timers.current.push(setTimeout(() => controller.setPads(Array.from({ length: PAD_COUNT }, () => ({ r: 0, g: 0, b: 0 }))), 90));
        }, t - performance.now()),
      );
    }
    const end = beats.at(-1)! + 500;
    timers.current.push(
      setTimeout(() => {
        const result = computeLatencyOffset(taps.current, beats);
        audio.playCue(result && result.stdDevMs <= MAX_STDDEV_MS ? 'select' : 'fail');
        setPhase({ name: 'result', result });
      }, end - performance.now()),
    );
    setBeatIndex(-1);
    setPhase({ name: 'running', beats, countIn, end });
  };

  const save = () => {
    if (phase.name !== 'result' || !phase.result) return;
    updateSettings({ latencyOffsetMs: phase.result.offsetMs, latencyCalibrated: true });
    getRuntime().audio.playCue('win');
    go({ name: back } as Route);
  };

  useInput((e) => {
    if (e.type === 'padDown' && phase.name === 'running') {
      taps.current.push(e.t); // raw timestamp: this is what we're measuring
      return;
    }
    if (e.type !== 'button' || !e.down) return;
    if (e.action === 'back') {
      clearTimers();
      go({ name: back } as Route);
    } else if (e.action === 'start' || e.action === 'select') {
      if (phase.name === 'result' && phase.result && phase.result.stdDevMs <= MAX_STDDEV_MS) save();
      else if (phase.name !== 'running') run();
    }
  });

  const current = settings.value.latencyCalibrated ? `${Math.round(settings.value.latencyOffsetMs)} ms` : 'not calibrated';
  return (
    <div class="screen center">
      <h2>Calibrate timing</h2>
      {phase.name === 'intro' && (
        <>
          <p class="lead">
            You'll hear {COUNT_IN} count-in clicks, then {BEATS} beats. <b>Tap any pad exactly with each beat.</b>
          </p>
          <p class="muted">Current offset: {current}. Use the same headphones or speaker you'll play with.</p>
          <button class="big" onClick={run}>Start</button>
        </>
      )}
      {phase.name === 'running' && (
        <>
          <div class={`beat ${beatIndex >= 0 && beatIndex < COUNT_IN ? 'countin' : ''}`} key={beatIndex}>
            {beatIndex < 0 ? '…' : beatIndex < COUNT_IN ? COUNT_IN - beatIndex : beatIndex - COUNT_IN + 1}
          </div>
          <p class="lead">{beatIndex < COUNT_IN ? 'Get ready…' : 'Tap with the beat!'}</p>
        </>
      )}
      {phase.name === 'result' && (
        <>
          {phase.result ? (
            <>
              <div class="bignum">{`${phase.result.offsetMs >= 0 ? '+' : ''}${Math.round(phase.result.offsetMs)} ms`}</div>
              <p class="muted">
                spread ±{Math.round(phase.result.stdDevMs)} ms over {phase.result.samples} taps · previous: {current}
              </p>
              {phase.result.stdDevMs > MAX_STDDEV_MS && <p class="notice bad">Taps were too uneven to trust. Try again, tapping steadily.</p>}
            </>
          ) : (
            <p class="notice bad">Not enough taps matched the beat. Try again.</p>
          )}
          <div class="row">
            {phase.result && phase.result.stdDevMs <= MAX_STDDEV_MS && (
              <button class="big" onClick={save}>Save</button>
            )}
            <button onClick={run}>Try again</button>
          </div>
        </>
      )}
      <button class="back" onClick={() => go({ name: back } as Route)}>
        Cancel
      </button>
    </div>
  );
}
