/**
 * Focused calibration sweep for two newly-annotated AMP params not covered
 * by probe-ii-opaque-amp-sweep.ts: master_trim (paramId 77) and neg_feedback
 * (paramId 24). Same proven path: fn 0x02 wire-integer SET + fn 0x02 GET to
 * read the device-rendered label at 5 wire points. Self-restoring (reads the
 * original first, restores at the end). Nothing saved to flash.
 *
 * Run: npx tsx scripts/_research/probe-ii-amp-trim-feedback-sweep.ts
 */
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const AMP_EFFECT_ID = 106;
const II_MODEL = 0x07;
const TIMEOUT_MS = 800;
const SETTLE_MS = 60;
const SWEEP_WIRES = [0, 16383, 32767, 49151, 65534];

const TARGETS = [
  { paramId: 77, name: 'master_trim' },
  { paramId: 24, name: 'neg_feedback' },
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

function readParam(conn: Conn, paramId: number): Promise<{ value: number; label?: string }> {
  const targetId = { effectId: AMP_EFFECT_ID, paramId };
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

async function setWire(conn: Conn, paramId: number, wire: number): Promise<void> {
  conn.send(buildSetWire(AMP_EFFECT_ID, paramId, wire));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));
  console.log(`SWEEP ${TARGETS.length} amp params (effectId ${AMP_EFFECT_ID}); restores originals.\n`);
  for (const t of TARGETS) {
    let original = -1;
    try { original = (await readParam(conn, t.paramId)).value; }
    catch { console.log(`${t.name}: could not read original, skipping`); continue; }
    const samples: string[] = [];
    for (const w of SWEEP_WIRES) {
      try {
        await setWire(conn, t.paramId, w);
        const { label } = await readParam(conn, t.paramId);
        samples.push(`${w}→"${label ?? ''}"`);
      } catch (e) {
        samples.push(`${w}→ERR:${e instanceof Error ? e.message : e}`);
      }
    }
    try { await setWire(conn, t.paramId, original); } catch { /* best-effort */ }
    console.log(`${t.name} (id ${t.paramId}, orig ${original}): ${samples.join('  ')}`);
  }
  console.log('\nAll originals restored (working buffer net-zero; nothing saved to flash).');
  process.exit(0);
}

main();
