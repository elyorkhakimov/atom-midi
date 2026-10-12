import { useEffect, useRef } from 'preact/hooks';
import type { Game } from '../games/framework';
import { gameById } from '../games/registry';
import { go } from './router';
import { adjustTime, getRuntime, settings, updateSettings } from './runtime';

/** Hosts one game: full-area canvas, rAF draw loop, input routed to the game. */
export function GameScreen({ id }: { id: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const info = gameById(id);
    const canvas = canvasRef.current;
    if (!info || !canvas) {
      go({ name: 'menu' });
      return;
    }
    const rt = getRuntime();
    const game: Game = info.create();
    rt.controller.reset();
    const popInput = rt.input.push((e) => game.onInput(e));
    game.start({
      audio: rt.audio,
      controller: rt.controller,
      bests: rt.bests,
      settings: () => settings.value,
      updateSettings,
      adjust: adjustTime,
      exit: () => go({ name: 'menu' }),
    });

    const g = canvas.getContext('2d')!;
    let w = 0;
    let h = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      w = rect.width;
      h = rect.height;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    const at = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };
    // One pointer at a time drags; a second finger just taps.
    let dragging: number | null = null;
    const onPointer = (e: PointerEvent) => {
      game.onTap?.(...at(e));
      if (dragging === null) {
        dragging = e.pointerId;
        canvas.setPointerCapture(e.pointerId);
      }
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerId === dragging) game.onDrag?.(...at(e));
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== dragging) return;
      dragging = null;
      game.onRelease?.(...at(e));
    };
    canvas.addEventListener('pointerdown', onPointer);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);

    let frame = requestAnimationFrame(function loop(now) {
      if (w > 0 && h > 0) game.draw(g, w, h, now);
      frame = requestAnimationFrame(loop);
    });

    return () => {
      cancelAnimationFrame(frame);
      canvas.removeEventListener('pointerdown', onPointer);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      ro.disconnect();
      popInput();
      game.stop();
      rt.controller.reset();
    };
  }, [id]);

  return <canvas class="game" ref={canvasRef} />;
}
