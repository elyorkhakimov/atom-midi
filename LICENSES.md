# Licenses

## Sound kits

| Kit | Location | License | Source |
|---|---|---|---|
| Electro (808/909-style) | `public/kits/electro/` | CC0-1.0 | Original work: every sample is synthesized by `tools/kit-gen/make-electronic-kit.ts` in this repository (`npm run kits` regenerates it). No third-party recordings. |

Each kit also records its license and source in its `kit.json`. Third-party samples added later must be
CC0 or clearly licensed, with the license and source URL recorded here and in the kit's `kit.json`.

## Protocol references

The ATOM native-mode protocol was learned from these MIT-licensed projects (facts only, no code copied):
[gregsadetsky/atompad](https://github.com/gregsadetsky/atompad), [uermel/padbound](https://github.com/uermel/padbound).
See `docs/atom-protocol.md`.

## Dependencies

Runtime: [Preact](https://preactjs.com/) and [@preact/signals](https://github.com/preactjs/signals) (MIT).
