/**
 * Goldens for the Axe-Fx II audibility walker
 * (`packages/fractal-gen2/src/tools/audibility.ts`).
 *
 * Pure-function tests over synthetic GridCell[] inputs. No hardware,
 * no dispatcher; the walker is what both `verifyChain` and `getPreset`
 * delegate to, so verifying it in isolation covers both surfaces.
 *
 * Cases follow the locked v1 scope:
 *   - Empty grid
 *   - Single serial chain OK
 *   - Missing-shunt break (routing_flags=0 mid-chain)
 *   - Dead leg (routing_flags points to empty source)
 *   - Parallel rows OK (both branches reach output)
 *   - Parallel rows with orphan branch (one reaches output, one doesn't)
 *     → walker flags the orphan as a break per BFS reachability semantics
 *   - Bypassed-MUTE block on the only path → break
 *   - Bypassed-MUTE block on a parallel path (alternate path exists) → no break
 *   - Bypassed-THRU block on the only path → no break
 *   - Output block bypassed → break
 *   - FX Loop engaged on the active path → soft note
 *   - FX Loop bypassed on the active path → no note
 *   - bypass_mode='MUTE FX OUT' on serial chain → no break (wet mute only)
 *
 * Run: npx tsx scripts/verify-audibility.ts
 */

import { checkAudibility } from '../packages/fractal-gen2/src/tools/audibility.js';
import type { GridCell } from 'fractal-midi/gen2/axe-fx-ii';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `. ${detail}` : ''}`);
  }
}

// Block IDs we reference. Matches BLOCK_BY_ID in fractal-midi/gen2/axe-fx-ii.
const AMP_1 = 106;
const CAB_1 = 109;
const REV_1 = 110;
const DELAY_1 = 115;
const FX_LOOP = 136;
const OUTPUT = 140;
const SHUNT_BASE = 200; // 200..235 are shunts

// Routing-flag bits. Bit N (0..3) set ⇒ row N+1 of the previous column
// connects to this cell's input.
const ROW1_IN = 0x1;
const ROW2_IN = 0x2;
const ROW3_IN = 0x4;
const ROW4_IN = 0x8;

function cell(row: number, col: number, blockId: number, routingFlags = 0): GridCell {
  return { row, col, blockId, routingFlags };
}

console.log('Case 1: empty grid → ok=true, "wire" summary');
{
  const r = checkAudibility({ cells: [] });
  check('ok=true', r.ok === true);
  check('summary mentions wire', r.summary.toLowerCase().includes('wire'));
  check('breaks empty', r.breaks.length === 0);
  check('notes empty', r.notes.length === 0);
}

console.log('\nCase 2: single serial chain on row 2, all cabled → ok=true');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),           // col 1 — no routing needed
    cell(2, 2, CAB_1, ROW2_IN),     // receives from row 2 col 1
    cell(2, 3, REV_1, ROW2_IN),
    cell(2, 4, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=true', r.ok === true, `summary=${r.summary}`);
  check('no breaks', r.breaks.length === 0);
}

console.log('\nCase 3: missing shunt mid-chain (routing_flags=0 at col 3) → break');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, CAB_1, ROW2_IN),
    cell(2, 3, REV_1, 0),           // ← broken cable
    cell(2, 4, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=false', r.ok === false);
  check('break at row 2 col 3', r.breaks.some(b => b.slot_ref.row === 2 && b.slot_ref.col === 3));
  check('reason mentions routing_mask=0', r.breaks[0]?.reason.includes('routing_mask=0'));
}

console.log('\nCase 4: dead leg — routing_flags point to empty source → break');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, CAB_1, ROW1_IN),     // points to row 1 col 1 — empty
    cell(2, 3, REV_1, ROW2_IN),
    cell(2, 4, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=false', r.ok === false);
  check('dead-leg break at row 2 col 2', r.breaks.some(b => b.slot_ref.row === 2 && b.slot_ref.col === 2));
  check('reason mentions dead leg or empty', r.breaks.some(b => b.reason.toLowerCase().includes('dead leg') || b.reason.toLowerCase().includes('empty')));
}

console.log('\nCase 5: parallel rows OK (row 1 + row 3 → merge col 4) → ok=true');
{
  const cells: GridCell[] = [
    cell(1, 1, AMP_1, 0),
    cell(3, 1, REV_1, 0),
    cell(1, 2, CAB_1, ROW1_IN),
    cell(3, 2, DELAY_1, ROW3_IN),
    cell(2, 3, OUTPUT, ROW1_IN | ROW3_IN),  // merges both
  ];
  const r = checkAudibility({ cells });
  check('ok=true', r.ok === true, `breaks=${JSON.stringify(r.breaks)}`);
}

console.log('\nCase 6: parallel rows with orphan branch — one path reaches output, one stops short → walker flags the orphan');
{
  const cells: GridCell[] = [
    cell(1, 1, AMP_1, 0),
    cell(3, 1, REV_1, 0),
    cell(1, 2, CAB_1, ROW1_IN),
    cell(3, 2, DELAY_1, 0),          // ← orphan: no input cable
    cell(1, 3, OUTPUT, ROW1_IN),
  ];
  const r = checkAudibility({ cells });
  // The orphan is a routing break. ok=false; one signal path still
  // works but the dead leg is real and the agent should know.
  check('ok=false (orphan branch is a break)', r.ok === false);
  check('break at row 3 col 2', r.breaks.some(b => b.slot_ref.row === 3 && b.slot_ref.col === 2));
}

console.log('\nCase 7: bypassed-MUTE amp on only path → break');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, CAB_1, ROW2_IN),
    cell(2, 3, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[AMP_1, true]]),
    bypassModeByBlockId: new Map([[AMP_1, 'MUTE']]),
  });
  check('ok=false', r.ok === false);
  check('break at row 2 col 1 (the amp)', r.breaks.some(b => b.slot_ref.row === 2 && b.slot_ref.col === 1));
  check('reason mentions MUTE', r.breaks.some(b => b.reason.includes('MUTE')));
}

console.log('\nCase 8: bypassed-MUTE block on a parallel path (alt path exists) → no break');
{
  const cells: GridCell[] = [
    cell(1, 1, AMP_1, 0),
    cell(3, 1, REV_1, 0),
    cell(1, 2, CAB_1, ROW1_IN),
    cell(3, 2, DELAY_1, ROW3_IN),
    cell(2, 3, OUTPUT, ROW1_IN | ROW3_IN),
  ];
  // Reverb on row 3 col 1 is bypassed-MUTE, but row 1 carries signal too.
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[REV_1, true]]),
    bypassModeByBlockId: new Map([[REV_1, 'MUTE']]),
  });
  check('ok=true (parallel path keeps signal alive)', r.ok === true, `breaks=${JSON.stringify(r.breaks)}`);
}

console.log('\nCase 9: bypassed-THRU amp on only path → no break (THRU passes signal)');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, CAB_1, ROW2_IN),
    cell(2, 3, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[AMP_1, true]]),
    bypassModeByBlockId: new Map([[AMP_1, 'THRU']]),
  });
  check('ok=true', r.ok === true);
}

console.log('\nCase 10: Output block bypassed → break (forced MUTE regardless of param)');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[OUTPUT, true]]),
    bypassModeByBlockId: new Map([[OUTPUT, 'THRU']]),  // even with THRU, hardware forces MUTE
  });
  check('ok=false', r.ok === false);
  check('reason mentions Output', r.breaks.some(b => b.reason.toLowerCase().includes('output')));
  check('reason mentions hardware-forced MUTE', r.breaks.some(b => b.reason.includes('MUTE')));
}

console.log('\nCase 11: FX Loop engaged on active path → soft note, ok=true');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, FX_LOOP, ROW2_IN),
    cell(2, 3, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[FX_LOOP, false]]),
    bypassModeByBlockId: new Map([[FX_LOOP, 'THRU']]),
  });
  check('ok=true (not a silence flag)', r.ok === true);
  check('exactly 1 note', r.notes.length === 1);
  check('note mentions FX Loop / Send / Return', r.notes[0]?.note.toLowerCase().match(/fx loop|send|return/) !== null);
}

console.log('\nCase 12: FX Loop bypassed on active path → no note (block is inert)');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, FX_LOOP, ROW2_IN),
    cell(2, 3, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[FX_LOOP, true]]),
    bypassModeByBlockId: new Map([[FX_LOOP, 'THRU']]),
  });
  check('ok=true', r.ok === true);
  check('no notes', r.notes.length === 0);
}

console.log('\nCase 13: bypass_mode="MUTE FX OUT" on only path → no break (only the wet tail is muted)');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, REV_1, ROW2_IN),
    cell(2, 3, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[REV_1, true]]),
    bypassModeByBlockId: new Map([[REV_1, 'MUTE FX OUT']]),
  });
  check('ok=true', r.ok === true, `breaks=${JSON.stringify(r.breaks)}`);
}

console.log('\nCase 14: shunts in the chain (200..235) walk like any cell');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, SHUNT_BASE, ROW2_IN),
    cell(2, 3, SHUNT_BASE + 1, ROW2_IN),
    cell(2, 4, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=true', r.ok === true);
}

console.log('\nCase 15: shunts with a gap → break');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, SHUNT_BASE, ROW2_IN),
    cell(2, 3, SHUNT_BASE + 1, 0),  // ← shunt with no input
    cell(2, 4, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=false', r.ok === false);
  check('break at row 2 col 3', r.breaks.some(b => b.slot_ref.row === 2 && b.slot_ref.col === 3));
}

// REGRESSION GUARD: empirical real-world bug 2026-05-23. Agent built a
// 6-block chain ending at col 6 with no placed Output block and no
// shunts through col 12. Pre-fix the walker said ok:true because col
// 6 (the rightmost placed col) had an input-reachable cell, so the
// agent confidently told the user the preset was wired. Scene 1 was
// silent. The walker must detect this: chain stops short of col 12,
// no placed Output block reachable, no signal at the hardware output.
console.log('\nCase 16: chain ends at col 6 with no Output block + no shunts to col 12 → break');
{
  const COMP_1 = 100;
  const MIXER = 138;
  const cells: GridCell[] = [
    cell(2, 1, COMP_1, 0),
    cell(2, 2, AMP_1, ROW2_IN),
    cell(2, 3, MIXER, ROW2_IN),
    cell(2, 4, CAB_1, ROW2_IN),
    cell(2, 5, DELAY_1, ROW2_IN),
    cell(2, 6, REV_1, ROW2_IN),
    // cols 7-12 empty, NO Output block placed
  ];
  const r = checkAudibility({ cells });
  check(
    'ok=false (chain stops short of device output col 12)',
    r.ok === false,
    `summary=${r.summary}, breaks=${JSON.stringify(r.breaks).slice(0, 200)}`,
  );
  check(
    'break names col 12 / device output',
    r.breaks.some((b) => b.reason.includes('col 12') || b.reason.toLowerCase().includes('device output')),
  );
  check(
    'break message suggests extending with shunts or placing an Output block',
    r.breaks.some((b) =>
      b.reason.toLowerCase().includes('shunt')
        || b.reason.toLowerCase().includes('output block')
        || b.reason.toLowerCase().includes('extend'),
    ),
  );
}

// Boundary test: chain extends through col 12 via shunts → ok=true.
// The natural fix for Case 16 is to extend with shunts; this test
// confirms that's accepted as a valid topology.
console.log('\nCase 17: chain at cols 1-6 + shunts through col 12 → ok=true (proper terminator)');
{
  const COMP_1 = 100;
  const cells: GridCell[] = [
    cell(2, 1, COMP_1, 0),
    cell(2, 2, AMP_1, ROW2_IN),
    cell(2, 3, CAB_1, ROW2_IN),
    cell(2, 4, DELAY_1, ROW2_IN),
    cell(2, 5, REV_1, ROW2_IN),
    cell(2, 6, SHUNT_BASE, ROW2_IN),
    cell(2, 7, SHUNT_BASE + 1, ROW2_IN),
    cell(2, 8, SHUNT_BASE + 2, ROW2_IN),
    cell(2, 9, SHUNT_BASE + 3, ROW2_IN),
    cell(2, 10, SHUNT_BASE + 4, ROW2_IN),
    cell(2, 11, SHUNT_BASE + 5, ROW2_IN),
    cell(2, 12, SHUNT_BASE + 6, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=true (chain reaches col 12)', r.ok === true,
    `summary=${r.summary}, breaks=${JSON.stringify(r.breaks).slice(0, 200)}`);
}

// ─────────────────────────────────────────────────────────────────
// Power-user parallel topologies.
// These are the routing patterns most frequently needed for wet/dry
// rigs, parallel effects, and multi-input configurations.
// ─────────────────────────────────────────────────────────────────

// Case 18: 3-way fan-out — amp at r2c1 branches into three parallel
// effects (delay r1c2, reverb r2c2, chorus r3c2), each on its own row,
// all independent chains running to col 12 via shunts.
// Models "multiple inputs branching from a single block."
console.log('\nCase 18: 3-way fan-out (amp → delay / reverb / chorus, 3 independent chains) → ok=true');
{
  const CHORUS_1 = 120;
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),                      // amp: source for all three
    cell(1, 2, DELAY_1, ROW2_IN),               // delay on row 1, receives from row 2 col 1
    cell(2, 2, REV_1, ROW2_IN),                 // reverb on row 2, receives from row 2 col 1
    cell(3, 2, CHORUS_1, ROW2_IN),              // chorus on row 3, receives from row 2 col 1
    // extend all three rows to col 12 with shunts
    cell(1, 3, SHUNT_BASE, ROW1_IN),
    cell(2, 3, SHUNT_BASE + 1, ROW2_IN),
    cell(3, 3, SHUNT_BASE + 2, ROW3_IN),
    cell(1, 4, SHUNT_BASE + 3, ROW1_IN),
    cell(2, 4, SHUNT_BASE + 4, ROW2_IN),
    cell(3, 4, SHUNT_BASE + 5, ROW3_IN),
    cell(1, 5, SHUNT_BASE + 6, ROW1_IN),
    cell(2, 5, SHUNT_BASE + 7, ROW2_IN),
    cell(3, 5, SHUNT_BASE + 8, ROW3_IN),
    cell(1, 6, SHUNT_BASE + 9, ROW1_IN),
    cell(2, 6, SHUNT_BASE + 10, ROW2_IN),
    cell(3, 6, SHUNT_BASE + 11, ROW3_IN),
    cell(1, 7, SHUNT_BASE + 12, ROW1_IN),
    cell(2, 7, SHUNT_BASE + 13, ROW2_IN),
    cell(3, 7, SHUNT_BASE + 14, ROW3_IN),
    cell(1, 8, SHUNT_BASE + 15, ROW1_IN),
    cell(2, 8, SHUNT_BASE + 16, ROW2_IN),
    cell(3, 8, SHUNT_BASE + 17, ROW3_IN),
    cell(1, 9, SHUNT_BASE + 18, ROW1_IN),
    cell(2, 9, SHUNT_BASE + 19, ROW2_IN),
    cell(3, 9, SHUNT_BASE + 20, ROW3_IN),
    cell(1, 10, SHUNT_BASE + 21, ROW1_IN),
    cell(2, 10, SHUNT_BASE + 22, ROW2_IN),
    cell(3, 10, SHUNT_BASE + 23, ROW3_IN),
    cell(1, 11, SHUNT_BASE + 24, ROW1_IN),
    cell(2, 11, SHUNT_BASE + 25, ROW2_IN),
    cell(3, 11, SHUNT_BASE + 26, ROW3_IN),
    cell(1, 12, SHUNT_BASE + 27, ROW1_IN),
    cell(2, 12, SHUNT_BASE + 28, ROW2_IN),
    cell(3, 12, SHUNT_BASE + 29, ROW3_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=true', r.ok === true, `breaks=${JSON.stringify(r.breaks).slice(0, 300)}`);
  check('no breaks', r.breaks.length === 0);
}

// Case 19: Diamond topology — amp at r2c1 fans out to delay r2c2 AND
// reverb r3c2, both merge into a mixer at r2c3 (receives from rows 2+3),
// then the mixer extends to col 12 via shunts.
// Classic wet/dry parallel rig: single input, two effect branches, merge.
console.log('\nCase 19: diamond (amp → delay+reverb parallel, merge at mixer, output via shunts) → ok=true');
{
  const MIXER = 138;
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, DELAY_1, ROW2_IN),            // delay: receives from r2c1
    cell(3, 2, REV_1, ROW2_IN),              // reverb: cross-row fan-out from r2c1
    cell(2, 3, MIXER, ROW2_IN | ROW3_IN),    // mixer: merges row-2 delay + row-3 reverb
    cell(2, 4, SHUNT_BASE, ROW2_IN),
    cell(2, 5, SHUNT_BASE + 1, ROW2_IN),
    cell(2, 6, SHUNT_BASE + 2, ROW2_IN),
    cell(2, 7, SHUNT_BASE + 3, ROW2_IN),
    cell(2, 8, SHUNT_BASE + 4, ROW2_IN),
    cell(2, 9, SHUNT_BASE + 5, ROW2_IN),
    cell(2, 10, SHUNT_BASE + 6, ROW2_IN),
    cell(2, 11, SHUNT_BASE + 7, ROW2_IN),
    cell(2, 12, SHUNT_BASE + 8, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=true', r.ok === true, `breaks=${JSON.stringify(r.breaks).slice(0, 300)}`);
  check('no breaks', r.breaks.length === 0);
}

// Case 20: Diamond with one broken leg.
// Same diamond as Case 19, but the reverb branch (r3c2) has
// routingFlags=0 — its input cable is missing. The delay branch still
// reaches the mixer and the output, but the broken leg is a real
// routing error and the walker must report it.
console.log('\nCase 20: diamond with broken reverb leg (r3c2 routingFlags=0) → ok=false, break at r3c2');
{
  const MIXER = 138;
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, DELAY_1, ROW2_IN),
    cell(3, 2, REV_1, 0),                    // broken: no input cable
    cell(2, 3, MIXER, ROW2_IN | ROW3_IN),
    cell(2, 4, SHUNT_BASE, ROW2_IN),
    cell(2, 5, SHUNT_BASE + 1, ROW2_IN),
    cell(2, 6, SHUNT_BASE + 2, ROW2_IN),
    cell(2, 7, SHUNT_BASE + 3, ROW2_IN),
    cell(2, 8, SHUNT_BASE + 4, ROW2_IN),
    cell(2, 9, SHUNT_BASE + 5, ROW2_IN),
    cell(2, 10, SHUNT_BASE + 6, ROW2_IN),
    cell(2, 11, SHUNT_BASE + 7, ROW2_IN),
    cell(2, 12, SHUNT_BASE + 8, ROW2_IN),
  ];
  const r = checkAudibility({ cells });
  check('ok=false (broken reverb leg)', r.ok === false);
  check('break at row 3 col 2', r.breaks.some((b) => b.slot_ref.row === 3 && b.slot_ref.col === 2));
  check('reason mentions routing_mask=0', r.breaks.some((b) => b.reason.includes('routing_mask=0')));
}

// Case 22: FX Loop → Output block — the classic "record rig" chain
// terminator. Amp feeds FX Loop (send to DAW), FX Loop output goes to
// the Output block at col 3. The Output block acts as the hardware sink;
// no shunts to col 12 are needed. The FX Loop is engaged (not bypassed),
// so the audibility check should fire a soft note AND ok=true.
console.log('\nCase 22: amp → FX Loop → Output block (no shunts) → ok=true with 1 FX Loop note');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, FX_LOOP, ROW2_IN),
    cell(2, 3, OUTPUT, ROW2_IN),
  ];
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[FX_LOOP, false], [OUTPUT, false]]),
    bypassModeByBlockId: new Map([[FX_LOOP, 'THRU'], [OUTPUT, 'THRU']]),
  });
  check('ok=true (Output block terminates chain)', r.ok === true, `breaks=${JSON.stringify(r.breaks)}`);
  check('exactly 1 note (FX Loop engaged)', r.notes.length === 1);
  check('note references FX Loop', r.notes[0]?.note.toLowerCase().match(/fx loop|send|return/) !== null);
}

// Case 21: MUTE-bypassed delay on parallel path — the delay is on row 2,
// reverb on row 3, both reach the output via their own chains. The delay
// is bypassed-MUTE, but the reverb path still carries signal, so the
// delay is NOT a cut vertex and there must be no silence break.
// The key distinction from Case 7: there the bypassed block WAS a cut vertex.
console.log('\nCase 21: parallel path survives MUTE-bypass on one leg (reverb still carries signal) → ok=true');
{
  const cells: GridCell[] = [
    cell(2, 1, AMP_1, 0),
    cell(2, 2, DELAY_1, ROW2_IN),
    cell(3, 2, REV_1, ROW2_IN),           // parallel reverb from amp
    // both legs run independently to col 12
    cell(2, 3, SHUNT_BASE, ROW2_IN),      cell(3, 3, SHUNT_BASE + 1, ROW3_IN),
    cell(2, 4, SHUNT_BASE + 2, ROW2_IN),  cell(3, 4, SHUNT_BASE + 3, ROW3_IN),
    cell(2, 5, SHUNT_BASE + 4, ROW2_IN),  cell(3, 5, SHUNT_BASE + 5, ROW3_IN),
    cell(2, 6, SHUNT_BASE + 6, ROW2_IN),  cell(3, 6, SHUNT_BASE + 7, ROW3_IN),
    cell(2, 7, SHUNT_BASE + 8, ROW2_IN),  cell(3, 7, SHUNT_BASE + 9, ROW3_IN),
    cell(2, 8, SHUNT_BASE + 10, ROW2_IN), cell(3, 8, SHUNT_BASE + 11, ROW3_IN),
    cell(2, 9, SHUNT_BASE + 12, ROW2_IN), cell(3, 9, SHUNT_BASE + 13, ROW3_IN),
    cell(2, 10, SHUNT_BASE + 14, ROW2_IN),cell(3, 10, SHUNT_BASE + 15, ROW3_IN),
    cell(2, 11, SHUNT_BASE + 16, ROW2_IN),cell(3, 11, SHUNT_BASE + 17, ROW3_IN),
    cell(2, 12, SHUNT_BASE + 18, ROW2_IN),cell(3, 12, SHUNT_BASE + 19, ROW3_IN),
  ];
  // Delay (row 2) is bypassed-MUTE; reverb (row 3) is active.
  const r = checkAudibility({
    cells,
    bypassByBlockId: new Map([[DELAY_1, true]]),
    bypassModeByBlockId: new Map([[DELAY_1, 'MUTE']]),
  });
  check('ok=true (reverb carries signal on parallel path)', r.ok === true,
    `breaks=${JSON.stringify(r.breaks)}`);
  check('no breaks', r.breaks.length === 0);
}

console.log(`\n${failed === 0 ? 'all cases pass' : `${failed} case(s) failed`}.`);
if (failed > 0) process.exit(1);
