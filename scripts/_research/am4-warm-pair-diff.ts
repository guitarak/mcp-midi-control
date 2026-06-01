/**
 * AM4 preset-binary warm-pair diff analyzer.
 *
 * Read-only post-hoc analysis script — does NOT touch hardware. Takes
 * the `samples/captured/am4-warm-pair-<step>-{before,after}.syx` files
 * written by `am4-warm-pair-capture.ts` and produces:
 *
 *   1. Raw byte-diff count per step (chunk-by-chunk).
 *   2. Septet-packed 14-bit ushort diff (the AM4 native param-value
 *      encoding from fn 0x1F). For each chunk, decode 3-byte-stride
 *      records and report which record positions changed.
 *   3. Stable-diff candidates — record positions that:
 *      - Changed in the after-vs-before of the step's mutation, AND
 *      - Did NOT change in any other step's noise (i.e., positions
 *        whose change correlates only with the targeted param).
 *      Outputs absolute byte offset, chunk index, record index,
 *      before/after ushort values, and delta.
 *
 * Septet-pack decode format (matches fn 0x1F atomic-read chunks):
 *
 *     value = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14)
 *
 * Each chunk holds (3074-bytes / 3) ≈ 1024 14-bit ushorts after an
 * optional 2-byte prelude. We decode the entire chunk payload at
 * stride 3 starting at offset 0 and report record indices; the
 * absolute byte offset within the chunk is just `record_index * 3`.
 *
 * Run (after `am4-warm-pair-capture.ts` has been run on hardware):
 *   npx tsx scripts/_research/am4-warm-pair-diff.ts
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

import {
  parsePresetDump,
  CHUNK_PAYLOAD_LEN,
  CHUNKS_PER_PRESET,
} from '@mcp-midi-control/am4/presetDump.js';

const CAPTURES_DIR = path.resolve('samples/captured');

interface StepFiles {
  id: string;
  before: string;
  after: string;
}

const STEPS: StepFiles[] = [
  { id: '1-baseline-redump',  before: 'am4-warm-pair-1-baseline-redump-before.syx', after: 'am4-warm-pair-1-baseline-redump-after.syx' },
  { id: '2-amp-gain-channel-A', before: 'am4-warm-pair-2-amp-gain-channel-A-before.syx', after: 'am4-warm-pair-2-amp-gain-channel-A-after.syx' },
  { id: '3-amp-gain-channel-B', before: 'am4-warm-pair-3-amp-gain-channel-B-before.syx', after: 'am4-warm-pair-3-amp-gain-channel-B-after.syx' },
  { id: '4-amp-master',       before: 'am4-warm-pair-4-amp-master-before.syx',       after: 'am4-warm-pair-4-amp-master-after.syx' },
  { id: '5-amp-type-swap',    before: 'am4-warm-pair-5-amp-type-swap-before.syx',    after: 'am4-warm-pair-5-amp-type-swap-after.syx' },
];

function decode14(b0: number, b1: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7);
}

function decode16Packed(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

function decodeChunkSeptets(chunk: Uint8Array): number[] {
  const out: number[] = [];
  for (let off = 0; off + 2 < chunk.length; off += 3) {
    out.push(decode16Packed(chunk[off]!, chunk[off + 1]!, chunk[off + 2]!));
  }
  return out;
}

function diffBytes(a: Uint8Array, b: Uint8Array): number[] {
  const out: number[] = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) out.push(i);
  return out;
}

function diffSeptets(a: number[], b: number[]): Array<{ rec: number; before: number; after: number; delta: number }> {
  const out: Array<{ rec: number; before: number; after: number; delta: number }> = [];
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] !== b[i]) {
      out.push({ rec: i, before: a[i]!, after: b[i]!, delta: b[i]! - a[i]! });
    }
  }
  return out;
}

function loadCapture(filename: string): Uint8Array {
  const p = path.join(CAPTURES_DIR, filename);
  if (!existsSync(p)) {
    throw new Error(`missing: ${p}\n  Run am4-warm-pair-capture.ts to generate.`);
  }
  return new Uint8Array(readFileSync(p));
}

interface ParsedStep {
  id: string;
  beforeBytes: Uint8Array;
  afterBytes: Uint8Array;
  beforeChunks: readonly Uint8Array[];
  afterChunks: readonly Uint8Array[];
  beforeSeptetChunks: number[][];
  afterSeptetChunks: number[][];
}

function loadStep(step: StepFiles): ParsedStep {
  const beforeBytes = loadCapture(step.before);
  const afterBytes = loadCapture(step.after);
  const beforeDump = parsePresetDump(beforeBytes);
  const afterDump = parsePresetDump(afterBytes);
  return {
    id: step.id,
    beforeBytes,
    afterBytes,
    beforeChunks: beforeDump.chunkPayloads,
    afterChunks: afterDump.chunkPayloads,
    beforeSeptetChunks: beforeDump.chunkPayloads.map((c) => decodeChunkSeptets(c)),
    afterSeptetChunks: afterDump.chunkPayloads.map((c) => decodeChunkSeptets(c)),
  };
}

function summarize(): void {
  const present = STEPS.filter((s) => {
    const have = existsSync(path.join(CAPTURES_DIR, s.before)) && existsSync(path.join(CAPTURES_DIR, s.after));
    return have;
  });
  if (present.length === 0) {
    console.error('No capture pairs found in samples/captured/.');
    console.error('Run: YES_DISCARD_Z04=1 npx tsx scripts/_research/am4-warm-pair-capture.ts');
    process.exit(1);
  }
  console.log(`AM4 warm-pair diff analyzer`);
  console.log('═'.repeat(70));
  console.log(`Loaded ${present.length}/${STEPS.length} step pairs from ${CAPTURES_DIR}`);
  console.log('');

  const steps = present.map(loadStep);

  // ── 1. Per-step byte-diff summary ──────────────────────────────────
  console.log('## 1. Per-step byte-diff summary');
  console.log(`${'step'.padEnd(28)} ${'c1'.padStart(6)} ${'c2'.padStart(6)} ${'c3'.padStart(6)} ${'c4'.padStart(6)}  total`);
  for (const s of steps) {
    const perChunk: number[] = [];
    for (let i = 0; i < CHUNKS_PER_PRESET; i++) {
      perChunk.push(diffBytes(s.beforeChunks[i]!, s.afterChunks[i]!).length);
    }
    const total = perChunk.reduce((a, b) => a + b, 0);
    console.log(
      `${s.id.padEnd(28)} ${perChunk.map((n) => String(n).padStart(6)).join(' ')}  ${String(total).padStart(5)}`,
    );
  }
  console.log('');

  // ── 2. Septet-decoded ushort diff ───────────────────────────────────
  console.log('## 2. Septet-decoded ushort diff (per chunk, records that changed)');
  console.log(`${'step'.padEnd(28)} ${'c1'.padStart(6)} ${'c2'.padStart(6)} ${'c3'.padStart(6)} ${'c4'.padStart(6)}  total`);
  for (const s of steps) {
    const perChunk: number[] = [];
    for (let i = 0; i < CHUNKS_PER_PRESET; i++) {
      perChunk.push(diffSeptets(s.beforeSeptetChunks[i]!, s.afterSeptetChunks[i]!).length);
    }
    const total = perChunk.reduce((a, b) => a + b, 0);
    console.log(
      `${s.id.padEnd(28)} ${perChunk.map((n) => String(n).padStart(6)).join(' ')}  ${String(total).padStart(5)}`,
    );
  }
  console.log('');

  // ── 3. Cache-hit validation ─────────────────────────────────────────
  //
  // Step 1 (baseline re-dump) should show ≤ 50 byte diffs total if the
  // warm-cache hypothesis from §10.1 holds. Any more and the rest of
  // the analysis is shaky.
  const baseline = steps.find((s) => s.id === '1-baseline-redump');
  if (baseline !== undefined) {
    console.log('## 3. Cache-hit validation (step 1)');
    let total = 0;
    for (let i = 0; i < CHUNKS_PER_PRESET; i++) {
      total += diffBytes(baseline.beforeChunks[i]!, baseline.afterChunks[i]!).length;
    }
    if (total <= 50) {
      console.log(`  ✓ ${total} byte diffs total — cache warm, per-param diffs should localize`);
    } else if (total <= 500) {
      console.log(`  ⚠  ${total} byte diffs — borderline; per-param diffs may be noisy but workable`);
    } else {
      console.log(`  ✗ ${total} byte diffs — cache cold; per-param byte positions WILL NOT localize`);
      console.log(`    Recommendation: try re-running am4-warm-pair-capture.ts after`);
      console.log(`    closing AM4-Edit, fully quitting Claude Desktop, and re-spawning the`);
      console.log(`    MCP child process. The warmth may be sensitive to MCP cold-start.`);
    }
    console.log('');
  }

  // ── 4. Stable-diff isolation: positions that changed ONLY in one step ──
  //
  // For each septet record position in each chunk, compute the SET of
  // steps where the record changed. Positions that changed in exactly
  // one step are the cleanest candidates for that step's targeted
  // param. Step 1 (baseline) is the noise reference: positions that
  // changed in step 1 are pure allocator drift.
  console.log('## 4. Stable-diff isolation per step (record positions that changed only in this step)');
  for (let ci = 0; ci < CHUNKS_PER_PRESET; ci++) {
    const stepChanges: Record<string, Set<number>> = {};
    for (const s of steps) {
      const changed = new Set<number>();
      const before = s.beforeSeptetChunks[ci]!;
      const after = s.afterSeptetChunks[ci]!;
      const len = Math.min(before.length, after.length);
      for (let r = 0; r < len; r++) {
        if (before[r] !== after[r]) changed.add(r);
      }
      stepChanges[s.id] = changed;
    }
    // For each step EXCEPT baseline, find positions in stepChanges[id]
    // that are NOT in stepChanges['1-baseline-redump'] (excluding noise)
    // AND are not in any other step's changes (to keep "exclusive to
    // this step"). If only baseline is present we skip exclusivity.
    const baselineChanges = stepChanges['1-baseline-redump'] ?? new Set<number>();
    for (const s of steps) {
      if (s.id === '1-baseline-redump') continue;
      const myChanges = stepChanges[s.id];
      const otherStepChanges = new Set<number>();
      for (const [id, set] of Object.entries(stepChanges)) {
        if (id === s.id || id === '1-baseline-redump') continue;
        for (const v of set) otherStepChanges.add(v);
      }
      const exclusive = [...myChanges].filter(
        (r) => !baselineChanges.has(r) && !otherStepChanges.has(r),
      );
      if (exclusive.length === 0) continue;
      console.log(`  [chunk ${ci + 1}] ${s.id}: ${exclusive.length} exclusive record(s)`);
      const before = s.beforeSeptetChunks[ci]!;
      const after = s.afterSeptetChunks[ci]!;
      // Show up to 16 of them with their absolute byte offset.
      for (const rec of exclusive.slice(0, 16)) {
        const off = rec * 3;
        const b = before[rec]!;
        const a = after[rec]!;
        console.log(
          `    rec[${String(rec).padStart(4)}] @byte 0x${off.toString(16).padStart(4, '0')}: ` +
            `0x${b.toString(16).padStart(4, '0')} → 0x${a.toString(16).padStart(4, '0')} ` +
            `(delta=${a - b > 0 ? '+' : ''}${a - b})`,
        );
      }
      if (exclusive.length > 16) console.log(`    … and ${exclusive.length - 16} more`);
    }
  }
  console.log('');

  // ── 5. Layout-table diff for step 5 (block-type swap) ──────────────
  const swap = steps.find((s) => s.id === '5-amp-type-swap');
  if (swap !== undefined) {
    console.log('## 5. Layout-table diff for step 5 (chunk1 offset 0x0e..0x40)');
    const before = swap.beforeChunks[0]!;
    const after = swap.afterChunks[0]!;
    let layoutDiffs = 0;
    for (let i = 0x0e; i <= 0x40; i++) {
      if (before[i] !== after[i]) {
        layoutDiffs++;
        console.log(
          `  c1[0x${i.toString(16).padStart(4, '0')}]: 0x${before[i]!.toString(16).padStart(2, '0')} → 0x${after[i]!.toString(16).padStart(2, '0')}`,
        );
      }
    }
    if (layoutDiffs === 0) {
      console.log('  ⚠  No diffs in 0x0e..0x40 — block-type swap may not have landed.');
      console.log('     Check that the AM4 actually showed the new block type after step 5.');
    } else {
      console.log(`  ${layoutDiffs} layout-table byte diff(s) — confirms slot register lives here`);
    }
    console.log('');
  }

  // ── 6. JSON dump of full per-step diff for downstream tooling ──────
  const jsonOut: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    captures_dir: CAPTURES_DIR,
    steps: {},
  };
  for (const s of steps) {
    const byChunk: Array<{
      chunk: number;
      byte_diffs: number[];
      septet_diffs: Array<{ rec: number; before: number; after: number; delta: number }>;
    }> = [];
    for (let ci = 0; ci < CHUNKS_PER_PRESET; ci++) {
      byChunk.push({
        chunk: ci + 1,
        byte_diffs: diffBytes(s.beforeChunks[ci]!, s.afterChunks[ci]!),
        septet_diffs: diffSeptets(s.beforeSeptetChunks[ci]!, s.afterSeptetChunks[ci]!),
      });
    }
    (jsonOut.steps as Record<string, unknown>)[s.id] = { chunks: byChunk };
  }
  const outPath = path.join(CAPTURES_DIR, 'am4-warm-pair-diff.json');
  writeFileSync(outPath, JSON.stringify(jsonOut, null, 2));
  console.log(`Wrote JSON → ${outPath}`);
}

summarize();
