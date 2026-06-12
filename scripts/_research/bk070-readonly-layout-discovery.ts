#!/usr/bin/env tsx
/**
 * BK-070 C1 — READ-ONLY per-preset layout discovery (2026-06-07).
 *
 * Goal: locate each placed block's `paramBase` inside the active preset's
 * binary WITHOUT writing anything to the device, so atomic apply can be made
 * portable across arbitrary compositions (closing the screech via a silent
 * one-shot push instead of an output mute).
 *
 * Thesis: `GET_ALL_PARAMS` (fn 0x1F, hardware-verified read-only) returns each
 * block's current param value vector. That same vector appears as a contiguous
 * run of 3-byte-packed ushorts inside the `export_preset` dump. Finding the run
 * gives the block's paramBase — no destructive SET_PARAM probing, no need to
 * crack the abstract block-order sort (the dump IS the ground-truth layout).
 *
 * Method (all reads):
 *   1. GET_GRID (fn 0x20)        → placed blocks + grid order.
 *   2. GET_ALL_PARAMS (fn 0x1F)  → per-block value vector.
 *   3. PATCH_DUMP (fn 0x03)      → active preset binary, flattened to ushorts.
 *   4. Locate each vector in the dump → paramBase; flag ambiguous matches.
 *   5. Cross-check consecutive paramBase gaps against BLOCK_BINARY_LAYOUT
 *      widths (Amp 238, Cab 80, Delay 142, ...).
 *
 * READ-ONLY: issues NO STORE_PRESET and NO SET_PARAM. Leaves the device
 * exactly as found. Safe to run on any active preset (factory or user).
 *
 * Run:  npx tsx scripts/_research/bk070-readonly-layout-discovery.ts
 */

import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import { parsePresetDump } from '@mcp-midi-control/fractal-gen2/presetDump.js';
import { BLOCK_BINARY_LAYOUT } from '@mcp-midi-control/fractal-gen2/blockBinaryLayout.js';
import {
  buildGetGridLayout,
  parseGetGridLayoutResponse,
  isGetGridLayoutResponse,
  buildGetAllParams,
  buildGetPresetNumber,
  isGetPresetNumberResponse,
  parseGetPresetNumberResponse,
  AXE_FX_II_BLOCKS,
} from 'fractal-midi/gen2/axe-fx-ii';

const SYSEX_START = 0xf0;
const AXEFX2_MODEL = 0x07;
const FRACTAL_MFR = [0x00, 0x01, 0x74];
const FN_PATCH_DUMP = 0x03;
const USHORTS_PER_CHUNK = 64; // matches bk070-measure-widths global coordinate convention
const NUM_CHUNKS = 64;

type Conn = ReturnType<typeof connectAxeFxII>;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const csum = (b: number[]): number => { let a = 0; for (const x of b) a ^= x; return a & 0x7f; };

/** 3-byte septet-packed → 16-bit ushort (II convention). */
function packed16(b0: number, b1: number, b2: number): number {
  return ((b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14)) & 0xffff;
}

/** Decode a preset-dump chunk payload (count header + 3-byte items). */
function decodeChunk(p: Uint8Array): Uint16Array {
  const count = (p[0] & 0x7f) | ((p[1] & 0x7f) << 7);
  const out = new Uint16Array(count);
  for (let i = 0; i < count; i++) {
    const off = 2 + i * 3;
    out[i] = packed16(p[off], p[off + 1], p[off + 2]);
  }
  return out;
}

/** id → canonical block-name + width, via BLOCK_BINARY_LAYOUT.wireIds. */
function layoutForEffectId(effectId: number): { name: string; width?: number } | undefined {
  for (const [name, layout] of Object.entries(BLOCK_BINARY_LAYOUT)) {
    if (layout.wireIds.includes(effectId)) return { name, width: layout.widthUshorts };
  }
  return undefined;
}

function displayName(effectId: number): string {
  return AXE_FX_II_BLOCKS.find((b) => b.id === effectId)?.name ?? `id ${effectId}`;
}

async function getActivePresetNumber(conn: Conn): Promise<number> {
  const respP = conn.receiveSysExMatching(isGetPresetNumberResponse, 1500);
  conn.send(buildGetPresetNumber());
  return parseGetPresetNumberResponse(await respP).presetNumber;
}

/** GET_GRID → placed effectIds (blocks 100..170) in column-major grid order, de-duped. */
async function getPlacedBlocks(conn: Conn): Promise<number[]> {
  const respP = conn.receiveSysExMatching(isGetGridLayoutResponse, 1500);
  conn.send(buildGetGridLayout());
  const cells = parseGetGridLayoutResponse(await respP);
  const seen = new Set<number>();
  const placed: number[] = [];
  for (const c of cells) {
    if (c.blockId >= 100 && c.blockId <= 170 && !seen.has(c.blockId)) {
      seen.add(c.blockId);
      placed.push(c.blockId);
    }
  }
  return placed;
}

/** GET_ALL_PARAMS (fn 0x1F) → the block's current value vector (active channel). */
async function getBlockValues(conn: Conn, effectId: number): Promise<number[]> {
  const frames: number[][] = [];
  const unsub = conn.onMessage((b) => {
    if (b[0] === SYSEX_START && b[4] === AXEFX2_MODEL && [0x74, 0x75, 0x76].includes(b[5])) {
      frames.push([...b]);
    }
  });
  conn.send(buildGetAllParams(effectId));
  await sleep(400);
  unsub();
  const values: number[] = [];
  for (const f of frames) {
    if (f[5] !== 0x75) continue; // only CHUNK frames carry values
    const chunkCount = (f[6] & 0x7f) | ((f[7] & 0x7f) << 7);
    for (let i = 0; i < chunkCount; i++) {
      const off = 8 + i * 3;
      values.push(packed16(f[off], f[off + 1], f[off + 2]));
    }
  }
  return values;
}

/** PATCH_DUMP (fn 0x03) → flat ushort array indexed by chunk*64 + ushort. */
async function dumpFlat(conn: Conn, wirePreset: number): Promise<Int32Array> {
  const frames: number[][] = [];
  const unsub = conn.onMessage((b) => {
    if (b[0] === SYSEX_START && b[4] === AXEFX2_MODEL && [0x77, 0x78, 0x79].includes(b[5])) {
      frames.push([...b]);
    }
  });
  const head = [SYSEX_START, ...FRACTAL_MFR, AXEFX2_MODEL, FN_PATCH_DUMP, (wirePreset >> 7) & 0x7f, wirePreset & 0x7f];
  conn.send([...head, csum(head), 0xf7]);
  await sleep(3000);
  unsub();
  if (frames.length !== 66) throw new Error(`PATCH_DUMP got ${frames.length} frames, expected 66`);
  const parsed = parsePresetDump(new Uint8Array(frames.flat()));
  // -1 sentinel marks unfilled cells (chunks with < 64 items) so they never match.
  const flat = new Int32Array(NUM_CHUNKS * USHORTS_PER_CHUNK).fill(-1);
  for (let c = 0; c < Math.min(parsed.chunkPayloads.length, NUM_CHUNKS); c++) {
    const decoded = decodeChunk(parsed.chunkPayloads[c]);
    for (let i = 0; i < Math.min(decoded.length, USHORTS_PER_CHUNK); i++) {
      flat[c * USHORTS_PER_CHUNK + i] = decoded[i];
    }
  }
  return flat;
}

/** All start offsets where `vec` appears contiguously in `flat`. */
function findRuns(flat: Int32Array, vec: number[]): number[] {
  if (vec.length === 0) return [];
  const hits: number[] = [];
  for (let s = 0; s + vec.length <= flat.length; s++) {
    let ok = true;
    for (let k = 0; k < vec.length; k++) {
      if (flat[s + k] !== vec[k]) { ok = false; break; }
    }
    if (ok) hits.push(s);
  }
  return hits;
}

/** Entropy proxy: distinct non-zero values — low means collision-prone. */
function distinctNonZero(vec: number[]): number {
  return new Set(vec.filter((v) => v !== 0)).size;
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  console.log('=== BK-070 read-only layout discovery (no writes) ===\n');

  const wirePreset = await getActivePresetNumber(conn);
  console.log(`Active preset: wire ${wirePreset} (location ${wirePreset + 1})`);

  const placed = await getPlacedBlocks(conn);
  console.log(`Placed blocks (grid order): ${placed.map(displayName).join(', ')}\n`);

  console.log('Reading per-block value vectors (fn 0x1F)...');
  const vectors = new Map<number, number[]>();
  for (const id of placed) {
    const v = await getBlockValues(conn, id);
    vectors.set(id, v);
  }

  console.log('Dumping active preset binary (fn 0x03)...\n');
  const flat = await dumpFlat(conn, wirePreset);

  interface Located {
    effectId: number;
    name: string;
    items: number;
    distinct: number;
    matches: number;
    globalBase?: number;
    chunk?: number;
    ushort?: number;
    expectedWidth?: number;
  }
  const located: Located[] = [];

  for (const id of placed) {
    const vec = vectors.get(id) ?? [];
    const lay = layoutForEffectId(id);
    const hits = findRuns(flat, vec);
    const rec: Located = {
      effectId: id,
      name: lay?.name ?? displayName(id),
      items: vec.length,
      distinct: distinctNonZero(vec),
      matches: hits.length,
      expectedWidth: lay?.width,
    };
    if (hits.length >= 1) {
      rec.globalBase = hits[0];
      rec.chunk = Math.floor(hits[0] / USHORTS_PER_CHUNK);
      rec.ushort = hits[0] % USHORTS_PER_CHUNK;
    }
    located.push(rec);
  }

  // Report.
  console.log('=== DISCOVERED paramBases ===');
  console.log('Block          | items | distinct | matches | paramBase (c:u / global) | width');
  console.log('---------------|-------|----------|---------|--------------------------|------');
  for (const r of located) {
    const base = r.globalBase !== undefined ? `c${r.chunk}:u${r.ushort} (${r.globalBase})` : '— NOT FOUND';
    const flag = r.matches === 0 ? '  ✗ no match' : r.matches > 1 ? `  ⚠ ${r.matches} matches (ambiguous)` : '';
    console.log(
      `  ${r.name.padEnd(13)}| ${String(r.items).padStart(5)} | ${String(r.distinct).padStart(8)} | ` +
      `${String(r.matches).padStart(7)} | ${base.padEnd(24)} | ${r.expectedWidth ?? '?'}${flag}`,
    );
  }

  // Cross-check: sort unambiguous matches by global base, compare gaps to widths.
  console.log('\n=== WIDTH CROSS-CHECK (consecutive paramBase gaps vs known widths) ===');
  const unambiguous = located.filter((r) => r.matches === 1 && r.globalBase !== undefined)
    .sort((a, b) => (a.globalBase! - b.globalBase!));
  let agree = 0, disagree = 0;
  for (let i = 0; i < unambiguous.length - 1; i++) {
    const me = unambiguous[i], next = unambiguous[i + 1];
    const gap = next.globalBase! - me.globalBase!;
    const w = me.expectedWidth;
    const verdict = w === undefined ? '(width unknown)' : gap === w ? '✓ matches width' : `✗ gap ${gap} ≠ width ${w}`;
    if (w !== undefined) { gap === w ? agree++ : disagree++; }
    console.log(`  ${me.name.padEnd(13)} base ${String(me.globalBase).padStart(4)} → next ${String(next.globalBase).padStart(4)} | gap ${String(gap).padStart(4)} vs width ${w ?? '?'}  ${verdict}`);
  }

  const found = located.filter((r) => r.matches >= 1).length;
  const clean = located.filter((r) => r.matches === 1).length;
  console.log('\n=== SUMMARY ===');
  console.log(`  placed blocks:        ${located.length}`);
  console.log(`  located (≥1 match):   ${found}`);
  console.log(`  unambiguous (1 match):${clean}`);
  console.log(`  width gaps agree:     ${agree}   disagree: ${disagree}`);
  console.log(
    found === located.length && disagree === 0
      ? '\n  ✅ Read-only discovery RELIABLE on this preset — atomic apply can use it (no sort needed).'
      : '\n  ⚠ Some blocks ambiguous/unfound or width-mismatched — see flags above.\n' +
        '    Ambiguous = low-entropy vector (run the width-walk anchor) or fn0x1F/dump encoding mismatch.\n' +
        '    Run on more presets before concluding; if persistent, fall back to C2 (sort matrix).',
  );

  console.log('\n(no writes issued; device left as found)');
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e); if (e instanceof Error && e.stack) console.error(e.stack); process.exit(1); });
