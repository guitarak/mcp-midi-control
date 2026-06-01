/**
 * Treat each block-record as a 35-bit value (5 septets, LSB-first), and
 * with the KNOWN effectId-sorted alignment, find the bit position+width
 * of the effectId field and the state fields. READ-ONLY.
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
const IDS = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];
const NAMES = ['Compressor 1', 'Amp 1', 'Cab 1', 'Reverb 1', 'Delay 1', 'Chorus 1', 'Flanger 1', 'Rotary Speaker 1', 'Phaser 1', 'Wah 1', 'Drive 1'];

function rec35LSB(rec: number[]): bigint {
  let v = 0n;
  for (let k = 0; k < 5; k++) v |= BigInt(rec[k] & 0x7f) << BigInt(7 * k);
  return v;
}
function rec35MSB(rec: number[]): bigint {
  let v = 0n;
  for (let k = 0; k < 5; k++) v = (v << 7n) | BigInt(rec[k] & 0x7f);
  return v;
}
const valsLSB = RECS.map(rec35LSB);
const valsMSB = RECS.map(rec35MSB);

function ext(v: bigint, start: number, width: number): number {
  return Number((v >> BigInt(start)) & ((1n << BigInt(width)) - 1n));
}

function findIdField(vals: bigint[], label: string) {
  console.log(`\n=== ${label}: search bit-field == effectId (with affine) ===`);
  let hits = 0;
  for (let start = 0; start <= 27; start++) {
    for (let width = 7; width <= 14; width++) {
      if (start + width > 35) continue;
      const ex = vals.map((v) => ext(v, start, width));
      // exact
      if (ex.every((e, i) => e === IDS[i])) { console.log(`  EXACT id at start=${start} w=${width}`); hits++; continue; }
      // affine e*a+b == id
      for (const a of [1, 2, 4, 8]) {
        const offs = ex.map((e, i) => IDS[i] - e * a);
        if (new Set(offs).size === 1) { console.log(`  id == field*${a} + ${offs[0]}  at start=${start} w=${width}  field=[${ex.join(',')}]`); hits++; }
      }
      // field == id - 100 (block index 0..70)
      if (ex.every((e, i) => e === IDS[i] - 100)) { console.log(`  (id-100) at start=${start} w=${width}`); hits++; }
    }
  }
  if (!hits) console.log('  none');
}
findIdField(valsLSB, 'LSB-first 35-bit');
findIdField(valsMSB, 'MSB-first 35-bit');

// Print the full 35-bit binary for each record, aligned, so we can eyeball
// which bits track the (known) effectId and which are state.
console.log('\n=== 35-bit LSB-first binary per record (id-sorted) ===');
console.log('id   name              | 35-bit (bit34..bit0)            | id binary');
for (let r = 0; r < RECS.length; r++) {
  const bin = valsLSB[r].toString(2).padStart(35, '0');
  const idbin = IDS[r].toString(2).padStart(8, '0');
  console.log(`${IDS[r]}  ${NAMES[r].padEnd(16)} | ${bin} | ${idbin}`);
}

console.log('\n=== 35-bit MSB-first binary per record (id-sorted) ===');
for (let r = 0; r < RECS.length; r++) {
  const bin = valsMSB[r].toString(2).padStart(35, '0');
  const idbin = IDS[r].toString(2).padStart(8, '0');
  console.log(`${IDS[r]}  ${NAMES[r].padEnd(16)} | ${bin} | ${idbin}`);
}

// Column-wise bit stability: which of the 35 bit positions are CONSTANT
// across all 11 records (=> structural/flag bits) vs varying (=> id/state).
console.log('\n=== per-bit constancy (LSB-first) ===');
for (let bit = 34; bit >= 0; bit--) {
  const col = valsLSB.map((v) => Number((v >> BigInt(bit)) & 1n));
  const allSame = col.every((b) => b === col[0]);
  if (allSame) process.stdout.write(`bit${bit}=${col[0]}(const) `);
}
console.log('\n--- varying bits (LSB-first) ---');
for (let bit = 34; bit >= 0; bit--) {
  const col = valsLSB.map((v) => Number((v >> BigInt(bit)) & 1n));
  if (!col.every((b) => b === col[0])) process.stdout.write(`bit${bit}=[${col.join('')}] `);
}
console.log();
