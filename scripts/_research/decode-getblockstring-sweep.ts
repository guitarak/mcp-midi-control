/**
 * S3: getBlockString sweep decoder SCAFFOLD (gen-3 enum WRITE leg, BK-093).
 *
 * The {raw-enum-id → name} table that lets us set gen-3 enums BY NAME is
 * device-resident: FM9-Edit.exe / Axe-Edit III.exe both carry the format string
 *   "msg_getBlockString: effectId: %d, paramId %d / %d, string %d / %d"
 * so the editor fetches each enum label from the device on demand. The existing
 * 2026-06-03 captures do NOT contain this exchange (the tester changed values,
 * never triggered a full label fetch). S3 is the ONE capture that closes the
 * write leg: open each block once in FM9-Edit with USBPcap running, so the
 * editor sweeps getBlockString for the whole device.
 *
 * This is the decoder, written AHEAD of the capture so the tester's file decodes
 * in one pass. The exact getBlockString wire shape is a HYPOTHESIS (no capture to
 * pin it yet); this scaffold finds it empirically by scanning fn=0x01 sub-actions
 * for response frames that carry ASCII label strings, and pairs each with the
 * (effectId, paramId, stringIndex) from the preceding request. Tighten the field
 * offsets against the real capture, then emit the {effectId, paramId, index→name}
 * table for registration.
 *
 * Run:  npx tsx scripts/_research/decode-getblockstring-sweep.ts <frames.json>
 * (frames.json = the decode-fm9-capture.ts output: [{dir,t,fn,sub,len,hex}, ...])
 */
import { readFileSync, existsSync } from 'node:fs';

interface Frame { dir: 'IN' | 'OUT'; t: string; fn: number; sub: number; len: number; hex: string; }

const PATH = process.argv[2];
if (!PATH || !existsSync(PATH)) {
  console.error('usage: decode-getblockstring-sweep.ts <frames.json>');
  console.error('  (run the S3 getBlockString-sweep capture through decode-fm9-capture.ts first)');
  process.exit(PATH ? 1 : 0);
}
const frames = JSON.parse(readFileSync(PATH, 'utf8')) as Frame[];
const bytes = (f: Frame): number[] => f.hex.split(/\s+/).filter(Boolean).map((h) => parseInt(h, 16));
const dec14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);

console.log(`Loaded ${frames.length} frames from ${PATH}.`);

// 1. Inventory fn=0x01 sub-actions (the gen-3 carrier for GET/SET/info).
const subInv = new Map<number, { in: number; out: number; maxLen: number }>();
for (const f of frames) {
  if (f.fn !== 0x01) continue;
  const cur = subInv.get(f.sub) ?? { in: 0, out: 0, maxLen: 0 };
  if (f.dir === 'IN') cur.in++; else cur.out++;
  cur.maxLen = Math.max(cur.maxLen, f.len);
  subInv.set(f.sub, cur);
}
console.log('\nfn=0x01 sub-action inventory:');
console.log('  sub   IN   OUT  maxLen');
for (const [sub, c] of [...subInv.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`  0x${sub.toString(16).padStart(2, '0')}  ${String(c.in).padStart(4)} ${String(c.out).padStart(5)} ${String(c.maxLen).padStart(7)}`);
}

// 2. Find frames whose payload carries a printable ASCII run >= 3 (label text).
//    Enum labels are ASCII ("Medium Spring", "Plexi 100W High"). The response
//    frame of the getBlockString exchange is the one that carries them.
function asciiRuns(b: number[], min = 4): string[] {
  const out: string[] = [];
  let cur = '';
  for (const ch of b) {
    if (ch >= 0x20 && ch < 0x7f) cur += String.fromCharCode(ch);
    else { if (cur.length >= min) out.push(cur); cur = ''; }
  }
  if (cur.length >= min) out.push(cur);
  return out;
}

// A real enum label reads like words, not binary noise that happens to be
// printable. Require a run of >=4 consecutive letters (e.g. "Spring", "Plexi",
// "Room"); coincidental printable bytes in septet data almost never produce one.
function looksLikeLabel(s: string): boolean {
  return /[A-Za-z]{4,}/.test(s);
}

interface StringFrame { idx: number; sub: number; dir: string; strings: string[]; effectId: number; paramId: number; }
const stringFrames: StringFrame[] = [];
for (let i = 0; i < frames.length; i++) {
  const f = frames[i];
  if (f.fn !== 0x01) continue;
  const b = bytes(f);
  const payload = b.slice(6, b.length - 2); // after F0 00 01 74 model fn ; before cs F7
  const runs = asciiRuns(payload).filter(looksLikeLabel);
  if (runs.length === 0) continue;
  // Hypothesis field offsets (refine against the real capture): payload[2..3] =
  // effectId, payload[4..5] = paramId (matches the fn=0x01 09/01 layout).
  stringFrames.push({
    idx: i,
    sub: f.sub,
    dir: f.dir,
    strings: runs,
    effectId: payload.length >= 4 ? dec14(payload[2], payload[3]) : -1,
    paramId: payload.length >= 6 ? dec14(payload[4], payload[5]) : -1,
  });
}

console.log(`\nFrames carrying ASCII label text: ${stringFrames.length}`);
if (stringFrames.length === 0) {
  console.log('  → No label strings in this capture. Expected for the value-change captures');
  console.log('    (the getBlockString sweep needs each block OPENED in the editor). This');
  console.log('    confirms the handoff: re-capture with the block-open sweep protocol.');
} else {
  // Which sub-action is the string carrier?
  const bySub = new Map<number, number>();
  for (const sf of stringFrames) bySub.set(sf.sub, (bySub.get(sf.sub) ?? 0) + 1);
  console.log('  string-carrying sub-actions:', [...bySub.entries()].map(([s, c]) => `0x${s.toString(16)}×${c}`).join(', '));
  console.log('\n  sample (first 25):');
  for (const sf of stringFrames.slice(0, 25)) {
    console.log(`    #${sf.idx} ${sf.dir} sub=0x${sf.sub.toString(16)} eff=${sf.effectId} pid=${sf.paramId} :: ${sf.strings.join(' | ').slice(0, 80)}`);
  }
  // Group into the {effectId: {paramId: [labels]}} table the registration needs.
  const table: Record<number, Record<number, string[]>> = {};
  for (const sf of stringFrames) {
    if (sf.effectId < 0 || sf.paramId < 0) continue;
    (table[sf.effectId] ??= {})[sf.paramId] ??= [];
    table[sf.effectId][sf.paramId].push(...sf.strings);
  }
  const blocks = Object.keys(table).length;
  console.log(`\n  recovered ${blocks} (effectId) groups (HYPOTHESIS offsets, verify before registering).`);
  console.log('  Once field offsets are confirmed against this capture, emit JSON keyed by');
  console.log('  device-true paramId and register as enum_values + a name→raw-id resolver to');
  console.log('  unblock set_param-by-name (closes BK-093 write leg).');
}
