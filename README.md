# Pad Games

Browser game and jam app for the PreSonus ATOM pad controller. See `SPEC.md`.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest
npm run typecheck
npm run build
```

Phase 0 tools (Chrome/Edge only):

- `/tools/atom-test/` — native mode, pad/button LEDs, guided mapping, device report
- `/tools/midi-monitor/` — raw MIDI log with timestamps

Protocol notes and the per-device verification matrix: `docs/atom-protocol.md`.
