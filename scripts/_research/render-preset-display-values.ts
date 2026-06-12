/**
 * render-preset-display-values.ts (research proof, NOT shipped wiring)
 *
 * Question: can the gen-3 preset BODY's raw u16 param words be rendered as
 * device-true DISPLAY values by joining them to the FM9 cache-derived ranges
 * (packages/fractal-midi/src/gen3/fm9/ranges.generated.ts)?
 *
 * Method, on one real FM9 factory-style export
 * (samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx):
 *
 *   1. Decode the preset body (presetBody.ts, cross-validated on 384 factory
 *      presets + this FM9 export against the reference decoder).
 *   2. Derive the body-word <-> paramId join from the decoder's own
 *      type-location rule: FM9 puts a block's TYPE id at per-channel param
 *      word 4, and the cache/catalog says TYPE is paramId 10 for amp/reverb
 *      (11 for delay is the TYPE enum; 10 is its MODEL slot), so
 *      word = paramId - 6 for amp/reverb blocks.
 *   3. VALIDATE the join + value mapping where independent ground truth
 *      exists: the reference decoder's amp knobs (drive/bass/mid/treble/
 *      master/depth/sag/presence) are display values computed raw/65535*10;
 *      our render display = displayMin + (raw/65535) * (displayMax -
 *      displayMin) over the cache range (0..10 for those knobs) must agree
 *      EXACTLY for all 4 channels. The amp TYPE word must also resolve to the
 *      same model name through the 331-entry device-true roster.
 *   4. Apply the validated mapping to REVERB and DELAY words and report the
 *      rendered display values, checking (a) every value lands inside its
 *      device-true range (it must, by construction; flagged anyway) and
 *      (b) enum words resolve to legal ordinals.
 *
 * The value-mapping hypothesis is the Finding-1 line (FINDINGS.md, FM9
 * community capture): the wire normalized float for REVERB_TIME fits
 * sec = 99.897*norm + 0.102, i.e. display = displayMin + norm*(displayMax -
 * displayMin) with norm = raw/65535 linear-in-range. This script tests that
 * same line against the stored-preset words.
 *
 * Run: npx tsx scripts/_research/render-preset-display-values.ts [path-to.syx]
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePresetDump } from '../../packages/fractal-gen3/src/presetDump.js';
import { decodeRawPatch } from '../../packages/fractal-gen3/src/presetHuffman.js';
import { decodeGen3Body, getProfile, type Gen3Block } from '../../packages/fractal-gen3/src/presetBody.js';
import { FM9_RANGES, type Fm9ParamRange } from '../../packages/fractal-midi/src/gen3/fm9/ranges.generated.js';
import { FM9_PARAMS_BY_FAMILY } from '../../packages/fractal-midi/src/gen3/fm9/params.js';
import { FM9_ENUM_OVERRIDES } from '../../packages/fractal-midi/src/gen3/fm9/enumOverrides.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '../..');
const SYX = process.argv[2]
  ?? resolve(root, 'samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx');

/** Body per-channel param word index = paramId + WORD_SHIFT (FM9 blocks whose
 *  TYPE is at word 4 while TYPE is paramId 10: amp/DISTORT, reverb, delay). */
const WORD_SHIFT = -6;

const CHANNELS = ['A', 'B', 'C', 'D'] as const;

let failed = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) console.log(`  ok    ${label}`);
  else {
    console.error(`  FAIL  ${label} (${detail})`);
    failed++;
  }
}

function u16(data: Uint8Array, off: number): number {
  return ((data[off] ?? 0) | ((data[off + 1] ?? 0) << 8)) & 0xffff;
}

function wordAt(body: Uint8Array, block: Gen3Block, channel: number, paramId: number): number | undefined {
  const w = paramId + WORD_SHIFT;
  if (w < 0 || w >= block.cols) return undefined;
  return u16(body, block.params_offset + channel * block.cols * 2 + w * 2);
}

/** The mapping under test: display = displayMin + (raw/65535)*(displayMax-displayMin). */
function renderFloat(raw: number, range: Fm9ParamRange): number {
  return range.displayMin + (raw / 65535) * (range.displayMax - range.displayMin);
}

function paramName(family: string, id: number): string {
  return FM9_PARAMS_BY_FAMILY[family]?.find((p) => p.paramId === id)?.name ?? `${family}[${id}]`;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Decode the export
// ---------------------------------------------------------------------------
const bytes = new Uint8Array(readFileSync(SYX));
const parsed = parsePresetDump(bytes, 0, undefined);
const decoded = decodeRawPatch(parsed.chunkPayloads);
const body = decodeGen3Body(decoded.body, parsed.modelId);
const profile = getProfile(parsed.modelId);
console.log(`preset: model=0x${parsed.modelId.toString(16)} (${profile.name})  crc_valid=${decoded.crcValid}`);
check('model is FM9 (ranges are FM9-true)', parsed.modelId === 0x12, `got 0x${parsed.modelId.toString(16)}`);
check('raw-patch CRC valid (self-validating decode)', decoded.crcValid, 'CRC mismatch');

const blocks = body.blocks ?? [];
const amp = blocks.find((b) => b.block === 'Amp');
const reverb = blocks.find((b) => b.block === 'Reverb');
const delay = blocks.find((b) => b.block === 'Delay');

// ---------------------------------------------------------------------------
// Step 1: VALIDATE the join + mapping on the amp block (independent oracle:
// the reference decoder's cross-validated knob extraction, raw/65535*10).
// ---------------------------------------------------------------------------
console.log('\n[1] amp (DISTORT) knobs: cache-range render vs reference-decoder values');
if (!amp?.channels) {
  check('Amp block with channels present', false, 'no amp block decoded');
} else {
  // knob name in the reference decoder -> catalog paramId (DISTORT family)
  const KNOBS: Record<string, number> = {
    drive: 11, // DISTORT_DRIVE
    bass: 12, // DISTORT_BASS
    mid: 13, // DISTORT_MID
    treble: 14, // DISTORT_TREBLE
    master_volume: 15, // DISTORT_MASTER
    depth: 26, // DISTORT_DEPTH
    sag: 29, // DISTORT_SUPPLYSAG
    presence: 30, // DISTORT_PRESENCE
  };
  const dist = FM9_RANGES.DISTORT;
  for (const [ch, chData] of Object.entries(amp.channels)) {
    const chIdx = CHANNELS.indexOf(ch as (typeof CHANNELS)[number]);
    // TYPE: body word 4 (paramId 10 + shift) -> 331-entry device-true roster
    const typeRaw = wordAt(decoded.body, amp, chIdx, 10)!;
    const rosterName = FM9_ENUM_OVERRIDES.DISTORT_TYPE[typeRaw];
    check(
      `ch ${ch} amp type word(paramId 10${WORD_SHIFT}) = ordinal ${typeRaw} "${rosterName}" matches decoder "${chData.type ?? chData.type_id}"`,
      typeRaw === chData.type_id,
      `word gives ${typeRaw}, decoder type_id ${chData.type_id}`
    );
    for (const [knob, pid] of Object.entries(KNOBS)) {
      const raw = wordAt(decoded.body, amp, chIdx, pid);
      const range = dist[pid];
      const ref = chData[knob];
      if (raw === undefined || !range || typeof ref !== 'number') {
        check(`ch ${ch} ${knob}`, false, `raw=${raw} range=${!!range} ref=${ref}`);
        continue;
      }
      const rendered = round2(renderFloat(raw, range));
      check(
        `ch ${ch} ${paramName('DISTORT', pid)} render=${rendered} ref=${ref}`,
        Math.abs(rendered - ref) < 0.005 + 1e-9,
        `raw=${raw} range=[${range.displayMin}..${range.displayMax}]`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step 2: apply the validated mapping to REVERB and DELAY (channel A) and
// report display-true values; assert in-range + legal enum ordinals.
// ---------------------------------------------------------------------------
function renderBlock(label: string, family: string, block: Gen3Block | undefined, ids: number[]): void {
  console.log(`\n[2] ${label} channel A: display-true render from cache ranges`);
  if (!block) {
    console.log(`  (no ${label} block in this preset)`);
    return;
  }
  const fam = FM9_RANGES[family];
  for (const id of ids) {
    const range = fam[id];
    const raw = wordAt(decoded.body, block, 0, id);
    if (!range || raw === undefined) {
      console.log(`  ${paramName(family, id).padEnd(22)} (no range/word)`);
      continue;
    }
    if (range.kind === 'enum') {
      const legal = raw < (range.enumCount ?? 0);
      const roster =
        family === 'REVERB' && id === 10 ? FM9_ENUM_OVERRIDES.REVERB_TYPE[raw] : undefined;
      check(
        `${paramName(family, id)} raw=${raw} is a legal ordinal (< ${range.enumCount})${roster ? ` = "${roster}"` : ''}`,
        legal,
        `enumCount=${range.enumCount}`
      );
    } else {
      const v = renderFloat(raw, range);
      check(
        `${paramName(family, id).padEnd(22)} raw=${String(raw).padStart(5)} -> ${round2(v)} (range ${range.displayMin}..${range.displayMax})`,
        v >= range.displayMin - 1e-6 && v <= range.displayMax + 1e-6,
        'out of device-true range'
      );
    }
  }
}

renderBlock('Reverb', 'REVERB', reverb, [10, 11, 12, 14, 15, 19, 20, 21, 22]);
renderBlock('Delay', 'DELAY', delay, [11, 12, 13, 14, 20, 21]);

// ---------------------------------------------------------------------------
console.log('');
if (failed > 0) {
  console.error(`render-preset-display-values: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('render-preset-display-values: mapping validated (display = displayMin + raw/65535 * (displayMax - displayMin), word = paramId - 6)');
