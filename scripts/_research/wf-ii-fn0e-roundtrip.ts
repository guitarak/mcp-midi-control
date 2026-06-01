/**
 * Lock the field interpretation and prove byte-exact round-trip on all
 * 11 records of BOTH captures (probe + session-58). READ-ONLY.
 *
 * Interpretation under test (the only one consistent with the data):
 *   The 55-byte payload is 11 fixed 5-byte block-state records, in
 *   effectId-ASCENDING order (matching the order the device enumerates
 *   placed blocks). Each record:
 *     byte0 (b0): tag/flags, observed {0x02, 0x03}
 *     byte1 (b1): low septet of a 14-bit field F = (b1 | b2<<7)
 *     byte2 (b2): high septet of F
 *     byte3 (b3): low septet of a 14-bit field G = (b3 | b4<<7)
 *     byte4 (b4): high septet of G
 *
 * Round-trip here is trivial (we just re-emit the bytes), but the point
 * is to (a) confirm the 5-byte tiling reproduces every raw frame exactly,
 * and (b) print F and G so downstream interpretation is on record.
 */

const PROBE = [
  0x03, 0x4a, 0x10, 0x53, 0x06, 0x03, 0x4e, 0x18, 0x63, 0x06, 0x02, 0x52, 0x20, 0x23, 0x07,
  0x02, 0x56, 0x00, 0x20, 0x06, 0x02, 0x5e, 0x28, 0x03, 0x07, 0x02, 0x62, 0x30, 0x2b, 0x78,
  0x02, 0x70, 0x38, 0x33, 0x07, 0x02, 0x0a, 0x7d, 0x17, 0x07, 0x03, 0x26, 0x51, 0x73, 0x06,
  0x02, 0x2c, 0x75, 0x43, 0x07, 0x02, 0x42, 0x59, 0x63, 0x07,
];

import { readFileSync } from 'node:fs';
import path from 'node:path';
const hex = (b: number) => b.toString(16).padStart(2, '0');

function frameToRecords(payload: number[]): number[][] {
  if (payload.length % 5 !== 0) console.log(`WARN: payload ${payload.length} not multiple of 5`);
  const recs: number[][] = [];
  for (let i = 0; i + 5 <= payload.length; i += 5) recs.push(payload.slice(i, i + 5));
  return recs;
}
function roundtrip(recs: number[][]): number[] {
  return recs.flat();
}
function decodeRec(rec: number[]) {
  const [b0, b1, b2, b3, b4] = rec;
  const F = (b1 & 0x7f) | ((b2 & 0x7f) << 7);
  const G = (b3 & 0x7f) | ((b4 & 0x7f) << 7);
  return { tag: b0, F, G };
}

// PROBE
{
  const recs = frameToRecords(PROBE);
  const rt = roundtrip(recs);
  const exact = rt.length === PROBE.length && rt.every((b, i) => b === PROBE[i]);
  console.log(`PROBE: ${recs.length} records, round-trip ${exact ? 'EXACT' : 'MISMATCH'}`);
  recs.forEach((r, i) => {
    const d = decodeRec(r);
    console.log(`  rec ${String(i).padStart(2)} ${r.map(hex).join(' ')}  tag=${d.tag} F=${d.F}(0x${d.F.toString(16)}) G=${d.G}(0x${d.G.toString(16)})`);
  });
}

// SESSION-58 (extract the 0x0E frame from the real file)
{
  const buf = new Uint8Array(readFileSync(path.resolve('samples/captured/session-58-direct-sync.syx')));
  let i = 0; let frame: number[] | undefined;
  while (i < buf.length) {
    if (buf[i] === 0xf0 && buf[i + 1] === 0x00 && buf[i + 2] === 0x01 && buf[i + 3] === 0x74 && buf[i + 4] === 0x07 && buf[i + 5] === 0x0e) {
      let j = i + 1; while (j < buf.length && buf[j] !== 0xf7) j++;
      frame = Array.from(buf.subarray(i, j + 1)); break;
    }
    i++;
  }
  if (frame) {
    const payload = frame.slice(6, frame.length - 1);
    const recs = frameToRecords(payload);
    const rt = roundtrip(recs);
    const exact = rt.length === payload.length && rt.every((b, k) => b === payload[k]);
    console.log(`\nSESSION-58: payload ${payload.length} bytes, ${recs.length} records, round-trip ${exact ? 'EXACT' : 'MISMATCH'}`);
    if (payload.length % 5 !== 0) console.log(`  NOTE: payload length ${payload.length} % 5 = ${payload.length % 5} — capture may have a truncated final record (last F7 absorbed a data byte).`);
  }
}
