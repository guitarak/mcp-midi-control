/**
 * wf-am4-editor-minimal-path-detail.ts
 *
 * READ-ONLY. Companion to wf-am4-editor-minimal-path-frames.ts.
 * Dumps representative frame bytes for the interesting action codes so we
 * can confirm what each is (read vs write, response shape) and verify there
 * is NO standalone fn=0x1F atomic-read opcode and NO fn=0x77/0x78/0x79
 * preset-dump in the AM4-Edit sync flow.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURE_DIR = join(process.cwd(), 'samples', 'captured');

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

const sync = readFileSync(join(CAPTURE_DIR, 'session-59-am4-edit-sync.syx'));
const frames = walk(sync);

console.log('=== fn-byte set on the wire (proves no standalone fn=0x1F / fn=0x77/78/79) ===');
const fnset = new Set(frames.filter((f) => f.model === 0x15).map((f) => f.fn));
console.log('  fn bytes seen:', [...fnset].sort((a, b) => a - b).map((x) => '0x' + x.toString(16)).join(', '));
console.log('  fn=0x1F present? ', fnset.has(0x1f));
console.log('  fn=0x77 present? ', fnset.has(0x77));
console.log('  fn=0x0E present? ', fnset.has(0x0e));

function firstWithAction(action: number, len?: number) {
  return frames.find((f) => f.model === 0x15 && f.fn === 0x01 && f.bytes.length >= 16
    && dec14(f.bytes[10], f.bytes[11]) === action && (len === undefined || f.bytes.length === len));
}

console.log('\n=== fn=0x08 GET_FIRMWARE_VERSION (handshake) ===');
const fw = frames.find((f) => f.model === 0x15 && f.fn === 0x08);
if (fw) console.log('  ', hex(fw.bytes.slice(0, 24)), `... (${fw.bytes.length} B)`);

console.log('\n=== fn=0x47 DEVICE_INFO (handshake) ===');
const dev = frames.find((f) => f.model === 0x15 && f.fn === 0x47);
if (dev) console.log('  ', hex(dev.bytes), `(${dev.bytes.length} B)`);

console.log('\n=== fn=0x64 MULTIPURPOSE_RESPONSE ===');
const mp = frames.find((f) => f.model === 0x15 && f.fn === 0x64);
if (mp) console.log('  ', hex(mp.bytes), `(${mp.bytes.length} B)`);

const interesting: [string, number, number?][] = [
  ['action=0x0D 64B (bypass long-read)', 0x0d, 64],
  ['action=0x0D 80B', 0x0d, 80],
  ['action=0x0D 165B', 0x0d, 165],
  ['action=0x0E 23B (short read)', 0x0e, 23],
  ['action=0x10 23B', 0x10, 23],
  ['action=0x26 23B', 0x26, 23],
  ['action=0x1F 238B', 0x1f, 238],
  ['action=0x12 55B', 0x12, 55],
  ['action=0x12 56B', 0x12, 56],
  ['action=0x17 64B (init burst)', 0x17, 64],
  ['action=0x01 64B (WRITE)', 0x01, 64],
];

for (const [label, action, len] of interesting) {
  const f = firstWithAction(action, len);
  console.log(`\n=== ${label} ===`);
  if (!f) { console.log('  (none found)'); continue; }
  const b = f.bytes;
  console.log('  pidLow=0x' + dec14(b[6], b[7]).toString(16)
    + ' pidHigh=0x' + dec14(b[8], b[9]).toString(16)
    + ' action=0x' + dec14(b[10], b[11]).toString(16)
    + ' hdr3=0x' + dec14(b[12], b[13]).toString(16)
    + ' hdr4=0x' + dec14(b[14], b[15]).toString(16) + ` (=${dec14(b[14], b[15])} raw bytes)`);
  console.log('  bytes[0..30]:', hex(b.slice(0, Math.min(31, b.length))));
}
