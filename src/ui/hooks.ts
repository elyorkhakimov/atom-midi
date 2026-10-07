import { useEffect, useRef } from 'preact/hooks';
import type { InputEvent } from '../input/events';
import { getRuntime } from './runtime';

/** Receive input while this component is mounted (topmost handler wins). */
export function useInput(handler: (e: InputEvent) => void): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => getRuntime().input.push((e) => ref.current(e)), []);
}

/** Calls `fn` after `ms` while a key condition holds; returns start/cancel. */
export function useHold(ms: number, fn: () => void): { start(): void; cancel(): void } {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return {
    start() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => fnRef.current(), ms);
    },
    cancel() {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    },
  };
}
