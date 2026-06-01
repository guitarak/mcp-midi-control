/**
 * Solve the fn 0x0E record bit layout by correlating against the known
 * 11 placed effectIds from the same capture. READ-ONLY.
 *
 * Two capture instances exist:
 *   PROBE (probe-axefx2-new-opcodes-findings.md) - empty payload request
 *   SYNC  (session-58-direct-sync.syx) - editor sync, same preset edited
 * Both have 11 records / 11 placed blocks. We use PROBE as primary.
 *
 * Placed blocks in PROBE preset: identical grid to SYNC (11 blocks).
 * Grid order (col-major) from SYNC GET_GRID:
 *   Comp1=100, Wah1=124, Phaser1=122, Drive1=133, Amp1=106, Cab1=108,
 *   Chorus1=116, Flanger1=118, Delay1=112, Rotary1=120, Reverb1=110
 */

const PROBE_RECORDS: number[][] = [
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

// SYNC records (3 differ from PROBE; both have 11)
const SYNC_RECORDS: number[][] = [
  [0x03, 0x4a, 0x10, 0x53, 0x06],
  [0x03, 0x4e, 0x18, 0x63, 0x06],
  [0x02, 0x52, 0x20, 0x23, 0x07],
  [0x02, 0x56, 0x00, 0x20, 0x06],
  [0x03, 0x5e, 0x28, 0x03, 0x07], // tag differs (02->03)
  [0x02, 0x62, 0x30, 0x2b, 0x78],
  [0x02, 0x70, 0x38, 0x33, 0x07],
  [0x02, 0x16, 0x41, 0x53, 0x07], // b1,b2,b3 differ
  [0x03, 0x26, 0x51, 0x73, 0x06],
  [0x02, 0x2c, 0x75, 0x43, 0x07],
  [0x02, 0x42, 0x59, 0x63, 0x07], // last record truncated in capture? has b4=07 only via probe
];

// Grid-order placed effectIds (col-major)
const GRID_ORDER_IDS = [100, 124, 122, 133, 106, 108, 116, 118, 112, 120, 110];
// effectId-sorted
const SORTED_IDS = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];

const hex = (b: number) => b.toString(16).padStart(2, '0');

// The record is 5 septets = 35 bits. Try to find a contiguous bit-field
// (any start 0..28, any width 7..14) within the LSB-first 35-bit value
// that, across all 11 records, is a PERMUTATION of the placed effectIds.
function rec35LSB(rec: number[]): number {
  let v = 0;
  for (let k = 0; k < 5; k++) v |= (rec[k] & 0x7f) << (7 * k);
  return v >>> 0;
}

function tryField(records: number[][], targetSet: number[], label: string) {
  const target = [...targetSet].sort((a, b) => a - b);
  const vals = records.map(rec35LSB);
  console.log(`\n--- ${label}: scanning bit-fields for a permutation of placed IDs ---`);
  let found = 0;
  for (let start = 0; start <= 28; start++) {
    for (let width = 7; width <= 14; width++) {
      if (start + width > 35) continue;
      const mask = (1 << width) - 1;
      const extracted = vals.map((v) => (v >>> start) & mask);
      const sorted = [...extracted].sort((a, b) => a - b);
      const isPerm = sorted.length === target.length && sorted.every((x, i) => x === target[i]);
      // Also accept "extracted+base" permutation for any base offset
      if (isPerm) {
        console.log(`  EXACT permutation at start=${start} width=${width}: ${extracted.join(',')}`);
        found++;
      } else {
        // base-offset test: extracted values are placedIds - K (constant)
        const minE = Math.min(...extracted);
        const k = target[0] - minE;
        const shifted = sorted.map((x) => x + k);
        if (shifted.every((x, i) => x === target[i]) && new Set(extracted).size === 11) {
          console.log(`  PERM with +${k} offset at start=${start} width=${width}: raw=${extracted.join(',')} (+${k} => ids)`);
          found++;
        }
      }
    }
  }
  if (!found) console.log('  (no clean permutation field found)');
}

tryField(PROBE_RECORDS, SORTED_IDS, 'PROBE vs sorted IDs');

// Maybe records are in GRID order, not sorted. Test direct positional match:
// for each candidate field, does extracted[i] map 1:1 to GRID_ORDER_IDS[i]
// (or with a constant offset)?
function tryPositional(records: number[][], orderedIds: number[], label: string) {
  const vals = records.map(rec35LSB);
  console.log(`\n--- ${label}: positional (record i -> ordered id i) ---`);
  let found = 0;
  for (let start = 0; start <= 28; start++) {
    for (let width = 7; width <= 14; width++) {
      if (start + width > 35) continue;
      const mask = (1 << width) - 1;
      const extracted = vals.map((v) => (v >>> start) & mask);
      // constant-offset positional match
      const offsets = extracted.map((e, i) => orderedIds[i] - e);
      const allSame = offsets.every((o) => o === offsets[0]);
      if (allSame) { console.log(`  POSITIONAL match start=${start} width=${width} offset=${offsets[0]}: raw=${extracted.join(',')}`); found++; }
      // linear (e * m + c) match
      // try m in small range
      for (const m of [2, 0.5]) {
        const lin = extracted.map((e) => m === 0.5 ? e >> 1 : e * 2);
        const offs = lin.map((e, i) => orderedIds[i] - e);
        if (offs.every((o) => o === offs[0])) { console.log(`  POSITIONAL m=${m} match start=${start} width=${width} offset=${offs[0]}`); found++; }
      }
    }
  }
  if (!found) console.log('  (no positional field found)');
}

tryPositional(PROBE_RECORDS, GRID_ORDER_IDS, 'PROBE positional vs GRID order');
tryPositional(PROBE_RECORDS, SORTED_IDS, 'PROBE positional vs SORTED order');

// Direct b1-column correlation: b1 raw values vs both orderings
console.log('\n=== b1 column vs orderings ===');
const b1 = PROBE_RECORDS.map((r) => r[1]);
console.log('b1 raw         :', b1.map((v) => `${v}`).join(', '));
console.log('GRID order ids :', GRID_ORDER_IDS.join(', '));
console.log('SORTED ids     :', SORTED_IDS.join(', '));
console.log('b1 - sorted    :', b1.map((v, i) => v - SORTED_IDS[i]).join(', '));
console.log('b1 - grid      :', b1.map((v, i) => v - GRID_ORDER_IDS[i]).join(', '));
console.log('sorted - b1*? ratios:', SORTED_IDS.map((v, i) => (v / b1[i]).toFixed(3)).join(', '));

// b2 column
console.log('\n=== b2 column ===');
console.log('b2 raw:', PROBE_RECORDS.map((r) => r[2]).map(hex).join(' '), '=', PROBE_RECORDS.map((r) => r[2]).join(','));
// b3 column
console.log('b3 raw:', PROBE_RECORDS.map((r) => r[3]).map(hex).join(' '), '=', PROBE_RECORDS.map((r) => r[3]).join(','));
// b4 column
console.log('b4 raw:', PROBE_RECORDS.map((r) => r[4]).map(hex).join(' '), '=', PROBE_RECORDS.map((r) => r[4]).join(','));
