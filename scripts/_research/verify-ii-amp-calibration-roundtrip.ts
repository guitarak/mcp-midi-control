/**
 * Verify the hardware-swept amp calibration overlays against the raw
 * sweep: for every (wire -> device-label) pair captured by the sweep,
 * decode the wire through the live resolver and confirm it reproduces
 * the device's own numeric label (within tolerance). This is the
 * strongest offline proof the overlays are correct: it round-trips the
 * actual device readings, no hardware needed.
 *
 * Run: npx tsx scripts/_research/verify-ii-amp-calibration-roundtrip.ts
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { resolveAxeFxIIParamKind } from '../../packages/axe-fx-ii/src/calibration.js';

interface Sample { setWire: number; echoedWire: number; label: string }
interface ParamSweep { paramId: number; name: string; controlType: string; originalWire: number; samples: Sample[] }
interface SweepFile { params: ParamSweep[] }

function labelNum(label: string): number | undefined {
  const m = /^(-?\d+(?:\.\d+)?)/.exec(label.trim());
  return m ? Number(m[1]) : undefined;
}

const root = process.cwd();
const sweep = JSON.parse(
  readFileSync(path.resolve(root, 'samples', 'captured', 'decoded', 'ii-opaque-amp-sweep.json'), 'utf8'),
) as SweepFile;

let checked = 0;
let pass = 0;
const fails: string[] = [];
const noCal: string[] = [];

for (const p of sweep.params) {
  const kind = resolveAxeFxIIParamKind('amp', p.name);
  if (kind?.decodeWire === undefined) {
    noCal.push(p.name);
    continue;
  }
  for (const s of p.samples) {
    const expected = labelNum(s.label);
    if (expected === undefined) continue; // enum/special label point, skip numeric check
    const decoded = kind.decodeWire(s.echoedWire);
    const dec = typeof decoded === 'number' ? decoded : labelNum(String(decoded));
    if (dec === undefined) continue;
    checked++;
    // Tolerance: 2% of |expected| or 0.05 absolute (covers small ratios),
    // plus a small floor for log-scale rounding at the extremes.
    const tol = Math.max(Math.abs(expected) * 0.02, 0.05);
    if (Math.abs(dec - expected) <= tol) {
      pass++;
    } else {
      fails.push(`${p.name}: wire ${s.echoedWire} device="${s.label}" decoded=${dec} (Δ ${(dec - expected).toFixed(3)})`);
    }
  }
}

console.log(`Round-trip checks: ${pass}/${checked} within tolerance`);
console.log(`Params with no decodeWire (enum/stuck, expected): ${noCal.length}: ${noCal.join(', ')}`);
if (fails.length > 0) {
  console.log(`\nMISMATCHES (${fails.length}):`);
  for (const f of fails) console.log(`  ${f}`);
  process.exit(1);
} else {
  console.log('\nALL hardware-swept overlays reproduce the device labels. ✓');
}
