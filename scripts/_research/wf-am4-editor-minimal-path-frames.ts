/**
 * wf-am4-editor-minimal-path-frames.ts
 *
 * READ-ONLY decode helper. Walks the AM4-Edit session-59 `.syx` captures
 * frame-by-frame (F0..F7), tallies model=0x15 fn bytes, and classifies
 * each fn=0x01 PARAM_RW frame by its action code + addressing so we can
 * see the MINIMAL PRIMITIVE AM4-Edit uses per editor action.
 *
 * The session-59 `.syx` files are concatenated raw SysEx with NO direction
 * tag (no USB IN/OUT marker survives a flat `.syx` dump). We infer
 * host->device (request/write) vs device->host (reply) heuristically from
 * frame SHAPE, and flag every direction call as a heuristic, not ground
 * truth. Frame-count and fn-byte multiset ARE ground truth.
 *
 * Cross-device transfer probe: scans for any fn=0x0E frame (the II
 * SYSEX_QUERY_STATES wire byte) to test whether AM4-Edit / AM4 firmware
 * speaks the II QUERY_STATES atomic-read.
 *
 * Usage: npx tsx scripts/_research/wf-am4-editor-minimal-path-frames.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CAPTURE_DIR = join(process.cwd(), 'samples', 'captured');

const CAPTURES = [
  'session-59-am4-idle.syx',
  'session-59-am4-preset-switch.syx',
  'session-59-am4-edit-sync.syx',
  'session-59-am4-preset-switch-via-edit.syx',
  'session-59-am4-param-change-via-edit.syx',
  'session-59-am4-block-bypass-via-edit.syx',
  'session-59-am4-block-type-swap-via-edit.syx',
  'session-59-am4-scene-switch-via-edit.syx',
];

interface Frame {
  start: number;
  len: number;
  model: number;
  fn: number;
  bytes: number[]; // full frame F0..F7
}

function walk(buf: Buffer): Frame[] {
  const frames: Frame[] = [];
  let i = 0;
  while (i < buf.length) {
    if (buf[i] !== 0xf0) {
      i++;
      continue;
    }
    const start = i;
    let j = i + 1;
    while (j < buf.length && buf[j] !== 0xf7) j++;
    if (j >= buf.length) break;
    const len = j - start + 1;
    const bytes = Array.from(buf.subarray(start, j + 1));
    // Fractal envelope: F0 00 01 74 <model> <fn> ...
    if (len >= 8 && bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74) {
      frames.push({ start, len, model: bytes[4], fn: bytes[5], bytes });
    } else {
      // Non-Fractal SysEx (shouldn't appear for AM4-Edit, but record it).
      frames.push({ start, len, model: -1, fn: -1, bytes });
    }
    i = j + 1;
  }
  return frames;
}

function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

// fn=0x01 PARAM_RW: F0 00 01 74 15 01 [pidL lo hi][pidH lo hi][act lo hi][r3 lo hi][r4 lo hi] payload... cs F7
function parsePidRw(f: Frame) {
  const b = f.bytes;
  // header starts at index 6 (after F0 00 01 74 15 01)
  const pidLow = decode14(b[6], b[7]);
  const pidHigh = decode14(b[8], b[9]);
  const action = decode14(b[10], b[11]);
  const hdr3 = decode14(b[12], b[13]);
  const hdr4 = decode14(b[14], b[15]);
  return { pidLow, pidHigh, action, hdr3, hdr4 };
}

/**
 * Direction heuristic for fn=0x01 frames (HEURISTIC, not ground truth):
 *  - 64-byte frame, hdr4=0x28 (40 raw bytes) => long read RESPONSE / write-echo (device->host)
 *  - 18-byte frame, hdr4=0x0000              => command ack (device->host) OR a read request (host->device)
 *  - 23-byte frame, hdr4=0x0004              => 0x0E short-read response, or 23-byte float WRITE request (host->device)
 * We cannot cleanly split request vs USB-receipt-echo from a flat .syx; we
 * report the action+length distribution and let the human read direction.
 */

function actionName(action: number): string {
  switch (action) {
    case 0x0001: return 'WRITE(float/u32)';
    case 0x0002: return 'WRITE-via-Edit(0x02 quirk §6i)';
    case 0x000c: return 'RENAME(0x0C)';
    case 0x000d: return 'READ-long(0x0D, 64B resp)';
    case 0x000e: return 'READ-short(0x0E, 23B resp)';
    case 0x0010: return 'READ(0x10)';
    case 0x0017: return 'INIT/REFRESH-burst(0x17)';
    case 0x001b: return 'SAVE-to-slot(0x1B)';
    case 0x001f: return 'READ(0x1F-action)';
    case 0x0026: return 'READ(0x26)';
    default:     return `action=0x${action.toString(16)}`;
  }
}

const BLOCK_SLOT_PID_LOW = 0x00ce;

function pidLowLabel(pidLow: number): string {
  if (pidLow === BLOCK_SLOT_PID_LOW) return '0xCE(CE-register: slot/scene/preset/rename)';
  if (pidLow === 0x0001) return '0x01(GLOBAL family)';
  if (pidLow === 0x0000) return '0x00(global-action)';
  return `0x${pidLow.toString(16)}(block pidLow)`;
}

function ceSubLabel(pidHigh: number): string {
  switch (pidHigh) {
    case 0x000a: return 'preset-switch(0xCE/0x0A)';
    case 0x000b: return 'preset-rename(0xCE/0x0B)';
    case 0x000d: return 'scene-switch(0xCE/0x0D)';
    case 0x000f: case 0x0010: case 0x0011: case 0x0012:
      return `block-slot-placement(0xCE/0x${pidHigh.toString(16)}, slot ${pidHigh - 0x0e})`;
    case 0x0070: return 'SCENE_MIDI_EXEC(0xCE/0x70)';
    default:
      if (pidHigh >= 0x0037 && pidHigh <= 0x003a) return `scene-rename(0xCE/0x${pidHigh.toString(16)})`;
      return `0xCE/0x${pidHigh.toString(16)}`;
  }
}

console.log('='.repeat(78));
console.log('AM4-Edit minimal-path frame walk — session-59 captures');
console.log('Model byte 0x15. Direction NOT recoverable from flat .syx; shape-classified only.');
console.log('='.repeat(78));

const globalFnTally: Record<string, number> = {};
let globalQueryStatesHits = 0;

for (const name of CAPTURES) {
  const path = join(CAPTURE_DIR, name);
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (err) {
    console.log(`\n### ${name}\n  (missing on disk: ${(err as Error).message})`);
    continue;
  }
  console.log(`\n${'#'.repeat(70)}`);
  console.log(`### ${name}  (${buf.length} bytes)`);
  if (buf.length === 0) {
    console.log('  EMPTY FILE — 0 frames captured.');
    continue;
  }
  const frames = walk(buf);
  console.log(`  total Fractal frames: ${frames.filter((f) => f.model >= 0).length}`);

  // fn-byte tally for model 0x15
  const fnTally: Record<number, number> = {};
  for (const f of frames) {
    if (f.model !== 0x15) continue;
    fnTally[f.fn] = (fnTally[f.fn] ?? 0) + 1;
    const key = `model=0x15 fn=0x${f.fn.toString(16).padStart(2, '0')}`;
    globalFnTally[key] = (globalFnTally[key] ?? 0) + 1;
    if (f.fn === 0x0e) globalQueryStatesHits++;
  }
  const fnLine = Object.entries(fnTally)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([fn, n]) => `0x${Number(fn).toString(16).padStart(2, '0')}×${n}`)
    .join('  ');
  console.log(`  fn-byte multiset (model 0x15): ${fnLine}`);

  // fn=0x01 action + addressing breakdown
  const actionTally: Record<string, number> = {};
  const ceTally: Record<string, number> = {};
  const lenByAction: Record<string, Set<number>> = {};
  for (const f of frames) {
    if (f.model !== 0x15 || f.fn !== 0x01) continue;
    if (f.bytes.length < 16) continue;
    const p = parsePidRw(f);
    const an = actionName(p.action);
    actionTally[an] = (actionTally[an] ?? 0) + 1;
    (lenByAction[an] ??= new Set()).add(f.len);
    if (p.pidLow === BLOCK_SLOT_PID_LOW) {
      const sub = ceSubLabel(p.pidHigh);
      ceTally[sub] = (ceTally[sub] ?? 0) + 1;
    }
  }
  if (Object.keys(actionTally).length > 0) {
    console.log('  fn=0x01 action breakdown (action code -> count, frame lengths):');
    for (const [an, n] of Object.entries(actionTally).sort((a, b) => b[1] - a[1])) {
      const lens = [...(lenByAction[an] ?? [])].sort((a, b) => a - b).join(',');
      console.log(`    ${an.padEnd(34)} ×${String(n).padStart(5)}   lens=[${lens}]`);
    }
  }
  if (Object.keys(ceTally).length > 0) {
    console.log('  fn=0x01 0xCE-register sub-address breakdown:');
    for (const [sub, n] of Object.entries(ceTally).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${sub.padEnd(46)} ×${n}`);
    }
  }

  // fn=0x0E cross-device transfer probe: dump any frame bytes.
  const queryStates = frames.filter((f) => f.model === 0x15 && f.fn === 0x0e);
  if (queryStates.length > 0) {
    console.log(`  !! fn=0x0E (QUERY_STATES wire byte) PRESENT ×${queryStates.length}:`);
    for (const f of queryStates.slice(0, 3)) {
      console.log(`     ${f.bytes.map((x) => x.toString(16).padStart(2, '0')).join(' ')}`);
    }
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log('AGGREGATE fn-byte multiset across all captures (model 0x15):');
for (const [k, n] of Object.entries(globalFnTally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}  ×${n}`);
}
console.log('-'.repeat(78));
console.log(`CROSS-DEVICE TRANSFER VERDICT — fn=0x0E (QUERY_STATES) frames: ${globalQueryStatesHits}`);
console.log(globalQueryStatesHits === 0
  ? '  => AM4-Edit does NOT emit fn=0x0E. II QUERY_STATES does not transfer (by absence-of-evidence; see notes).'
  : '  => fn=0x0E PRESENT — inspect bytes above; possible cross-device transfer.');
console.log('='.repeat(78));
