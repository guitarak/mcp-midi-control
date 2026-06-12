/**
 * wf-ii-decode-0e-querystates.ts  (READ-ONLY)
 * Decode the fn=0x0E QUERY_STATES response body as 5-byte records and
 * cross-check the implied blockIds against the fn=0x20 grid's placed
 * blocks in the same capture. Tests the "per-block compact state" theory:
 * the editor reads bypass + channel + type for every placed block in a
 * single round-trip, instead of our per-block fn=0x1F + per-param fn=0x02
 * loop.
 */
import { readFileSync } from 'node:fs';
import { BLOCK_BY_ID } from 'fractal-midi/gen2/axe-fx-ii';

const file = process.argv[2] ?? 'samples/captured/session-58-direct-sync.syx';
const buf = readFileSync(file);

function framePayload(targetFn: number): number[] | undefined {
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) { i++; continue; }
    const start = i;
    let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    if (j - start + 1 >= 7 && buf[start + 1] === 0x00 && buf[start + 2] === 0x01 &&
        buf[start + 3] === 0x74 && buf[start + 5] === targetFn && (j - 1) - (start + 6) > 8) {
      return Array.from(buf.subarray(start + 6, j - 1)); // payload only
    }
    i = j + 1;
  }
  return undefined;
}

function decode14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }

// --- 0x20 grid: extract placed blockIds (col-major 12×4, 4 bytes/cell) ---
const grid = framePayload(0x20);
const placed = new Set<number>();
if (grid) {
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 4; row++) {
      const off = col * 16 + row * 4;
      const id = decode14(grid[off], grid[off + 1]);
      if (id !== 0 && !(id >= 200 && id <= 235)) placed.add(id);
    }
  }
}
console.log('Grid placed blockIds:', [...placed].sort((a, b) => a - b).map((id) => `${id}(${BLOCK_BY_ID[id]?.name ?? '?'})`).join(', '));

// --- 0x0E body: try 5-byte record stride ---
const qs = framePayload(0x0e);
if (!qs) { console.log('no 0x0E response found'); process.exit(0); }
console.log(`\n0x0E payload length = ${qs.length} bytes`);
for (const stride of [5]) {
  console.log(`\n-- stride ${stride} records (n=${Math.floor(qs.length / stride)}) --`);
  for (let r = 0; r + stride <= qs.length; r += stride) {
    const rec = qs.slice(r, r + stride);
    // Hypothesis: [blockId_lo, blockId_hi, byteA, byteB, byteC]
    const id14 = decode14(rec[0], rec[1]);
    const name = BLOCK_BY_ID[id14]?.name ?? '?';
    const inGrid = placed.has(id14) ? 'PLACED' : '';
    console.log(
      `  rec[${r / stride}] raw=[${rec.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]  id14=${id14} ${name} ${inGrid}`,
    );
  }
}
