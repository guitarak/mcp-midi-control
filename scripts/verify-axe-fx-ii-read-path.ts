/**
 * IN-GATE read-path display-value oracle for the Axe-Fx II amp block.
 *
 * The II analog of verify-msg.ts's AM4 display goldens. The pre-ship gate
 * historically had ZERO gated wire->display assertions for the II, which
 * is exactly how the get_preset raw-opaque-decode bug (#4, alpha.4 AND
 * alpha.15) walked through: the deep amp params had no calibration, so
 * the resolver produced no decodeWire and the reader fell back to the raw
 * wire integer. Display-units / calibration goldens only cover params
 * that ARE in the calibration table; an UNcalibrated param simply is not
 * in the table, so its absence is invisible to them.
 *
 * This oracle guards both failure modes against regression:
 *   1. Coverage: every amp deep param in the committed fixture MUST
 *      resolve with a decodeWire closure (a future revert that strips the
 *      calibration overlay fails the gate, not a Desktop session).
 *   2. Correctness: replaying the recorded (wire -> device-rendered
 *      label) samples through the shared resolver must reproduce the
 *      device's own numeric label within tolerance.
 *
 * Fixture: scripts/fixtures/ii-amp-readpath.json, recorded fn=0x02
 * samples from the 2026-05-29 hardware sweep (committed; the raw sweep
 * under samples/ is gitignored and cannot gate).
 *
 * Run: npx tsx scripts/verify-axe-fx-ii-read-path.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAxeFxIIParamKind } from '@mcp-midi-control/fractal-gen2/calibration.js';

interface Sample { wire: number; display: number; label: string }
interface FixtureParam { block: string; name: string; samples: Sample[] }
interface Fixture { params: FixtureParam[] }

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}${detail ? `: ${detail}` : ''}`);
  }
}

function labelNum(s: string): number | undefined {
  const m = /^(-?\d+(?:\.\d+)?)/.exec(String(s).trim());
  return m ? Number(m[1]) : undefined;
}

// Each fixture is a committed device sweep for one block family. The raw
// sweeps under samples/ are gitignored and cannot gate; these are the
// committed, display-redacted (wire -> device label) records.
const FIXTURES: Array<{ file: string; label: string; minParams: number }> = [
  { file: 'ii-amp-readpath.json', label: 'amp', minParams: 60 },
  { file: 'ii-cab-readpath.json', label: 'cab', minParams: 18 },
];

let totalSamples = 0;
let okSamples = 0;
for (const fx of FIXTURES) {
  const fixturePath = path.resolve(process.cwd(), 'scripts', 'fixtures', fx.file);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture;
  console.log(`\nAxe-Fx II read-path oracle [${fx.label}]: ${fixture.params.length} params from committed device fixture`);

  check(
    `${fx.label} fixture is non-empty (would catch a corrupted/missing fixture)`,
    fixture.params.length >= fx.minParams,
    `only ${fixture.params.length} params (want >= ${fx.minParams})`,
  );

  for (const p of fixture.params) {
    const kind = resolveAxeFxIIParamKind(p.block, p.name);
    // (1) Coverage: a calibratable deep param MUST have a decodeWire. This is
    // the guard against a calibration-overlay revert (the #4 bug class).
    if (kind?.decodeWire === undefined) {
      check(`${p.block}.${p.name} resolves with decodeWire (calibration present)`, false,
        'no decodeWire: calibration overlay missing/reverted; get_preset would return RAW wire');
      continue;
    }
    // (2) Correctness: each recorded (wire -> device label) reproduces.
    let paramOk = true;
    for (const s of p.samples) {
      const decoded = kind.decodeWire(s.wire);
      const dec = typeof decoded === 'number' ? decoded : labelNum(String(decoded));
      totalSamples++;
      if (dec === undefined) { paramOk = false; continue; }
      const tol = Math.max(Math.abs(s.display) * 0.02, 0.05);
      if (Math.abs(dec - s.display) <= tol) okSamples++;
      else {
        paramOk = false;
        console.error(`        ${p.name}: wire ${s.wire} device="${s.label}" decoded=${dec} (Δ ${(dec - s.display).toFixed(3)})`);
      }
    }
    check(`${p.block}.${p.name} decodes ${p.samples.length} device samples to display`, paramOk);
  }
}

console.log(`\n${okSamples}/${totalSamples} sample round-trips within tolerance.`);
if (failures > 0) {
  console.error(`\n✗ Axe-Fx II read-path oracle: ${failures} failure(s).`);
  process.exit(1);
}
console.log('\n✓ Axe-Fx II read-path: every amp deep param decodes to a display value (not raw wire).');
