#!/usr/bin/env tsx
/**
 * Empirical verification of the chain_integrity fix against the live
 * II working buffer. The other-laptop session left a 6-block chain at
 * cols 1-6 (CPR1 → AMP1 → MIX → CAB1 → DLY1 → REV1) with no Output
 * block placed and no shunts through col 12. Scene 1 was silent in
 * real life because signal didn't reach the col 12 device output.
 *
 * Pre-fix chain_integrity returned ok:true. Post-fix it should return
 * ok:false with a break naming col 12.
 *
 * Approach: do a minimal apply_preset that REPLAYS the current grid
 * state (without changing it) with verify_chain:true, and inspect the
 * chain_integrity field. If we just want to read state, the audibility
 * walker is also invoked by other read paths.
 *
 * Simpler: we already know the grid via axefx2_get_grid_layout. Just
 * construct a synthetic GridCell[] matching what we observed and feed
 * checkAudibility directly. That's a pure-function call, no hardware
 * needed beyond the initial read we already did.
 */

import { checkAudibility } from '../../packages/fractal-gen2/src/tools/audibility.js';
import type { GridCell } from 'fractal-midi/gen2/axe-fx-ii';

// IDs per fractal-midi/src/gen2/axe-fx-ii/blockTypes.ts
const COMP_1 = 100;
const AMP_1 = 106;
const CAB_1 = 109;
const REV_1 = 110;
const DELAY_1 = 115;
const MIXER = 138;

const ROW2_IN = 0x2; // row 2 of col N-1 feeds row 2 of col N

// Snapshot of the live II working buffer (read 2026-05-23):
//   Row 2, serial chain, 6 blocks:
//     CPR1 → AMP1 → MIX → CAB1 → DLY1 → REV1
//   Cols 7-12 empty. No Output block placed.
//
// Pre-fix chain_integrity.ok was true because col 6 (reverb) had an
// input-reachable cell. Scene 1 was silent in practice.
const liveCells: GridCell[] = [
  { row: 2, col: 1, blockId: COMP_1, routingFlags: 0 },
  { row: 2, col: 2, blockId: AMP_1, routingFlags: ROW2_IN },
  { row: 2, col: 3, blockId: MIXER, routingFlags: ROW2_IN },
  { row: 2, col: 4, blockId: CAB_1, routingFlags: ROW2_IN },
  { row: 2, col: 5, blockId: DELAY_1, routingFlags: ROW2_IN },
  { row: 2, col: 6, blockId: REV_1, routingFlags: ROW2_IN },
];

console.log('Empirical verification of chain_integrity fix:');
console.log('Live II working-buffer state: 6 blocks at row 2 cols 1-6, no Output block, no shunts to col 12.');
console.log();

const result = checkAudibility({ cells: liveCells });

console.log(`ok: ${result.ok}`);
console.log(`summary: ${result.summary}`);
console.log(`breaks (${result.breaks.length}):`);
for (const b of result.breaks) {
  console.log(`  row ${b.slot_ref.row} col ${b.slot_ref.col}: ${b.reason}`);
}
console.log();

if (result.ok) {
  console.error('FAIL: walker still returns ok:true for a chain that ends short of col 12.');
  process.exit(1);
}

const namesCol12 = result.breaks.some((b) =>
  b.reason.includes('col 12') || b.reason.toLowerCase().includes('device output'),
);
if (!namesCol12) {
  console.error('FAIL: break does not name col 12 / device output.');
  process.exit(1);
}

console.log('PASS: chain_integrity correctly detects the broken chain.');
console.log('The fix would have surfaced this to the agent on the other laptop,');
console.log('preventing the misleading "ok, scene 1 should work" message.');
