/**
 * Read-only investigation: independently confirm BoodieTraps' gen-3 continuous-write
 * claims against our OWN captured FM9 frames. No hardware, no device writes.
 *
 *  (1) Decode every sub=0x52 (mouse-drag SET) frame's 5-septet float32 value at pos 12-16
 *      and check it forms a sensible normalized ramp (amp Balance 0->-100; reverb-type sweep).
 *  (2) Characterize the 0x56 "begin-gesture" pairing around 0x52 runs.
 *  (3) Verify Drew's checksum rule XOR(F0..last payload) & 0x7F on the 0x52 frames.
 *  (4) Characterize the 152 super-duos2 .syx envelope (0x77/0x78/0x79) + body entropy.
 */
import { readFileSync } from 'node:fs';
import { decode5SeptetFloat32 } from '../../packages/fractal-midi/src/axe-fx-iii/setParam.ts';
import { parsePresetDump, extractPresetName } from '../../packages/fractal-modern/src/presetDump.ts';

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}
function hexToBytes(hex: string): number[] {
  return hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
}
function fractalXorChecksum(bytes: number[]): number {
  // XOR(F0 .. last payload byte, i.e. everything except the stored cksum + F7) & 0x7F
  let x = 0;
  for (let i = 0; i < bytes.length - 2; i++) x ^= bytes[i];
  return x & 0x7f;
}

type Frame = { dir: string; t: string; fn: number; sub: number; len: number; hex: string };

function loadFrames(path: string): Frame[] {
  return JSON.parse(readFileSync(path, 'utf8')) as Frame[];
}

function analyse52(path: string, label: string) {
  const frames = loadFrames(path);
  const f52 = frames.filter((f) => f.sub === 0x52);
  console.log(`\n=== ${label} ===`);
  console.log(`sub=0x52 frames: ${f52.length}`);
  let cksumOk = 0;
  const rows: { dir: string; eid: number; pid: number; val: number; raw: number }[] = [];
  for (const f of f52) {
    const b = hexToBytes(f.hex);
    const eid = decode14(b[8], b[9]);
    const pid = decode14(b[10], b[11]);
    const val = decode5SeptetFloat32(b[12], b[13], b[14], b[15], b[16]);
    const raw = ((b[12] & 0x7f) | ((b[13] & 0x7f) << 7) | ((b[14] & 0x7f) << 14)
      | ((b[15] & 0x7f) << 21) | ((b[16] & 0x7f) << 28)) >>> 0;
    if (fractalXorChecksum(b) === (b[b.length - 2] & 0x7f)) cksumOk++;
    rows.push({ dir: f.dir, eid, pid, val, raw });
  }
  console.log(`checksum XOR&0x7F matches stored: ${cksumOk}/${f52.length}`);
  // Group by (eid,pid) to show the swept param(s)
  const byParam = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `eid=${r.eid} pid=${r.pid}`;
    if (!byParam.has(k)) byParam.set(k, []);
    byParam.get(k)!.push(r);
  }
  for (const [k, rs] of byParam) {
    const vals = rs.map((r) => r.val);
    console.log(`  ${k}  (${rs.length} frames, dir=${[...new Set(rs.map((r) => r.dir))].join('/')})`);
    console.log(`     normalized float32 sequence: ${vals.map((v) => v.toFixed(4)).join(', ')}`);
    console.log(`     min=${Math.min(...vals).toFixed(4)} max=${Math.max(...vals).toFixed(4)}`);
  }
}

function analyseGesture(path: string, label: string) {
  const frames = loadFrames(path);
  console.log(`\n--- gesture pairing: ${label} ---`);
  // Show the interleaving of 0x56 (begin) and 0x52 (drag) in order
  const seq = frames
    .filter((f) => f.sub === 0x56 || f.sub === 0x52)
    .map((f) => (f.sub === 0x56 ? `[56:${f.dir}]` : '52'));
  // Compress runs of '52'
  const out: string[] = [];
  let run = 0;
  for (const s of seq) {
    if (s === '52') run++;
    else {
      if (run) { out.push(`52x${run}`); run = 0; }
      out.push(s);
    }
  }
  if (run) out.push(`52x${run}`);
  console.log(`  ${out.join(' ')}`);
  // Show the 0x56 frame payloads (pid sentinel 0x7f2d per Drew)
  for (const f of frames.filter((x) => x.sub === 0x56)) {
    const b = hexToBytes(f.hex);
    console.log(`  56 ${f.dir}: pid=${decode14(b[10], b[11]).toString(16)} hex=${f.hex}`);
  }
}

function analyseSyxEnvelope(path: string, label: string) {
  const buf = readFileSync(path);
  console.log(`\n=== ${label} (${buf.length} bytes) ===`);
  // Split into F0..F7 frames
  const frames: number[][] = [];
  let cur: number[] = [];
  for (const byte of buf) {
    if (byte === 0xf0) cur = [byte];
    else if (byte === 0xf7) { cur.push(byte); frames.push(cur); cur = []; }
    else cur.push(byte);
  }
  const byFn = new Map<number, number>();
  let bodyBytes: number[] = [];
  for (const fr of frames) {
    const fn = fr[5];
    byFn.set(fn, (byFn.get(fn) ?? 0) + 1);
    if (fn === 0x78) bodyBytes.push(...fr.slice(6, -2)); // 0x78 = body payload
  }
  console.log(`frames: ${frames.length}`);
  for (const [fn, n] of [...byFn].sort((a, b) => a[0] - b[0])) {
    console.log(`  fn=0x${fn.toString(16)}: ${n} frame(s)`);
  }
  // Shannon entropy of the concatenated 0x78 body (high ~= compressed)
  if (bodyBytes.length) {
    const counts = new Array(256).fill(0);
    for (const b of bodyBytes) counts[b]++;
    let H = 0;
    for (const c of counts) if (c) { const p = c / bodyBytes.length; H -= p * Math.log2(p); }
    console.log(`  0x78 body: ${bodyBytes.length} septet-bytes, Shannon entropy ${H.toFixed(2)} bits/byte (8.0 = random/compressed)`);
    // Does 0xAA / 0x55 appear notably? (Drew: CRC init 0xAA55)
    console.log(`  byte 0xAA count=${counts[0xaa]}, 0x55 count=${counts[0x55]}, 0x2a count=${counts[0x2a]}, 0x55 in septet space`);
  }
}

function analyseUint16Image(path: string, label: string) {
  const buf = new Uint8Array(readFileSync(path));
  const parsed = parsePresetDump(buf, 0, 0x12);
  console.log(`\n=== ${label}: uint16-image analysis (the "compressed body?" question) ===`);
  console.log(`  parsePresetDump OK: model=0x${parsed.modelId.toString(16)}, chunks=${parsed.chunkPayloads.length}`);
  console.log(`  extractPresetName -> "${extractPresetName(parsed)}"  (name decodes => body is plain uint16, NOT compressed)`);
  // Unpack every uint16 word across all chunks, measure entropy of the WORD stream.
  const words: number[] = [];
  for (const ch of parsed.chunkPayloads) {
    for (let off = 2; off + 2 < ch.length; off += 3) {
      words.push((ch[off] | (ch[off + 1] << 7) | (ch[off + 2] << 14)) & 0xffff);
    }
  }
  const counts = new Map<number, number>();
  for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1);
  let H = 0;
  for (const c of counts.values()) { const p = c / words.length; H -= p * Math.log2(p); }
  console.log(`  ${words.length} uint16 words, ${counts.size} distinct, entropy ${H.toFixed(2)} bits/word`);
  const zeros = counts.get(0) ?? 0;
  console.log(`  zero-words: ${zeros} (${(100 * zeros / words.length).toFixed(1)}%)  <- high zero-fraction = sparse/uncompressed`);
  // Exploratory: do the read-leg amp ordinals (65 SV Bass 2, 264 SV Bass 1, 179 Texas Star Clean) appear as raw words?
  for (const ord of [65, 179, 264]) {
    console.log(`  word==${ord} occurs ${counts.get(ord) ?? 0}x (read-leg ordinal; stored-index space may differ)`);
  }
}

const D = 'samples/captured/decoded';
analyse52(`${D}/fm9-amp-balance-0-to-neg100-ralf-2026-06-04.frames.json`, 'AMP BALANCE 0 -> -100 (continuous)');
analyse52(`${D}/fm9-reverb-type-medroom-to-medspring-2026-06-03.frames.json`, 'REVERB TYPE sweep');
analyseGesture(`${D}/fm9-amp-balance-0-to-neg100-ralf-2026-06-04.frames.json`, 'amp-balance');
analyseSyxEnvelope('samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx', '152 Super Duos2 .syx');
analyseUint16Image('samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx', '152 Super Duos2');
