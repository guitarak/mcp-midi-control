/**
 * Consolidated fn 0x0E decode summary + perf accounting. READ-ONLY.
 * Records are position-encoded (effectId-ascending = same order the
 * device enumerates placed blocks). 5 bytes/record = pure per-block
 * state. effectId is IMPLICIT (recovered by zipping against the grid's
 * placed-block list, exactly like fn 0x1F position=paramId).
 */
const RECS: number[][] = [
  [0x03, 0x4a, 0x10, 0x53, 0x06], [0x03, 0x4e, 0x18, 0x63, 0x06],
  [0x02, 0x52, 0x20, 0x23, 0x07], [0x02, 0x56, 0x00, 0x20, 0x06],
  [0x02, 0x5e, 0x28, 0x03, 0x07], [0x02, 0x62, 0x30, 0x2b, 0x78],
  [0x02, 0x70, 0x38, 0x33, 0x07], [0x02, 0x0a, 0x7d, 0x17, 0x07],
  [0x03, 0x26, 0x51, 0x73, 0x06], [0x02, 0x2c, 0x75, 0x43, 0x07],
  [0x02, 0x42, 0x59, 0x63, 0x07],
];
const IDS = [100, 106, 108, 110, 112, 116, 118, 120, 122, 124, 133];
const NAMES = ['Compressor 1', 'Amp 1', 'Cab 1', 'Reverb 1', 'Delay 1', 'Chorus 1', 'Flanger 1', 'Rotary Speaker 1', 'Phaser 1', 'Wah 1', 'Drive 1'];
const hex = (b: number) => b.toString(16).padStart(2, '0');

console.log('=== fn 0x0E record -> placed block (by position zip with grid) ===');
console.log('pos | rawbytes      | effectId  block            | b0  b1 b2 b3 b4');
for (let r = 0; r < RECS.length; r++) {
  const [b0, b1, b2, b3, b4] = RECS[r];
  console.log(`${String(r).padStart(2)}  | ${RECS[r].map(hex).join(' ')} | ${IDS[r]}      ${NAMES[r].padEnd(16)} | ${b0}   ${hex(b1)} ${hex(b2)} ${hex(b3)} ${hex(b4)}`);
}

// Per-column candidate semantics
console.log('\n=== column candidate semantics ===');
console.log('b0 (tag)  :', RECS.map((r) => r[0]).join('  '), ' -> {2,3}; hypothesis: bypass/engaged flag or record-shape selector');
console.log('b1        :', RECS.map((r) => hex(r[1])).join(' '), ' -> varies most; hypothesis: low 7 bits of a per-block state word OR channel/scene mask');
console.log('b2        :', RECS.map((r) => hex(r[2])).join(' '), ' -> steps ~8 in id-order for first run; hypothesis: 2nd septet of state word');
console.log('b3        :', RECS.map((r) => hex(r[3])).join(' '), ' -> low nibble nearly always 0x3; hypothesis: 3rd septet');
console.log('b4        :', RECS.map((r) => hex(r[4])).join(' '), ' -> {06,07,78}; one outlier (Chorus=0x78)');

// Most-defensible field grouping for downstream: tag + 28-bit packed state.
console.log('\n=== tag + 28-bit packed state (b1..b4, LSB-first septets) ===');
for (let r = 0; r < RECS.length; r++) {
  const [b0, b1, b2, b3, b4] = RECS[r];
  const state = (b1 & 0x7f) | ((b2 & 0x7f) << 7) | ((b3 & 0x7f) << 14) | ((b4 & 0x7f) << 21);
  console.log(`${NAMES[r].padEnd(16)} id=${IDS[r]} tag=${b0} state28=0x${state.toString(16).padStart(7, '0')} (${state})`);
}

// ---- PERF accounting for getPreset() ----
// Current getPreset round-trips (from reader.ts), for an N-block preset
// with C channel-bearing blocks (canBypass) and include_channel_state=true:
//   1  grid read (fn 0x20)
//   1  preset name (fn 0x0F)
//   per channel-bearing block: 1 fn 0x11 get-channel + (if Y) full per-param fn 0x02 loop + 1 set Y + 1 verify + 1 restore
//   per block: 1 fn 0x1F bulk dump + 1 fn 0x02 scene-resolved bypass (paramId 255)
//   1  scene number (fn 0x29)
// The DEFAULT path (include_channel_state defaulted true in code) is heavy.
const N = 11, C = 11; // this test preset: 11 placed, all canBypass
const gridName = 2;
const perBlock = 1 /*fn1F*/ + 1 /*bypass255 fn02*/;
const perChannelBlock_active = 1 /*get channel fn11*/;
const sceneNum = 1;
// NOTE: the Y-channel per-param fn 0x02 loop only fires when activeChannel!==undefined.
// Lower bound (no Y loop): grid+name + N*(1F + bypass255) + C*(getCh) + scene
const lower = gridName + N * perBlock + C * perChannelBlock_active + sceneNum;
console.log('\n=== getPreset round-trip count (this 11-block preset) ===');
console.log(`current (lower bound, channel reads but no Y per-param loop): ${lower} round-trips`);
console.log('  = 2 (grid+name) + 11*(fn1F + fn02-bypass255) + 11 (fn11 get-channel) + 1 (scene)');
console.log(`current (upper, Y per-param loop on every channel block): adds C * (1 setY + 1 verify + ~K params fn02 + 1 restore) — dozens to hundreds more`);
console.log(`\nfn 0x0E replacement: 1 grid (fn 0x20, to recover effectId order) + 1 fn 0x0E + 1 name + 1 scene = 4 round-trips for bypass+channel+? state of ALL blocks`);
console.log(`Reduction: ${lower} -> 4  (~${(lower / 4).toFixed(1)}x fewer) on the bypass/channel axis; the per-param VALUE dump (fn 0x1F) is still needed if callers want param values, but bypass/channel/scene state no longer needs per-block fn 0x02.`);
