/**
 * Decode an AM4 (model 0x15) USBPcap capture: per-direction fn/action histogram,
 * length histogram, and an ASCII-string scan (does the editor flow carry names —
 * preset / cab / amp-model — over the wire?).
 *
 * Run: npx tsx scripts/_research/decode-am4-capture.ts <path.pcapng>
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const AM4_MODEL = 0x15;
const BLOCK_EPB = 0x00000006;

function* blocks(buf: Buffer): Generator<{ type: number; body: Buffer }> {
  let off = 0;
  while (off + 8 <= buf.length) {
    const t = buf.readUInt32LE(off);
    const len = buf.readUInt32LE(off + 4);
    if (len < 12 || off + len > buf.length) break;
    yield { type: t, body: buf.subarray(off + 8, off + len - 4) };
    off += len;
  }
}
function parseEpb(body: Buffer): { tsHi: number; tsLo: number; data: Buffer } | null {
  if (body.length < 20) return null;
  const capLen = body.readUInt32LE(12);
  if (20 + capLen > body.length) return null;
  return { tsHi: body.readUInt32LE(4), tsLo: body.readUInt32LE(8), data: Buffer.from(body.subarray(20, 20 + capLen)) };
}
function parseUsb(p: Buffer): { direction: 'IN' | 'OUT'; transferType: number; payload: Buffer } | null {
  if (p.length < 27) return null;
  const headerLen = p.readUInt16LE(0);
  if (headerLen > p.length) return null;
  const dataLength = p.readUInt32LE(23);
  return { direction: (p.readUInt8(16) & 0x01) ? 'IN' : 'OUT', transferType: p.readUInt8(22), payload: p.subarray(headerLen, headerLen + dataLength) };
}
function usbMidi(payload: Buffer): number[] {
  const m: number[] = [];
  for (let i = 0; i + 4 <= payload.length; i += 4) {
    const cin = payload[i] & 0x0f, b1 = payload[i + 1], b2 = payload[i + 2], b3 = payload[i + 3];
    if (cin === 0x4 || cin === 0x7 || (cin >= 0x8 && cin <= 0xb) || cin === 0xe) m.push(b1, b2, b3);
    else if (cin === 0x5 || cin === 0xf) m.push(b1);
    else if (cin === 0x6 || cin === 0xc || cin === 0xd) m.push(b1, b2);
  }
  return m;
}

const arg = process.argv[2];
if (!arg || !existsSync(arg)) { console.error('usage: <path.pcapng>'); process.exit(1); }
const buf = readFileSync(path.resolve(arg));

const streams = new Map<string, { dir: 'IN' | 'OUT'; cur: number[] | null; frames: number[][] }>();
for (const { type, body } of blocks(buf)) {
  if (type !== BLOCK_EPB) continue;
  const epb = parseEpb(body); if (!epb) continue;
  const usb = parseUsb(epb.data); if (!usb || usb.transferType !== 0x03 || usb.payload.length < 4) continue;
  const key = usb.direction;
  let st = streams.get(key);
  if (!st) { st = { dir: usb.direction, cur: null, frames: [] }; streams.set(key, st); }
  for (const b of usbMidi(usb.payload)) {
    if (b === 0xf0) st.cur = [0xf0];
    else if (st.cur) { st.cur.push(b); if (b === 0xf7) { st.frames.push(st.cur); st.cur = null; } }
  }
}

const isAm4 = (f: number[]): boolean => f[0] === 0xf0 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && f[4] === AM4_MODEL;
const hex = (n: number): string => n.toString(16).padStart(2, '0');

for (const dir of ['OUT', 'IN'] as const) {
  const st = streams.get(dir);
  const frames = (st?.frames ?? []).filter(isAm4);
  // fn (byte 5); for fn=0x01 also show action (bytes 10-11 LE) family
  const fnHist = new Map<string, number>();
  const lenHist = new Map<number, number>();
  for (const f of frames) {
    const fn = f[5];
    let key = `fn=0x${hex(fn)}`;
    if (fn === 0x01 && f.length >= 12) key += ` act=0x${hex(f[11])}${hex(f[10])}`;
    fnHist.set(key, (fnHist.get(key) ?? 0) + 1);
    lenHist.set(f.length, (lenHist.get(f.length) ?? 0) + 1);
  }
  console.log(`\n=== ${dir}: ${frames.length} AM4 frames ===`);
  console.log('  fn[:act] dist: ' + [...fnHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, n]) => `${k}×${n}`).join('  '));
  console.log('  length hist (top): ' + [...lenHist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l}B×${n}`).join('  '));
}

// ── ASCII string scan: does the wire carry names (preset/cab/amp-model)? ──
// Scan every AM4 frame payload for printable-ASCII runs >= 4 chars (low-7-bit too).
const allFrames: number[][] = [];
for (const st of streams.values()) for (const f of st.frames) if (isAm4(f)) allFrames.push(f);
const strings = new Map<string, number>();
for (const f of allFrames) {
  for (const decode of [(b: number) => b, (b: number) => b & 0x7f]) {
    let run = '';
    for (const b of f.slice(6, -2)) {
      const c = decode(b);
      if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
      else { if (run.length >= 4) strings.set(run, (strings.get(run) ?? 0) + 1); run = ''; }
    }
    if (run.length >= 4) strings.set(run, (strings.get(run) ?? 0) + 1);
  }
}
const uniq = [...strings.entries()].filter(([s]) => /[A-Za-z]{3}/.test(s)).sort((a, b) => b[1] - a[1]);
console.log(`\n=== ASCII strings on the wire: ${uniq.length} distinct (>=4 chars, has letters) ===`);
if (uniq.length === 0) console.log('  (none — the editor does NOT fetch names over the wire on refresh; names are editor-local)');
else for (const [s, n] of uniq.slice(0, 40)) console.log(`  ${String(n).padStart(4)}×  "${s}"`);
