# Licenses

## Sound kits

| Kit | Location | License | Source |
|---|---|---|---|
| Acoustic | `public/kits/acoustic/` | **CC BY-SA 3.0** (drums, cymbals) + CC0-1.0 (high tom, clap, tambourine) | Drums and cymbals from the [Salamander Drumkit](https://archive.org/details/SalamanderDrumkit) by **Alexander Holm**, licensed [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/); trimmed, mixed to mono and normalized for this kit, which is therefore also CC BY-SA 3.0. High tom, clap and tambourine from the [Versilian Community Sample Library](https://github.com/sgossner/VCSL) (CC0). |
| Electro (808/909-style) | `public/kits/electro/` | CC0-1.0 | Original work: every sample is synthesized by `tools/kit-gen/make-electronic-kit.ts` in this repository (`npm run kits` regenerates it). No third-party recordings. |
| Animals & FX | `public/kits/fun/` | CC0-1.0 | OpenGameArt: [Baby Animals – Sounds Pack](https://opengameart.org/content/baby-animals-sounds-pack), [Dog sounds](https://opengameart.org/content/dog-sounds) (pauliuw), [Cat purr meow](https://opengameart.org/content/cat-purr-meow) (Kerzoven), [Sci-fi aliens and cows pack](https://opengameart.org/content/sci-fi-aliens-and-cows-pack) (qubodup), [spring sounds](https://opengameart.org/content/spring-sounds) (bart); [Kenney](https://kenney.nl) Digital Audio and Impact Sounds. |

## Game sounds

`public/sounds/` (metronome, menu sounds, jingles, voice, sound-match sounds): all CC0 — [Kenney](https://kenney.nl)
Interface Sounds, Music Jingles and Voiceover Pack, and VCSL woodblock, claves, bass drum and glockenspiel.
Per-file sources are in `public/sounds/SOURCES.md`. Cues without a file are synthesized in `src/audio/cues.ts`.

Kits and sounds are built from the raw downloads by `tools/kit-gen/build-sample-kits.ts` (`npm run kits:samples`,
needs ffmpeg and the sources listed in that script).

Each kit also records its license and source in its `kit.json`. Third-party samples added later must be
CC0 or clearly licensed, with the license and source URL recorded here and in the kit's `kit.json`.

## Protocol references

The ATOM native-mode protocol was learned from these MIT-licensed projects (facts only, no code copied):
[gregsadetsky/atompad](https://github.com/gregsadetsky/atompad), [uermel/padbound](https://github.com/uermel/padbound).
See `docs/atom-protocol.md`.

## Dependencies

Runtime: [Preact](https://preactjs.com/) and [@preact/signals](https://github.com/preactjs/signals) (MIT).
