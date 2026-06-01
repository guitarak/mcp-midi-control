/**
 * Calibration sweep for the remaining annotated PITCH knobs not covered by
 * probe-ii-output-pitch-cal-sweep.ts:
 *   voice_1_splice (31), voice_2_splice (32), amplitube_alpha (76),
 *   voice_1_delay (17), voice_2_delay (18)   on PITCH 1 (effectId 130).
 *
 * Places PITCH at the first empty grid cell if absent, sweeps 5 wire points,
 * restores each param's original, then clears the cell it placed (layout
 * restored). Nothing saved to flash.
 *
 * Run: npx tsx scripts/_research/probe-ii-pitch-extras-cal-sweep.ts
 */
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
  buildGetGridLayout,
  parseGetGridLayoutResponse,
  buildSetGridCell,
} from 'fractal-midi/axe-fx-ii';

const II_MODEL = 0x07;
const PITCH_EFFECT_ID = 130;
const TIMEOUT_MS = 800;
const SETTLE_MS = 80;
const SWEEP_WIRES = [0, 16383, 32767, 49151, 65534];

const TARGETS = [
  { paramId: 17, name: 'pitch.voice_1_delay' },
  { paramId: 18, name: 'pitch.voice_2_delay' },
  { paramId: 31, name: 'pitch.voice_1_splice' },
  { paramId: 32, name: 'pitch.voice_2_splice' },
  { paramId: 76, name: 'pitch.amplitube_alpha' },
];

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
async function sweep(conn: Conn, paramId: number, name: string): Promise<void> {
  let original = -1;
  try { original = (await readParam(conn, PITCH_EFFECT_ID, paramId)).value; }
  catch { console.log(`${name}: no response — SKIP`); return; }
  const samples: string[] = [];
  for (const w of SWEEP_WIRES) {
    try {
      await setWire(conn, PITCH_EFFECT_ID, paramId, w);
      samples.push(`${w}→"${(await readParam(conn, PITCH_EFFECT_ID, paramId)).label ?? ''}"`);
    } catch { samples.push(`${w}→ERR`); }
  }
  try { await setWire(conn, PITCH_EFFECT_ID, paramId, original); } catch { /* best effort */ }
  console.log(`${name} (pid ${paramId}, orig ${original}): ${samples.join('  ')}`);
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));
  const grid = await readGrid(conn);
  const placed = grid.some((c) => c.blockId === PITCH_EFFECT_ID);
  let cell: { row: number; col: number } | undefined;
  if (!placed) {
    const empty = grid.find((c) => c.blockId === 0);
    if (!empty) { console.log('No empty cell to place PITCH — abort.'); process.exit(0); }
    cell = { row: empty.row, col: empty.col };
    console.log(`Placing PITCH at R${cell.row}C${cell.col} (temporary).`);
    conn.send(buildSetGridCell({ row: cell.row, col: cell.col, blockId: PITCH_EFFECT_ID }));
    await new Promise((r) => setTimeout(r, 200));
  } else { console.log('PITCH already placed; layout untouched.'); }

  for (const t of TARGETS) await sweep(conn, t.paramId, t.name);

  if (cell) {
    conn.send(buildSetGridCell({ row: cell.row, col: cell.col, blockId: 0 }));
    await new Promise((r) => setTimeout(r, 200));
    const after = await readGrid(conn);
    console.log(after.some((c) => c.blockId === PITCH_EFFECT_ID)
      ? 'WARNING: PITCH still on grid after clear.'
      : 'Layout restored (cell empty again).');
  }
  console.log('Done. Param originals restored; nothing saved.');
  process.exit(0);
}
main();
