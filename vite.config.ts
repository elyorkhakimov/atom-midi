import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works under a GitHub Pages project path.
  base: './',
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        midiMonitor: resolve(import.meta.dirname, 'tools/midi-monitor/index.html'),
        atomTest: resolve(import.meta.dirname, 'tools/atom-test/index.html'),
      },
    },
  },
  server: {
    // Reachable from a phone on the LAN; adb reverse to localhost is preferred (secure context).
    host: true,
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
