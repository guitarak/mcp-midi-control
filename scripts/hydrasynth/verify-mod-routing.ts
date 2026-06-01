/**
 * Golden test for the Hydrasynth mod-matrix + macro routing layer.
 *
 * Run: npx tsx scripts/hydrasynth/verify-mod-routing.ts
 *
 * Covers the four-layer chain that makes set_mod_route / set_macro_route and
 * name-resolved modmatrix/macro params work:
 *   1. modRouting.ts        - name<->wire tables (generated from edisyn).
 *   2. encoding.ts          - resolveNrpnValue routes mod fields to the
 *                             value-table / bipolar-depth encoders.
 *   3. descriptor/schema.ts - modmatrix + macro params surface as name-backed
 *                             enums / bipolar with correct decode.
 *   4. modRouteState.ts     - slot allocation (alloc / reuse / explicit /
 *                             full / per-port + per-macro isolation).
 *
 * Exits non-zero on the first failed group so it gates CI alongside the
 * other scripts/hydrasynth/verify-*.ts goldens.
 */
import {
  MOD_SOURCE_BY_WIRE, MOD_DEST_BY_WIRE, MOD_SOURCE_NAMES, MOD_DEST_NAMES,
  resolveModSource, resolveModDest,
} from '../../packages/hydrasynth/src/modRouting.js';
import { findHydraNrpn } from '../../packages/hydrasynth/src/nrpn.js';
import { resolveNrpnValue } from '../../packages/hydrasynth/src/encoding.js';
import { HYDRASYNTH_DESCRIPTOR } from '../../packages/hydrasynth/src/descriptor.js';
import {
  allocateSlot, modMatrixNamespace, macroNamespace, resetModRouteState,
} from '../../packages/core/src/protocol-generic/dispatcher/modRouteState.js';

let failures = 0;
let checks = 0;
function expect(label: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    console.error(`FAIL ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    failures++;
  } else {
    checks++;
  }
}

// ── 1. Name<->wire tables (byte-verified vs ASMHydrasynth.java) ──────
expect('table src lengths match', MOD_SOURCE_NAMES.length, 163);
expect('table dest lengths match', MOD_DEST_NAMES.length, 330);
expect('src Env 1 wire', resolveModSource('Env 1')?.wire, 0x01 * 128 + 0x01); // 129
expect('src Env 2 wire', resolveModSource('Env 2')?.wire, 130);
expect('src LFO 1 wire', resolveModSource('LFO 1')?.wire, 0x01 * 128 + 0x06);
expect('src Mod Wheel wire', resolveModSource('Mod Wheel')?.wire, 0x01 * 128 + 0x18);
expect('src loose match', resolveModSource('env2')?.label, 'Env 2');
expect('src unknown -> undefined', resolveModSource('nonsense'), undefined);
expect('dest Osc 1 Pitch wire', resolveModDest('Osc 1 Pitch')?.wire, 0x04 * 128 + 0x01); // 513
expect('dest Filt 1 Cutoff wire', resolveModDest('Filt 1 Cutoff')?.wire, 0x02 * 128 + 0x28);
expect('dest Mut 1 Depth wire', resolveModDest('Mut 1 Depth')?.wire, 0x02 * 128 + 0x1f);
expect('dest Amp Level wire', resolveModDest('Amp Level')?.wire, 0x02 * 128 + 0x02);
// Wire keys may collapse the documented Sustain==CC64 source alias (<=1).
expect('src wire-key collisions <= 1', MOD_SOURCE_NAMES.length - Object.keys(MOD_SOURCE_BY_WIRE).length <= 1, true);
expect('dest wire-key collisions == 0', MOD_DEST_NAMES.length - Object.keys(MOD_DEST_BY_WIRE).length, 0);

// ── 1b. Friendly-name alias layer (aliasNorm) ───────────────────────
// The synonyms an agent or recipe author naturally reaches for must resolve
// to the device's exact label so the wire value is right.
expect('alias src Velocity', resolveModSource('Velocity')?.label, 'Note-On Vel');
expect('alias dest Filter Cutoff', resolveModDest('Filter Cutoff')?.label, 'Filt 1 Cutoff');
expect('alias dest Filter 1 Resonance', resolveModDest('Filter 1 Resonance')?.label, 'Filt 1 Resonance');
expect('alias dest Reverb Mix', resolveModDest('Reverb Mix')?.label, 'Reverb Dry/Wet');
expect('alias dest Mutator 1 Depth', resolveModDest('Mutator 1 Depth')?.label, 'Mut 1 Depth');
expect('exact label still wins', resolveModDest('Filt 1 Cutoff')?.label, 'Filt 1 Cutoff');
expect('genuinely-unknown undefined', resolveModDest('Exciter Burst'), undefined);
// Aftertouch / polytouch synonyms ("pressing harder changes the sound").
expect('alias src polytouch', resolveModSource('polytouch')?.label, 'Poly Aftertouch');
expect('alias src pressure', resolveModSource('pressure')?.label, 'Poly Aftertouch');
expect('alias src aftertouch', resolveModSource('aftertouch')?.label, 'Poly Aftertouch');
expect('alias src key pressure', resolveModSource('key pressure')?.label, 'Poly Aftertouch');
expect('alias src channel aftertouch', resolveModSource('channel aftertouch')?.label, 'Chan Aftertouch');
expect('exact Poly Aftertouch resolves', resolveModSource('Poly Aftertouch')?.label, 'Poly Aftertouch');

// ── 2. encoding.ts routes mod fields correctly ──────────────────────
function encWire(name: string, input: number | string): number {
  const e = findHydraNrpn(name);
  if (!e) throw new Error(`verify-mod-routing: no NRPN entry for ${name}`);
  return resolveNrpnValue(e, input).wire;
}
expect('enc modsource by name', encWire('modmatrix1modsource', 'Env 1'), 129);
expect('enc modsource loose', encWire('modmatrix5modsource', 'env2'), 130);
expect('enc modtarget by name', encWire('modmatrix1modtarget', 'Filt 1 Cutoff'), 0x02 * 128 + 0x28);
expect('enc modtarget mut depth', encWire('modmatrix7modtarget', 'Mut 1 Depth'), 0x02 * 128 + 0x1f);
expect('enc macro target by name', encWire('macro1target1', 'Filt 1 Cutoff'), 0x02 * 128 + 0x28);
expect('enc mod depth 0 -> center', encWire('modmatrix1depth', 0), 4096);
expect('enc mod depth +128 -> max', encWire('modmatrix1depth', 128), 8192);
expect('enc mod depth -128 -> 0', encWire('modmatrix1depth', -128), 0);
expect('enc mod depth +64', encWire('modmatrix1depth', 64), 6144);
expect('enc macro depth 0 -> center', encWire('macro1depth1', 0), 4096);
expect('enc modsource numeric passthrough', encWire('modmatrix1modsource', 129), 129);
expect('enc plain knob unaffected', encWire('filter1cutoff', 64), 4096);
// reject paths
let rejected = 0;
try { encWire('modmatrix1modsource', 'NoSuchSource'); } catch { rejected++; }
try { encWire('modmatrix1depth', 999); } catch { rejected++; }
expect('enc rejects bad source + OOR depth', rejected, 2);

// ── 3. descriptor surfaces mod params as name-backed enums ──────────
const blocks = HYDRASYNTH_DESCRIPTOR.blocks;
const mm = blocks['modmatrix'];
expect('modmatrix block registered', mm !== undefined, true);
expect('modsource unit', mm?.params['1modsource']?.unit, 'enum');
expect('modsource decode', mm?.params['1modsource']?.decode(129), 'Env 1');
expect('modsource encode', mm?.params['1modsource']?.encode('Env 2'), 130);
expect('modtarget decode', mm?.params['1modtarget']?.decode(513), 'Osc 1 Pitch');
expect('depth unit', mm?.params['1depth']?.unit, 'bipolar');
expect('depth encode 0', mm?.params['1depth']?.encode(0), 4096);
expect('depth decode max', mm?.params['1depth']?.decode(8192), 128);
const macros = blocks['macros'];
expect('macro target registered', macros?.params['macro1target1'] !== undefined, true);
expect('macro target decode', macros?.params['macro1target1']?.decode(0x02 * 128 + 0x28), 'Filt 1 Cutoff');
expect('macro target encode', macros?.params['macro1target1']?.encode('Filt 1 Cutoff'), 0x02 * 128 + 0x28);
expect('macro depth registered', macros?.params['macro1depth1'] !== undefined, true);
// descriptor advertises the routing capabilities
expect('cap has_mod_matrix', HYDRASYNTH_DESCRIPTOR.capabilities.has_mod_matrix, true);
expect('cap mod_matrix_slots', HYDRASYNTH_DESCRIPTOR.capabilities.mod_matrix_slots, 32);
expect('cap has_macro_routing', HYDRASYNTH_DESCRIPTOR.capabilities.has_macro_routing, true);

// ── 4. slot allocation ──────────────────────────────────────────────
resetModRouteState();
const ns = modMatrixNamespace('hydrasynth');
expect('alloc1', allocateSlot(ns, 'a', 32).slot, 1);
expect('alloc2', allocateSlot(ns, 'b', 32).slot, 2);
const reuse = allocateSlot(ns, 'a', 32);
expect('reuse slot', reuse.slot, 1);
expect('reuse flag', reuse.reused, true);
expect('alloc3 fills gap', allocateSlot(ns, 'c', 32).slot, 3);
expect('explicit honored', allocateSlot(ns, 'x', 32, 10).slot, 10);
let allocThrew = 0;
try { allocateSlot(ns, 'y', 32, 99); } catch { allocThrew++; }
expect('explicit OOR throws', allocThrew, 1);
// per-macro isolation
resetModRouteState('hydrasynth');
expect('macro1 slot1', allocateSlot(macroNamespace('hydrasynth', 1), 'd', 8).slot, 1);
expect('macro2 independent', allocateSlot(macroNamespace('hydrasynth', 2), 'd', 8).slot, 1);
// full matrix throws
resetModRouteState();
const full = modMatrixNamespace('full');
for (let i = 0; i < 4; i++) allocateSlot(full, `k${i}`, 4);
let fullThrew = 0;
try { allocateSlot(full, 'overflow', 4); } catch { fullThrew++; }
expect('full matrix throws', fullThrew, 1);
// per-port reset isolation
resetModRouteState();
allocateSlot(modMatrixNamespace('a'), 'k', 32);
allocateSlot(modMatrixNamespace('b'), 'k', 32);
resetModRouteState('a');
expect('reset a frees a', allocateSlot(modMatrixNamespace('a'), 'k2', 32).slot, 1);
expect('reset a keeps b', allocateSlot(modMatrixNamespace('b'), 'k2', 32).slot, 2);

console.log(`\nverify-mod-routing: ${checks} checks passed`);
if (failures > 0) {
  console.error(`verify-mod-routing: ${failures} FAILURES`);
  process.exit(1);
}
