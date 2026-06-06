import { readFileSync } from 'node:fs';

const path = 'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-enum-label-sweep-harp-2026-06-04.frames.json';
const frames = JSON.parse(readFileSync(path, 'utf8')) as Array<{
  dir: string; t: number; fn: number; sub: number; len: number; hex: string;
}>;

console.log('total frames:', frames.length);

const needles = ['Spring','Hall','Room','Plexi','Texas','Blues','SV Bass','Clean','Lead','Nashville','Music'];

function hexToBytes(hex: string): number[] {
  return hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
}

// payload = bytes after the 5-byte header (f0 00 01 74 12) up to but not including checksum + f7
function payload(bytes: number[]): number[] {
  // strip f0 ... f7. header is 5 bytes, trailing checksum+f7 = 2 bytes
  return bytes.slice(5, bytes.length - 2);
}

function asciiRuns(bytes: number[], minLen = 4): string[] {
  const out: string[] = [];
  let cur = '';
  for (const b of bytes) {
    if (b >= 0x20 && b <= 0x7e) {
      cur += String.fromCharCode(b);
    } else {
      if (cur.length >= minLen) out.push(cur);
      cur = '';
    }
  }
  if (cur.length >= minLen) out.push(cur);
  return out;
}

// streaming MSB-first 8->7 septet unpack
function septetUnpack(payloadBytes: number[]): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const b of payloadBytes) {
    acc = (acc << 7) | (b & 0x7f);
    bits += 7;
    if (bits >= 8) {
      out.push((acc >> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return out;
}

// require >=4 LETTERS specifically (a-zA-Z), per claim
function letterRuns(bytes: number[], minLetters = 4): string[] {
  const out: string[] = [];
  let cur = '';
  let letters = 0;
  for (const b of bytes) {
    const isPrintable = b >= 0x20 && b <= 0x7e;
    const isLetter = (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
    if (isPrintable) {
      cur += String.fromCharCode(b);
      if (isLetter) letters++;
    } else {
      if (letters >= minLetters) out.push(cur);
      cur = ''; letters = 0;
    }
  }
  if (letters >= minLetters) out.push(cur);
  return out;
}

const allRawRuns = new Map<string, number>();
const allSeptetRuns = new Map<string, number>();
const needleHits: string[] = [];

let csFails = 0;

for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  const bytes = hexToBytes(f.hex);

  // checksum check
  let xor = 0;
  for (let k = 0; k < bytes.length - 2; k++) xor ^= bytes[k];
  xor &= 0x7f;
  const cs = bytes[bytes.length - 2];
  if (xor !== cs) csFails++;

  const pl = payload(bytes);

  // raw scan: scan whole frame bytes (raw) AND payload — use full bytes for raw run detection
  const rawRuns = letterRuns(bytes);
  for (const r of rawRuns) allRawRuns.set(r, (allRawRuns.get(r) ?? 0) + 1);

  // septet unpack of payload
  const unpacked = septetUnpack(pl);
  const sRuns = letterRuns(unpacked);
  for (const r of sRuns) allSeptetRuns.set(r, (allSeptetRuns.get(r) ?? 0) + 1);

  // needle search in both raw frame string and unpacked string (case-insensitive)
  const rawStr = bytes.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
  const upStr = unpacked.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
  for (const n of needles) {
    if (rawStr.includes(n)) needleHits.push(`needle "${n}" RAW frame#${i} fn=${f.fn} sub=${f.sub} dir=${f.dir}`);
    if (upStr.includes(n)) needleHits.push(`needle "${n}" SEPTET frame#${i} fn=${f.fn} sub=${f.sub} dir=${f.dir}`);
  }
}

console.log('checksum failures:', csFails, '/', frames.length);
console.log('\n=== NEEDLE HITS ===');
console.log(needleHits.length ? needleHits.join('\n') : '(none)');

console.log('\n=== RAW ASCII letter-runs (>=4 letters) ===');
[...allRawRuns.entries()].sort((a,b)=>b[1]-a[1]).forEach(([r,c])=>console.log(`  ${c}x  ${JSON.stringify(r)}`));

console.log('\n=== SEPTET-UNPACK ASCII letter-runs (>=4 letters) ===');
[...allSeptetRuns.entries()].sort((a,b)=>b[1]-a[1]).slice(0,200).forEach(([r,c])=>console.log(`  ${c}x  ${JSON.stringify(r)}`));
console.log('septet distinct runs:', allSeptetRuns.size);
