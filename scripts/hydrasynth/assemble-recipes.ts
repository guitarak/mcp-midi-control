/**
 * Assemble + VALIDATE curated Hydrasynth patch recipes from the
 * curation-workflow output into a committed TS table.
 *
 * The workflow (scripts -> Workflow "hydra-recipe-curation") emits raw
 * candidate recipes. This script is the validation gate between that
 * creative output and the codebase: it dry-runs every param through the
 * SAME pipeline `apply_patch` uses (findPatchOffset for buildability +
 * resolveNrpnValue for value/enum validity) and validates route names
 * against the descriptor, DROPPING anything that wouldn't apply cleanly.
 * Only genuinely-applyable recipes are emitted.
 *
 * Output: packages/core/src/protocol-generic/recipes/patchArchetype.curated.ts
 * (committed) — a typed `CURATED_HYDRA_PATCH_RECIPES` const that
 * patchArchetype.ts spreads into HYDRA_PATCH_RECIPES. Hardware-audition
 * bakes come from the OVERLAY.
 *
 * Usage: npx tsx scripts/hydrasynth/assemble-recipes.ts <recipes.json>
 * where <recipes.json> is `{recipes:[...]}` (the workflow result).
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { findPatchOffset } from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { resolveNrpnValue } from '@mcp-midi-control/hydrasynth/encoding.js';
import {
  NRPN_DISPLAY,
  lfoRateDisplayForIndex,
  reverbtimeDisplayForIndex,
} from '@mcp-midi-control/hydrasynth/nrpnDisplay.js';
import { HYDRASYNTH_DESCRIPTOR as D } from '@mcp-midi-control/hydrasynth/descriptor.js';

const LFO_RATE_SYNC_OFF_RE = /^lfo[1-5]ratesyncoff$/;

/**
 * One-time migration to display-first units. The curation workflow
 * produced legacy wire/index values; convert each to the panel reading
 * (ms / Hz / seconds) so the migrated value resolves to the identical
 * (or device-equivalent) wire. Non-display-first params pass through.
 *
 *   - env/LFO TIME params (msLookup): legacy 0..128 index → display ms.
 *   - lfo*ratesyncoff: legacy table index (0..1024) → panel Hz.
 *   - reverbtime: legacy REVERB_TIMES index (0..128) → panel seconds/ms.
 */
function migrateTimeValue(name: string, v: number | string): number | string {
  if (typeof v !== 'number') return v;
  if (name === 'reverbtime') return reverbtimeDisplayForIndex(v);
  if (LFO_RATE_SYNC_OFF_RE.test(name)) return lfoRateDisplayForIndex(v);
  const f = NRPN_DISPLAY[name];
  if (!f?.msLookup) return v;
  const oldWire = v >= 0 && v <= 128 ? v * 64 : v;
  const idx = Math.min(Math.max(Math.round(oldWire / 64), 0), f.msLookup.length - 1);
  return f.msLookup[idx]!; // display ms
}

const CATEGORIES = new Set([
  'Ambient', 'Arp', 'Bass', 'BassLead', 'Brass', 'Chord', 'Drum', 'E-piano',
  'FX', 'FxMusic', 'Keys', 'Lead', 'Organ', 'Pad', 'Perc', 'Rhythmic',
  'Sequence', 'Strings', 'Vocal',
]);
// Hand-authored seeds already in patchArchetype.ts — never overwrite.
const RESERVED = new Set([
  'sub_warmth', 'growl_wobble', 'warm_analog_pad', 'evolving_wash', 'suitcase_ep', 'brass_swell',
  'prophet5_pad', 'juno106_pad', 'obxa_jump',
]);
// Recipes removed after audition (excluded even if still present in the raw
// input). ratchet_acid_gate: the free-running LFO->Amp "gate" wasn't musical
// and a tempo-synced rework wasn't pursued — dropped 2026-05-31.
const REMOVED = new Set(['ratchet_acid_gate']);

function paramApplies(name: string, value: number | string): boolean {
  if (findPatchOffset(name) === undefined) return false;
  const entry = findHydraNrpn(name);
  if (!entry) return false;
  try { resolveNrpnValue(entry, value); return true; } catch { return false; }
}
function modNameResolves(kind: 'source' | 'target', name: string): boolean {
  const s = D.blocks['modmatrix']?.params[kind === 'source' ? '1modsource' : '1modtarget'];
  if (!s) return false;
  try { s.encode(name); return true; } catch { return false; }
}
function macroTargetResolves(macro: number, name: string): boolean {
  const s = D.blocks['macros']?.params[`macro${macro}target1`];
  if (!s) return false;
  try { s.encode(name); return true; } catch { return false; }
}

interface RawRecipe {
  name: string; category: string; description: string;
  params: Record<string, number | string>;
  mod_routes?: { source: string; target: string; depth: number }[];
  macro_routes?: { macro: number; target: string; depth: number }[];
  signature_params: Record<string, number | string>;
  tags: string[]; cultural_reference: string; source_notes: string;
}

/**
 * Hardware-audition overlay (2026-05-31). Applied on top of the workflow's
 * raw values during emission: `set` overrides/adds params (already in
 * DISPLAY units — NOT migrated again) and `drop` removes redundant keys.
 * This keeps the generator authoritative + the audition fixes reproducible.
 */
interface Overlay { set?: Record<string, number | string>; drop?: string[]; }
const OVERLAY: Record<string, Overlay> = {
  // Param bakes from the audition:
  cs80_brass_swell: { set: { lfo1ratesyncoff: '5.77 Hz' } },          // vibrato (display-first Hz; was legacy index 650, was INIT 1 Hz seasick)
  fm_soft_horn_swell: { set: { filter1cutoff: 52, amplevel: 118 }, drop: ['osc1keytrack', 'osc2keytrack'] }, // was too dark/quiet
  cp70_electric_grand: {                                              // saw->tri/sine + struck-decay rework
    set: { osc1type: 'Triangle', osc2type: 'Sine', osc2semi: 12, osc2cent: 4, filter1type: 'LP Fat 12',
           filter1cutoff: 56, filter1resonance: 14, filter1env1amount: 48, env1attacksyncoff: 0,
           env1decaysyncoff: 140, env1sustain: 0, env1releasesyncoff: 200, env2attacksyncoff: 0,
           env2decaysyncoff: 2200, env2sustain: 20, env2releasesyncoff: 320 },
    drop: ['osc1keytrack', 'osc2keytrack'] },
  glacial_drone: { set: { voicedetune: 6 } },                        // 18 caused sub-beating "helicopter"
  noise_wind_howl: { set: { mixernoisevol: 86, env2attacksyncoff: 800 } }, // noise level (post scaling fix) + quicker swell
  // Redundant osc keytrack:100 (INIT already tracks 100%) — drop:
  funk_clavinet_superstition: { drop: ['osc1keytrack', 'osc2keytrack'] },
  drawbar_gospel_b3: { drop: ['osc1keytrack', 'osc2keytrack', 'osc3keytrack'] },
  vox_continental_reed: { drop: ['osc1keytrack', 'osc2keytrack', 'osc3keytrack'] },
  fm_september_brass: { drop: ['osc1keytrack', 'osc2keytrack'] },
};

const inputPath = process.argv[2];
if (!inputPath) { console.error('usage: assemble-recipes.ts <recipes.json>'); process.exit(1); }
const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as { recipes: RawRecipe[] };

const seenNames = new Set<string>(RESERVED);
const kept: RawRecipe[] = [];
const drops: string[] = [];

for (const r of raw.recipes ?? []) {
  if (!r || typeof r.name !== 'string') { drops.push('(missing name)'); continue; }
  const name = r.name.trim();
  if (REMOVED.has(name)) { drops.push(`${name}: removed (excluded by REMOVED set)`); continue; }
  if (seenNames.has(name)) { drops.push(`${name}: duplicate/reserved name`); continue; }
  if (!CATEGORIES.has(r.category)) { drops.push(`${name}: bad category '${r.category}'`); continue; }

  // Filter params to applyable ones (migrating legacy time indices to ms first).
  const params: Record<string, number | string> = {};
  for (const [k, rawV] of Object.entries(r.params ?? {})) {
    const v = migrateTimeValue(k, rawV);
    if (paramApplies(k, v)) params[k] = v;
    else drops.push(`${name}: dropped param ${k}=${JSON.stringify(rawV)} (not buildable/invalid value)`);
  }
  // Apply the audition overlay: drop redundant keys, then set baked
  // tweaks (already DISPLAY units — not run through migrateTimeValue).
  const ov = OVERLAY[name];
  if (ov?.drop) for (const k of ov.drop) delete params[k];
  if (ov?.set) for (const [k, v] of Object.entries(ov.set)) {
    if (paramApplies(k, v)) params[k] = v;
    else drops.push(`${name}: overlay set ${k}=${JSON.stringify(v)} invalid`);
  }
  if (Object.keys(params).length < 4) { drops.push(`${name}: <4 valid params after filtering — dropped`); continue; }

  // Routes.
  const mod_routes = (r.mod_routes ?? []).filter((m) => {
    const ok = modNameResolves('source', m.source) && modNameResolves('target', m.target) && Math.abs(m.depth) <= 127;
    if (!ok) drops.push(`${name}: dropped mod_route ${m.source}->${m.target}`);
    return ok;
  });
  const macro_routes = (r.macro_routes ?? []).filter((m) => {
    const ok = Number.isInteger(m.macro) && m.macro >= 1 && m.macro <= 8 && macroTargetResolves(m.macro, m.target) && Math.abs(m.depth) <= 127;
    if (!ok) drops.push(`${name}: dropped macro_route m${m.macro}->${m.target}`);
    return ok;
  });

  // Signature ⊆ kept params (value-matched).
  const signature_params: Record<string, number | string> = {};
  for (const [k, rawV] of Object.entries(r.signature_params ?? {})) {
    const v = migrateTimeValue(k, rawV);
    if (Object.prototype.hasOwnProperty.call(params, k) && params[k] === v) signature_params[k] = v;
  }
  // Backfill signature from params if the model's picks were dropped.
  if (Object.keys(signature_params).length < 2) {
    for (const [k, v] of Object.entries(params).slice(0, 4)) signature_params[k] = v;
  }

  seenNames.add(name);
  kept.push({
    name, category: r.category, description: String(r.description ?? '').trim(),
    params, mod_routes, macro_routes, signature_params,
    tags: Array.isArray(r.tags) ? r.tags : [],
    cultural_reference: String(r.cultural_reference ?? '').trim(),
    source_notes: String(r.source_notes ?? '').trim(),
  });
}

// Emit committed TS.
const j = (v: unknown) => JSON.stringify(v);
const lines: string[] = [];
lines.push('/**');
lines.push(' * Curated Hydrasynth patch recipes (BK-074 Phase 2) — GENERATED by');
lines.push(' * scripts/hydrasynth/assemble-recipes.ts from the hydra-recipe-curation');
lines.push(' * workflow output, then VALIDATED (every param dry-run through');
lines.push(' * findPatchOffset + resolveNrpnValue; routes through the descriptor).');
lines.push(' * Do not edit by hand — re-run the assembler. Audition bakes come from');
lines.push(' * the OVERLAY in assemble-recipes.ts.');
lines.push(' */');
lines.push("import type { PatchRecipeSpec } from './patchArchetype.js';");
lines.push('');
lines.push('export const CURATED_HYDRA_PATCH_RECIPES: Readonly<Record<string, PatchRecipeSpec>> = {');
for (const r of kept) {
  lines.push(`  ${JSON.stringify(r.name)}: {`);
  lines.push(`    name: ${j(r.name)},`);
  lines.push(`    category: ${j(r.category)},`);
  lines.push(`    description: ${j(r.description)},`);
  lines.push(`    params: ${j(r.params)},`);
  if (r.mod_routes && r.mod_routes.length) lines.push(`    mod_routes: ${j(r.mod_routes)},`);
  if (r.macro_routes && r.macro_routes.length) lines.push(`    macro_routes: ${j(r.macro_routes)},`);
  if ((r.mod_routes && r.mod_routes.length) || (r.macro_routes && r.macro_routes.length)) lines.push(`    requires_nrpn: true,`);
  lines.push(`    signature_params: ${j(r.signature_params)},`);
  lines.push(`    tags: ${j(r.tags)},`);
  lines.push(`    cultural_reference: ${j(r.cultural_reference)},`);
  lines.push(`    source_notes: ${j(r.source_notes)},`);
  lines.push(`  },`);
}
lines.push('};');
lines.push('');

const outPath = 'packages/core/src/protocol-generic/recipes/patchArchetype.curated.ts';
writeFileSync(outPath, lines.join('\n'));

console.log(`Kept ${kept.length} recipes; dropped ${drops.length} items.`);
const byCat = new Map<string, number>();
for (const r of kept) byCat.set(r.category, (byCat.get(r.category) ?? 0) + 1);
console.log('By category:', [...byCat.entries()].map(([c, n]) => `${c}:${n}`).join(', '));
if (drops.length) { console.log('\nDrops:'); for (const d of drops.slice(0, 60)) console.log('  -', d); }
console.log(`\nWrote ${outPath}`);
