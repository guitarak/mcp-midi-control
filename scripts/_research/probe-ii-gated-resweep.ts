/**
 * Re-sweep the 2 amp params that were stuck (flat label) on the loaded
 * model during the calibration sweep: xformer_grind (paramId 9) and
 * bypass (paramId 28). Hypothesis: they are gated/inactive on the loaded
 * amp model and may respond on a different model.
 *
 * For each of a few amp models (current + 3 spread samples), set the
 * model (amp.effect_type, paramId 0), then set each target param to
 * 3 wire points and read the device label. If a target moves on any
 * model, it is calibratable; if it never moves, it is firmware-internal
 * / not user-controllable and stays opaque.
 *
 * Mutates the working buffer (changes the amp model); restores the
 * ORIGINAL model at the end. Never saves to flash. Switching amp models
 * resets other amp params to model defaults, so reload the preset after
 * if you need the exact prior amp state.
 *
 * Run: npx tsx scripts/_research/probe-ii-gated-resweep.ts
 */
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const AMP_EFFECT_ID = parseInt(process.env.AMP_EFFECT_ID ?? '106', 10);
const II_MODEL = 0x07;
const TIMEOUT_MS = 800;
const SETTLE_MS = 80;
const MODEL_SETTLE_MS = 300; // model switch resets the block; give it room

const TARGETS = [
  { paramId: 9, name: 'xformer_grind' },
  { paramId: 28, name: 'bypass' },
];
const SWEEP = [0, 32767, 65534];

type Conn = ReturnType<typeof connectAxeFxII>;
function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function buildSetWire(paramId: number, wire: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, II_MODEL, 0x02,
    AMP_EFFECT_ID & 0x7f, (AMP_EFFECT_ID >> 7) & 0x7f,
    paramId & 0x7f, (paramId >> 7) & 0x7f,
    wire & 0x7f, (wire >> 7) & 0x7f, (wire >> 14) & 0x03, 0x01];
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
async function setWire(conn: Conn, paramId: number, wire: number, settle: number): Promise<void> {
  conn.send(buildSetWire(paramId, wire));
  await new Promise((r) => setTimeout(r, settle));
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));
  const original = await readParam(conn, 0); // amp.effect_type
  const origModel = original.value;
  console.log(`Original amp model: index ${origModel} ("${original.label ?? '?'}")\n`);

  // Spread sample of models to try (plus the original). Indices chosen to
  // span the AMP_EFFECT_TYPE list (clean / crunch / high-gain regions).
  const models = [...new Set([origModel, 0, 40, 90])];

  for (const m of models) {
    await setWire(conn, 0, m, MODEL_SETTLE_MS);
    let modelLabel = '?';
    try { modelLabel = (await readParam(conn, 0)).label ?? '?'; } catch { /* */ }
    console.log(`--- model index ${m} ("${modelLabel}") ---`);
    for (const t of TARGETS) {
      const seen: string[] = [];
      for (const w of SWEEP) {
        try {
          await setWire(conn, t.paramId, w, SETTLE_MS);
          const { label } = await readParam(conn, t.paramId);
          seen.push(`${w}→"${label ?? ''}"`);
        } catch (e) {
          seen.push(`${w}→ERR`);
        }
      }
      const distinct = new Set(seen.map((s) => s.split('→')[1])).size;
      console.log(`  ${t.name}: ${seen.join('  ')}   ${distinct > 1 ? 'RESPONDS' : 'flat'}`);
    }
  }

  // Restore original model.
  await setWire(conn, 0, origModel, MODEL_SETTLE_MS);
  console.log(`\nRestored amp model to index ${origModel}. (Other amp params are at this model's defaults; reload the preset for exact prior state.)`);
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
