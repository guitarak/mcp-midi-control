/**
 * Finish PROBE-II-CAL-SWEEP: the two param families that the amp sweep
 * could not reach.
 *
 *   output.scene_1_main / scene_2_main  (OUTPUT block, effectId 140) —
 *     always present, no placement needed. scene_1 full 5-point sweep,
 *     scene_2 two-point confirm (they should share one scale).
 *   pitch.voice_1_pan / voice_1_feedback (PITCH 1, effectId 130) —
 *     needs PITCH placed. Reads the grid first; if PITCH (blockId 130) is
 *     absent, places it in the first empty cell, sweeps, then clears that
 *     cell to restore the layout. If PITCH was already placed, leaves the
 *     layout alone.
 *
 * Every param sweep reads the original first and restores it. Grid is
 * restored to its starting shape. Nothing is saved to flash; a preset
 * reload also discards everything.
 *
 * Run: npx tsx scripts/_research/probe-ii-output-pitch-cal-sweep.ts
 */
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
  buildGetGridLayout,
  parseGetGridLayoutResponse,
  buildSetGridCell,
} from 'fractal-midi/gen2/axe-fx-ii';

const II_MODEL = 0x07;
const TIMEOUT_MS = 800;
const SETTLE_MS = 80;
const SWEEP_WIRES = [0, 16383, 32767, 49151, 65534];

type Conn = ReturnType<typeof connectAxeFxII>;

function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function buildSetWire(effectId: number, paramId: number, wire: number): number[] {
  const head = [
    0xf0, 0x00, 0x01, 0x74, II_MODEL, 0x02,
    effectId & 0x7f, (effectId >> 7) & 0x7f,
    paramId & 0x7f, (paramId >> 7) & 0x7f,
    wire & 0x7f, (wire >> 7) & 0x7f, (wire >> 14) & 0x03,
    0x01,
  ];
  return [...head, csum(head), 0xf7];
}

function readParam(conn: Conn, effectId: number, paramId: number): Promise<{ value: number; label?: string }> {
  const targetId = { effectId, paramId };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('timeout')); }, TIMEOUT_MS);
    const unsub = conn.onMessage((bytes) => {
      if (isGetBlockParameterResponse(bytes, targetId)) {
        clearTimeout(timer); unsub();
        try { resolve(parseGetBlockParameterResponse(bytes)); } catch (e) { reject(e); }
      }
    });
    conn.send(buildGetBlockParameterValue(targetId));
  });
}

function readGrid(conn: Conn): Promise<ReturnType<typeof parseGetGridLayoutResponse>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsub(); reject(new Error('grid read timeout')); }, TIMEOUT_MS * 2);
    const unsub = conn.onMessage((bytes) => {
      if (bytes[4] === II_MODEL && bytes[5] === 0x20 && bytes.length > 100) {
        clearTimeout(timer); unsub();
        try { resolve(parseGetGridLayoutResponse(bytes)); } catch (e) { reject(e); }
      }
    });
    conn.send(buildGetGridLayout());
  });
}

async function setWire(conn: Conn, effectId: number, paramId: number, wire: number): Promise<void> {
  conn.send(buildSetWire(effectId, paramId, wire));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

async function sweep(conn: Conn, effectId: number, paramId: number, name: string, wires = SWEEP_WIRES): Promise<void> {
  let original = -1;
  try { original = (await readParam(conn, effectId, paramId)).value; }
  catch { console.log(`${name}: could not read original (block not placed / no response) — SKIP`); return; }
  const samples: string[] = [];
  for (const w of wires) {
    try {
      await setWire(conn, effectId, paramId, w);
      const { label } = await readParam(conn, effectId, paramId);
      samples.push(`${w}→"${label ?? ''}"`);
    } catch (e) { samples.push(`${w}→ERR`); }
  }
  try { await setWire(conn, effectId, paramId, original); } catch { /* best effort */ }
  console.log(`${name} (effId ${effectId} pid ${paramId}, orig ${original}): ${samples.join('  ')}`);
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));

  console.log('=== OUTPUT block (effectId 140, always present) ===');
  await sweep(conn, 140, 8, 'output.scene_1_main');
  await sweep(conn, 140, 9, 'output.scene_2_main', [0, 32767, 65534]);

  console.log('\n=== PITCH 1 (effectId 130) ===');
  const grid = await readGrid(conn);
  const pitchPlaced = grid.some((c) => c.blockId === 130);
  let placedCell: { row: number; col: number } | undefined;
  if (!pitchPlaced) {
    const empty = grid.find((c) => c.blockId === 0);
    if (!empty) { console.log('No empty grid cell to place PITCH — SKIP pitch sweep.'); }
    else {
      placedCell = { row: empty.row, col: empty.col };
      console.log(`PITCH not placed; placing blockId 130 at R${placedCell.row}C${placedCell.col} (temporary).`);
      conn.send(buildSetGridCell({ row: placedCell.row, col: placedCell.col, blockId: 130 }));
      await new Promise((r) => setTimeout(r, 200));
    }
  } else {
    console.log('PITCH 1 already placed; using existing instance, layout untouched.');
  }

  if (pitchPlaced || placedCell) {
    await sweep(conn, 130, 15, 'pitch.voice_1_pan');
    await sweep(conn, 130, 19, 'pitch.voice_1_feedback');
    await sweep(conn, 130, 16, 'pitch.voice_2_pan');
    await sweep(conn, 130, 20, 'pitch.voice_2_feedback');
  }

  if (placedCell) {
    console.log(`Clearing temporary PITCH at R${placedCell.row}C${placedCell.col} (restore layout).`);
    conn.send(buildSetGridCell({ row: placedCell.row, col: placedCell.col, blockId: 0 }));
    await new Promise((r) => setTimeout(r, 200));
    const after = await readGrid(conn);
    const stillThere = after.some((c) => c.blockId === 130);
    console.log(stillThere ? 'WARNING: PITCH still on grid after clear — check manually.' : 'Layout restored (cell empty again).');
  }

  console.log('\nDone. Param originals restored; nothing saved to flash.');
  process.exit(0);
}

main();
