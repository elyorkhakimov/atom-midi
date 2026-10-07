/**
 * Builds the sample-based kits and game sounds from the raw downloads in samples-src/
 * (not committed; see samples-src/SOURCES.md for where each set comes from).
 *
 *   node tools/kit-gen/build-sample-kits.ts
 *
 * Needs ffmpeg on PATH. Every file is decoded to mono 48 kHz, its leading silence
 * trimmed (so the hit starts at sample 0 — this matters for timing), its tail cut
 * below -60 dB (capped per instrument, with a fade), and peak-normalized; loudness
 * per hit comes from the engine's velocity gain, as for the Electro kit.
 *
 * Output: public/kits/acoustic/, public/kits/fun/, public/sounds/.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { KitInstrument, KitJson } from '../../src/audio/kit.ts';

const SR = 48000;
const ROOT = join(import.meta.dirname, '../..');
const SRC = join(ROOT, 'samples-src');
const SAL = join(SRC, 'salamander/OH');
const VCSL = join(SRC, 'vcsl');
const KENNEY = join(SRC, 'kenney');
const OGA = join(SRC, 'oga');

// ---------------------------------------------------------------------------
// Audio processing
// ---------------------------------------------------------------------------
function decode(file: string): Float32Array {
  if (!existsSync(file)) throw new Error(`Missing source ${file}`);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4).slice();
}

const db = (d: number) => 10 ** (d / 20);

interface Shape {
  /** Hard cap on length in seconds (with a fade-out over the last part). */
  maxSeconds: number;
  /** Peak level after normalizing, dBFS. */
  levelDb?: number;
  /** Start threshold relative to the file's peak, dB. */
  onsetDb?: number;
}

function shape(x: Float32Array, { maxSeconds, levelDb = -1, onsetDb = -36 }: Shape): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak === 0) throw new Error('silent sample');
  // Start just before the first sample above the onset threshold.
  const on = peak * db(onsetDb);
  let start = x.findIndex((v) => Math.abs(v) >= on);
  start = Math.max(0, start - Math.round(0.0005 * SR));
  // End where it falls below -60 dB for good, capped.
  const off = peak * db(-60);
  let end = x.length;
  while (end > start && Math.abs(x[end - 1]!) < off) end--;
  end = Math.min(end, start + Math.round(maxSeconds * SR));
  const out = x.slice(start, end);
  const fadeIn = Math.round(0.0005 * SR);
  for (let i = 0; i < fadeIn && i < out.length; i++) out[i]! *= i / fadeIn;
  const fadeOut = Math.min(out.length >> 2, Math.round(Math.min(0.3, maxSeconds * 0.25) * SR));
  for (let i = 0; i < fadeOut; i++) out[out.length - 1 - i]! *= (i / fadeOut) ** 2;
  let p = 0;
  for (const v of out) p = Math.max(p, Math.abs(v));
  const g = db(levelDb) / p;
  for (let i = 0; i < out.length; i++) out[i]! *= g;
  return out;
}

function wav(samples: Float32Array): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// ---------------------------------------------------------------------------
// Kits
// ---------------------------------------------------------------------------
interface InstrumentSpec {
  id: string;
  name: string;
  color: [number, number, number];
  chokeGroup?: string;
  shape: Shape;
  /** Source files per velocity layer, softest first. One layer gets a velocity filter. */
  layers: string[][];
}

/** Up to `n` files spread across a numbered series (e.g. kick_OH_F_1..11), for round-robin variety. */
function spread(dir: string, prefix: string, n: number): string[] {
  const files = readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && /^_\d+\.wav$/i.test(f.slice(prefix.length)))
    .sort((a, b) => parseInt(a.slice(prefix.length + 1)) - parseInt(b.slice(prefix.length + 1)));
  if (!files.length) throw new Error(`No files for ${prefix} in ${dir}`);
  const pick = n >= files.length ? files : Array.from({ length: n }, (_, i) => files[Math.round((i * (files.length - 1)) / Math.max(1, n - 1))]!);
  return pick.map((f) => join(dir, f));
}

const sal = (prefix: string, n = 3) => spread(SAL, prefix, n);

/** Equal velocity ranges, softest first. */
function ranges(count: number): [number, number][] {
  return Array.from({ length: count }, (_, i) => [Math.round((i * 127) / count) + 1, Math.round(((i + 1) * 127) / count)] as [number, number]);
}

function buildKit(meta: Omit<KitJson, 'pads' | 'instruments'>, specs: InstrumentSpec[]): void {
  if (specs.length !== 16) throw new Error(`${meta.id}: need 16 instruments, got ${specs.length}`);
  const out = join(ROOT, 'public/kits', meta.id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  let bytes = 0;
  const instruments: Record<string, KitInstrument> = {};
  for (const spec of specs) {
    const r = ranges(spec.layers.length);
    instruments[spec.id] = {
      name: spec.name,
      color: spec.color,
      ...(spec.chokeGroup ? { chokeGroup: spec.chokeGroup } : {}),
      ...(spec.layers.length > 1 ? { crossfade: 8 } : { velocityFilter: true }),
      layers: spec.layers.map((files, li) => ({
        minVelocity: r[li]![0],
        maxVelocity: r[li]![1],
        samples: files.map((file, vi) => {
          const name = `${spec.id}_${li + 1}_${vi + 1}.wav`;
          const data = wav(shape(decode(file), spec.shape));
          bytes += data.length;
          writeFileSync(join(out, name), data);
          return name;
        }),
      })),
    };
  }
  const kit: KitJson & { sampleRate: number } = { ...meta, sampleRate: SR, pads: specs.map((s) => s.id), instruments };
  writeFileSync(join(out, 'kit.json'), JSON.stringify(kit, null, 2) + '\n');
  console.log(`${meta.id}: ${(bytes / 1e6).toFixed(1)} MB`);
}

// Pad order: pad 0 = bottom-left, rows go up.
const DRUM: Shape = { maxSeconds: 1.2 };
const TOM: Shape = { maxSeconds: 1.1 };
const CYMBAL: Shape = { maxSeconds: 2.5, levelDb: -3 };

function acoustic(): void {
  buildKit(
    {
      id: 'acoustic',
      name: 'Acoustic',
      description: 'Real drum kit (Salamander Drumkit) with high tom, clap and tambourine (VCSL)',
      license: 'CC-BY-SA-3.0 AND CC0-1.0',
      source:
        'Drums and cymbals: Salamander Drumkit by Alexander Holm, CC BY-SA 3.0 (https://archive.org/details/SalamanderDrumkit), trimmed, mixed to mono and normalized for this kit. ' +
        'High tom, clap and tambourine: Versilian Community Sample Library, CC0 (https://github.com/sgossner/VCSL).',
    },
    [
      // Row 0
      { id: 'kick', name: 'Kick', color: [127, 0, 0], shape: DRUM, layers: [sal('kick_OH_P'), sal('kick_OH_F'), sal('kick_OH_FF')] },
      { id: 'snare', name: 'Snare', color: [127, 60, 0], shape: DRUM, layers: [sal('snare_OH_Ghost', 2), sal('snare_OH_MP', 3), sal('snare_OH_F', 3), sal('snare_OH_FF', 2)] },
      { id: 'closedHat', name: 'Closed hi-hat', color: [127, 110, 0], chokeGroup: 'hat', shape: { maxSeconds: 0.8 }, layers: [sal('hihatClosed_OH_P', 4), sal('hihatClosed_OH_F', 4)] },
      { id: 'openHat', name: 'Open hi-hat', color: [100, 127, 0], chokeGroup: 'hat', shape: { maxSeconds: 1.8, levelDb: -2 }, layers: [sal('hihatOpen_OH_P', 2), sal('hihatOpen_OH_F', 2), sal('hihatOpen_OH_FF', 2)] },
      // Row 1: same roles as the Electro kit (low/mid/high tom, clap), so Rhythm copy patterns fit every kit.
      { id: 'floorTom', name: 'Floor tom', color: [0, 40, 127], shape: TOM, layers: [sal('loTom_OH_PP', 2), sal('loTom_OH_MP', 2), sal('loTom_OH_FF', 2)] },
      { id: 'rackTom', name: 'Rack tom', color: [0, 90, 127], shape: TOM, layers: [sal('hiTom_OH_P', 2), sal('hiTom_OH_F', 2), sal('hiTom_OH_FF', 2)] },
      {
        id: 'highTom',
        name: 'High tom',
        color: [0, 127, 127],
        shape: TOM,
        layers: [2, 3, 4].map((v) => [1, 2].map((rr) => join(VCSL, `Membranophones/Struck Membranophones/Tom 1/Stick/TomH_HitS_v${v}_rr${rr}_Mid.wav`))),
      },
      {
        id: 'clap',
        name: 'Clap',
        color: [127, 30, 60],
        shape: { maxSeconds: 0.6 },
        layers: [[1, 3, 5].map((rr) => join(VCSL, `Idiophones/Struck Idiophones/Claps/Clap_rr${rr}.wav`))],
      },
      // Row 2
      { id: 'pedalHat', name: 'Pedal hi-hat', color: [127, 127, 40], chokeGroup: 'hat', shape: { maxSeconds: 0.6 }, layers: [sal('hihatFoot_OH_MP', 4)] },
      { id: 'crossStick', name: 'Cross-stick', color: [127, 0, 127], shape: { maxSeconds: 0.6 }, layers: [sal('snareStick_OH_F', 4)] },
      {
        id: 'tambourine',
        name: 'Tambourine',
        color: [90, 0, 127],
        shape: { maxSeconds: 1 },
        layers: [[join(VCSL, 'Idiophones/Struck Idiophones/Tambourine 1/Tamb1_Hit_v1_rr1_Mid.wav')], [join(VCSL, 'Idiophones/Struck Idiophones/Tambourine 1/Tamb1_Hit_v2_rr1_Mid.wav')]],
      },
      { id: 'cowbell', name: 'Cowbell', color: [127, 70, 30], shape: { maxSeconds: 1, levelDb: -3 }, layers: [sal('cowbell_P', 2), sal('cowbell_MP', 2), sal('cowbell_FF', 2)] },
      // Row 3: cymbals
      { id: 'crash', name: 'Crash', color: [0, 127, 60], shape: CYMBAL, layers: [sal('crash1_OH_P', 2), sal('crash1_OH_FF', 2)] },
      { id: 'splash', name: 'Splash', color: [0, 127, 0], shape: { maxSeconds: 1.8, levelDb: -3 }, layers: [sal('splash1_OH_P', 2), sal('splash1_OH_F', 2)] },
      { id: 'ride', name: 'Ride', color: [60, 60, 127], shape: { maxSeconds: 1.6, levelDb: -3 }, layers: [sal('ride2_OH_PP', 2), sal('ride2_OH_MP', 2), sal('ride2_OH_FF', 2)] },
      { id: 'rideBell', name: 'Ride bell', color: [110, 110, 127], shape: { maxSeconds: 1.8, levelDb: -3 }, layers: [sal('ride2Bell_OH_F', 3)] },
    ],
  );
}

const kenney = (pack: string, file: string) => join(KENNEY, `kenney_${pack}`, pack === 'voiceover-pack' ? '' : 'Audio', file);
const oga = (path: string) => join(OGA, path);
// Animals and effects often start with breath or a soft swell: start where the sound is clearly audible.
const FX: Shape = { maxSeconds: 1.5, onsetDb: -20 };
const ANIMAL: Shape = { maxSeconds: 2, onsetDb: -20 };

function fun(): void {
  const dog = (n: string) => oga(`dog-sounds/Dog/${n}.wav`);
  buildKit(
    {
      id: 'fun',
      name: 'Animals & FX',
      description: 'Farm animals, boings, lasers and power-ups',
      license: 'CC0-1.0',
      source:
        'All CC0: OpenGameArt "Baby Animals – Sounds Pack", "Dog sounds" (pauliuw), "Cat purr meow" (Kerzoven), "Sci-fi aliens and cows pack" (qubodup), "spring sounds" (bart); ' +
        'Kenney Digital Audio and Impact Sounds (kenney.nl).',
    },
    [
      // Row 0: animals
      { id: 'dog', name: 'Dog', color: [127, 60, 0], shape: ANIMAL, layers: [[dog('Dog Bark 1'), dog('Dog Bark 2'), dog('Dog Bark 3')]] },
      { id: 'cat', name: 'Cat', color: [127, 110, 0], shape: ANIMAL, layers: [[oga('cat-purr-meow/cat_softmew.wav'), oga('baby-animals/Meow.ogg')]] },
      { id: 'cow', name: 'Cow', color: [127, 127, 127], shape: ANIMAL, layers: [[oga('baby-animals/Moo.ogg'), oga('cows/qubodup-sci-fi-cow-alien-soundpack/moo-notification.wav')]] },
      { id: 'sheep', name: 'Sheep', color: [110, 110, 90], shape: ANIMAL, layers: [[oga('baby-animals/Baa.ogg')]] },
      // Row 1: more animals
      { id: 'chick', name: 'Chick', color: [127, 127, 0], shape: ANIMAL, layers: [[oga('baby-animals/Peeps.ogg')]] },
      { id: 'piglet', name: 'Piglet', color: [127, 40, 80], shape: ANIMAL, layers: [[oga('baby-animals/Squeal.ogg')]] },
      { id: 'horse', name: 'Horse', color: [90, 40, 0], shape: ANIMAL, layers: [[oga('baby-animals/Whinny.ogg')]] },
      { id: 'goat', name: 'Goat', color: [80, 127, 60], shape: ANIMAL, layers: [[oga('baby-animals/Bleat.ogg')]] },
      // Row 2: boings and lasers
      {
        id: 'boing',
        name: 'Boing',
        color: [0, 127, 60],
        shape: FX,
        layers: [[1, 2, 3].map((n) => oga(`spring-sounds/door springs/door spring - Region #${n}.wav`))],
      },
      {
        id: 'boing2',
        name: 'Big boing',
        color: [0, 127, 0],
        shape: FX,
        layers: [[4, 5, 6].map((n) => oga(`spring-sounds/door springs/door spring - Region #${n}.wav`))],
      },
      { id: 'laser', name: 'Laser', color: [127, 0, 0], shape: FX, layers: [[1, 2, 3].map((n) => kenney('digital-audio', `laser${n}.ogg`))] },
      { id: 'zap', name: 'Zap', color: [0, 90, 127], shape: FX, layers: [[kenney('digital-audio', 'zap1.ogg'), kenney('digital-audio', 'zap2.ogg')]] },
      // Row 3: power-ups and bells
      { id: 'powerUp', name: 'Power-up', color: [60, 0, 127], shape: FX, layers: [[1, 2, 3].map((n) => kenney('digital-audio', `powerUp${n}.ogg`))] },
      { id: 'phaserUp', name: 'Whoosh up', color: [0, 127, 127], shape: FX, layers: [[1, 2].map((n) => kenney('digital-audio', `phaserUp${n}.ogg`))] },
      { id: 'phaserDown', name: 'Whoosh down', color: [0, 60, 127], shape: FX, layers: [[1, 2].map((n) => kenney('digital-audio', `phaserDown${n}.ogg`))] },
      {
        id: 'bell',
        name: 'Bell',
        color: [127, 90, 40],
        shape: { maxSeconds: 2, levelDb: -3 },
        layers: [[0, 1, 2].map((n) => kenney('impact-sounds', `impactBell_heavy_00${n}.ogg`))],
      },
    ],
  );
}

// ---------------------------------------------------------------------------
// Game sounds (cues). Any cue not listed here stays synthesized (src/audio/cues.ts).
// ---------------------------------------------------------------------------
function cues(): void {
  const out = join(ROOT, 'public/sounds');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const wood = (f: string) => join(VCSL, 'Idiophones/Struck Idiophones/Woodblock', f);
  const map: Record<string, { file: string; shape: Shape; source: string }> = {
    click: { file: wood('wood_click_mp.wav'), shape: { maxSeconds: 0.15, levelDb: -4 }, source: 'VCSL woodblock (CC0)' },
    clickAccent: { file: join(VCSL, 'Idiophones/Struck Idiophones/Claves/Claves1_Hit_v3_rr1_Mid.wav'), shape: { maxSeconds: 0.2, levelDb: -2 }, source: 'VCSL claves (CC0)' },
    tick: { file: kenney('interface-sounds', 'click_002.ogg'), shape: { maxSeconds: 0.2, levelDb: -8 }, source: 'Kenney Interface Sounds (CC0)' },
    select: { file: kenney('interface-sounds', 'confirmation_001.ogg'), shape: { maxSeconds: 0.8, levelDb: -4 }, source: 'Kenney Interface Sounds (CC0)' },
    win: { file: kenney('music-jingles', '8-Bit jingles/jingles_NES00.ogg'), shape: { maxSeconds: 3, levelDb: -4 }, source: 'Kenney Music Jingles (CC0)' },
    fail: { file: kenney('interface-sounds', 'error_006.ogg'), shape: { maxSeconds: 1, levelDb: -4 }, source: 'Kenney Interface Sounds (CC0)' },
    record: { file: kenney('voiceover-pack', 'Female/new_highscore.ogg'), shape: { maxSeconds: 2, levelDb: -2 }, source: 'Kenney Voiceover Pack (CC0)' },
    youWin: { file: kenney('voiceover-pack', 'Female/you_win.ogg'), shape: { maxSeconds: 2, levelDb: -2 }, source: 'Kenney Voiceover Pack (CC0)' },
    zone0: { file: join(VCSL, 'Membranophones/Struck Membranophones/Bass Drum 1/BDrumNew_hit_v7_rr1_Sum.wav'), shape: { maxSeconds: 0.8 }, source: 'VCSL bass drum (CC0)' },
    zone1: { file: join(VCSL, 'Idiophones/Struck Idiophones/Glockenspiel/glock_loud_C6_01.wav'), shape: { maxSeconds: 0.8, levelDb: -3 }, source: 'VCSL glockenspiel (CC0)' },
    zone3: { file: kenney('digital-audio', 'phaserUp1.ogg'), shape: { maxSeconds: 0.6, levelDb: -3 }, source: 'Kenney Digital Audio (CC0)' },
  };
  const manifest: Record<string, string> = {};
  let bytes = 0;
  for (const [name, { file, shape: s }] of Object.entries(map)) {
    const data = wav(shape(decode(file), s));
    bytes += data.length;
    writeFileSync(join(out, `${name}.wav`), data);
    manifest[name] = `${name}.wav`;
  }
  writeFileSync(join(out, 'cues.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(out, 'SOURCES.md'),
    '# Game sounds\n\nGenerated by `tools/kit-gen/build-sample-kits.ts`. All CC0.\n\n' +
      Object.entries(map)
        .map(([n, m]) => `- \`${n}.wav\`: ${m.source} — ${basename(m.file)}`)
        .join('\n') +
      '\n',
  );
  console.log(`sounds: ${(bytes / 1e6).toFixed(2)} MB`);
}

acoustic();
fun();
cues();
