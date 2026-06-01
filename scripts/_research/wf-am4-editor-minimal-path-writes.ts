/**
 * wf-am4-editor-minimal-path-writes.ts
 *
 * READ-ONLY. Isolates the actual EDIT frames (the minimal primitive) from
 * the polling noise in each per-action session-59 capture. Strategy: for an
 * "X-via-edit" capture, the polling traffic (action=0x0D/0x0E/0x10/0x26 reads
 * to fixed addresses) is identical across all captures; the SIGNAL is the
 * rare frame whose (pidLow,pidHigh,action) is unique to the user's action.
 *
 * We surface, per capture, every fn=0x01 frame whose action is a known WRITE
 * (0x01) OR a structural action (0x0C rename, 0x1B save, 0x17 init burst),
 * plus any frame addressing the CE-register navigation sub-addresses
 * (0x0A preset-switch, 0x0D scene-switch, 0x0F-0x12 slot placement).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURE_DIR = join(process.cwd(), 'samples', 'captured');
const CAPTURES = [
  'session-59-am4-preset-switch-via-edit.syx',
  'session-59-am4-param-change-via-edit.syx',
  'session-59-am4-block-bypass-via-edit.syx',
  'session-59-am4-block-type-swap-via-edit.syx',
  'session-59-am4-scene-switch-via-edit.syx',
];

function walk(buf: Buffer) {
  const frames: { fn: number; model: number; bytes: number[] }[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) { i++; continue; }
    const start = i;
    let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    const bytes = Array.from(buf.subarray(start, j + 1));
    if (bytes.length >= 8 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74) {
      frames.push({ model: bytes[4], fn: bytes[5], bytes });
    }
    i = j + 1;
  }
  return frames;
}

const dec14 = (lo: number, hi: number) => (lo & 0x7f) | ((hi & 0x7f) << 7);
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join(' ');

// Actions that represent a user EDIT (host->device write / structural change),
// not a continuous poll-read.
const WRITE_ACTIONS = new Set([0x01, 0x02, 0x0c, 0x1b, 0x17]);

for (const name of CAPTURES) {
  const buf = readFileSync(join(CAPTURE_DIR, name));
  const frames = walk(buf);
  console.log(`\n${'#'.repeat(70)}\n### ${name}`);
  const writes = frames.filter((f) => {
    if (f.model !== 0x15 || f.fn !== 0x01 || f.bytes.length < 16) return false;
    const action = dec14(f.bytes[10], f.bytes[11]);
    return WRITE_ACTIONS.has(action);
  });
  // Group by (pidLow,pidHigh,action) signature to collapse repeats.
  const groups = new Map<string, { count: number; sample: number[] }>();
  for (const f of writes) {
    const b = f.bytes;
    const sig = `pidLow=0x${dec14(b[6], b[7]).toString(16)} pidHigh=0x${dec14(b[8], b[9]).toString(16)} action=0x${dec14(b[10], b[11]).toString(16)}`;
    const g = groups.get(sig) ?? { count: 0, sample: b };
    g.count++;
    groups.set(sig, g);
  }
  console.log(`  ${writes.length} write/structural frames in ${frames.length} total -> ${groups.size} distinct (pidLow,pidHigh,action) signatures:`);
  for (const [sig, g] of [...groups.entries()].sort((a, b) => a[1].count - b[1].count)) {
    const b = g.sample;
    const hdr4 = dec14(b[14], b[15]);
    console.log(`    ${sig.padEnd(48)} ×${String(g.count).padStart(3)}  hdr4=${hdr4}  ${hex(b.slice(0, Math.min(24, b.length)))}${b.length > 24 ? ' ...' : ''}`);
  }
}
