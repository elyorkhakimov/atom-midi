# PreSonus ATOM — native control protocol

Status: **Phase 0, desk research done; hardware verification pending.** The code
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
| Enter native mode | Note Off ch 16, note 0, vel 127 → `8F 00 7F` | ✅ | ☐ |
| Exit native mode | Note Off ch 16, note 0, vel 0 → `8F 00 00` | ✅ | ☐ |
| Pad input | Note On/Off ch 1, notes 36–51 | ✅ | ☐ |
| Pad layout | 36 = bottom-left, row-major left→right, bottom→top; 51 = top-right | ✅ (padbound layout) | ☐ |
| Pad LED state | Note On ch 1, pad note, vel = state | ✅ | ☐ |
| Pad LED colour | Note On ch 2 / 3 / 4 = R / G / B (0–127), pad note | ✅ | ☐ |
| Pad LED states 1/2 | padbound: 1 = blink, 2 = breathe. atompad (fw 3.00): **only 127 lights; 1–126 = off** | ❌ **conflict** | ☐ |
| Pad brightness | No brightness control; scale RGB values | ✅ | ☐ |
| Knobs | CC 14–17 ch 1, relative: 1–63 = +n, 65–127 = −(v−64) (acceleration) | ✅ | ☐ |
| Buttons | CC ch 1, 127 = down, 0 = up (see table) | ✅ | ☐ |
| Button LEDs | Same CC out on ch 1: 127 = bright, 0 = dim (atompad: can't fully turn off) | ✅ | ☐ |
| RGB buttons | Preset (27), Bank (26), Play (109): R/G/B via same CC on ch 2/3/4 | atompad only | ☐ |
| Shift LED | padbound: Shift (32) has no LED | padbound only | ☐ |
| Pressure | Default: **channel** aftertouch. Setup menu → pad 7 = **polyphonic** aftertouch (per pad, `Ax note value`). Also CC 22 or off | atompad | ☐ |
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
| Select | 103 | right | mono |
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

1. Do states 1 and 2 blink or breathe (padbound), or are they off (atompad)? Firmware version matters.
2. Does `minimal` diff mode (no state message on a colour change) work?
3. Which buttons react to RGB? Can a mono button LED be fully off?
4. Is the pad layout exactly as above?
5. Port names per OS: macOS reports "ATOM". What do Android and ChromeOS report? `isAtomPortName` matches `\batom\b` and excludes "SQ".
6. Is `MIDIMessageEvent.timeStamp` valid (non-zero, ≤ `performance.now()`) on every platform? How big is the handler lag?
7. How many LED messages per second can the USB link take before input lags, especially on Android OTG? Use the 30/60 fps rainbow tests with pad hits.
8. Is the exit message delivered on `pagehide` and `visibilitychange` on Android? This covers app switching, screen off, and closing the tab.
9. What is the acceleration range of the knobs (max |Δ| seen)?
10. Firmware version of our unit. It's shown in the device's setup mode or PreSonus Hub/Universal Control.

## How to verify (per device)

1. `npm run dev`, then open `/tools/atom-test/` (Mac/Chromebook: `localhost:5173`;
   Android: ADB over Wi-Fi + `adb reverse tcp:5173 tcp:5173`, then `localhost:5173` in Chrome).
2. **Connect MIDI** → allow. The ATOM is auto-selected and native mode is entered.
3. Work through sections 2–4 and **5 · Guided mapping** (16 pads, 20 buttons, 4 knobs, pressure).
4. Tick the **Manual checks**, enter the device name, then **Export report (JSON)**.
5. Save the report under `docs/reports/` and fill in the matrix below.

The MIDI monitor (`/tools/midi-monitor/`) shows raw traffic with timestamps and handler-lag stats. Use it when something doesn't match.

## Verification matrix

| Check | MacBook M4 (Chrome) | Mac mini (Chrome/Edge) | OnePlus 12 (Chrome) | Galaxy S22 Ultra (Chrome) | Chromebook |
|---|---|---|---|---|---|
| Port name(s) | | | | | |
| Native mode enter/exit | | | | | |
| All pads light R/G/B/W | | | | | |
| Pad layout / notes 36–51 | | | | | |
| All 20 buttons map | | | | | |
| 4 knobs map | | | | | |
| Poly aftertouch | | | | | |
| State 1/2 blink/breathe | | | | | |
| Minimal diff mode | | | | | |
| RGB buttons (26/27/109) | | | | | |
| 30 / 60 fps LED animation OK | | | | | |
| Exit on tab hide / app switch | | | | | |
| Re-enter on return | | | | | |
| Hot-plug recovery | | | | | |
| timeStamp valid; handler lag mean/max (ms) | | | | | |

## Findings log

_(add dated entries as devices are tested)_
