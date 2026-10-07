# Pad Games — Project Spec

A browser-based game and jam app for a **PreSonus ATOM** pad controller, for a family
(kids from ~7 years old and adults), 1–4 players. Runs in Chrome on Android phones,
Macs, and Chromebooks. The ATOM provides the input (pads, buttons, knobs) and the
lights (RGB pads); the phone/laptop provides screen, sound, and game logic.

Read this whole file before starting. Work in the phases at the bottom, starting
with Phase 0. Ask before deviating from the stack or the non-goals.

---

## 1. Target devices and browsers

| Device | Browser | Notes |
|---|---|---|
| OnePlus 12 (Android) | Chrome | ATOM via USB-C OTG (ATOM has a USB-B socket) |
| Samsung Galaxy S22 Ultra (Android) | Chrome (not Samsung Internet) | same |
| MacBook (M4), Mac mini | Chrome or Edge | **Safari has no Web MIDI — unsupported** |
| Chromebook | Chrome | |

- Layout must work on phone portrait and landscape, and laptop screens.
- Wired audio only. Show a one-time warning that Bluetooth audio adds 100–200+ ms.

## 2. Tech stack

- **TypeScript**, **Vite**, strict mode.
- No heavy framework. Canvas for game screens; plain DOM or a small library
  (Preact or Svelte — pick one and stay consistent) for menus and settings.
- **Web MIDI** (`navigator.requestMIDIAccess()`, no SysEx needed).
- **Web Audio** for all sound. Use an AudioWorklet only if scheduling precision requires it.
- **PWA**: manifest + service worker; installable; works offline after first load
  (cache app and sound kits).
- **Vitest** for unit tests of pure logic (scoring, calibration math, quantization, timing).
- Hosting: static site on **GitHub Pages** (HTTPS required for Web MIDI). No backend.
- Persistence: `localStorage` / IndexedDB per device (settings, calibration, high
  scores, recorded beats).

## 3. Hardware: PreSonus ATOM

- 16 velocity- and pressure-sensitive RGB pads (4×4), 20 buttons (some with LEDs),
  4 endless encoders. USB bus-powered, class-compliant MIDI.
- Pads default to notes **36–51** (bottom-left to top-right — verify).
- Pressure: set the ATOM's Setup menu to **polyphonic aftertouch** (per-pad pressure).
  Velocity curve: user sets the most sensitive curve on the device; all further
  shaping happens in the app.

### Native control mode (required)

The app must put the ATOM into its undocumented "native control" mode (what Studio One
uses). In this mode the app controls all pad colors and every button reports to the app.
Community-documented details (**verify all of these in Phase 0** against the open-source
`atompad` project and the `padbound` docs):

- **Enter:** Note Off on MIDI channel 16 (0-based ch 15), note 0, velocity 127.
  **Exit:** same message with velocity 0.
- Pad LED on/off and RGB color are set with MIDI messages where the channel selects
  the function/color component and the velocity carries the value (0–127 per R/G/B).
- No hardware blink/pulse/brightness — all animation is done in software.
- Some buttons have RGB LEDs set similarly (exact CCs/channels to be mapped).

Requirements:
- Send the exit message on page hide/unload (`pagehide`, `visibilitychange`) so the
  ATOM works normally in other apps afterwards. Re-enter native mode when the page
  becomes visible again or the device reconnects.
- Handle hot-plug (`MIDIAccess.onstatechange`): detect connect/disconnect, show status.
- LED output must be rate-limited/coalesced (only send changes; batch per animation
  frame) so animations don't flood the USB link.
- On a pad hit, send the LED feedback message **first**, before sound or rendering work.

## 4. Architecture

```
src/
  midi/        Web MIDI access, ATOM driver (native mode, LED control, mapping)
  input/       Normalized input events with timestamps (pads, pressure, buttons, encoders)
  calibration/ Per-pad velocity calibration, latency calibration
  audio/       Audio engine: kits, velocity layers, round-robin, choke, scheduling
  games/       One folder per game; shared game framework (state machine, scoring)
  ui/          Menus, settings, screens
  storage/     Persistence helpers
  pwa/         Service worker, caching
public/kits/   Sound kits (see §7)
tools/         Protocol test page, MIDI monitor
```

### Input layer
- Normalize everything to events: `PadDown{pad, velocity, t}`, `PadPressure{pad, value, t}`,
  `PadUp{pad, t}`, `Button{id, down, t}`, `Encoder{id, delta, t}`.
- `t` = the Web MIDI event timestamp (`event.timeStamp`, `performance.now()` domain),
  **not** the time the handler runs. All scoring uses these timestamps.
- Apply per-pad velocity calibration and the user's response curve here.
- Double-trigger guard: ignore a second PadDown on the same pad within 25 ms unless
  its velocity is higher (configurable).

### Timing model
- Convert between `performance.now()` and `AudioContext` time using
  `audioContext.getOutputTimestamp()` (and `baseLatency`/`outputLatency` where available).
- Schedule sounds ahead on the audio clock; never rely on `setTimeout` for musical timing.
- The **GO signal is audio** (precisely scheduled). Pad LEDs and screen flash at the
  same moment as secondary cues.
- Per-device **latency offset** from the calibration screen is applied to all scoring.

## 5. Calibration and settings

1. **Pad calibration wizard:** "tap each pad softly a few times, then hard a few
   times" → per-pad min/max → mapping so soft ≈ 20, hard = 127 on every pad.
2. **Response curve:** linear / soft / hard (adjustable with an encoder); kid profile.
3. **Minimum velocity threshold** (ignore ghost hits).
4. **Latency calibration:** "tap along with the beat" (8–16 taps) → mean offset
   stored per device. Show measured offset in ms.
5. **Profiles:** multiple player profiles (name, color, curve).
6. Settings: master volume, metronome volume, LED brightness cap (default ~35% to save
   power on phones), kit selection, language-light kid UI toggle.

All stored per device.

## 6. Audio engine

- Kits loaded from `public/kits/<kit>/kit.json` + sample files.
- Per instrument: multiple **velocity layers** (e.g. soft/medium/hard with velocity
  ranges), optional crossfade near layer boundaries, **round-robin** within a layer.
- Gain from velocity using a curve (default `gain = (v/127)^2`); optional velocity-driven
  low-pass filter for single-sample instruments.
- **Choke groups** (closed hi-hat cuts open hi-hat).
- Voice limit (e.g. 32) with oldest-voice stealing.
- Polyphonic aftertouch can modulate (filter/swell/roll) — optional per instrument.
- Melodic mode: pads mapped to a scale (no wrong notes), sampled or synthesized instrument.
- Use the device's native sample rate; mono 16-bit samples are fine.

## 7. Sound kits

- Start with 3 kits: acoustic, electronic (808/909-style), and a fun sound-effects kit.
- **Only use CC0 or clearly licensed samples** (freesound.org filtered to CC0, 99Sounds,
  SampleSwap, Hydrogen/DrumGizmo kits — check each license). Record license and source
  per kit in `kit.json` and a `LICENSES.md`.
- Trim silence, mono, normalized. Keep each kit ≲ 10 MB.

## 8. Players and pad layouts

- **Simultaneous 3–4 player games:** one **corner pad per player** (pads at the four
  corners) so hands don't collide; each corner glows in its player's color.
- **2-player simultaneous:** each player gets a half (left/right 2×4) or a 2×2 quadrant.
- **Turn-based games:** active player uses the whole board; the board shows whose turn it is.
- Player colors: red, blue, green, yellow (consistent everywhere: pads, screen, scores).

## 9. Games

✓ = core for Phase 1. Others are backlog in rough priority order.

### Single player
| Game | Rules summary |
|---|---|
| ✓ Reaction (random) | GO after random 2–6 s; react; best time this session. Only a hit before GO is a false start (any hit after GO counts) |
| Countdown | 3-2-1-GO with beeps (1 s apart); react without jumping early |
| On the beat | 3-2-1, hit exactly on the 4th beat; score in ±ms |
| ✓ Rhythm copy | App plays a pattern (1–2 bars, 120 BPM default) 3×, 4-click count-in, player plays it 3×. Match each hit to nearest expected hit on same pad within ±100 ms: points = 100×(1−|err|/100 ms); miss = 0; extra/wrong-pad hit = −25. Show % and average error in ms. 10 built-in patterns |
| ✓ Free jam | Play kits with velocity; encoders: kit, volume, tempo/metronome |
| Beat recorder | Count-in, record 1/2/4 bars with metronome, quantize (16th or 8th), loop playback, show grid |
| Whack-a-mole | Random pads light; hit before they fade; speeds up |
| Simon | Repeat growing color+sound sequence |
| Color rush | Screen shows a color; hit a pad of that color among distractors |
| Dynamics trainer | Hit at target loudness (soft/medium/loud) |
| Pressure fishing | Hold a pad, keep aftertouch inside a moving target zone |
| Steady tempo | Metronome fades after 4 bars; keep time; show drift |
| Breakout | Encoder moves the paddle |
| Safe cracker | Encoder finds hidden numbers, guided by ticking; pads confirm |
| Pitch match | Encoder tunes a tone to match the target |

### Multiplayer (2–4)
| Game | Players / style | Rules summary |
|---|---|---|
| ✓ Reaction battle | 2–4, simultaneous (corner pads) | First clean hit after GO wins; early = disqualified for the round; win tally |
| Countdown race | 2–4, simultaneous | Countdown variant of the above |
| Closest to the beat | 2–4, simultaneous | Nearest to the 4th beat wins (±ms) |
| Copy my beat | 2–4, turns | One records, next copies (rhythm-copy scoring), rotate |
| Rhythm battle | 2–4, turns | Same pattern, each plays in turn, highest score wins |
| Simon chain | 2–4, turns | Repeat sequence and add one step; miss = out |
| Quiz buzzer | 2–4, simultaneous | Parent asks; first buzz locks others out; parent awards points via buttons |
| Freeze | 2–4, simultaneous | Music stops → hit your pad; slowest or early is out |
| Hot potato | 2–4, turns | Lit pad passes on correct hits as tempo rises; holder at buzzer is out |
| Color whack | 2, simultaneous | Hit only your color; others' color = penalty |
| Tug of war | 2, simultaneous (halves) | Tap rate moves the rope |
| Territory | 2, simultaneous (halves) | Claim/steal pads in 30 s |
| Loudness duel | 2–4, turns | Closest to target loudness |
| Pong | 2, simultaneous | Two encoders move paddles |
| Band mode | 2–4, cooperative | Each player's quadrant is an instrument; jam together |

### Shared game framework
- State machine per game (menu → ready → countdown/play → results).
- Results screen: big numbers, winner in player color, session best (session = until
  reload; also keep per-device all-time best in storage).
- Every game playable without touching the phone/laptop after start: ATOM buttons for
  Start / Back / Next, encoders for menu scrolling and values.

## 10. UI requirements

- Kid-friendly: large text, high contrast, minimal reading, sounds for feedback.
- Main menu navigable entirely from the ATOM (encoder scroll, pad or button select).
- Status bar: ATOM connected / native mode active / audio started / latency offset.
- First run: "Tap to start" (required to unlock audio), MIDI permission prompt, then
  calibration prompts.
- Parent settings behind a long-press or button combo.

## 11. Dev workflow

- `npm run dev` (Vite). Laptop testing at `localhost`.
- Phone testing: phone USB port is used by the ATOM, so use **ADB over Wi-Fi**
  (wireless debugging) + `adb reverse tcp:5173 tcp:5173`, open `localhost:5173` on the
  phone (secure context), debug via `chrome://inspect` on the Mac.
- Deploy: GitHub Actions → GitHub Pages on push to `main`.

## 12. Non-goals (for now)

- No Safari/iOS support, no backend, no accounts, no online leaderboards.
- No native apps. A future native Android version (Kotlin + Oboe/C++ or Rust) may be
  built only if phone audio latency is unacceptable for jamming; keep game logic,
  scoring, and kit formats free of browser-specific code where practical so it can be ported.
- No support for other controllers yet, but keep the ATOM driver behind an interface
  (`PadController`) so others (e.g. Akai MPD218, Maschine via WebHID) can be added later.

## 13. Phases

**Phase 0 — Protocol test harness (do first)**
- `tools/midi-monitor`: list ports, log all incoming messages with timestamps.
- `tools/atom-test`: enter/exit native mode; light each pad in R/G/B/white; set
  arbitrary RGB; map every button and encoder (record their notes/CCs into
  `src/midi/atomMap.ts`); verify pad note numbers and aftertouch.
- Verify on all four device types. Document findings in `docs/atom-protocol.md`.

**Phase 1 — Core + first games**
- ATOM driver, input layer, audio engine with one kit, calibration screens, settings,
  main menu, Reaction (single), Reaction battle (multi), Rhythm copy, Free jam.
- Unit tests for scoring, calibration mapping, timestamp conversion.

**Phase 2 — More games and kits**
- Remaining games in backlog order, 3 kits, beat recorder, profiles.

**Phase 3 — Polish**
- PWA install/offline, animations, accessibility, performance on phones,
  measured latency report per device.

## 14. Acceptance checks (manual, per device)

- ATOM detected, native mode entered, all 16 pads light in any color.
- Exiting the tab returns the ATOM to normal mode.
- Every pad, button, and encoder produces the expected event.
- Soft vs hard hits produce audibly different sounds (layers + gain).
- Reaction times are consistent across devices after latency calibration (±10 ms).
- Rhythm copy scores a perfectly played pattern at ≥95%.
- 4-player reaction battle: simultaneous hits resolved correctly by timestamp.
