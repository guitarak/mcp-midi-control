/**
 * Calibration SWEEP probe for opaque amp params (Axe-Fx II).
 *
 * For each opaque amp param, set 5 known wire points across the 16-bit
 * range and read the device's own rendered display label at each via the
 * fn=0x02 GET path (validated clean by probe-ii-opaque-amp-labels.ts).
 * The (wire → label) pairs are ground-truth calibration evidence: the
 * endpoints give displayMin/displayMax, the midpoint distinguishes
 * linear vs log scale, and enum params reveal their index→label table.
 *
 * SAFETY: mutates the ACTIVE WORKING BUFFER only (never saves to flash).
 * Reads each param's original wire first and restores it at the end, so
 * the net change is zero. Switching presets also discards everything.
 * Uses the fn=0x02 wire-integer SET (8-byte payload + channel-commit),
 * the same proven path as bk070-amp-param-mapper.ts.
 *
 * Output: writes samples/captured/decoded/ii-opaque-amp-sweep.json
 * (gitignored scratch) for the calibration workflow to consume.
 *
 * Run: npx tsx scripts/_research/probe-ii-opaque-amp-sweep.ts
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { connectAxeFxII } from '@mcp-midi-control/axe-fx-ii/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
} from 'fractal-midi/axe-fx-ii';

const AMP_EFFECT_ID = parseInt(process.env.AMP_EFFECT_ID ?? '106', 10);
const II_MODEL = 0x07;
const TIMEOUT_MS = 800;
const SETTLE_MS = 60;

const SWEEP_WIRES = [0, 16383, 32767, 49151, 65534];

const OPAQUE: Array<{ paramId: number; name: string; controlType: string }> = [
  { paramId: 8, name: 'tone_freq', controlType: 'knob' },
  { paramId: 9, name: 'xformer_grind', controlType: 'knob' },
  { paramId: 11, name: 'wslpf', controlType: 'unknown' },
  { paramId: 12, name: 'xformer_low_freq', controlType: 'knob' },
  { paramId: 13, name: 'xformer_hi_freq', controlType: 'knob' },
  { paramId: 17, name: 'offset1', controlType: 'unknown' },
  { paramId: 18, name: 'cliptype2', controlType: 'unknown' },
  { paramId: 19, name: 'supply_sag', controlType: 'knob' },
  { paramId: 25, name: 'presence_freq', controlType: 'knob' },
  { paramId: 26, name: 'low_res_freq', controlType: 'knob' },
  { paramId: 27, name: 'low_res', controlType: 'knob' },
  { paramId: 28, name: 'bypass', controlType: 'unknown' },
  { paramId: 29, name: 'depth_freq', controlType: 'knob' },
  { paramId: 30, name: 'drivetype', controlType: 'unknown' },
  { paramId: 31, name: 'mv_cap', controlType: 'knob' },
  { paramId: 32, name: 'wshpf', controlType: 'unknown' },
  { paramId: 33, name: 'harmonics', controlType: 'knob' },
  { paramId: 35, name: 'b_time_const', controlType: 'knob' },
  { paramId: 36, name: 'tube_grid_bias', controlType: 'knob' },
  { paramId: 37, name: 'fbtype', controlType: 'unknown' },
  { paramId: 38, name: 'pi_ratio', controlType: 'unknown' },
  { paramId: 41, name: 'low_res_q', controlType: 'knob' },
  { paramId: 42, name: 'preamp_bias', controlType: 'knob' },
  { paramId: 43, name: 'hi_freq', controlType: 'knob' },
  { paramId: 44, name: 'hi_resonance', controlType: 'knob' },
  { paramId: 46, name: 'xformer_drive', controlType: 'knob' },
  { paramId: 48, name: 'preamp_hardness', controlType: 'knob' },
  { paramId: 50, name: 'speaker_drive', controlType: 'knob' },
  { paramId: 51, name: 'xformer_match', controlType: 'knob' },
  { paramId: 52, name: 'screenfreq', controlType: 'unknown' },
  { paramId: 53, name: 'screenq', controlType: 'unknown' },
  { paramId: 55, name: 'geq_band_1', controlType: 'knob' },
  { paramId: 56, name: 'geq_band_2', controlType: 'knob' },
  { paramId: 57, name: 'geq_band_3', controlType: 'knob' },
  { paramId: 58, name: 'geq_band_4', controlType: 'knob' },
  { paramId: 59, name: 'geq_band_5', controlType: 'knob' },
  { paramId: 60, name: 'geq_band_6', controlType: 'knob' },
  { paramId: 61, name: 'geq_band_7', controlType: 'knob' },
  { paramId: 62, name: 'geq_band_8', controlType: 'knob' },
  { paramId: 63, name: 'bias_excursion', controlType: 'knob' },
  { paramId: 64, name: 'excursiontime', controlType: 'unknown' },
  { paramId: 65, name: 'recoverytime', controlType: 'unknown' },
  { paramId: 66, name: 'triode_2_plate_freq', controlType: 'knob' },
  { paramId: 67, name: 'triode_1_plate_freq', controlType: 'knob' },
  { paramId: 70, name: 'out_comp_clarity', controlType: 'knob' },
  { paramId: 71, name: 'character_q', controlType: 'knob' },
  { paramId: 72, name: 'character_freq', controlType: 'knob' },
  { paramId: 73, name: 'character_amt', controlType: 'knob' },
  { paramId: 75, name: 'out_comp_amount', controlType: 'knob' },
  { paramId: 76, name: 'out_comp_threshold', controlType: 'knob' },
  { paramId: 80, name: 'preamp_cf_compress', controlType: 'knob' },
  { paramId: 81, name: 'preamp_cf_time', controlType: 'knob' },
  { paramId: 82, name: 'version', controlType: 'knob' },
  { paramId: 83, name: 'pickattack', controlType: 'knob' },
  { paramId: 84, name: 'dynamic_presence', controlType: 'knob' },
  { paramId: 87, name: 'ac_line_freq', controlType: 'knob' },
  { paramId: 88, name: 'pwr_amp_hardness', controlType: 'knob' },
  { paramId: 91, name: 'preamp_cf_ratio', controlType: 'knob' },
  { paramId: 93, name: 'cathode_resist', controlType: 'knob' },
  { paramId: 94, name: 'cbtime', controlType: 'unknown' },
  { paramId: 97, name: 'bright', controlType: 'knob' },
  { paramId: 98, name: 'pwr_amp_bias', controlType: 'knob' },
  { paramId: 99, name: 'preamp_dynamics', controlType: 'knob' },
  { paramId: 100, name: 'hi_freq_slope', controlType: 'knob' },
  { paramId: 101, name: 'variac', controlType: 'knob' },
  { paramId: 103, name: 'gridhardness', controlType: 'unknown' },
  { paramId: 105, name: 'saturation_drive', controlType: 'knob' },
  { paramId: 106, name: 'crunch', controlType: 'knob' },
  { paramId: 107, name: 'triode2extime', controlType: 'unknown' },
  { paramId: 108, name: 'triode2rectime', controlType: 'unknown' },
  { paramId: 112, name: 'triode1ratio', controlType: 'unknown' },
  { paramId: 113, name: 'preamp_cf_hardness', controlType: 'knob' },
  { paramId: 114, name: 'pi_bias_shift', controlType: 'knob' },
  { paramId: 115, name: 'motor_drive', controlType: 'knob' },
  { paramId: 116, name: 'motor_time_const', controlType: 'knob' },
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
  console.log(`SWEEP ${OPAQUE.length} opaque amp params (effectId ${AMP_EFFECT_ID}); restores originals.\n`);
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
    // Restore original.
    try { await setWire(conn, p.paramId, originalWire); } catch { /* best-effort */ }
    results.push({ paramId: p.paramId, name: p.name, controlType: p.controlType, originalWire, samples });
    const compact = samples.map((s) => `${s.setWire}→"${s.label}"`).join('  ');
    console.log(`${p.name} (id ${p.paramId}, orig ${originalWire}): ${compact}`);
  }

  const outDir = path.resolve(process.cwd(), 'samples', 'captured', 'decoded');
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ii-opaque-amp-sweep.json');
  writeFileSync(outPath, JSON.stringify({ effectId: AMP_EFFECT_ID, sweepWires: SWEEP_WIRES, params: results }, null, 2));
  console.log(`\nWrote ${results.length} param sweeps → ${outPath}`);
  console.log('All originals restored (working buffer net-zero; nothing saved to flash).');
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
