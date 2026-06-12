/**
 * Gate: the generated FM9 rosters wired into FM9_ENUM_OVERRIDES must keep their
 * validated shape — exact counts plus the hardware/documented ordinal anchors.
 * A bad regeneration (wrong cache, wrong anchor, table-merge) fails here instead
 * of silently shipping wrong model names. Runs in preflight.
 */
import { FM9_ENUM_OVERRIDES } from 'fractal-midi/gen3/fm9';

let failed = 0;
function check(label: string, cond: boolean, detail: string): void {
  if (cond) {
    console.log(`  ok    ${label}`);
  } else {
    console.error(`  FAIL  ${label} — ${detail}`);
    failed++;
  }
}

const amp = FM9_ENUM_OVERRIDES.DISTORT_TYPE;
const fuzz = FM9_ENUM_OVERRIDES.FUZZ_TYPE;
const reverb = FM9_ENUM_OVERRIDES.REVERB_TYPE;

check('amp roster count = 331', Object.keys(amp).length === 331, `got ${Object.keys(amp).length}`);
check('amp[65] = SV Bass 2', amp[65] === 'SV Bass 2', `got ${amp[65]}`);
check('amp[179] = Texas Star Clean', amp[179] === 'Texas Star Clean', `got ${amp[179]}`);
check('amp[264] = SV Bass 1', amp[264] === 'SV Bass 1', `got ${amp[264]}`);

check('drive/FUZZ roster count = 86', Object.keys(fuzz).length === 86, `got ${Object.keys(fuzz).length}`);
check('fuzz[15] = Blues OD', fuzz[15] === 'Blues OD', `got ${fuzz[15]}`);
check('fuzz[36] = Blackglass 7K', fuzz[36] === 'Blackglass 7K', `got ${fuzz[36]}`);

check('reverb roster count = 79', Object.keys(reverb).length === 79, `got ${Object.keys(reverb).length}`);
check('reverb[16] = Medium Spring', reverb[16] === 'Medium Spring', `got ${reverb[16]}`);
check('reverb[45] = Music Hall', reverb[45] === 'Music Hall', `got ${reverb[45]}`);

if (failed > 0) {
  console.error(`\nverify-fm9-rosters: ${failed} check(s) FAILED`);
  process.exit(1);
}
console.log('\nverify-fm9-rosters: all checks passed (amp 331 / drive 86 / reverb 79 wired device-true, anchors valid)');
