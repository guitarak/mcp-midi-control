/**
 * Gen-3 enum-flow: a param the device's editor cache marks `kind:'enum'`
 * (with an enumCount) MUST route as a DISCRETE wire write (sub 09 00,
 * float32(ordinal)) even when no name vocabulary has been correlated for it
 * yet. Before this flowed into the catalog builder, any enum the AM4/XML/roster
 * overlay missed fell through to the CONTINUOUS float wire (sub 52 00), so the
 * device stored the wrong ordinal — caught catalog-wide by the FM9 full
 * SET→GET roundtrip hardware sweep (2026-06-18, ~hundreds of type/mode
 * selectors). The cache `kind` is typecode-derived (authoritative) and FM9 is
 * the device whose roundtrip validates the direction, so this gates on FM9.
 *
 * Guards:
 *   - cache-enum params (DELAY_MODEL, PITCH_TYPE, DISTORT_DRIVETYPE, ...) route
 *     discrete with a bounded numeric-ordinal encode and an 'enum' unit;
 *   - the ordinal encode refuses out-of-range ordinals and refuses names
 *     (no vocab to resolve against);
 *   - a genuine continuous knob (reverb.mix) stays continuous;
 *   - the III (no deviceRanges table) is UNAFFECTED — its enum routing is
 *     unchanged, so the byte-identity anchor cannot drift from this change.
 */
import { createModernCatalog } from '../packages/fractal-gen3/dist/catalog.js';
import {
  AXE_FX_III_BLOCKS,
  resolveEffectId,
} from '../packages/fractal-midi/dist/gen3/axe-fx-iii/index.js';
import {
  FM9_PARAMS_BY_FAMILY,
  FM9_RANGES,
} from '../packages/fractal-midi/dist/gen3/fm9/index.js';
import { PARAMS_BY_FAMILY as III_PARAMS_BY_FAMILY } from '../packages/fractal-midi/dist/gen3/axe-fx-iii/index.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) ok += 1;
  else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

console.log('Gen-3 enum-flow (device-cache kind:enum → discrete wire):');

const fm9 = createModernCatalog({
  blocks: AXE_FX_III_BLOCKS,
  paramsByFamily: FM9_PARAMS_BY_FAMILY,
  resolveEffectId,
  dropEmptyMappedBlocks: true,
  deviceRanges: FM9_RANGES,
});

// ── Cache-enum params route discrete ───────────────────────────────
// Each of these is kind:'enum' in FM9_RANGES with no overlay name table, so
// pre-fix they fell through to continuous. (block slug, param key, enumCount).
const ENUM_CASES: ReadonlyArray<[string, string, number]> = [
  ['delay', 'model', 29],
  ['pitch', 'type', 16],
  ['amp', 'drivetype', 8],
  ['amp', 'fbtype', 69],
  ['phaser', 'mode', 3],
];
for (const [slug, key, count] of ENUM_CASES) {
  const s = fm9.blocks[slug]?.params[key];
  check(`fm9 ${slug}.${key} present`, s !== undefined);
  if (s === undefined) continue;
  check(`fm9 ${slug}.${key} routes DISCRETE`, s.wire_kind === 'discrete', `wire_kind=${s.wire_kind}`);
  check(`fm9 ${slug}.${key} reports unit 'enum'`, s.unit === 'enum', `unit=${s.unit}`);
  check(`fm9 ${slug}.${key} marked enum_partial (numeric ordinals)`, s.enum_partial === true);
  // bounded numeric-ordinal encode
  check(`fm9 ${slug}.${key} accepts ordinal 0`, fm9.encodeParamOrThrow(slug, key, 0, 'FM9') === 0);
  check(`fm9 ${slug}.${key} accepts top ordinal ${count - 1}`, fm9.encodeParamOrThrow(slug, key, count - 1, 'FM9') === count - 1);
  let refusedHigh = false;
  try {
    fm9.encodeParamOrThrow(slug, key, count, 'FM9');
  } catch {
    refusedHigh = true;
  }
  check(`fm9 ${slug}.${key} refuses out-of-range ordinal ${count}`, refusedHigh);
  let refusedName = false;
  try {
    fm9.encodeParamOrThrow(slug, key, 'SomeName', 'FM9');
  } catch {
    refusedName = true;
  }
  check(`fm9 ${slug}.${key} refuses a name (no vocab yet)`, refusedName);
}

// ── A genuine continuous knob stays continuous ─────────────────────
const mix = fm9.blocks['reverb']?.params['mix'];
check('fm9 reverb.mix stays CONTINUOUS', mix?.wire_kind === 'continuous', `wire_kind=${mix?.wire_kind}`);

// ── Net effect: many params flip, all of them cache-enum ────────────
const withRanges = (() => {
  let d = 0;
  for (const b of Object.values(fm9.blocks)) for (const s of Object.values(b.params)) if (s.wire_kind === 'discrete') d += 1;
  return d;
})();
const overlayOnly = createModernCatalog({
  blocks: AXE_FX_III_BLOCKS,
  paramsByFamily: FM9_PARAMS_BY_FAMILY,
  resolveEffectId,
  dropEmptyMappedBlocks: true,
  // no deviceRanges → simulates the pre-fix overlay-only routing
});
let overlayDiscrete = 0;
for (const b of Object.values(overlayOnly.blocks)) for (const s of Object.values(b.params)) if (s.wire_kind === 'discrete') overlayDiscrete += 1;
check('fm9 enum-flow flips a substantial set to discrete', withRanges - overlayDiscrete > 100, `flipped ${withRanges - overlayDiscrete}`);

// ── III is unaffected (no deviceRanges) ────────────────────────────
const iii = createModernCatalog({
  blocks: AXE_FX_III_BLOCKS,
  paramsByFamily: III_PARAMS_BY_FAMILY,
  resolveEffectId,
  // III passes NO deviceRanges — byte-identity anchor, must not change.
});
// reverb.mix on III: continuous, exactly as before.
check('iii reverb.mix unaffected (continuous)', iii.blocks['reverb']?.params['mix']?.wire_kind === 'continuous');

console.log(`gen3-enum-flow: ${ok} ok, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
