/**
 * Determine direction of the fn 0x0E frame in session-58-direct-sync.syx.
 * Print the frames in sequence around it. READ-ONLY.
 *
 * The probe SENT an empty-payload 0x0E and RECEIVED the 62-byte frame.
 * If session-58's 0x0E is byte-identical to the probe's 62-byte response,
 * then session-58's 0x0E is the DEVICE RESPONSE (not the editor request),
 * and there should be an EMPTY 0x0E request just before it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

const CAPTURE = path.resolve('samples/captured/session-58-direct-sync.syx');
const hex = (b: number) => b.toString(16).padStart(2, '0');
interface Frame { index: number; offset: number; length: number; fn: number; bytes: number[]; }
function walk(buf: Uint8Array): Frame[] {
  const frames: Frame[] = []; let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) { i++; continue; }
    const start = i; let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    if (j - start + 1 >= 7 && buf[start + 1] === 0x00 && buf[start + 2] === 0x01 && buf[start + 3] === 0x74 && buf[start + 4] === 0x07) {
      frames.push({ index: frames.length, offset: start, length: j - start + 1, fn: buf[start + 5], bytes: Array.from(buf.subarray(start, j + 1)) });
    }
    i = j + 1;
  }
  return frames;
}
const buf = new Uint8Array(readFileSync(CAPTURE));
const frames = walk(buf);
const idx0e = frames.findIndex((f) => f.fn === 0x0e);
console.log('=== Frames around the fn 0x0E in session-58-direct-sync ===');
for (let k = Math.max(0, idx0e - 6); k <= Math.min(frames.length - 1, idx0e + 4); k++) {
  const f = frames[k];
  const mark = k === idx0e ? '  <<< fn 0x0E' : '';
  console.log(`[${f.index}] off=0x${f.offset.toString(16)} fn=0x${hex(f.fn)} len=${f.length}  ${f.bytes.slice(0, 14).map(hex).join(' ')}${f.length > 14 ? ' ...' : ''}${mark}`);
}

// Is there an empty-payload 0x0E anywhere (the request)?
const empties = frames.filter((f) => f.fn === 0x0e && f.length <= 8);
console.log(`\nEmpty-payload 0x0E (request) frames found: ${empties.length}`);
empties.forEach((f) => console.log(`  [${f.index}] ${f.bytes.map(hex).join(' ')}`));

// Note: a single .syx capture file may concatenate BOTH directions
// (MIDI-OX style) or only one. Count total 0x0E frames:
console.log(`\nTotal 0x0E frames: ${frames.filter((f) => f.fn === 0x0e).length}`);

// XOR-checksum validity of the 62-byte 0x0E frame (does it pass as a
// well-formed device message?). cs is 2nd-to-last byte.
const f0e = frames[idx0e];
let acc = 0;
for (let k = 0; k < f0e.bytes.length - 2; k++) acc ^= f0e.bytes[k];
console.log(`\n0x0E frame checksum check: computed ${hex(acc & 0x7f)} vs frame's 2nd-last byte ${hex(f0e.bytes[f0e.bytes.length - 2])} => ${(acc & 0x7f) === f0e.bytes[f0e.bytes.length - 2] ? 'VALID checksum (last data byte is cs!)' : 'NOT a checksum (frame has no trailing cs; 55 payload bytes are all data)'}`);
