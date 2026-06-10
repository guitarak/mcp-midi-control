/**
 * Golden tests for the gen-3 preset patch-body codec (presetHuffman.ts):
 * 3-to-16 unpacking, the dynamic Huffman decompressor, and CRC-16/CCITT.
 *
 * Self-contained goldens (no sample files), plus an OPTIONAL validation against
 * a real factory bank when the gitignored samples are present locally.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  decode3to16,
  encode16to3,
  huffmanUncompress,
  huffmanCompress,
  crc16ccitt,
  decodeRawPatch,
  reencodeRawPatch,
} from '../packages/fractal-modern/dist/presetHuffman.js';
import { parsePresetDump } from '../packages/fractal-modern/dist/presetDump.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { ok += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

console.log('gen-3 preset patch-body codec goldens:\n');

// 1. CRC-16/CCITT correctness via the universally-known check value:
//    CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection) of "123456789"
//    is 0x29B1. If our implementation reproduces it, the algorithm is right; the
//    device just uses a different init (0xAA55).
const check9 = crc16ccitt(new TextEncoder().encode('123456789'), 0xffff);
check('crc16ccitt("123456789", init=0xFFFF) === 0x29B1 (standard check value)', check9 === 0x29b1, `got 0x${check9.toString(16)}`);

// 2. 3-to-16 unpacking: 3 wire bytes -> one uint16 (b0 | b1<<7 | b2<<14) -> 2 LE.
//    0x55 0x54 0x02 -> 0x55 | 0x54<<7 | 0x02<<14 = 0xAA55 -> bytes 55 AA.
const w = decode3to16(new Uint8Array([0x55, 0x54, 0x02]));
check('decode3to16([55,54,02]) -> [0x55,0xAA] (0xAA55 LE)', w[0] === 0x55 && w[1] === 0xaa, `got [${w[0].toString(16)},${w[1].toString(16)}]`);

// 3. Huffman decode of a hand-built stream. Tree for symbols 'A'(0x41) and
//    'B'(0x42): 0 (internal) 1 <A> 1 <B>  => codes A=0, B=1. Then data bits
//    0 1 0 1 -> "ABAB".
function bitsToBytes(bits: number[]): Uint8Array {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
  return out;
}
const tree = [0, 1, ...[0,1,0,0,0,0,0,1], 1, ...[0,1,0,0,0,0,1,0]]; // 0, 1+0x41, 1+0x42
const data = [0, 1, 0, 1]; // A B A B
const decoded = huffmanUncompress(bitsToBytes([...tree, ...data]), 4);
check('huffmanUncompress(hand-built A/B tree) -> "ABAB"', new TextDecoder().decode(decoded) === 'ABAB', JSON.stringify(new TextDecoder().decode(decoded)));

// 4. Encoder round-trips (self-contained).
const sample = new TextEncoder().encode('the quick brown fox jumps over the lazy dog 0123456789 0123456789');
const rt = huffmanUncompress(huffmanCompress(sample), sample.length);
check('huffmanUncompress(huffmanCompress(x)) === x', rt.length === sample.length && rt.every((b, i) => b === sample[i]));
const single = new Uint8Array(50).fill(0x7e); // single-symbol edge case
const rtSingle = huffmanUncompress(huffmanCompress(single), single.length);
check('huffman round-trip on a single-symbol body', rtSingle.length === 50 && rtSingle.every((b) => b === 0x7e));
const img = new Uint8Array([0x55, 0xaa, 0x00, 0x80, 0x7f, 0x01]);
const imgRt = decode3to16(encode16to3(img));
check('decode3to16(encode16to3(x)) === x', imgRt.length === img.length && imgRt.every((b, i) => b === img[i]));

// 5. OPTIONAL: validate the full pipeline against a real factory bank if present.
const bankPath = 'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_A-250603-182903.syx';
if (existsSync(bankPath)) {
  const bank = new Uint8Array(readFileSync(bankPath));
  const dump = parsePresetDump(bank.subarray(0, 49336), 0, 0x10);
  const d = decodeRawPatch(dump.chunkPayloads);
  check('factory III preset 0: stored CRC == computed CRC (device-validated)', d.crcValid, `stored=0x${d.storedCrc.toString(16)} computed=0x${d.computedCrc.toString(16)}`);
  check('factory III preset 0: body decompresses to declared size', d.body.length === d.decompSize, `${d.body.length} vs ${d.decompSize}`);
  // Full authoring round-trip (his Layer 3): decode -> re-encode (recompress +
  // recompute CRC) -> decode -> body matches and the new patch self-validates.
  const re = reencodeRawPatch(d.rawPatch, d.body);
  const reCrcOk = ((re[0x04] | (re[0x05] << 8)) & 0xffff) === ((): number => { const t = re.slice(); t[0x04] = 0; t[0x05] = 0; return crc16ccitt(t, 0xaa55); })();
  const reBody = huffmanUncompress(re.subarray(0x4c, 0x4c + ((re[0x4a] | (re[0x4b] << 8)) & 0xffff)), (re[0x48] | (re[0x49] << 8)) & 0xffff);
  check('factory III preset 0: re-encoded patch carries a valid CRC', reCrcOk);
  check('factory III preset 0: re-encoded body decodes back byte-exact', reBody.length === d.body.length && reBody.every((b, i) => b === d.body[i]));
  check('factory III preset 0: re-encode preserves header [0x00:0x48] (name etc.)', re.subarray(0, 0x48).every((b, i) => b === d.rawPatch[i] || i === 0x04 || i === 0x05));
} else {
  console.log('  (skip) factory bank samples not present — self-contained goldens only');
}

console.log(`\n${ok} ok, ${fail} fail.`);
process.exit(fail === 0 ? 0 : 1);
