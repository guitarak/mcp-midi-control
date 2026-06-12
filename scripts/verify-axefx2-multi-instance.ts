#!/usr/bin/env tsx
/**
 * Verify Axe-Fx II translateSpec honors `instance` when resolving the
 * block name to an effectId. Pre-fix (alpha.1) both `instance:1` and
 * `instance:2` resolved to "Amp 1" (effectId 106). Placing the same
 * effectId twice triggered the device's "move on duplicate" behavior:
 * the second placement evicted the first cell, leaving col 2 empty, and
 * the cable row 2 col 1 → row 2 col 2 NACKed with 0x0e (dst empty).
 *
 * This file is the structural-translator guard. Wire-op coverage (cable
 * NACK aggregation, mid-sequence ok=false flip) lives in
 * verify-grid-routing.ts; agent-sweep coverage lives in
 * scripts/agent-regression/cases-axe-fx-ii.ts (multi_amp_dual_voice).
 *
 * Run via: npx tsx scripts/verify-axefx2-multi-instance.ts
 */

import { translateSpec } from '../packages/fractal-gen2/src/descriptor/writer.js';
import { buildApplyPresetOps } from '../packages/fractal-gen2/src/tools/applyExecutor.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { resolveBlock } from 'fractal-midi/gen2/axe-fx-ii';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

// ─── Case 1: two amp slots, instance:1 + instance:2 → distinct names ──
console.log('\nCase 1: translateSpec resolves instance:2 to "Amp 2" (distinct effectId)');
{
  // Pure structural translator test: block_type + instance only.
  // Param-value encoding is covered by verify-axe-fx-ii-encoding.ts;
  // including knobs here ties this test to display-calibration state
  // unnecessarily.
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 1 },
      { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2 },
      { slot: { row: 2, col: 4 }, block_type: 'cab' },
    ],
  };
  const translated = translateSpec(spec);
  const ampBlocks = translated.blocks.filter((b) => /^Amp /.test(String(b.block)));
  check('two amp blocks present', ampBlocks.length === 2, `got ${ampBlocks.length}`);
  check('first amp resolves to "Amp 1"', ampBlocks[0]?.block === 'Amp 1', `got ${ampBlocks[0]?.block}`);
  check('second amp resolves to "Amp 2"', ampBlocks[1]?.block === 'Amp 2', `got ${ampBlocks[1]?.block}`);
  const amp1 = resolveBlock('Amp 1');
  const amp2 = resolveBlock('Amp 2');
  check('Amp 1 / Amp 2 are distinct effectIds', amp1 !== undefined && amp2 !== undefined && amp1.id !== amp2.id, `amp1.id=${amp1?.id} amp2.id=${amp2?.id}`);
  // Distinct ids in blocks[] auto-derive:
  check('first amp id is "amp"', ampBlocks[0]?.id === 'amp', `got ${ampBlocks[0]?.id}`);
  check('second amp id is "amp_2"', ampBlocks[1]?.id === 'amp_2', `got ${ampBlocks[1]?.id}`);
}

// ─── Case 2: drive block instance:2 resolves to "Drive 2" ─────────────
console.log('\nCase 2: translateSpec resolves drive instance:2 to "Drive 2"');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 2, col: 2 }, block_type: 'drive', instance: 1 },
      { slot: { row: 2, col: 3 }, block_type: 'drive', instance: 2 },
    ],
  };
  const translated = translateSpec(spec);
  const drives = translated.blocks.filter((b) => /^Drive /.test(String(b.block)));
  check('two drive blocks present', drives.length === 2);
  check('first drive resolves to "Drive 1"', drives[0]?.block === 'Drive 1', `got ${drives[0]?.block}`);
  check('second drive resolves to "Drive 2"', drives[1]?.block === 'Drive 2', `got ${drives[1]?.block}`);
}

// ─── Case 3: out-of-range instance throws structured error ────────────
console.log('\nCase 3: instance:3 on amp (max 2) throws structured DispatchError');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 2 }, block_type: 'amp', instance: 3 }],
  };
  let caught: Error | undefined;
  try {
    translateSpec(spec);
  } catch (err) {
    caught = err as Error;
  }
  check('threw', caught !== undefined, 'no error');
  check(
    'error message names the valid range',
    caught !== undefined && /instance=3.*1\.\.2|valid instances: 1\.\.2/.test(caught.message),
    `got: ${caught?.message}`,
  );
}

// ─── Case 4: default instance (omitted) resolves to instance 1 ────────
console.log('\nCase 4: omitted instance defaults to instance 1 ("Amp 1")');
{
  const spec: PresetSpec = {
    slots: [{ slot: { row: 2, col: 2 }, block_type: 'amp' }],
  };
  const translated = translateSpec(spec);
  check('first block resolves to "Amp 1"', translated.blocks[0]?.block === 'Amp 1', `got ${translated.blocks[0]?.block}`);
  check('first block id auto-derives to "amp"', translated.blocks[0]?.id === 'amp', `got ${translated.blocks[0]?.id}`);
}

// ─── Case 5: buildApplyPresetOps produces distinct PLACE bytes for 2 amps ──
console.log('\nCase 5: buildApplyPresetOps emits distinct effectIds for two amp slots');
{
  const spec: PresetSpec = {
    slots: [
      { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 1 },
      { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2 },
    ],
  };
  const translated = translateSpec(spec);
  const ops = buildApplyPresetOps(translated);
  const places = ops.filter((o) => o.kind === 'place_block' && /^PLACE Amp /.test(o.summary));
  check('two amp PLACE ops emitted', places.length === 2, `got ${places.length}`);
  // The set_grid_cell wire shape carries effectId in the payload; the
  // distinct-name assertion above covers the same surface from the
  // translator side. Cross-check at the byte level: the PLACE ops MUST
  // have distinct wire bytes (different effectIds → different bytes).
  if (places.length === 2) {
    const byte1 = places[0].bytes.join(',');
    const byte2 = places[1].bytes.join(',');
    check('two PLACE op byte streams are distinct', byte1 !== byte2, 'two PLACE ops emitted identical wire bytes — duplicate effectId would re-trigger the alpha.1 move-on-duplicate bug');
  }
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
