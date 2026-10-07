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

    let frame = requestAnimationFrame(function loop(now) {
      if (w > 0 && h > 0) game.draw(g, w, h, now);
      frame = requestAnimationFrame(loop);
    });

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      popInput();
      game.stop();
      rt.controller.reset();
    };
  }, [id]);

  return <canvas class="game" ref={canvasRef} />;
}
