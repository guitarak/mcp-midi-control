/**
 * READ-ONLY baseline probe: read the device's own rendered display label
 * for every opaque amp param via fn=0x02 GET_BLOCK_PARAMETER_VALUE.
 *
 * Purpose: validate that the per-param fn=0x02 label is clean + parseable
 * (e.g. "470.0 Hz", "2.00", "0.150") BEFORE running the mutating wire
 * sweep that derives calibration ranges. The alpha.13 report flagged the
 * get_preset BULK path label as unstable; this checks the single-param
 * path the calibration sweep will rely on.
 *
 * Mutates nothing. Reads the active working buffer's amp block.
 *
 * Run: npx tsx scripts/_research/probe-ii-opaque-amp-labels.ts
 */
import { connectAxeFxII } from '@mcp-midi-control/fractal-gen2/midi.js';
import {
  buildGetBlockParameterValue,
  isGetBlockParameterResponse,
  parseGetBlockParameterResponse,
} from 'fractal-midi/gen2/axe-fx-ii';

const AMP_EFFECT_ID = parseInt(process.env.AMP_EFFECT_ID ?? '106', 10);
const TIMEOUT_MS = 800;

// The 76 opaque amp paramIds enumerated by
// enumerate-ii-opaque-amp-params.ts (controlType + name kept for context).
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

function readParam(
  conn: ReturnType<typeof connectAxeFxII>,
  paramId: number,
): Promise<{ value: number; label?: string }> {
  const targetId = { effectId: AMP_EFFECT_ID, paramId };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('timeout'));
    }, TIMEOUT_MS);
    const unsub = conn.onMessage((bytes) => {
      if (isGetBlockParameterResponse(bytes, targetId)) {
        clearTimeout(timer);
        unsub();
        try {
          resolve(parseGetBlockParameterResponse(bytes));
        } catch (e) {
          reject(e);
        }
      }
    });
    conn.send(buildGetBlockParameterValue(targetId));
  });
}

async function main(): Promise<void> {
  const conn = connectAxeFxII();
  await new Promise((r) => setTimeout(r, 150));
  console.log(`Reading ${OPAQUE.length} opaque amp params (effectId ${AMP_EFFECT_ID}), READ ONLY\n`);
  console.log('paramId\tname\tcontrolType\twire\tlabel');
  let ok = 0;
  let labelled = 0;
  for (const p of OPAQUE) {
    try {
      const { value, label } = await readParam(conn, p.paramId);
      ok++;
      if (label !== undefined && label !== '') labelled++;
      console.log(`${p.paramId}\t${p.name}\t${p.controlType}\t${value}\t${label ?? '(no label)'}`);
    } catch (e) {
      console.log(`${p.paramId}\t${p.name}\t${p.controlType}\tERR\t${e instanceof Error ? e.message : String(e)}`);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  console.log(`\nread ok: ${ok}/${OPAQUE.length}; with non-empty label: ${labelled}/${OPAQUE.length}`);
  setTimeout(() => process.exit(0), 200);
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : String(e)); process.exit(1); });
