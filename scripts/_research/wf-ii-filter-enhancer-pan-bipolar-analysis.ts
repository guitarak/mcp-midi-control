/**
 * OFFLINE analysis (read-only, no MIDI): is Axe-Fx II filter/enhancer
 * pan_left/pan_right stored bipolar at the wire (like AM4) rather than
 * the catalog's claimed 0..100 percent?
 *
 * Pure arithmetic against the Session 128 encoding sweep
 * (samples/captured/decoded/encoding-sweep-results.json). The sweep
 * wrote raw display floats 3.0 and 7.0 via fn=0x2e and read back the
 * fn=0x1F state-dump u16 at the same position. A two-point linear fit
 * recovers the device's native display->wire map for each position.
 *
 * Run: npx tsx scripts/_research/wf-ii-filter-enhancer-pan-bipolar-analysis.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SWEEP = join(
  process.cwd(),
  'samples',
  'captured',
  'decoded',
  'encoding-sweep-results.json',
);

const A = 3.0;
const B = 7.0;

interface Pos {
  pos: number;
  type: string;
  baseline: number;
  s1: number;
  s2: number;
  scale?: number;
}
interface Block {
  name: string;
  effectId: number;
  positions: number;
  encodingMap: Pos[];
}

function fit(d1: number, w1: number, d2: number, w2: number) {
  const a = (w2 - w1) / (d2 - d1);
  const b = w1 - a * d1;
  const dispAt = (w: number) => (w - b) / a;
  return {
    a,
    b,
    dispAtWire0: dispAt(0),
    dispAtCenter: dispAt(32767),
    dispAtWireMax: dispAt(65534),
  };
}

// bipolar display d in [-M,M] -> wire (d/M + 1)/2 * 65534
const bipWire = (d: number, m: number) => Math.round(((d / m + 1) / 2) * 65534);

const j: Record<string, Block> = JSON.parse(readFileSync(SWEEP, 'utf-8'));

// Catalog (params.ts) paramIds for the 4 target params + bipolar references.
const targets = [
  { block: 'filter', name: 'pan_left', paramId: 9 },
  { block: 'filter', name: 'pan_right', paramId: 10 },
  { block: 'enhancer', name: 'pan_left', paramId: 8 },
  { block: 'enhancer', name: 'pan_right', paramId: 9 },
];
const refs = [
  { block: 'amp', name: 'balance (REF ±100)', paramId: 22 },
];

console.log('AM4 ground-truth bipolar arithmetic:');
console.log('  display=30 ->', bipWire(30, 100), '(STATE-AM4: 42597; simple-pct would be 19660)\n');

function report(block: string, name: string, paramId: number) {
  const b = j[block];
  if (!b) {
    console.log(`${block}.${name}: block missing in sweep`);
    return;
  }
  const e = b.encodingMap.find((x) => x.pos === paramId);
  if (!e) {
    console.log(`${block}.${name}: pos ${paramId} missing`);
    return;
  }
  if (e.s1 === e.s2) {
    console.log(`${block}.${name} (pos ${paramId}): no delta (readonly), type=${e.type}`);
    return;
  }
  const f = fit(A, e.s1, B, e.s2);
  const span = 65534 / f.a;
  // best symmetric bipolar match
  const candidates = [10, 20, 50, 90, 99, 100, 180, 200];
  let bestM = 100;
  let bestErr = Infinity;
  for (const m of candidates) {
    const err = Math.abs(bipWire(A, m) - e.s1) + Math.abs(bipWire(B, m) - e.s2);
    if (err < bestErr) {
      bestErr = err;
      bestM = m;
    }
  }
  const centeredAtZero = Math.abs(f.dispAtCenter) < 0.5;
  console.log(`${block}.${name} (pos ${paramId}) base=${e.baseline} s1=${e.s1} s2=${e.s2}`);
  console.log(
    `   linear: display range [${f.dispAtWire0.toFixed(1)} .. ${f.dispAtWireMax.toFixed(1)}], ` +
      `center(wire32767)=${f.dispAtCenter.toFixed(2)}, span=${span.toFixed(1)}`,
  );
  console.log(
    `   ${centeredAtZero ? 'BIPOLAR (centered at 0)' : 'NOT centered at 0'}; ` +
      `best symmetric ±${bestM} bipolar fit, residual=${bestErr} ` +
      `(bipWire ±${bestM}: ${bipWire(A, bestM)}/${bipWire(B, bestM)})`,
  );
  // What the CURRENT catalog (0..100 percent) would decode the baseline as,
  // vs a bipolar ±M decode.
  const pctDecode = (e.baseline / 65534) * 100;
  const bipDecode = ((e.baseline / 65534) * 2 - 1) * bestM;
  console.log(
    `   baseline ${e.baseline} decoded as: current-catalog(0..100%)=${pctDecode.toFixed(1)} ` +
      `vs bipolar(±${bestM})=${bipDecode.toFixed(1)}`,
  );
  console.log('');
}

console.log('=== TARGET PARAMS ===');
for (const t of targets) report(t.block, t.name, t.paramId);
console.log('=== REFERENCE (known bipolar ±100) ===');
for (const r of refs) report(r.block, r.name, r.paramId);
