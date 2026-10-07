# Pad Games

Browser games and a drum jam for the PreSonus ATOM pad controller, for kids and adults, 1–4 players.
Chrome/Edge on Android, Mac and Chromebook (Safari has no Web MIDI). See `SPEC.md`.

```sh
npm install
npm run dev        # http://localhost:5173
npm test           # Vitest (pure logic: scoring, calibration, timing, input)
npm run typecheck
npm run build      # typecheck + production build into dist/
npm run kits       # regenerate the synthesized Electro kit
```

Phone testing: the page must be a secure context (http://localhost or https). See `docs/atom-protocol.md`
("How to verify") for `adb reverse` or the Chrome flag option.

## Without an ATOM

Keyboard stand-in: pads are `Z X C V` (bottom row) / `A S D F` / `Q W E R` / `1 2 3 4` (top row),
Shift = hard hit, Alt = soft hit. Space = Play, Esc = Stop, Enter = Select, arrows = navigation,
M = Click (metronome), `[ ]` `; '` `, .` `/ \` = knobs 1–4.

## ATOM controls

| Control | Action |
|---|---|
| Top-row pads 1–4 (menu) | Open Reaction / Reaction battle / Rhythm copy / Free jam |
| ▶ Play / Select | Start, confirm |
| ■ Stop | Back |
| ▲ ▼ ◀ ▶, knob 1 | Navigate; knob 2 changes values in Settings |
| Hold Select/Play on ⚙️, or Shift + Setup | Parent settings |
| Click | Metronome on/off (Free jam) |

## Layout

```
src/midi/         ATOM protocol map, driver (PadController), LED frame writer, Web MIDI helpers
src/input/        Normalized events, velocity curve/threshold, double-trigger guard, keyboard
src/calibration/  Latency maths: tap-along offset, acoustic loopback
src/audio/        Engine (layers, crossfade, round-robin, choke, voice stealing), clock, cues, metronome
src/games/        Framework, players, and one folder per game
src/ui/           Preact screens, routing, runtime wiring
src/storage/      localStorage persistence, settings, best scores
public/kits/      Sound kits (kit.json + WAV)
tools/            ATOM protocol test page, MIDI monitor, audio latency test, kit generator
```

Tools: `/tools/atom-test/`, `/tools/midi-monitor/` and `/tools/latency-test/` (speaker→mic loopback, compares
Chrome latency settings; also linked from Settings).
Protocol notes and device results: `docs/atom-protocol.md`. Licenses: `LICENSES.md`.
