/**
 * Decode the first real FM9 USBPcap capture (htrom2015, 2026-06-03) into
 * per-direction SysEx streams and analyze the gen-3 wire shape on real FM9
 * hardware.
 *
 * Reuses the proven pcapng → USBPcap pseudo-header → USB-MIDI 4-byte de-frame
 * → SysEx pipeline from `decode-usbpcap-axefx.ts`, generalized to ANY Fractal
 * model byte (here FM9 = 0x12) so we can confirm the III-codec reuse holds.
 *
 * Capture metadata (from the owner's email):
 *   FM9 firmware 11.00 / FM9-Edit 1.03.19 / Patch 152 "Super Duos2"
 *   Actions: idle → reload preset → click Reverb block → Reverb Mix
 *            100% → 99.5% → 100%   (read off the FM9 front panel)
 *   Captured on Windows (USBPcap) despite the owner being a Mac user.
 *
 * Usage: npx tsx scripts/_research/decode-fm9-capture.ts <path.pcapng>
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const FRACTAL_MFR = [0xf0, 0x00, 0x01, 0x74];
const FM9_MODEL = 0x12;
const MODEL_NAMES: Record<number, string> = {
  0x03: 'Standard/Ultra', 0x07: 'II', 0x10: 'III', 0x11: 'FM3',
  0x12: 'FM9', 0x14: 'VP4', 0x15: 'AM4',
};

function hex(b: number, w = 2): string { return b.toString(16).padStart(w, '0'); }
function toHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes).map((b) => hex(b)).join(' ');
}

// ─── pcapng block parser (verbatim from decode-usbpcap-axefx.ts) ────────────
const BLOCK_EPB = 0x00000006;

function* iteratePcapngBlocks(buf: Buffer): Generator<{ type: number; body: Buffer }> {
  let off = 0;
  while (off + 8 <= buf.length) {
    const blockType = buf.readUInt32LE(off);
    const blockLen = buf.readUInt32LE(off + 4);
    if (blockLen < 12 || off + blockLen > buf.length) break;
    yield { type: blockType, body: buf.subarray(off + 8, off + blockLen - 4) };
    off += blockLen;
  }
}

interface ParsedPacket { tsHi: number; tsLo: number; data: Buffer; }
function parseEpb(body: Buffer): ParsedPacket | null {
  if (body.length < 20) return null;
  const tsHi = body.readUInt32LE(4);
  const tsLo = body.readUInt32LE(8);
  const capLen = body.readUInt32LE(12);
  if (20 + capLen > body.length) return null;
  return { tsHi, tsLo, data: Buffer.from(body.subarray(20, 20 + capLen)) };
}

interface UsbPacket { endpoint: number; transferType: number; direction: 'IN' | 'OUT'; payload: Buffer; }
function parseUsbPcap(packet: Buffer): UsbPacket | null {
  if (packet.length < 27) return null;
  const headerLen = packet.readUInt16LE(0);
  if (headerLen > packet.length) return null;
  const endpoint = packet.readUInt8(21);
  const transferType = packet.readUInt8(22);
  const dataLength = packet.readUInt32LE(23);
  const infoByte = packet.readUInt8(16);
  const direction = (infoByte & 0x01) ? 'IN' : 'OUT';
  return { endpoint, transferType, direction, payload: packet.subarray(headerLen, headerLen + dataLength) };
}

function decodeUsbMidi(payload: Buffer): number[] {
  const midi: number[] = [];
  for (let i = 0; i + 4 <= payload.length; i += 4) {
    const cin = payload[i] & 0x0f;
    const b1 = payload[i + 1], b2 = payload[i + 2], b3 = payload[i + 3];
    switch (cin) {
      case 0x4: midi.push(b1, b2, b3); break;
      case 0x5: midi.push(b1); break;
      case 0x6: midi.push(b1, b2); break;
      case 0x7: midi.push(b1, b2, b3); break;
      case 0x8: case 0x9: case 0xa: case 0xb: midi.push(b1, b2, b3); break;
      case 0xc: case 0xd: midi.push(b1, b2); break;
      case 0xe: midi.push(b1, b2, b3); break;
      case 0xf: midi.push(b1); break;
      default: break;
    }
  }
  return midi;
}

function isFractal(frame: number[]): boolean {
  return FRACTAL_MFR.every((v, i) => frame[i] === v);
}

// ─── main ───────────────────────────────────────────────────────────────────
const arg = process.argv[2];
if (!arg) { console.error('Usage: decode-fm9-capture <path.pcapng>'); process.exit(1); }
const abs = path.resolve(arg);
if (!existsSync(abs)) { console.error(`Not found: ${abs}`); process.exit(1); }
const buf = readFileSync(abs);
console.log(`File: ${abs} (${(buf.length / 1024).toFixed(1)} KB)\n`);

interface StreamState { direction: 'IN' | 'OUT'; endpoint: number; currentFrame: number[] | null; frames: Array<{ ts: number; bytes: number[] }>; }
const streams = new Map<string, StreamState>();
let epbCount = 0;

for (const { type, body } of iteratePcapngBlocks(buf)) {
  if (type !== BLOCK_EPB) continue;
  epbCount++;
  const epb = parseEpb(body); if (!epb) continue;
  const usb = parseUsbPcap(epb.data); if (!usb) continue;
  if (usb.transferType !== 0x03 || usb.payload.length < 4) continue;
  const key = `${usb.direction}/ep0x${hex(usb.endpoint)}`;
  let st = streams.get(key);
  if (!st) { st = { direction: usb.direction, endpoint: usb.endpoint, currentFrame: null, frames: [] }; streams.set(key, st); }
  const ts = epb.tsHi * 0x100000000 + epb.tsLo;
  for (const b of decodeUsbMidi(usb.payload)) {
    if (b === 0xf0) st.currentFrame = [0xf0];
    else if (st.currentFrame) {
      st.currentFrame.push(b);
      if (b === 0xf7) { st.frames.push({ ts, bytes: st.currentFrame }); st.currentFrame = null; }
    }
  }
}

interface TF { direction: 'IN' | 'OUT'; bytes: number[]; ts: number; }
const all: TF[] = [];
for (const [, st] of streams) for (const f of st.frames) all.push({ direction: st.direction, bytes: f.bytes, ts: f.ts });
all.sort((a, b) => a.ts - b.ts);

const fractal = all.filter((f) => isFractal(f.bytes));
const byModel = new Map<number, number>();
for (const f of fractal) { const m = f.bytes[4]; byModel.set(m, (byModel.get(m) ?? 0) + 1); }

console.log(`EPBs: ${epbCount}  | total SysEx frames: ${all.length}  | Fractal frames: ${fractal.length}`);
console.log('Fractal frames by model byte: ' + [...byModel.entries()].sort(([a], [b]) => a - b)
  .map(([m, n]) => `0x${hex(m)}(${MODEL_NAMES[m] ?? '?'}):${n}`).join('  '));

const fm9 = fractal.filter((f) => f.bytes[4] === FM9_MODEL);
const fm9Out = fm9.filter((f) => f.direction === 'OUT');
const fm9In = fm9.filter((f) => f.direction === 'IN');
console.log(`\nFM9 (0x12) frames: ${fm9.length}  (OUT ${fm9Out.length}, IN ${fm9In.length})`);

// fn byte = byte[5] for gen-2; gen-3 uses fn=0x01 + sub-action in byte[6+].
// Show fn distribution per direction, and the (fn, sub) pair for fn=0x01.
function fnSummary(frames: TF[]): string {
  const m = new Map<string, number>();
  for (const f of frames) {
    const fn = f.bytes[5];
    const key = fn === 0x01 ? `01:${hex(f.bytes[6] ?? 0)}` : hex(fn ?? 0);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return [...m.entries()].sort().map(([k, n]) => `${k}×${n}`).join('  ');
}
console.log(`  OUT fn[:sub] dist: ${fnSummary(fm9Out)}`);
console.log(`  IN  fn[:sub] dist: ${fnSummary(fm9In)}`);

// Length histogram (IN frames are the unverified read-back — size matters).
function lenHist(frames: TF[]): string {
  const m = new Map<number, number>();
  for (const f of frames) m.set(f.bytes.length, (m.get(f.bytes.length) ?? 0) + 1);
  return [...m.entries()].sort(([a], [b]) => a - b).map(([l, n]) => `${l}B×${n}`).join('  ');
}
console.log(`  OUT length hist: ${lenHist(fm9Out)}`);
console.log(`  IN  length hist: ${lenHist(fm9In)}`);

const t0 = fm9.length ? fm9[0].ts : 0;
const rel = (ts: number) => ((ts - t0) / 1e6).toFixed(3);

// ── A. State-broadcast triple 0x74/0x75/0x76 — emitted on a real edit (knob
//    turn). These are the smoking gun for the Reverb Mix change. ──
const broadcasts = fm9.filter((f) => [0x74, 0x75, 0x76].includes(f.bytes[5]));
console.log(`\n═══ STATE-BROADCAST TRIPLE (0x74/0x75/0x76) — ${broadcasts.length} frames ═══`);
for (const f of broadcasts) {
  console.log(`${f.direction} fn=0x${hex(f.bytes[5])} +${rel(f.ts)}s len=${f.bytes.length}: ${toHex(f.bytes)}`);
}

// ── B. Outbound fn=0x01 frames that carry a non-zero VALUE region (bytes 10+)
//    = actual SET/writes, as opposed to GET requests (value region all-zero).
//    The Reverb Mix 100→99.5→100 write should appear here. ──
const writes = fm9.filter((f) =>
  f.direction === 'OUT' && f.bytes[5] === 0x01 && f.bytes.slice(10, -2).some((b) => b !== 0));
console.log(`\n═══ OUTBOUND fn=0x01 WRITES (non-zero value region) — ${writes.length} frames ═══`);
for (const f of writes) {
  const sub = hex(f.bytes[6]);
  const pid = f.bytes[8] | (f.bytes[9] << 7); // septet LE 14-bit param id guess
  console.log(`+${rel(f.ts)}s sub=0x${sub} pid=0x${hex(f.bytes[8])}${hex(f.bytes[9])}(=${pid}) : ${toHex(f.bytes)}`);
}

// ── C. fn=0x1F bulk reads (atomic GET on II; present here too) ──
const bulk = fm9.filter((f) => f.bytes[5] === 0x1f);
console.log(`\n═══ fn=0x1F frames — ${bulk.length} ═══`);
for (const f of bulk) console.log(`${f.direction} +${rel(f.ts)}s len=${f.bytes.length}: ${toHex(f.bytes.slice(0, 32))}${f.bytes.length > 32 ? ' …' : ''}`);

// ── D. Persist all FM9 frames to a decoded artifact for grep/diff later. ──
const base = path.basename(abs).replace(/\.pcapng$/i, '');
const outPath = path.resolve(`samples/captured/decoded/${base}.frames.json`);
try {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(fm9.map((f) => ({
    dir: f.direction, t: rel(f.ts), fn: f.bytes[5], sub: f.bytes[6], len: f.bytes.length,
    hex: toHex(f.bytes),
  })), null, 0));
  console.log(`\nWrote ${fm9.length} FM9 frames → ${outPath}`);
} catch (e) { console.log('artifact write skipped:', (e as Error).message); }
