/**
 * Test: is 0x02/0x03 a LENGTH/COUNT prefix for a variable-length record,
 * rather than a fixed 5-byte stride? READ-ONLY.
 *
 * If 0x02 means "2 following septets" and 0x03 means "3 following", the
 * total payload byte budget would be: sum(count_i) + 11 (the count bytes).
 */

const PROBE_PAYLOAD = [
  0x03, 0x4a, 0x10, 0x53, 0x06, 0x03, 0x4e, 0x18, 0x63, 0x06, 0x02, 0x52, 0x20, 0x23, 0x07,
  0x02, 0x56, 0x00, 0x20, 0x06, 0x02, 0x5e, 0x28, 0x03, 0x07, 0x02, 0x62, 0x30, 0x2b, 0x78,
  0x02, 0x70, 0x38, 0x33, 0x07, 0x02, 0x0a, 0x7d, 0x17, 0x07, 0x03, 0x26, 0x51, 0x73, 0x06,
  0x02, 0x2c, 0x75, 0x43, 0x07, 0x02, 0x42, 0x59, 0x63, 0x07,
];
const SORTED_IDS = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];
const hex = (b: number) => b.toString(16).padStart(2, '0');
const dec14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);

// Walk: read count byte (must be 0x02/0x03), then `count` data bytes.
console.log('=== Parse as [count][count data bytes] records ===');
let i = 0;
let rec = 0;
const fields: { count: number; data: number[] }[] = [];
while (i < PROBE_PAYLOAD.length) {
  const count = PROBE_PAYLOAD[i];
  if (count !== 0x02 && count !== 0x03) {
    console.log(`  rec ${rec}: NON-count byte ${hex(count)} at offset ${i} — variable-len hypothesis FAILS here`);
    break;
  }
  const data = PROBE_PAYLOAD.slice(i + 1, i + 1 + count);
  fields.push({ count, data });
  console.log(`  rec ${String(rec).padStart(2)} count=${count} data=[${data.map(hex).join(' ')}]`);
  i += 1 + count;
  rec++;
}
console.log(`consumed ${i}/${PROBE_PAYLOAD.length} bytes in ${rec} records`);

// The above WON'T tile cleanly if counts are 2/3 with stride !=5.
// Sum check: how many bytes if 0x02->2 data, 0x03->3 data?
// There are (from fixed parse) tags: 03,03,02,02,02,02,02,02,03,02,02
const tags = [3, 3, 2, 2, 2, 2, 2, 2, 3, 2, 2];
const totalIfVarLen = tags.reduce((a, c) => a + 1 + c, 0);
console.log(`\nIf var-len (1 count byte + count data): total = ${totalIfVarLen} bytes (payload is ${PROBE_PAYLOAD.length})`);

// Alternative: fixed 5-byte stride is correct. Re-examine with the
// understanding that b0 is a TAG meaning something else. Note b0 distribution:
// records with tag 0x03: indices 0,1,8 (in probe). tag 0x02: rest.
// Cross-ref to grid: which blocks are at records 0,1,8?
// We don't yet know record->block. Let's correlate tag with block PROPERTIES.
console.log('\n=== Fixed 5-byte records, field columns ===');
const recs: number[][] = [];
for (let k = 0; k < PROBE_PAYLOAD.length; k += 5) recs.push(PROBE_PAYLOAD.slice(k, k + 5));
console.log('tag(b0):', recs.map((r) => r[0]).join(' '));
console.log('b1     :', recs.map((r) => r[1]).map(hex).join(' '));
console.log('b2     :', recs.map((r) => r[2]).map(hex).join(' '));
console.log('b3     :', recs.map((r) => r[3]).map(hex).join(' '));
console.log('b4     :', recs.map((r) => r[4]).map(hex).join(' '));

// NEW IDEA: maybe (b1,b2) is septet14 but it's NOT effectId — it's a
// per-block "param base address" or "byte offset into the preset binary".
// And (b3,b4) is septet14 state. Decode both as septet14 lo-first:
console.log('\n=== (b1,b2) and (b3,b4) as septet14 lo-first ===');
for (let r = 0; r < recs.length; r++) {
  const [b0, b1, b2, b3, b4] = recs[r];
  const f1 = dec14(b1, b2);
  const f2 = dec14(b3, b4);
  console.log(`rec ${String(r).padStart(2)} tag=${b0}  f1=${f1} (0x${f1.toString(16)})  f2=${f2} (0x${f2.toString(16)})  f2.lo=${f2 & 0xff} f2.hi=${(f2 >> 8) & 0xff}`);
}

// IDEA: the (b1,b2) septet14 vals  - are they a strictly increasing sequence
// that equals effectId * some_stride? Look at f1 sorted:
const f1s = recs.map((r) => dec14(r[1], r[2]));
console.log('\nf1 values:', f1s.join(', '));
console.log('f1 sorted:', [...f1s].sort((a, b) => a - b).join(', '));
console.log('f1 deltas (in record order):', f1s.map((v, i) => i ? v - f1s[i - 1] : 0).join(', '));

// Map idea: f1 / 32?  or f1 relation to effectId.
// placed sorted ids: 100..133. f1 range?
console.log('f1 min/max:', Math.min(...f1s), Math.max(...f1s));
