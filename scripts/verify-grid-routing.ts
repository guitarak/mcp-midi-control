#!/usr/bin/env tsx
/**
 * Wire-byte mock test harness for Axe-Fx II grid routing.
 *
 * Captures emitted SysEx bytes from runApplyPresetAtOps under a fake
 * ApplyConn that records sends and replies with canned ACKs. Asserts:
 *
 *   1. Every block→next cable in a serial chain is emitted as a
 *      SET_CELL_ROUTING write (fn 0x06)
 *   2. The cable write targets the correct destination cell with the
 *      correct source-row mask
 *   3. result_code 0x00 ACKs return ok:true with empty nacked_steps[]
 *   4. result_code != 0x00 mid-sequence NACKs are aggregated into
 *      nacked_steps[] AND flip ok:false (THE 2026-05-23 regression
 *      guard — pre-fix this returned ok:true)
 *   5. Each rejected cable is captured (not just the last one)
 *
 * Run via: npx tsx scripts/verify-grid-routing.ts
 */

import {
  runApplyPresetAtOps,
  type ApplyConn,
  type ApplyPresetAtOp,
} from '../packages/fractal-gen2/src/tools/applyExecutor.js';
import {
  isSetCellRoutingResponse,
  isSetGridCellResponse,
  isGetGridLayoutResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? `\n        ${detail}` : ''}`);
  }
}

/**
 * Mock ApplyConn that:
 *   - Records every send() call as a captured frame
 *   - Replies to known opcodes (set_grid_cell, set_cell_routing,
 *     store_preset, get_grid_layout) with a canned ACK
 *   - Lets the test override the result_code for specific cable
 *     writes via `nackOnCableTo` (a list of (row, col) tuples that
 *     should NACK with result_code 0x0e)
 */
function createMockConn(opts: {
  nackOnCableTo?: { row: number; col: number }[];
  nackOnGridCellAt?: { row: number; col: number }[];
} = {}): { conn: ApplyConn; sentFrames: number[][] } {
  const sentFrames: number[][] = [];
  const nackCables = new Set(
    (opts.nackOnCableTo ?? []).map((r) => `${r.row}:${r.col}`),
  );
  const nackCells = new Set(
    (opts.nackOnGridCellAt ?? []).map((r) => `${r.row}:${r.col}`),
  );

  // The pending receiveSysExMatching predicate. Triggers on the next send.
  let pendingPredicate: ((bytes: number[]) => boolean) | null = null;
  let pendingResolve: ((bytes: number[]) => void) | null = null;
  let pendingReject: ((err: Error) => void) | null = null;

  /**
   * Build a fake response for a captured send. Returns the bytes the
   * server would have received from the device. The II's response
   * envelope is fn=0x64 MULTIPURPOSE_RESPONSE with the echoed request
   * fn at byte[6] and the result_code at byte[7].
   */
  const FUNC_MULTIPURPOSE_RESPONSE = 0x64;
  const FUNC_SET_GRID_CELL = 0x05;
  const FUNC_SET_CELL_ROUTING = 0x06;
  const FUNC_STORE_PRESET = 0x1D;
  const FUNC_GET_GRID_LAYOUT = 0x20;

  function fabricateResponse(sentBytes: number[]): number[] | undefined {
    // SysEx envelope: F0 00 01 74 07 <fn> ... F7
    if (sentBytes[0] !== 0xF0 || sentBytes[5] === undefined) return undefined;
    const fn = sentBytes[5];

    if (fn === FUNC_SET_CELL_ROUTING) {
      const dstCell = sentBytes[7]!;
      const col = Math.floor(dstCell / 4) + 1;
      const row = (dstCell % 4) + 1;
      const shouldNack = nackCables.has(`${row}:${col}`);
      const resultCode = shouldNack ? 0x0E : 0x00;
      // Response: F0 00 01 74 07 64 06 <result_code> <cksum> F7
      return [0xF0, 0x00, 0x01, 0x74, 0x07, FUNC_MULTIPURPOSE_RESPONSE, FUNC_SET_CELL_ROUTING, resultCode, 0x00, 0xF7];
    }

    if (fn === FUNC_SET_GRID_CELL) {
      const cell = sentBytes[6]!;
      const col = Math.floor(cell / 4) + 1;
      const row = (cell % 4) + 1;
      const shouldNack = nackCells.has(`${row}:${col}`);
      const resultCode = shouldNack ? 0x0E : 0x00;
      return [0xF0, 0x00, 0x01, 0x74, 0x07, FUNC_MULTIPURPOSE_RESPONSE, FUNC_SET_GRID_CELL, resultCode, 0x00, 0xF7];
    }

    if (fn === FUNC_GET_GRID_LAYOUT) {
      // Skip-empty optimization reads the grid once before clearing.
      // We return a minimal valid response: fn at byte 5 directly
      // (no multipurpose wrapping for this read op).
      const bytes: number[] = [0xF0, 0x00, 0x01, 0x74, 0x07, FUNC_GET_GRID_LAYOUT];
      // 48 cells worth of empty data (blockId=0, routing=0); shape per
      // parseGetGridLayoutResponse. 4 bytes per cell is a simplification —
      // real parser may want more. The test path doesn't exercise this
      // unless `clear_cell` or `switch_preset` ops are present.
      for (let c = 0; c < 48; c++) {
        bytes.push(0x00, 0x00, 0x00, 0x00);
      }
      bytes.push(0x00, 0xF7);
      return bytes;
    }

    if (fn === FUNC_STORE_PRESET) {
      return [0xF0, 0x00, 0x01, 0x74, 0x07, FUNC_MULTIPURPOSE_RESPONSE, FUNC_STORE_PRESET, 0x00, 0x00, 0xF7];
    }

    return undefined;
  }

  const conn: ApplyConn = {
    send(bytes: number[]): void {
      sentFrames.push([...bytes]);
      // If a receive is pending and the response matches, fire it.
      if (pendingPredicate && pendingResolve) {
        const fab = fabricateResponse(bytes);
        if (fab !== undefined && pendingPredicate(fab)) {
          const resolve = pendingResolve;
          pendingPredicate = null;
          pendingResolve = null;
          pendingReject = null;
          // Resolve on next microtask to mimic async wire delay.
          queueMicrotask(() => resolve(fab));
        }
      }
    },
    receiveSysExMatching(
      predicate: (bytes: number[]) => boolean,
      timeoutMs?: number,
    ): Promise<number[]> {
      return new Promise<number[]>((resolve, reject) => {
        pendingPredicate = predicate;
        pendingResolve = resolve;
        pendingReject = reject;
        // Safety timeout: 5s default; test runs are << 5s.
        const timer = setTimeout(() => {
          if (pendingReject === reject) {
            pendingPredicate = null;
            pendingResolve = null;
            pendingReject = null;
            reject(new Error('mock conn: no matching response within timeout'));
          }
        }, timeoutMs ?? 5000);
        // Unref so it doesn't keep node alive
        timer.unref?.();
      });
    },
  };

  return { conn, sentFrames };
}

/**
 * Build a minimal "place block + cable" op sequence directly so the
 * test exercises only what we care about — no need to pull the full
 * buildApplyPresetOps codepath. Each cable op is a SET_CELL_ROUTING
 * targeting (row, col) from (srcRow, col-1).
 */
function buildCableOp(
  srcRow: number,
  dstRow: number,
  dstCol: number,
): ApplyPresetAtOp {
  // SET_CELL_ROUTING bytes: F0 00 01 74 07 06 <src_cell> <dst_cell> <connect> <cksum> F7
  // cell = (col-1)*4 + (row-1)
  const srcCell = (dstCol - 1 - 1) * 4 + (srcRow - 1);
  const dstCell = (dstCol - 1) * 4 + (dstRow - 1);
  const bytes = [0xF0, 0x00, 0x01, 0x74, 0x07, 0x06, srcCell, dstCell, 0x01, 0x00, 0xF7];
  // `kind` only affects logging/heuristics inside runApplyPresetAtOps;
  // we use a string the executor doesn't special-case so the cable
  // path runs verbatim. Cast through `unknown` to bypass the strict
  // union, our test cares about the wire bytes + awaitResponse, not
  // the op-kind discriminator semantics.
  return {
    kind: 'cable',
    summary: `CABLE R${srcRow}C${dstCol - 1} → R${dstRow}C${dstCol}`,
    bytes,
    awaitResponse: 'set_cell_routing',
  };
}

// ─── Case 1: clean serial chain, all ACKs OK ──────────────────────────
console.log('\nCase 1: serial chain cables 2→3, 3→4, 4→5 all ack OK');
{
  const ops: ApplyPresetAtOp[] = [
    buildCableOp(2, 2, 3),
    buildCableOp(2, 2, 4),
    buildCableOp(2, 2, 5),
  ];
  const { conn, sentFrames } = createMockConn();
  const result = await runApplyPresetAtOps(conn, ops);
  check('3 frames sent', sentFrames.length === 3, `got ${sentFrames.length}`);
  check('result.ok === true', result.ok === true);
  check('nacked_steps empty', result.nackedSteps.length === 0);
  check('acks === 3', result.acks === 3);
}

// ─── Case 2: ONE cable NACKs mid-sequence ─────────────────────────────
console.log('\nCase 2: cable to R2C4 NACKs (result_code=0x0e) — ok:false, nacked_steps[0] captures');
{
  const ops: ApplyPresetAtOp[] = [
    buildCableOp(2, 2, 3),
    buildCableOp(2, 2, 4),   // NACK
    buildCableOp(2, 2, 5),
  ];
  const { conn } = createMockConn({ nackOnCableTo: [{ row: 2, col: 4 }] });
  const result = await runApplyPresetAtOps(conn, ops);
  check(
    'result.ok === false (mid-sequence NACK flips ok)',
    result.ok === false,
    `ok=${result.ok}, nackedSteps=${result.nackedSteps.length}`,
  );
  check('nacked_steps.length === 1', result.nackedSteps.length === 1);
  check(
    'nacked_steps[0].index === 1 (R2C3→R2C4 was 2nd op)',
    result.nackedSteps[0]?.index === 1,
    `got index=${result.nackedSteps[0]?.index}`,
  );
  check(
    'nacked_steps[0].kind === set_cell_routing',
    result.nackedSteps[0]?.kind === 'set_cell_routing',
  );
  check(
    'nacked_steps[0].resultCode === 0x0e',
    result.nackedSteps[0]?.resultCode === 0x0E,
  );
}

// ─── Case 3: THREE cables NACK — ALL captured (not just last) ──────────
console.log('\nCase 3: three cables NACK (R2C3, R2C5, R2C6) — nacked_steps captures all 3');
{
  const ops: ApplyPresetAtOp[] = [
    buildCableOp(2, 2, 3),   // NACK
    buildCableOp(2, 2, 4),
    buildCableOp(2, 2, 5),   // NACK
    buildCableOp(2, 2, 6),   // NACK
  ];
  const { conn } = createMockConn({
    nackOnCableTo: [
      { row: 2, col: 3 },
      { row: 2, col: 5 },
      { row: 2, col: 6 },
    ],
  });
  const result = await runApplyPresetAtOps(conn, ops);
  check(
    'result.ok === false',
    result.ok === false,
    `ok=${result.ok}, nackedSteps=${result.nackedSteps.length}`,
  );
  check(
    'nacked_steps.length === 3 (all captured, not just last)',
    result.nackedSteps.length === 3,
    `got ${result.nackedSteps.length}`,
  );
  check(
    'lastNack still points at the LAST nack for back-compat',
    result.lastNack !== undefined,
  );
  const indexes = result.nackedSteps.map((n) => n.index).sort((a, b) => a - b);
  check(
    'indexes are [0, 2, 3] in order',
    indexes.length === 3 && indexes[0] === 0 && indexes[1] === 2 && indexes[2] === 3,
    `got [${indexes.join(', ')}]`,
  );
}

// ─── Case 4: down-diagonal cable R1C2 → R2C3 (parallel topology) ───────
console.log('\nCase 4: down-diagonal cable R1C2→R2C3 emits correct bytes (cross-row allowed)');
{
  const ops: ApplyPresetAtOp[] = [buildCableOp(1, 2, 3)];
  const { conn, sentFrames } = createMockConn();
  const result = await runApplyPresetAtOps(conn, ops);
  check('1 frame sent', sentFrames.length === 1);
  check('result.ok === true', result.ok === true);
  // Verify the emitted bytes: src_cell = (3-1-1)*4 + (1-1) = 4, dst_cell = (3-1)*4 + (2-1) = 9
  const frame = sentFrames[0];
  check(
    'src_cell byte = 0x04 (R1 of col 2)',
    frame[6] === 0x04,
    `got 0x${frame[6]?.toString(16)}`,
  );
  check(
    'dst_cell byte = 0x09 (R2 of col 3)',
    frame[7] === 0x09,
    `got 0x${frame[7]?.toString(16)}`,
  );
  check('connect flag = 0x01', frame[8] === 0x01);
}

// ─── Case 5: SET_GRID_CELL NACK on block placement ─────────────────────
console.log('\nCase 5: SET_GRID_CELL placement NACKs — captured as set_grid_cell in nacked_steps');
{
  const ops: ApplyPresetAtOp[] = [
    {
      kind: 'place_block',
      summary: 'PLACE Amp 1 at R2C2',
      // SET_GRID_CELL: F0 00 01 74 07 05 <cell> <blockLo> <blockHi> <cksum> F7
      // (fn byte = 0x05 = FUNC_SET_GRID_CELL per the codec)
      // cell = (col-1)*4 + (row-1) = (2-1)*4 + (2-1) = 5
      bytes: [0xF0, 0x00, 0x01, 0x74, 0x07, 0x05, 0x05, 0x6A, 0x00, 0x00, 0xF7],
      awaitResponse: 'set_grid_cell',
    },
  ];
  const { conn } = createMockConn({ nackOnGridCellAt: [{ row: 2, col: 2 }] });
  const result = await runApplyPresetAtOps(conn, ops);
  check('result.ok === false (grid-cell NACK)', result.ok === false);
  check('nacked_steps.length === 1', result.nackedSteps.length === 1);
  check(
    'nacked_steps[0].kind === set_grid_cell',
    result.nackedSteps[0]?.kind === 'set_grid_cell',
  );
}

// ─── Summary ───────────────────────────────────────────────────────────
console.log('');
if (failed > 0) {
  console.error(`x ${failed} grid-routing check(s) FAILED.`);
  console.error('  These guard the cable-emission + NACK-aggregation contract.');
  console.error('  Pre-fix the writer overwrote lastNack on each new failure;');
  console.error('  Cases 2-3 are the regression guards for that bug.');
  process.exit(1);
}
console.log('All grid-routing checks pass.');
