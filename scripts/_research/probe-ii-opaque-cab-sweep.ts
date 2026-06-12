/**
 * Calibration SWEEP probe for opaque CAB params (Axe-Fx II), effectId 108.
 *
 * Sibling of probe-ii-opaque-amp-sweep.ts. The cab block exposes ~18 continuous
 * knobs (room size, mic spacing, speaker size, air/proximity freq, delays,
 * motor time const, levels) that render as raw 16-bit wire integers in
 * get_preset because they carry no calibration. For each, set 5 known wire
 * points across the range and read the device's own rendered display label via
 * the fn=0x02 GET path. The (wire -> label) pairs are ground-truth: endpoints
 * give displayMin/displayMax, the midpoint distinguishes linear vs log.
 *
 * SAFETY: mutates the ACTIVE WORKING BUFFER only (never saves to flash). Reads
 * each param's original wire first and restores it at the end, so the net
 * change is zero. Switching presets also discards everything. Requires a CAB
 * block placed at effectId 108 (Cab 1) in the active preset.
 *
 * Output: samples/captured/decoded/ii-opaque-cab-sweep.json (gitignored).
 * Run: npx tsx scripts/_research/probe-ii-opaque-cab-sweep.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const CAB_EFFECT_ID = parseInt(process.env.CAB_EFFECT_ID ?? '108', 10);
const II_MODEL = 0x07;
const TIMEOUT_MS = 800;
const SETTLE_MS = 60;

const SWEEP_WIRES = [0, 16383, 32767, 49151, 65534];

const OPAQUE: Array<{ paramId: number; name: string; controlType: string }> = [
  { paramId: 5, name: 'level_l', controlType: 'knob' },
  { paramId: 6, name: 'level_r', controlType: 'knob' },
  { paramId: 14, name: 'drive', controlType: 'knob' },
  { paramId: 15, name: 'saturation', controlType: 'knob' },
  { paramId: 16, name: 'room_level', controlType: 'knob' },
  { paramId: 17, name: 'room_size', controlType: 'knob' },
  { paramId: 18, name: 'mic_spacing', controlType: 'knob' },
  { paramId: 21, name: 'speaker_size', controlType: 'knob' },
  { paramId: 22, name: 'proximity', controlType: 'knob' },
  { paramId: 23, name: 'air', controlType: 'knob' },
  { paramId: 24, name: 'motor_drive', controlType: 'knob' },
  { paramId: 25, name: 'air_freq', controlType: 'knob' },
  { paramId: 26, name: 'delay_l', controlType: 'knob' },
  { paramId: 27, name: 'delay_r', controlType: 'knob' },
  { paramId: 28, name: 'proximity_r', controlType: 'knob' },
  { paramId: 29, name: 'prox_freq', controlType: 'knob' },
  { paramId: 36, name: 'dephase', controlType: 'knob' },
  { paramId: 38, name: 'motor_time_constant', controlType: 'knob' },
];

type Conn = ReturnType<typeof connectAxeFxII>;

function csum(b: number[]): number { let a = 0; for (const x of b) a ^= x; return a & 0x7f; }
function buildSetWire(effectId: number, paramId: number, wire: number): number[] {
  const head = [
    0xf0, 0x00, 0x01, 0x74, II_MODEL, 0x02,
    effectId & 0x7f, (effectId >> 7) & 0x7f,
    paramId & 0x7f, (paramId >> 7) & 0x7f,
    wire & 0x7f, (wire >> 7) & 0x7f, (wire >> 14) & 0x03,
    0x01, // channel-commit
  ];
  return [...head, csum(head), 0xf7];
}

function readParam(conn: Conn, paramId: number): Promise<{ value: number; label?: string }> {
  const targetId = { effectId: CAB_EFFECT_ID, paramId };
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
  conn.send(buildSetWire(CAB_EFFECT_ID, paramId, wire));
  await new Promise((r) => setTimeout(r, SETTLE_MS));
}

interface ParamSweep {
  paramId: number;
  name: string;
  controlType: string;
  originalWire: number;
  samples: Array<{ setWire: number; echoedWire: number; label: string }>;
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));
  console.log(`SWEEP ${OPAQUE.length} opaque CAB params (effectId ${CAB_EFFECT_ID}); restores originals.\n`);
  const results: ParamSweep[] = [];
  for (const p of OPAQUE) {
    let originalWire = -1;
    try {
      originalWire = (await readParam(conn, p.paramId)).value;
    } catch {
      console.log(`${p.name}: could not read original, skipping`);
      continue;
    }
    const samples: ParamSweep['samples'] = [];
    for (const w of SWEEP_WIRES) {
      try {
        await setWire(conn, p.paramId, w);
        const { value, label } = await readParam(conn, p.paramId);
        samples.push({ setWire: w, echoedWire: value, label: label ?? '' });
      } catch (e) {
        samples.push({ setWire: w, echoedWire: -1, label: `ERR:${e instanceof Error ? e.message : e}` });
      }
    }
    try { await setWire(conn, p.paramId, originalWire); } catch { /* best-effort */ }
    results.push({ paramId: p.paramId, name: p.name, controlType: p.controlType, originalWire, samples });
    const compact = samples.map((s) => `${s.setWire}→"${s.label}"`).join('  ');
    console.log(`${p.name} (id ${p.paramId}, orig ${originalWire}): ${compact}`);
  }

  const outDir = path.resolve(process.cwd(), 'samples', 'captured', 'decoded');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ii-opaque-cab-sweep.json');
  writeFileSync(outPath, JSON.stringify({ effectId: CAB_EFFECT_ID, sweepWires: SWEEP_WIRES, params: results }, null, 2));
  console.log(`\nWrote ${results.length} param sweeps → ${outPath}`);
  console.log('All originals restored (working buffer net-zero; nothing saved to flash).');
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
