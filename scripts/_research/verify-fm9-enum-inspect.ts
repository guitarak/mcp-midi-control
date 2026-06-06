import { readFileSync } from 'node:fs';

const path = 'C:/dev/mcp-midi-tools/samples/captured/decoded/fm9-enum-label-sweep-harp-2026-06-04.frames.json';
const frames = JSON.parse(readFileSync(path, 'utf8')) as Array<{
  dir: string; t: number; fn: number; sub: number; len: number; hex: string;
}>;

function hexToBytes(hex: string): number[] {
  return hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
}
function payload(bytes: number[]): number[] {
  return bytes.slice(5, bytes.length - 2);
}
function septetUnpack(payloadBytes: number[]): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const b of payloadBytes) {
    acc = (acc << 7) | (b & 0x7f);
    bits += 7;
    if (bits >= 8) { out.push((acc >> (bits - 8)) & 0xff); bits -= 8; }
  }
  return out;
}
function show(bytes: number[]): string {
  return bytes.map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.')).join('');
}

// Inspect frame 11 (first "Clean" hit) plus its surrounding OUT request frame.
for (const idx of [10, 11, 178, 179]) {
  const f = frames[idx];
  const bytes = hexToBytes(f.hex);
  const pl = payload(bytes);
  const up = septetUnpack(pl);
  console.log(`\n=== frame#${idx} dir=${f.dir} fn=${f.fn} sub=${f.sub} len=${f.len} bytelen=${bytes.length} ===`);
  console.log('header fn/sub bytes:', bytes.slice(5, 12).map(b=>b.toString(16).padStart(2,'0')).join(' '));
  console.log('SEPTET ascii:', show(up));
}

// Count fn=1 sub=46 IN frames and what strings they carry. Group all septet runs by frame fn/sub.
const bySubGroup = new Map<string, Set<string>>();
function letterRuns(bytes: number[], minLetters = 4): string[] {
  const out: string[] = []; let cur=''; let letters=0;
  for (const b of bytes) {
    const p = b>=0x20&&b<=0x7e; const l=(b>=0x41&&b<=0x5a)||(b>=0x61&&b<=0x7a);
    if(p){cur+=String.fromCharCode(b); if(l)letters++;} else { if(letters>=minLetters)out.push(cur.trim()); cur='';letters=0; }
  }
  if(letters>=minLetters)out.push(cur.trim());
  return out;
}
for (const f of frames) {
  const bytes = hexToBytes(f.hex);
  const up = septetUnpack(payload(bytes));
  const key = `fn=${f.fn} sub=${f.sub} dir=${f.dir}`;
  if (!bySubGroup.has(key)) bySubGroup.set(key, new Set());
  for (const r of letterRuns(up)) bySubGroup.get(key)!.add(r);
}
console.log('\n=== strings grouped by fn/sub/dir ===');
for (const [k,set] of bySubGroup) {
  console.log(`\n${k}: (${set.size} distinct)`);
  console.log([...set].slice(0,40).map(s=>JSON.stringify(s)).join(', '));
}
