/**
 * ADVERSARIAL re-derivation of the FM9 gen-3 READ/BROADCAST decode claims.
 * Reads the de-framed frames JSON directly; recomputes every septet decode,
 * checksum, and float32 from raw bytes. Trusts nothing from the prior agent.
 */
import { readFileSync } from 'node:fs';

interface Frame { dir: 'IN' | 'OUT'; t: string; fn: number; sub: number; len: number; hex: string; }

function load(p: string): Frame[] {
  return JSON.parse(readFileSync(p, 'utf8')) as Frame[];
}
function bytes(f: Frame): number[] { return f.hex.split(' ').map((h) => parseInt(h, 16)); }

// septet little-endian 14-bit: lo7 | hi7<<7
function sept14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
// 3-septet packValue16: lo7 | mid7<<7 | top<<14
function sept3(a: number, b: number, c: number): number {
  return (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x7f) << 14);
}
// XOR checksum F0..last-payload, &0x7f. Returns computed vs stored.
function checksum(b: number[]): { computed: number; stored: number; ok: boolean } {
  // last byte F7, byte before = stored checksum
  const stored = b[b.length - 2];
  let x = 0;
  for (let i = 0; i < b.length - 2; i++) x ^= b[i];
  x &= 0x7f;
  return { computed: x, stored, ok: x === stored };
}

const REVERB = process.argv[2] ?? 'samples/captured/decoded/fm9-reverb-type-medroom-to-medspring-2026-06-03.frames.json';
const READBACK = process.argv[3] ?? 'samples/captured/decoded/fm9-readback-htrom2015-2026-06-03.frames.json';

const rev = load(REVERB);
const rb = load(READBACK);

console.log(`=== reverb-type capture: ${rev.length} FM9 frames ===`);
console.log(`=== readback capture:    ${rb.length} FM9 frames ===\n`);

// ---------------------------------------------------------------------------
// CLAIM 3: fn=0x1F is a 10-byte OUT poll, reply = 0x74/0x75/0x76 burst.
// ---------------------------------------------------------------------------
console.log('--- CLAIM 3: fn=0x1F poll ---');
const f1f = rev.filter((f) => f.fn === 0x1f);
const f1fOut = f1f.filter((f) => f.dir === 'OUT');
const f1fIn = f1f.filter((f) => f.dir === 'IN');
console.log(`fn=0x1F: total ${f1f.length}, OUT ${f1fOut.length}, IN ${f1fIn.length}`);
const lenSet1f = new Set(f1f.map((f) => f.len));
console.log(`fn=0x1F lengths: ${[...lenSet1f].join(',')}`);
if (f1fOut[0]) {
  const b = bytes(f1fOut[0]);
  console.log(`first 0x1F OUT: ${f1fOut[0].hex}`);
  console.log(`  blockId sept14(b6=${b[6].toString(16)},b7=${b[7].toString(16)}) = ${sept14(b[6], b[7])}`);
  console.log(`  checksum ${JSON.stringify(checksum(b))}`);
}
// What follows the first few 0x1F OUT frames in time order (whole stream)?
const ordered = rev.slice().sort((a, b) => parseFloat(a.t) - parseFloat(b.t));
let burstFollows = 0, polls = 0;
for (let i = 0; i < ordered.length; i++) {
  if (ordered[i].fn === 0x1f && ordered[i].dir === 'OUT') {
    polls++;
    // find next frame within 0.01s
    const t = parseFloat(ordered[i].t);
    const nxt = ordered.slice(i + 1).find((f) => parseFloat(f.t) >= t);
    if (nxt && nxt.fn === 0x74) burstFollows++;
  }
}
console.log(`0x1F OUT polls=${polls}, immediately followed by 0x74 HEAD: ${burstFollows}`);

// ---------------------------------------------------------------------------
// CLAIM 1: 0x74 HEAD / 0x75 BODY / 0x76 END framing
// ---------------------------------------------------------------------------
console.log('\n--- CLAIM 1: 0x74/0x75/0x76 framing ---');
const heads = rev.filter((f) => f.fn === 0x74);
const bodies = rev.filter((f) => f.fn === 0x75);
const ends = rev.filter((f) => f.fn === 0x76);
console.log(`0x74 HEAD: ${heads.length}, 0x75 BODY: ${bodies.length}, 0x76 END: ${ends.length}`);

// Inspect the burst around t=5.24
const burst = ordered.filter((f) => [0x74, 0x75, 0x76].includes(f.fn) &&
  parseFloat(f.t) >= 5.23 && parseFloat(f.t) <= 5.30);
console.log(`Burst frames t=5.23..5.30: ${burst.map((f) => `${f.fn.toString(16)}@${f.t}(${f.len}B)`).join(' ')}`);
for (const f of burst) {
  const b = bytes(f);
  if (f.fn === 0x74) {
    const blockId = sept14(b[6], b[7]);
    const itemCount = sept14(b[8], b[9]);
    const flag = b[10];
    console.log(`  0x74 HEAD: blockId=${blockId} itemCount=${itemCount} flag=0x${flag.toString(16)} cs=${JSON.stringify(checksum(b))}`);
  } else if (f.fn === 0x75) {
    const recCount = sept14(b[6], b[7]);
    const payloadLen = b.length - 6 - 2 - 2; // F0..fn(6 bytes incl fn at idx5) then 2 count bytes; minus cs+F7(2)
    // Actually: header = F0 00 01 74 12 75 = 6 bytes (idx0..5). then count b6,b7 = 2. then records. then cs,F7 = 2.
    const recBytes = b.length - 6 - 2 - 2;
    console.log(`  0x75 BODY: recCount=${recCount} bodyLen=${f.len} recBytes=${recBytes} recBytes/3=${(recBytes / 3).toFixed(2)} cs=${JSON.stringify(checksum(b))}`);
  } else {
    console.log(`  0x76 END: ${f.hex} cs=${JSON.stringify(checksum(b))}`);
  }
}

// ---------------------------------------------------------------------------
// CLAIM 2 + 7: positional records; reverb type record[10] 1->16; SET enum 524.
// ---------------------------------------------------------------------------
console.log('\n--- CLAIM 2 + 7: positional records & enum id ---');
// Decode 0x75 records into a flat array (concatenate pages by recCount).
function decode75pages(frames: Frame[]): number[] {
  const recs: number[] = [];
  for (const f of frames) {
    const b = bytes(f);
    const recCount = sept14(b[6], b[7]);
    let off = 8; // after F0..75 (6) + count (2)
    for (let i = 0; i < recCount; i++) {
      recs.push(sept3(b[off], b[off + 1], b[off + 2]));
      off += 3;
    }
  }
  return recs;
}

// Find baseline burst (block 66) earliest, and post-SET burst (after SET).
function burstsForBlock(frames: Frame[]): Array<{ t: number; head: Frame; bodies: Frame[]; end?: Frame }> {
  const ord = frames.slice().sort((a, b) => parseFloat(a.t) - parseFloat(b.t));
  const out: Array<{ t: number; head: Frame; bodies: Frame[]; end?: Frame }> = [];
  let cur: { t: number; head: Frame; bodies: Frame[]; end?: Frame } | null = null;
  for (const f of ord) {
    if (f.fn === 0x74) { if (cur) out.push(cur); cur = { t: parseFloat(f.t), head: f, bodies: [] }; }
    else if (f.fn === 0x75 && cur) cur.bodies.push(f);
    else if (f.fn === 0x76 && cur) { cur.end = f; out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}
const allBursts = burstsForBlock(rev);
console.log(`Total bursts: ${allBursts.length}`);
// block id per burst
for (const burst of allBursts.slice(0, 3)) {
  const hb = bytes(burst.head);
  console.log(`  burst@${burst.t} block=${sept14(hb[6], hb[7])} itemCount=${sept14(hb[8], hb[9])} bodies=${burst.bodies.length}`);
}

// Locate the SET (fn=0x01 sub=0x09) for reverb
const sets = rev.filter((f) => f.dir === 'OUT' && f.fn === 0x01 && f.sub === 0x09);
console.log(`\nfn=0x01 sub=0x09 SET frames: ${sets.length}`);
for (const s of sets) {
  const b = bytes(s);
  // doc claims eff at b8,b9; pid at b10,b11; value at b15,b16
  console.log(`  SET@${s.t} len=${s.len}: ${s.hex}`);
  console.log(`    b6=sub=${b[6].toString(16)} b7=${b[7].toString(16)}`);
  console.log(`    eff sept14(b8=${b[8].toString(16)},b9=${b[9].toString(16)})=${sept14(b[8], b[9])}`);
  console.log(`    pid sept14(b10=${b[10].toString(16)},b11=${b[11].toString(16)})=${sept14(b[10], b[11])}`);
  console.log(`    val@b15,b16 sept14=${sept14(b[15], b[16])}  3sept(b15,b16,b17)=${sept3(b[15], b[16], b[17])}`);
  console.log(`    cs=${JSON.stringify(checksum(b))}`);
}

// baseline burst (just before SET) vs post-SET burst
const setT = sets.length ? parseFloat(sets[0].t) : Infinity;
const baselineBurst = allBursts.filter((bu) => bu.t < setT).pop();
const postBurst = allBursts.filter((bu) => bu.t > setT)[0];
if (baselineBurst && postBurst) {
  const baseRecs = decode75pages(baselineBurst.bodies);
  const postRecs = decode75pages(postBurst.bodies);
  console.log(`\nbaseline burst@${baselineBurst.t}: ${baseRecs.length} records`);
  console.log(`post-SET burst@${postBurst.t}: ${postRecs.length} records`);
  console.log(`record[0] base=${baseRecs[0]} post=${postRecs[0]} (full-scale 65534?)`);
  console.log(`record[10] base=${baseRecs[10]} post=${postRecs[10]}`);
  const diffs: Array<[number, number, number]> = [];
  const n = Math.max(baseRecs.length, postRecs.length);
  for (let i = 0; i < n; i++) if (baseRecs[i] !== postRecs[i]) diffs.push([i, baseRecs[i], postRecs[i]]);
  console.log(`diff count: ${diffs.length}`);
  console.log(`diffs: ${diffs.map(([i, a, b]) => `[${i}]${a}->${b}`).join(' ')}`);
}

// ---------------------------------------------------------------------------
// CLAIM 7 echo: 60B IN echo float32 = 16/78
// ---------------------------------------------------------------------------
console.log('\n--- CLAIM 7 echo float32 ---');
// 5-septet float32 decode (from prior art parseGen3SetValueEcho).
function decode5SeptetFloat32(b0: number, b1: number, b2: number, b3: number, b4: number): number {
  // 5 septets -> 32 bits, LE order assumed.
  const raw = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x7f) << 14) | ((b3 & 0x7f) << 21) | ((b4 & 0x7f) << 28);
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(raw >>> 0, 0);
  return buf.readFloatLE(0);
}
// find 60B IN frames after the SET
const echoes = rev.filter((f) => f.dir === 'IN' && f.len === 60 && parseFloat(f.t) > setT && parseFloat(f.t) < setT + 0.2);
console.log(`60B IN frames just after SET: ${echoes.length}`);
for (const e of echoes.slice(0, 3)) {
  const b = bytes(e);
  console.log(`  echo@${e.t}: ${e.hex.slice(0, 80)}...`);
  // doc: float32 of bytes[12..16]
  const fl = decode5SeptetFloat32(b[12], b[13], b[14], b[15], b[16]);
  console.log(`    sub=${b[6].toString(16)} float32(b12..16)=${fl}  16/78=${(16 / 78).toFixed(8)}  *78=${(fl * 78).toFixed(4)}`);
  console.log(`    eff sept14(b8,b9)=${sept14(b[8], b[9])} pid sept14(b10,b11)=${sept14(b[10], b[11])}`);
}

// ---------------------------------------------------------------------------
// CLAIM 4: sub=0x7b live poll, ordinal addressing
// CLAIM 5: sub=0x37 meter, trailer 12 04
// CLAIM 6: sub=0x2e 755B
// ---------------------------------------------------------------------------
console.log('\n--- CLAIM 4/5/6: sub-action catalog (readback capture) ---');
const subDist = new Map<string, number>();
for (const f of rb) {
  if (f.fn === 0x01) {
    const k = `${f.dir} sub=${f.sub.toString(16)} len=${f.len}`;
    subDist.set(k, (subDist.get(k) ?? 0) + 1);
  }
}
console.log('fn=0x01 sub/len/dir dist (readback):');
for (const [k, n] of [...subDist.entries()].sort()) console.log(`  ${k}: ${n}`);

// sub=0x7b ordinal sweep for Mix
const s7b = rb.filter((f) => f.fn === 0x01 && f.sub === 0x7b);
console.log(`\nsub=0x7b frames: ${s7b.length}`);
const ord7bOut = new Map<number, number>();
for (const f of s7b.filter((x) => x.dir === 'OUT')) {
  const b = bytes(f);
  const ordn = sept14(b[8], b[9]);
  ord7bOut.set(ordn, (ord7bOut.get(ordn) ?? 0) + 1);
}
console.log(`sub=0x7b OUT ordinals (b8,b9): ${[...ord7bOut.entries()].map(([o, n]) => `${o}×${n}`).join(' ')}`);
// IN values for each ordinal
const ordVals = new Map<number, Set<number>>();
for (const f of s7b.filter((x) => x.dir === 'IN')) {
  const b = bytes(f);
  const ordn = sept14(b[8], b[9]);
  const val = sept3(b[12], b[13], b[14]);
  if (!ordVals.has(ordn)) ordVals.set(ordn, new Set());
  ordVals.get(ordn)!.add(val);
}
for (const [o, vs] of [...ordVals.entries()].sort()) {
  const arr = [...vs].sort((a, b) => a - b);
  console.log(`  ord ${o}: ${arr.length} distinct vals, range ${arr[0]}..${arr[arr.length - 1]}${arr.length <= 12 ? ' = ' + arr.join(',') : ''}`);
}

// sub=0x37 meter + trailer
const s37 = rb.filter((f) => f.fn === 0x01 && f.sub === 0x37);
console.log(`\nsub=0x37 frames: ${s37.length}`);
const s37out = new Set(s37.filter((x) => x.dir === 'OUT').map((x) => x.hex));
console.log(`sub=0x37 OUT unique frames: ${s37out.size}`);
const s37in = s37.filter((x) => x.dir === 'IN').slice(0, 6);
for (const f of s37in) {
  const b = bytes(f);
  console.log(`  37 IN: val3sept(b12,b13,b14)=${sept3(b[12], b[13], b[14])} trailer b15,b16=${b[15]?.toString(16)},${b[16]?.toString(16)}`);
}

// sub=0x2e size
const s2e = rb.filter((f) => f.fn === 0x01 && f.sub === 0x2e);
console.log(`\nsub=0x2e frames: ${s2e.length} (readback)`);
const s2eRev = rev.filter((f) => f.fn === 0x01 && f.sub === 0x2e);
console.log(`sub=0x2e frames: ${s2eRev.length} (reverb cap)`);
const s2eLen = new Map<string, Set<number>>();
for (const f of [...s2e, ...s2eRev]) {
  const k = f.dir;
  if (!s2eLen.has(k)) s2eLen.set(k, new Set());
  s2eLen.get(k)!.add(f.len);
}
for (const [d, ls] of s2eLen) console.log(`  sub=0x2e ${d} lengths: ${[...ls].join(',')}`);
