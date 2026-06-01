/**
 * One-shot probe: does fn 0x06 SET_CELL_ROUTING accept srcCol=1?
 *
 * Question we are answering
 * -------------------------
 * Every apply_preset run since at least 2026-05-23 NACKs at the first
 * cable (R2C1 → R2C2) with result_code=0x0e. The SYSEX-MAP says
 * AxeEdit's own click-to-connect on Comp(R2C1) → Amp(R2C2) did update
 * Amp's mask (session-68 capture). The captured oracle that the codec
 * was tested against is R2C2 → R2C3. R2C1 → R2C2 has never been a
 * golden. Confirm whether the bytes we emit are accepted by the device
 * under controlled conditions.
 *
 * Variants tested (against slot 1, factory baseline)
 * ---------------------------------------------------
 *  V1. cable R2C1 → R2C2, current grid as-is (whatever the preset has)
 *  V2. cable R2C2 → R2C3 (control: known to work per session-69 oracle)
 *  V3. cable R2C1 → R2C2 with connect=0 (delete; even if add fails,
 *      delete shape may differ)
 *  V4. cable R2C1 → R2C2 after explicitly PLACING a shunt at R2C1
 *      (blockId 200) — tests whether the device cares about col-1
 *      contents
 *  V5. cable R2C1 → R2C2 after explicitly placing a content block (drive
 *      blockId 113 if available; falls back to amp 106) at R2C1
 *
 * Each variant: log request bytes, response bytes, parsed result code.
 *
 * Setup: Axe-Fx II powered on, USB connected, Claude Desktop CLOSED
 * (single-writer MIDI port). Run with `npx tsx scripts/_research/probe-
 * axefx2-col1-cable.ts`.
 *
 * Output: a verdict line at the end naming which variants succeeded /
 * failed and the result code observed. Hand back to the session that
 * spawned this probe.
 */

import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import {
  buildGetGridLayout,
  buildSetCellRouting,
  buildSetGridCell,
  buildSwitchPreset,
  isGetGridLayoutResponse,
  isSetCellRoutingResponse,
  isSetGridCellResponse,
  parseGetGridLayoutResponse,
  parseSetCellRoutingResponse,
  parseSetGridCellResponse,
} from 'fractal-midi/axe-fx-ii';

const SHUNT_BASE_ID = 200;
const AMP1_BLOCK_ID = 106;
const ROUTING_ACK_TIMEOUT_MS = 600;
const GRID_ACK_TIMEOUT_MS = 800;

function toHex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

async function attemptCable(
  conn: ReturnType<typeof connectAxeFxII>,
  label: string,
  srcRow: number, srcCol: number, dstRow: number, dstCol: number,
  connect: boolean,
): Promise<{ ok: boolean; resultCode: number; reqBytes: number[]; respBytes: number[] | null }> {
  const reqBytes = buildSetCellRouting({ srcRow, srcCol, dstRow, dstCol, connect });
  console.log(`\n  ▶ ${label}`);
  console.log(`    req: ${toHex(reqBytes)}`);
  const ackP = conn.receiveSysExMatching(isSetCellRoutingResponse, ROUTING_ACK_TIMEOUT_MS);
  conn.send(reqBytes);
  try {
    const respBytes = await ackP;
    const parsed = parseSetCellRoutingResponse(respBytes);
    console.log(`    resp: ${toHex(respBytes)}`);
    console.log(`    result_code: 0x${parsed.resultCode.toString(16).padStart(2, '0')} (${parsed.ok ? 'OK' : 'NACK'})`);
    return { ok: parsed.ok, resultCode: parsed.resultCode, reqBytes, respBytes };
  } catch (err) {
    console.log(`    ⚠ no response within ${ROUTING_ACK_TIMEOUT_MS}ms: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, resultCode: -1, reqBytes, respBytes: null };
  }
}

async function placeAt(
  conn: ReturnType<typeof connectAxeFxII>,
  row: number, col: number, blockId: number, label: string,
): Promise<boolean> {
  const reqBytes = buildSetGridCell({ row, col, blockId });
  console.log(`\n  ▶ place ${label} (blockId=${blockId}) at R${row}C${col}`);
  console.log(`    req: ${toHex(reqBytes)}`);
  const ackP = conn.receiveSysExMatching(isSetGridCellResponse, GRID_ACK_TIMEOUT_MS);
  conn.send(reqBytes);
  try {
    const respBytes = await ackP;
    const parsed = parseSetGridCellResponse(respBytes);
    console.log(`    result_code: 0x${parsed.resultCode.toString(16).padStart(2, '0')} (${parsed.ok ? 'OK' : 'NACK'})`);
    return parsed.ok;
  } catch (err) {
    console.log(`    ⚠ no response: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

async function snapshotGrid(conn: ReturnType<typeof connectAxeFxII>, label: string): Promise<void> {
  const ackP = conn.receiveSysExMatching(isGetGridLayoutResponse, GRID_ACK_TIMEOUT_MS);
  conn.send(buildGetGridLayout());
  try {
    const ack = await ackP;
    const cells = parseGetGridLayoutResponse(ack);
    const r2 = cells.filter((c) => c.row === 2);
    const summary = r2
      .map((c) => `C${c.col}:bid=${c.blockId} m=0x${c.routingFlags.toString(16).padStart(2, '0')}`)
      .join(' | ');
    console.log(`  [grid ${label} row 2] ${summary}`);
  } catch (err) {
    console.log(`  ⚠ grid read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  console.log('Connecting to Axe-Fx II...');
  let conn: ReturnType<typeof connectAxeFxII>;
  try {
    conn = connectAxeFxII();
  } catch (err) {
    console.error('❌ Failed to connect:', err instanceof Error ? err.message : err);
    console.error('   Ensure (1) Axe-Fx II powered on + USB connected,');
    console.error('   and (2) Claude Desktop is CLOSED (Windows MIDI single-writer).');
    process.exit(1);
  }
  if (!conn.hasInput) {
    console.error('❌ output port opened but input not available — cannot capture responses.');
    process.exit(1);
  }
  console.log('✓ Connected.\n');

  console.log('Step 1: Reloading slot 1 (factory baseline) so we have a known starting state.');
  conn.send(buildSwitchPreset(0));
  await sleep(250);
  await snapshotGrid(conn, 'baseline');

  const results: Array<{ name: string; ok: boolean; resultCode: number }> = [];

  console.log('\n─── V1: cable R2C1 → R2C2 (current grid, whatever it has) ───');
  const v1 = await attemptCable(conn, 'V1 add cable R2C1→R2C2', 2, 1, 2, 2, true);
  results.push({ name: 'V1 R2C1→R2C2 add', ok: v1.ok, resultCode: v1.resultCode });

  console.log('\n─── V2: cable R2C2 → R2C3 (CONTROL — captured oracle works here) ───');
  const v2 = await attemptCable(conn, 'V2 add cable R2C2→R2C3', 2, 2, 2, 3, true);
  results.push({ name: 'V2 R2C2→R2C3 add', ok: v2.ok, resultCode: v2.resultCode });

  console.log('\n─── V3: cable R2C1 → R2C2 with connect=0 (delete) ───');
  const v3 = await attemptCable(conn, 'V3 remove cable R2C1→R2C2', 2, 1, 2, 2, false);
  results.push({ name: 'V3 R2C1→R2C2 remove', ok: v3.ok, resultCode: v3.resultCode });

  console.log('\n─── V4: place a SHUNT at R2C1, then cable R2C1 → R2C2 ───');
  await placeAt(conn, 2, 1, SHUNT_BASE_ID, 'SHUNT 1');
  await sleep(80);
  await snapshotGrid(conn, 'after shunt placement');
  const v4 = await attemptCable(conn, 'V4 add cable R2C1→R2C2 (col 1 = shunt)', 2, 1, 2, 2, true);
  results.push({ name: 'V4 R2C1→R2C2 with shunt@C1', ok: v4.ok, resultCode: v4.resultCode });

  console.log('\n─── V5: place AMP at R2C1, then cable R2C1 → R2C2 ───');
  await placeAt(conn, 2, 1, AMP1_BLOCK_ID, 'AMP1');
  await sleep(80);
  await snapshotGrid(conn, 'after amp placement');
  const v5 = await attemptCable(conn, 'V5 add cable R2C1→R2C2 (col 1 = amp content)', 2, 1, 2, 2, true);
  results.push({ name: 'V5 R2C1→R2C2 with amp@C1', ok: v5.ok, resultCode: v5.resultCode });

  console.log('\n─── Cleanup: reload slot 1 so this probe is non-destructive ───');
  conn.send(buildSwitchPreset(0));
  await sleep(250);

  console.log('\n══════════════════════════════════════════════════════════');
  console.log('  VERDICT');
  console.log('══════════════════════════════════════════════════════════');
  for (const r of results) {
    const tag = r.ok ? '✓ OK  ' : '✗ NACK';
    const code = r.resultCode === -1 ? 'TIMEOUT' : `0x${r.resultCode.toString(16).padStart(2, '0')}`;
    console.log(`  ${tag}  result=${code}  ${r.name}`);
  }

  const v2ok = results.find((r) => r.name.startsWith('V2'))?.ok ?? false;
  if (!v2ok) {
    console.log('\n⚠ Control case V2 (R2C2→R2C3) failed — codec/connection broken, not a col-1 issue.');
  } else {
    const v5ok = results.find((r) => r.name.startsWith('V5'))?.ok ?? false;
    const v4ok = results.find((r) => r.name.startsWith('V4'))?.ok ?? false;
    if (v5ok || v4ok) {
      console.log('\n→ R2C1→R2C2 succeeds when col 1 has content; failure mode is "empty source cell".');
      console.log('  FIX: legacy auto-chain shunt loop must fill cols 1..12 (any empty row-2 cell), not just N+1..12.');
    } else {
      console.log('\n→ R2C1→R2C2 fails even with content at col 1. Bug is somewhere else; needs further hardware investigation.');
      console.log('  Compare V1/V3/V4/V5 result codes against documented 0x00/0x01/0x0C — what does 0x0E mean?');
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
