/**
 * Brute-force: for each of the 4 adjacent septet-pairs in the 5-byte
 * record, decode as 14-bit (both lo-first and hi-first), and check if
 * the 11 decoded values are a PERMUTATION (or affine image) of the 11
 * placed effectIds. READ-ONLY.
 *
 * Also: maybe effectId lives in a single byte that I'm masking wrong.
 * Test b1 with NO mask vs effectId, and b1 as (effectId - 0x40) etc.
 */

const RECS: number[][] = [
  [0x03, 0x4a, 0x10, 0x53, 0x06],
  [0x03, 0x4e, 0x18, 0x63, 0x06],
  [0x02, 0x52, 0x20, 0x23, 0x07],
  [0x02, 0x56, 0x00, 0x20, 0x06],
  [0x02, 0x5e, 0x28, 0x03, 0x07],
  [0x02, 0x62, 0x30, 0x2b, 0x78],
  [0x02, 0x70, 0x38, 0x33, 0x07],
  [0x02, 0x0a, 0x7d, 0x17, 0x07],
  [0x03, 0x26, 0x51, 0x73, 0x06],
  [0x02, 0x2c, 0x75, 0x43, 0x07],
  [0x02, 0x42, 0x59, 0x63, 0x07],
];
const SORTED = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];
const target = [...SORTED].sort((a, b) => a - b);
const hex = (b: number) => b.toString(16).padStart(2, '0');

function isAffinePerm(vals: number[]): string | undefined {
  // is there a,b such that sorted(a*vals+b) == target? try a in {1,2,0.5,-1}
  for (const a of [1, 2, 0.5, -1, 4, 0.25]) {
    const mapped = vals.map((v) => a < 1 ? Math.floor(v * a) : v * a);
    // pick b so min(mapped)+b = target[0]
    const b = target[0] - Math.min(...mapped);
    const out = mapped.map((v) => v + b).sort((x, y) => x - y);
    if (out.length === target.length && out.every((x, i) => x === target[i]) && new Set(vals).size === 11) {
      return `a=${a} b=${b}`;
    }
  }
  return undefined;
}

console.log('=== adjacent septet-pair 14-bit decode tests ===');
for (let pos = 0; pos < 4; pos++) {
  const loFirst = RECS.map((r) => (r[pos] & 0x7f) | ((r[pos + 1] & 0x7f) << 7));
  const hiFirst = RECS.map((r) => (r[pos + 1] & 0x7f) | ((r[pos] & 0x7f) << 7));
  const aLo = isAffinePerm(loFirst);
  const aHi = isAffinePerm(hiFirst);
  console.log(`pos ${pos}-${pos + 1} lo-first: [${loFirst.join(',')}] ${aLo ? 'AFFINE-PERM ' + aLo : ''}`);
  console.log(`pos ${pos}-${pos + 1} hi-first: [${hiFirst.join(',')}] ${aHi ? 'AFFINE-PERM ' + aHi : ''}`);
}

console.log('\n=== single-byte column affine tests ===');
for (let pos = 0; pos < 5; pos++) {
  const col = RECS.map((r) => r[pos]);
  const a = isAffinePerm(col);
  console.log(`col b${pos}: [${col.join(',')}] ${a ? 'AFFINE-PERM ' + a : ''}`);
}

// The b1 column is the clear "index" carrier. Map it as a SORTING KEY:
// if we sort records by b1, does some OTHER field become monotonic = effectId?
console.log('\n=== records sorted by b1 ===');
const byB1 = [...RECS].sort((a, b) => a[1] - b[1]);
for (const r of byB1) console.log(`  b1=${hex(r[1])}(${r[1]})  ${r.map(hex).join(' ')}`);

// KEY HYPOTHESIS: b1 is itself a packed (effectId, channel) or the records are
// ordered such that b1 = some monotonic block-INDEX, and b2 encodes effectId.
// b2 column for records sorted by b1:
console.log('\n=== b2 for records in b1 order ===');
console.log(byB1.map((r) => `${hex(r[2])}(${r[2]})`).join(' '));

// MULTIDIM: maybe (b1<<?)|b2 packs a value that equals effectId<<N.
// Let's compute for each record (b1*K + b2) for various K and see which gives
// a permutation of placed ids in some scaling.
console.log('\n=== (b1*K + b2)/D scan ===');
for (const K of [1, 2, 4, 8, 16, 32, 64, 128]) {
  for (const D of [1, 2, 4, 8, 16, 32, 64]) {
    const vals = RECS.map((r) => Math.floor((r[1] * K + r[2]) / D));
    const a = isAffinePerm(vals);
    if (a) console.log(`  K=${K} D=${D}: AFFINE-PERM ${a} vals=[${vals.join(',')}]`);
  }
}
console.log('(scan done)');
