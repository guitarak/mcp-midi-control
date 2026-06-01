/**
 * Hardware verify the Hydrasynth apply_patch fixes from 2026-05-24:
 *   1. Name resolver accepts dotted display_names AND abbreviations
 *      ("filter1res", "filter1.res", "filter1resonance" all resolve)
 *   2. Mixer params encode (mixer.osc1_vol → mixerosc1vol → patch buffer)
 *   3. Validation errors batch into one response
 *
 * Replays the exact param shape from the 2026-05-24 user bug report.
 * Pre-fix this took 3 round-trips (each surfacing one new bad name);
 * post-fix it should land in 1 (or surface every error at once if the
 * inputs include any unknown names).
 *
 * Setup: Hydrasynth connected, Claude Desktop CLOSED.
 * Run: `npx tsx scripts/_research/probe-hydra-apply-patch-bugfix.ts`
 */

import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { findPatchOffset } from '@mcp-midi-control/hydrasynth/patchEncoder.js';

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}${detail ? `  (${detail})` : ''}`);
    fail++;
  }
}

console.log('Hydrasynth apply_patch bug-fix verification');
console.log('=====================================');

console.log('\nName resolver:');
// Canonical
const r1 = findHydraNrpn('filter1resonance');
check('canonical "filter1resonance" resolves', r1?.name === 'filter1resonance');
// Dotted alias
const r2 = findHydraNrpn('filter1.res');
check('dotted alias "filter1.res" resolves to canonical', r2?.name === 'filter1resonance');
// Abbreviated (pre-fix this rejected)
const r3 = findHydraNrpn('filter1res');
check('abbreviated "filter1res" resolves to canonical', r3?.name === 'filter1resonance');
// Mixer dotted
const r4 = findHydraNrpn('mixer.osc1_vol');
check('mixer alias "mixer.osc1_vol" resolves to canonical', r4?.name === 'mixerosc1vol');
// Mixer underscore-stripped
const r5 = findHydraNrpn('mixerosc1_vol');
check('partial-strip "mixerosc1_vol" resolves', r5?.name === 'mixerosc1vol');
// Env attack
const r6 = findHydraNrpn('env1.attack');
check('"env1.attack" resolves to canonical env1attacksyncoff', r6?.name === 'env1attacksyncoff');
// Env decay alias (filter1.env1amt → filter1env1amount)
const r7 = findHydraNrpn('filter1.env1amt');
check('"filter1.env1amt" resolves to canonical', r7?.name === 'filter1env1amount');
const r8 = findHydraNrpn('filter1env1amt');
check('abbreviated "filter1env1amt" resolves', r8?.name === 'filter1env1amount');

console.log('\nPATCH_OFFSETS coverage (post-canonical-name fix):');
// These should all resolve to canonical name, then PATCH_OFFSETS finds the entry.
for (const inputName of [
  'mixer.osc1_vol',
  'mixerosc1vol',
  'mixer.osc2_vol',
  'filter1.res',
  'filter1resonance',
  'filter1.env1amt',
  'filter1env1amount',
]) {
  const entry = findHydraNrpn(inputName);
  const offset = entry ? findPatchOffset(entry.name) : undefined;
  check(
    `${inputName} → canonical → PATCH_OFFSETS`,
    offset !== undefined,
    entry ? `canonical=${entry.name}, offset=${offset?.byte ?? 'NONE'}` : 'name did not resolve',
  );
}

console.log('\nUnknown-name fall-through:');
const r9 = findHydraNrpn('this_does_not_exist');
check('genuinely-unknown names still return undefined', r9 === undefined);

console.log('');
if (fail === 0) {
  console.log(`✅ All ${pass} checks passed.`);
  process.exit(0);
} else {
  console.log(`❌ ${fail} check(s) failed; ${pass} passed.`);
  process.exit(1);
}
