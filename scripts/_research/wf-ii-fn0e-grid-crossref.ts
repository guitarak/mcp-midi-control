/**
 * Cross-reference the fn 0x0E QUERY_STATES records against the GET_GRID
 * (fn 0x20) response captured in the SAME editor sync
 * (session-58-direct-sync.syx). READ-ONLY.
 *
 * Goal: figure out which blocks the test preset had placed, so we can
 * map each 0x0E 5-byte record to a block.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CAPTURE = path.resolve('samples/captured/session-58-direct-sync.syx');

const BLOCKS: Record<number, string> = {
  100: 'Compressor 1', 101: 'Compressor 2', 102: 'Graphic EQ 1', 103: 'Graphic EQ 2',
  104: 'Parametric EQ 1', 105: 'Parametric EQ 2', 106: 'Amp 1', 107: 'Amp 2',
  108: 'Cab 1', 109: 'Cab 2', 110: 'Reverb 1', 111: 'Reverb 2', 112: 'Delay 1',
  113: 'Delay 2', 114: 'Multi Delay 1', 115: 'Multi Delay 2', 116: 'Chorus 1',
  117: 'Chorus 2', 118: 'Flanger 1', 119: 'Flanger 2', 120: 'Rotary Speaker 1',
  121: 'Rotary Speaker 2', 122: 'Phaser 1', 123: 'Phaser 2', 124: 'Wah 1',
  125: 'Wah 2', 126: 'Formant', 127: 'Volume/Pan 1', 128: 'Tremolo/Panner 1',
  129: 'Tremolo/Panner 2', 130: 'Pitch 1', 131: 'Filter 1', 132: 'Filter 2',
  133: 'Drive 1', 134: 'Drive 2', 135: 'Enhancer', 136: 'FX Loop', 137: 'Mixer',
  138: 'Mixer 2', 139: 'Input Noise Gate', 140: 'Output', 141: 'Controllers',
  142: 'Feedback Send', 143: 'Feedback Return', 144: 'Synth 1', 145: 'Synth 2',
  146: 'Vocoder', 147: 'Megatap Delay', 148: 'Crossover 1', 149: 'Crossover 2',
  150: 'Gate Expander', 151: 'Gate Expander 2', 152: 'Ring Modulator', 153: 'Pitch 2',
  154: 'Multiband Compressor 1', 155: 'Multiband Compressor 2', 156: 'Quad Chorus 1',
  157: 'Quad Chorus 2', 158: 'Resonator 1', 159: 'Resonator 2', 160: 'Graphic EQ 3',
  161: 'Graphic EQ 4', 162: 'Parametric EQ 3', 163: 'Parametric EQ 4', 164: 'Filter 3',
  165: 'Filter 4', 166: 'Volume/Pan 2', 167: 'Volume/Pan 3', 168: 'Volume/Pan 4',
  169: 'Looper', 170: 'Tone Match',
};
const hex = (b: number) => b.toString(16).padStart(2, '0');

interface Frame { index: number; offset: number; length: number; fn: number; payload: Uint8Array; }
function walkFrames(buf: Uint8Array): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) { i++; continue; }
    const start = i;
    let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    if (j - start + 1 >= 7 && buf[start + 1] === 0x00 && buf[start + 2] === 0x01 && buf[start + 3] === 0x74 && buf[start + 4] === 0x07) {
      frames.push({ index: frames.length, offset: start, length: j - start + 1, fn: buf[start + 5], payload: buf.subarray(start + 6, j - 1) });
    }
    i = j + 1;
  }
  return frames;
}

const buf = new Uint8Array(readFileSync(CAPTURE));
const frames = walkFrames(buf);

// ── Parse the fn 0x20 GET_GRID response ──────────────────────────────
const gridFrame = frames.find((f) => f.fn === 0x20 && f.length >= 8 + 48 * 4);
if (!gridFrame) { console.log('No grid frame found'); process.exit(1); }
console.log('=== GET_GRID (fn 0x20) placed blocks ===');
const bytes = Array.from(buf.subarray(gridFrame.offset, gridFrame.offset + gridFrame.length));
const placed: { col: number; row: number; blockId: number; routing: number }[] = [];
let i = 6;
for (let cellIdx = 0; cellIdx < 48; cellIdx++) {
  const col = Math.floor(cellIdx / 4) + 1;
  const row = (cellIdx % 4) + 1;
  const blockId = (bytes[i] & 0x7f) | ((bytes[i + 1] & 0x7f) << 7);
  const routing = bytes[i + 2] & 0x0f;
  if (blockId !== 0 && !(blockId >= 200 && blockId <= 235)) {
    placed.push({ col, row, blockId, routing });
  }
  i += 4;
}
// dedupe by blockId, keep first occurrence
const seen = new Set<number>();
const uniquePlaced = placed.filter((p) => { if (seen.has(p.blockId)) return false; seen.add(p.blockId); return true; });
console.log('Placed (unique) blocks in grid order:');
for (const p of uniquePlaced) {
  console.log(`  col${p.col} row${p.row}  id=${p.blockId} (0x${hex(p.blockId)})  ${BLOCKS[p.blockId] ?? '???'}`);
}
console.log(`\nTotal unique placed blocks: ${uniquePlaced.length}`);
console.log('Placed block IDs (sorted):', uniquePlaced.map((p) => p.blockId).sort((a, b) => a - b).join(', '));

// ── The fn 0x0E response from THIS capture ──────────────────────────
const fn0e = frames.find((f) => f.fn === 0x0e);
if (fn0e) {
  const full = Array.from(buf.subarray(fn0e.offset, fn0e.offset + fn0e.length));
  console.log('\n=== fn 0x0E from THIS capture (should match probe) ===');
  console.log('bytes:', full.map(hex).join(' '));
  const pay = Array.from(fn0e.payload);
  console.log('payload len:', pay.length, '/5 =', pay.length / 5);
  const recs: number[][] = [];
  for (let k = 0; k < pay.length; k += 5) recs.push(pay.slice(k, k + 5));
  console.log('\n=== Cross-ref: each 0x0E record b1 vs placed effectIds ===');
  console.log('Placed IDs:', uniquePlaced.map((p) => p.blockId).join(', '));
  for (let r = 0; r < recs.length; r++) {
    console.log(`  rec ${String(r).padStart(2)} = ${recs[r].map(hex).join(' ')}`);
  }
  // Hypothesis test: 11 records, and placed-block count?
  console.log(`\n0x0E record count: ${recs.length}  vs placed-block count: ${uniquePlaced.length}`);
}

// ── fn 0x02 GET responses in the capture — these tell us params read ──
console.log('\n=== fn 0x02 frames (the per-block GET loop AxeEdit ran) ===');
for (const f of frames.filter((x) => x.fn === 0x02)) {
  const full = Array.from(buf.subarray(f.offset, f.offset + f.length));
  console.log(`  [${f.index}] len=${f.length} ${full.map(hex).join(' ')}`);
}
