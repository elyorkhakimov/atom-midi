# PreSonus ATOM — native control protocol

Status: **Phase 0 closed 2026-10-07.** Checked on the Mac mini and OnePlus 12. MacBook, S22 Ultra and Chromebook were
not tested (owner's call: expected to behave the same). Test them if problems appear. The code
version of this table is `src/midi/atomMap.ts`. Update both together.

Channels in this document are **1-based** (as on hardware and in the MIDI monitor).
`atomMap.ts` uses 0-based channels (ch 1 = `0`).

## Sources

| Source | What it gives | Licence |
|---|---|---|
| [gregsadetsky/atompad](https://github.com/gregsadetsky/atompad) (Python) | Full protocol, states it was **tested on firmware 3.00** | MIT |
| [uermel/padbound](https://github.com/uermel/padbound) `plugins/presonus_atom.py` | Same protocol plus a physical layout; claims hardware blink/breathe | MIT |
| [EMATech/AtomCtrl](https://github.com/EMATech/AtomCtrl) | Original reverse-engineering (cited by both) | — |
| [kmitch95120/Reaper-ATOM-Integration](https://github.com/kmitch95120/Reaper-ATOM-Integration) | Reaper integration, cited by atompad | — |

We only use protocol facts from these projects, not their code.

## Protocol summary

| Function | Message | Sources agree? | Verified on our ATOM |
|---|---|---|---|
| Enter native mode | Note Off ch 16, note 0, vel 127 → `8F 00 7F` | ✅ | ✅ |
| Exit native mode | Note Off ch 16, note 0, vel 0 → `8F 00 00` | ✅ | ✅ |
| Pad input | Note On/Off ch 1, notes 36–51 | ✅ | ✅ |
| Pad layout | 36 = bottom-left, row-major left→right, bottom→top; 51 = top-right | ✅ (padbound layout) | ✅ (walk test) |
| Pad LED state | Note On ch 1, pad note, vel = state | ✅ | ✅ |
| Pad LED colour | Note On ch 2 / 3 / 4 = R / G / B (0–127), pad note | ✅ | ✅ |
| Pad LED states 1/2 | padbound: 1 = blink, 2 = breathe. atompad (fw 3.00): only 127 lights; 1–126 = off | ❌ conflict | ✅ **blink / breathe work** (Mac mini); 64 = off |
| Pad brightness | No brightness control; scale RGB values | ✅ | ☐ |
| Knobs | CC 14–17 ch 1, relative: 1–63 = +n, 65–127 = −(v−64) (acceleration) | ✅ | ✅ (max step seen 6) |
| Buttons | CC ch 1, 127 = down, 0 = up (see table) | ✅ | ✅ all 20 |
| Button LEDs | Same CC out on ch 1: 127 = bright, 0 = dim (atompad: can't fully turn off) | ✅ | ✅ bright/dim |
| RGB buttons | Preset (27), Bank (26), Play (109): R/G/B via same CC on ch 2/3/4 | atompad only | Preset, Bank, Select, Play |
| Shift LED | padbound: Shift (32) has no LED | padbound only | ☐ |
| Pressure | Default: **channel** aftertouch. Setup menu → pad 7 = **polyphonic** aftertouch (per pad, `Ax note value`). Also CC 22 or off | atompad | ✅ Setup + pad 7 → poly |
| Mode persistence | Native mode lasts until exit or USB replug | atompad | ☐ |
| Setup button | Pressing Setup makes the firmware send note-offs for all 16 pads | atompad | ☐ |

### Buttons

| Button | CC | Column | LED |
|---|---|---|---|
| Setup | 86 | left | mono |
| Set Loop | 85 | left | mono |
| Editor | 31 | left | mono |
| Nudge | 30 | left | mono |
| Show/Hide | 29 | left | mono |
| Preset | 27 | left | **RGB** |
| Bank | 26 | left | **RGB** |
| Full Level | 25 | left | mono |
| Note Repeat | 24 | left | mono |
| Shift | 32 | left | none |
| Up | 87 | right | mono |
| Down | 89 | right | mono |
| Left | 90 | right | mono |
| Right | 102 | right | mono |
| Select | 103 | right | **RGB** |
| Zoom | 104 | right | mono |
| Click | 105 | right | mono |
| Record | 107 | right | mono |
| Play | 109 | right | **RGB** |
| Stop | 111 | right | mono |

### Order of LED messages

`atompad` (the fw 3.00-verified source) sends **R, G, B, then state**. `padbound` sends
state first. `atomMap.padColorMessages` uses the atompad order. One open question is
whether a lit pad changes colour when only R/G/B are re-sent, without the state
message. If it does, a colour change costs 1–3 messages instead of 4. The atom-test
"Diff mode: minimal" setting tests this.

## Open questions for hardware verification

1. ~~Do states 1 and 2 blink or breathe?~~ Yes, on our unit (Mac mini report). Firmware version still to be recorded.
2. ~~Does `minimal` diff mode work?~~ Yes (Mac mini report).
3. ~~Which buttons react to RGB?~~ Preset, Bank, Select, Play. Can a mono button LED be fully off?
4. ~~Is the pad layout exactly as above?~~ Yes (walk test).
4a. What is `BF 7F 7F` (CC 127 = 127 on ch 16)? Seen 10× then 4× on the Mac mini, and 1× on the OnePlus
    (a single session, so probably a single native-mode enter). Likely the device acknowledging native mode. Check: click "Enter native mode" with the log open and see if one arrives.
    If so, it can confirm that native mode was really entered.
4b. Hit-feedback LED latency: native mode feels slower than the ATOM's own lighting in factory mode. Compare the `batched` and `state-first` hit modes, at 100% brightness.
5. Port names per OS: macOS reports "ATOM". What do Android and ChromeOS report? `isAtomPortName` matches `\batom\b` and excludes "SQ".
6. Is `MIDIMessageEvent.timeStamp` valid (non-zero, ≤ `performance.now()`) on every platform? How big is the handler lag?
7. How many LED messages per second can the USB link take before input lags, especially on Android OTG? Use the 30/60 fps rainbow tests with pad hits.
8. Is the exit message delivered on `pagehide` and `visibilitychange` on Android? This covers app switching, screen off, and closing the tab.
9. What is the acceleration range of the knobs (max |Δ| seen)?
10. Firmware version of our unit. It's shown in the device's setup mode or PreSonus Hub/Universal Control.

## How to verify (per device)

1. `npm run dev`, then open `/tools/atom-test/`. Mac/Chromebook: `localhost:5173`.
   **Android:** the page must be a secure context, or Chrome hides Web MIDI completely
   and the page wrongly said "not available in this browser". Opening `http://<mac-ip>:5173` alone fails. Use either:
   - **A (spec):** Wireless debugging on the phone → `adb pair` / `adb connect` from the Mac →
     `adb reverse tcp:5173 tcp:5173`, then `http://localhost:5173/tools/atom-test/` on the phone.
   - **B (quick):** on the phone open `chrome://flags/#unsafely-treat-insecure-origin-as-secure`,
     add `http://<mac-ip>:5173` (the "Network" URL Vite prints), Enable, Relaunch.
2. If pressure shows "channel aftertouch": **Exit native mode**, hold Setup, tap pad 7, release, then Enter native mode again.
2b. **Connect MIDI** → allow. The ATOM is auto-selected and native mode is entered.
3. Work through sections 2–4 and **5 · Guided mapping** (16 pads, 20 buttons, 4 knobs, pressure).
4. Tick the **Manual checks**, enter the device name, then **Export report (JSON)**.
5. Save the report under `docs/reports/` and fill in the matrix below.

The MIDI monitor (`/tools/midi-monitor/`) shows raw traffic with timestamps and handler-lag stats. Use it when something doesn't match.

## Verification matrix

| Check | MacBook M4 (Chrome) | Mac mini (Brave 154) | OnePlus 12 (Chrome) | Galaxy S22 Ultra (Chrome) | Chromebook |
|---|---|---|---|---|---|
| Port name(s) | | `ATOM` (PreSonus), in + out | `ATOM` (PreSonus) | | |
| Native mode enter/exit | | ✅ | ✅ (tester: no issues) | | |
| All pads light R/G/B/W | | ✅ | ✅ (tester: no issues) | | |
| Pad layout / notes 36–51 | | ✅ walk | ✅ mapping | | |
| All 20 buttons map | | ✅ | ✅ | | |
| 4 knobs map | | ✅ | ✅ | | |
| Poly aftertouch | | ✅ after Setup + pad 7 | ✅ | | |
| State 1/2 blink/breathe | | ✅ both | | | |
| Minimal diff mode | | ✅ | | | |
| RGB buttons | | (same ATOM: see OnePlus) | Preset, Bank, Select, Play | | |
| 30 / 60 fps LED animation OK | | ✅ / ✅ (no sound to judge) | | | |
| Hit LED feels instant | | ✅ with batched send | ✅ (tester: no issues) | | |
| Exit on tab hide / app switch | | ✅ | | | |
| Re-enter on return | | ✅ | | | |
| Hot-plug recovery | | ✅ | | | |
| timeStamp valid; handler lag mean/max (ms) | | ✅ 0 bad; 0.57 / 30 (one spike) | ✅ 0 bad; 2.9 / 19.8 | | |
| Audio: sample rate, base / output latency | | 48 kHz, 5.3 / 16 ms | 48 kHz, 4 / **40 ms** | | |

## Findings log

### 2026-10-07 — Mac mini, Brave 154 (`reports/2026-10-07-mac-mini-brave.json`)

- Native mode, pad RGB and layout are confirmed. Blink (state 1) and breathe (state 2) work in
  hardware, so padbound is right and atompad's fw 3.00 note doesn't apply to this unit. State 64 = off.
- Minimal diff mode works: R/G/B alone recolours a lit pad (1–3 msgs instead of 4).
- RGB works on many more buttons than 26/27/109. Per-button list pending.
- Pressure was channel aftertouch (same value for all held pads). The device setting needs switching.
- Timestamps are fine: no zero/future timestamps; handler runs 0.76 ms (mean) / 6.2 ms (max) after `timeStamp`.
- Hit LED feedback feels slower in native mode than the ATOM's own lighting in factory mode.
  Changes made: LED batches now go in one `send()`; a `state-first` hit mode (1 message) to compare.
- Unknown `BF 7F` ×10 (CC 127, ch 16). The full bytes are logged from now on.
- Not yet run: guided mapping (buttons, knobs).
- Phone: "Web MIDI not available" in Chrome. Cause: the page wasn't a secure context (LAN IP over http).
  The message is fixed and the phone setup is documented above.

### 2026-10-07 (second run) — Mac mini, Brave 154 (`reports/2026-10-07-mac-mini-brave-2.json`)

- Guided mapping **41/41 pass**: all 16 pads (notes 36–51, ch 1), all 20 button CCs, knobs CC 14–17
  (clockwise = 1–63), poly aftertouch. `atomMap.ts` needs no changes.
- Per-pad pressure works after Setup + pad 7 (done with native mode exited).
- Hit LED feedback now feels instant with batched sends (`batched` mode, 35% brightness).
  `state-first` wasn't needed.
- RGB on buttons: the tester believes all nav buttons take RGB too. Per-button boxes weren't ticked, so the exact list is still pending.
- `BF 7F 7F` ×4. Likely a native-mode acknowledgement (see open question 4a).
- Handler lag mean 0.57 ms, one 30 ms spike in 4276 events. Watch this on phones.
- Audio: 48 kHz, baseLatency 5.3 ms, outputLatency 16 ms.

### 2026-10-07 — OnePlus 12, Chrome 154 (`reports/2026-10-07-oneplus-12-chrome.json`)

- Guided mapping **41/41 pass**. Same port name (`ATOM`, PreSonus), poly aftertouch works.
- RGB buttons from the colour-cycle test: **Preset, Bank, Select, Play** (`atomMap` updated: Select → rgb).
- Manual checks were not ticked. The tester reports everything behaved like the Mac except audio latency.
- **Audio latency is noticeably worse on the phone:** Chrome reports outputLatency **40 ms** (Mac mini 16 ms),
  baseLatency 4 ms. Handler lag mean 2.9 ms / max 19.8 ms (Mac 0.6 / 30).
  The phone's USB-C port is taken by the ATOM, so audio went through the speaker (or Bluetooth, which would be
  worse and is under-reported). See "Phone audio latency" below.
- `BF 7F 7F` ×1.

### Phone audio latency (to address in Phase 1)

- Try `AudioContext({ latencyHint: 0 })` and other values, and compare the reported `outputLatency`.
- Make sure the context runs at the device's native rate (48 kHz here) so Chrome can use the AAudio low-latency path.
- Wired audio with the ATOM plugged in needs a USB-C hub with a headphone DAC/passthrough (the OnePlus 12 has
  no 3.5 mm jack). Check whether that lowers outputLatency compared with the speaker.
- A measured round-trip test (mic loopback) is in Phase 3. Until then, Chrome's reported `outputLatency` is
  our estimate, and the latency-calibration screen covers scoring.
