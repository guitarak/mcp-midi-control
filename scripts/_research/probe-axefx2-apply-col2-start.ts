/**
 * Hardware verify the shunt-loop fix in applyExecutor.ts.
 *
 * Pre-fix: an apply_preset spec with content starting at col 2+ left
 * col 1 empty (shunt loop only filled cols [resolved.length+1..12]).
 * The first auto-cable col 1 → col 2 then NACKed with result_code=0x0e.
 *
 * Post-fix: shunt loop walks all of row 2 (cols 1..12) and fills every
 * empty cell. Col 1 gets a shunt when no user content placed there.
 *
 * This probe runs the buildApplyPresetOps pipeline for a 2-block spec
 * (amp@C2 + cab@C3) against live hardware, then inspects the result:
 *   - ok must be true
 *   - nackedSteps must be empty
 *   - get_grid_layout post-apply shows blocks at C2 + C3, shunts at the
 *     remaining row-2 cells, and a non-zero routing mask on C2 (signal
 *     reaches the amp from col 1).
 *
 * Setup: Axe-Fx II connected, Claude Desktop CLOSED.
 * Run: `npx tsx scripts/_research/probe-axefx2-apply-col2-start.ts`
 */

import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildApplyPresetOps,
  runApplyPresetAtOps,
} from '@mcp-midi-control/fractal-gen2/tools/applyExecutor.js';
import {
  buildGetGridLayout,
  isGetGridLayoutResponse,
  parseGetGridLayoutResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function main(): Promise<void> {
  console.log('Connecting to Axe-Fx II...');
  const conn = connectAxeFxII();
  if (!conn.hasInput) {
    console.error('❌ input port not available, cannot verify');
    process.exit(1);
  }
  console.log('✓ Connected.\n');

  // Build the same MinTest shape that failed in production: amp@C2 + cab@C3.
  const ops = buildApplyPresetOps(
    {
      name: 'ColTwoTest',
      blocks: [
        { block: 'Amp 1', row: 2, col: 2, paramsByChannel: { X: { effect_type: 31 } } },
        { block: 'Cab 1', row: 2, col: 3 },
      ],
    },
    { wire: true },
  );

  console.log(`Generated ${ops.length} ops for working-buffer apply (amp@C2 + cab@C3).`);
  const cableCount = ops.filter((o) => o.kind === 'cable').length;
  const shuntPlacements = ops.filter((o) => o.kind === 'place_block' && /SHUNT/.test(o.summary)).length;
  const clears = ops.filter((o) => o.kind === 'clear_cell').length;
  console.log(`  clears: ${clears}, shunt placements: ${shuntPlacements}, cables: ${cableCount}`);
  console.log(`  expect shunt placements=10 (cols 1,4,5..12 = 10 empty row-2 cells), cables=11 (cols 2..12)`);

  console.log('\nRunning ops against the device...');
  const result = await runApplyPresetAtOps(conn, ops);
  console.log(`\nResult: ok=${result.ok}, acks=${result.acks}, nackedSteps=${result.nackedSteps.length}, elapsed=${result.elapsedMs}ms`);

  if (result.nackedSteps.length > 0) {
    console.log('\n❌ NACK(s) recorded:');
    for (const n of result.nackedSteps) {
      console.log(`  step ${n.index}: ${n.summary} → result_code=0x${n.resultCode.toString(16).padStart(2, '0')}`);
    }
  } else {
    console.log('\n✓ No NACKs');
  }

  await sleep(120);

  console.log('\nReading post-apply grid...');
  const ackP = conn.receiveSysExMatching(isGetGridLayoutResponse, 800);
  conn.send(buildGetGridLayout());
  const ack = await ackP;
  const cells = parseGetGridLayoutResponse(ack);
  const r2 = cells.filter((c) => c.row === 2).sort((a, b) => a.col - b.col);
  console.log('Row 2 state:');
  for (const c of r2) {
    const tag = c.blockId === 0 ? 'EMPTY' : c.blockId >= 200 && c.blockId <= 235 ? `shunt(${c.blockId})` : `bid=${c.blockId}`;
    console.log(`  C${c.col}: ${tag}  mask=0x${c.routingFlags.toString(16).padStart(2, '0')}`);
  }

  const c2 = r2.find((c) => c.col === 2);
  const c3 = r2.find((c) => c.col === 3);
  const c1 = r2.find((c) => c.col === 1);
  const c12 = r2.find((c) => c.col === 12);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('══════════════════════════════════════════════════════════');
  const apply_ok = result.ok && result.nackedSteps.length === 0;
  const cellsPopulated =
    c1?.blockId !== 0 &&
    c2?.blockId === 106 &&
    c3?.blockId === 108 &&
    c12?.blockId !== 0;
  const cabled =
    (c2?.routingFlags ?? 0) !== 0 &&
    (c12?.routingFlags ?? 0) !== 0;

  console.log(`  apply ok:                  ${apply_ok ? '✓' : '✗'}  (ok=${result.ok}, nacks=${result.nackedSteps.length})`);
  console.log(`  col 1 populated:           ${c1?.blockId !== 0 ? '✓' : '✗'}  (bid=${c1?.blockId})`);
  console.log(`  amp at col 2:              ${c2?.blockId === 106 ? '✓' : '✗'}  (bid=${c2?.blockId})`);
  console.log(`  cab at col 3:              ${c3?.blockId === 108 ? '✓' : '✗'}  (bid=${c3?.blockId})`);
  console.log(`  shunt at col 12:           ${c12?.blockId !== 0 ? '✓' : '✗'}  (bid=${c12?.blockId})`);
  console.log(`  col 2 has input cable:     ${(c2?.routingFlags ?? 0) !== 0 ? '✓' : '✗'}  (mask=0x${(c2?.routingFlags ?? 0).toString(16)})`);
  console.log(`  col 12 has input cable:    ${(c12?.routingFlags ?? 0) !== 0 ? '✓' : '✗'}  (mask=0x${(c12?.routingFlags ?? 0).toString(16)})`);

  if (apply_ok && cellsPopulated && cabled) {
    console.log('\n✅ FIX VERIFIED: col-2-start apply now succeeds end-to-end with full row-2 chain.');
  } else {
    console.log('\n❌ Fix did NOT fully resolve the issue. Inspect output above.');
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
