/**
 * wf-ii-editor-minimal-path-detail.ts  (READ-ONLY)
 * Dump every frame for a chosen fn-set with full payload length + head,
 * so we can confirm request vs response pairing for the editor's
 * minimal read opcodes (0x0E, 0x20, 0x0F, 0x47, 0x08) and the per-edit
 * 0x74/0x75/0x76 triple body.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const wantedFns = new Set(process.argv.slice(3).map((s) => parseInt(s, 16)));
const buf = readFileSync(file);

let i = 0;
let idx = 0;
while (i < buf.length) {
  if (buf[i] !== 0xf0) { i++; continue; }
  const start = i;
  let j = i + 1;
  while (j < buf.length && buf[j] !== 0xf7) j++;
  if (j >= buf.length) break;
  const len = j - start + 1;
  if (len >= 7 && buf[start + 1] === 0x00 && buf[start + 2] === 0x01 && buf[start + 3] === 0x74) {
    const fn = buf[start + 5];
    if (wantedFns.size === 0 || wantedFns.has(fn)) {
      const payloadLen = Math.max(0, (j - 1) - (start + 6));
      const head: number[] = [];
      for (let p = start + 6; p < Math.min(start + 6 + 16, j - 1); p++) head.push(buf[p]);
      console.log(
        `frame#${idx} fn=0x${fn.toString(16).padStart(2, '0')} total=${len} payloadLen=${payloadLen} head=[${head.map((b) => b.toString(16).padStart(2, '0')).join(' ')}]`,
      );
    }
    idx++;
  }
  i = j + 1;
}
