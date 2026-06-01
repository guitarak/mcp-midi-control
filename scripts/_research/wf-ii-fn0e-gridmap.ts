/**
 * Align the 11 fn 0x0E records to the 11 grid-placed blocks and decode
 * the per-record fields with that alignment known. READ-ONLY.
 *
 * Grid order (col-major) from session-58 GET_GRID, all row 2:
 *   rec? -> block; we test BOTH "records in grid order" and "records in
 *   effectId order".
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

// Grid: {col,row,id,name}
const GRID = [
  { col: 1, row: 2, id: 100, name: 'Compressor 1' },
  { col: 2, row: 2, id: 124, name: 'Wah 1' },
  { col: 3, row: 2, id: 122, name: 'Phaser 1' },
  { col: 4, row: 2, id: 133, name: 'Drive 1' },
  { col: 5, row: 2, id: 106, name: 'Amp 1' },
  { col: 6, row: 2, id: 108, name: 'Cab 1' },
  { col: 7, row: 2, id: 116, name: 'Chorus 1' },
  { col: 8, row: 2, id: 118, name: 'Flanger 1' },
  { col: 9, row: 2, id: 112, name: 'Delay 1' },
  { col: 11, row: 2, id: 120, name: 'Rotary Speaker 1' },
  { col: 12, row: 2, id: 110, name: 'Reverb 1' },
];
const hex = (b: number) => b.toString(16).padStart(2, '0');

// effectId-sorted alignment
const byId = [...GRID].sort((a, b) => a.id - b.id);

console.log('=== Alignment A: records in GRID (col-major) order ===');
console.log('rec | tag b1   b2   b3   b4 | block            col row id   id-hex');
for (let r = 0; r < RECS.length; r++) {
  const [b0, b1, b2, b3, b4] = RECS[r];
  const g = GRID[r];
  console.log(`${String(r).padStart(2)}  |  ${b0}  ${hex(b1)}   ${hex(b2)}   ${hex(b3)}   ${hex(b4)} | ${g.name.padEnd(16)} ${g.col}   ${g.row}   ${g.id}  0x${hex(g.id)}`);
}
// In grid order, does b1 relate to col? b1=4a..70 for first 9, then 0a,26,2c,42...
console.log('\nGRID-order b1 vs col:');
for (let r = 0; r < RECS.length; r++) console.log(`  col${GRID[r].col} -> b1=${hex(RECS[r][1])}(${RECS[r][1]})`);

console.log('\n=== Alignment B: records in effectId-SORTED order ===');
console.log('rec | tag b1   b2   b3   b4 | block            id');
for (let r = 0; r < RECS.length; r++) {
  const [b0, b1, b2, b3, b4] = RECS[r];
  const g = byId[r];
  console.log(`${String(r).padStart(2)}  |  ${b0}  ${hex(b1)}   ${hex(b2)}   ${hex(b3)}   ${hex(b4)} | ${g.name.padEnd(16)} ${g.id}`);
}
// In effectId order, what is b1? sorted ids 100,106,108,110,112,116,118,120,122,124,133
console.log('\nSORTED-id b1 column:', RECS.map((r) => `${hex(r[1])}`).join(' '));
console.log('SORTED ids        :', byId.map((g) => g.id).join(', '));

// The records appear to be in NEITHER pure order. Let's find the permutation
// of GRID blocks that makes b1 strictly relate to effectId or col.
// Sort records by b1 and see which ordering of blocks (by id or col) matches count.
console.log('\n=== records sorted by b1, with both orderings for reference ===');
const order = RECS.map((r, i) => i).sort((a, b) => RECS[a][1] - RECS[b][1]);
console.log('b1-sorted record indices:', order.join(', '));
console.log('b1 values sorted        :', order.map((i) => RECS[i][1]).join(', '));

// Look at b2 in b1-sorted order:
console.log('b2 in b1-order          :', order.map((i) => RECS[i][2]).join(', '));
console.log('b3 in b1-order          :', order.map((i) => RECS[i][3]).join(', '));

// HYPOTHESIS: b1 packs (effectId - base) but with a different base for two
// halves. Note b1 values fall in two clusters:
//   cluster A (>=0x4a): 4a 4e 52 56 5e 62 70  (7 values)
//   cluster B (<0x4a):  0a 26 2c 42           (4 values)  [rec 7,8,9,10]
// 7+4 = 11. Maybe high bit / cluster = a category, and within cluster b1 is index.
console.log('\n=== cluster split ===');
RECS.forEach((r, i) => {
  console.log(`rec ${String(i).padStart(2)} b1=${hex(r[1])} cluster ${r[1] >= 0x4a ? 'A(amp-row?)' : 'B'}  block(grid)=${GRID[i].name}`);
});
