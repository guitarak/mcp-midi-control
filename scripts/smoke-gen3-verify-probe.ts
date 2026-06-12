/**
 * Smoke test for the gen-3 WRITE-VERIFY probe, with NO hardware.
 *
 * Drives `runVerifyProbe` against STATEFUL mocks that simulate an FM9. Three
 * scenarios cover the cooperative path AND the failure paths the probe must
 * report correctly:
 *   1. Cooperative + echoing: accepts SETs, reflects them on the next poll,
 *      stores the discrete float32(ordinal) SET, AND emits the 60-byte value-echo, so the
 *      echo-parse path is exercised. Answers the fn=0x13 STATUS_DUMP from its
 *      live placed-block set (the probe gates reverb tests + set_block on that
 *      list, not on poll answers). Asserts every test PASSES and that the
 *      safety RELOAD (SysEx sub=0x27 preset switch) was actually sent.
 *   2. Rejecting: returns a 0x64 MULTIPURPOSE_RESPONSE for set_bypass. Asserts
 *      the probe records that op as FAIL (the rejection-detection path).
 *   3. Echo-only: echoes the value but does NOT reflect it on poll. Asserts the
 *      continuous test still PASSES via the echo branch.
 *
 * Run: npx tsx scripts/smoke-gen3-verify-probe.ts
 */
import { mockConnect, type MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import { packValue16, pack5Septet32, decode5SeptetFloat32 } from 'fractal-midi/gen3/axe-fx-iii';
import { fractalChecksum } from 'fractal-midi/shared';
import { runVerifyProbe } from '@mcp-midi-control/server-all/cli/gen3-verify-probe-core.js';

const MODEL = 0x12;
const REVERB = 66;
const DRIVE = 118;
const REVERB_ITEMS = 44; // stride 11; index 0 (mix) + 10 (type) are channel A

const dec14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);
const enc14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const env = (fn: number, payload: number[]): number[] => {
  const body = [0xf0, 0x00, 0x01, 0x74, MODEL, fn, ...payload];
  return [...body, fractalChecksum(body), 0xf7];
};
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
const floatSeptets = (norm: number): number[] => { _f32[0] = norm; return pack5Septet32(_u32[0]); };

interface MockOpts { rejectFn?: number; reflect?: boolean; emitEcho?: boolean }

function makeDevice(opts: MockOpts): MidiConnection & { sent: number[][] } {
  const reflect = opts.reflect !== false;
  const state = new Map<string, number>([[`${REVERB}:0`, 10000], [`${REVERB}:10`, 16]]);
  const placed = new Set<number>([REVERB]);

  const burst = (eff: number, items: number): number[][] => {
    const vals = Array.from({ length: items }, (_, i) => state.get(`${eff}:${i}`) ?? 0);
    return [
      env(0x74, [...enc14(eff), ...enc14(items), 0x07]),
      env(0x75, [0x00, 0x02, ...vals.flatMap((v) => packValue16(v))]),
      env(0x76, []),
    ];
  };
  // A 60-byte-ish value-echo carrying the normalized value at bytes 12-16.
  const echo = (eff: number, pid: number, norm: number): number[] =>
    env(0x01, [0x09, 0x00, ...enc14(eff), ...enc14(pid), ...floatSeptets(norm), ...Array(20).fill(0)]);

  const responder = (out: number[]): number[][] => {
    if (out[0] !== 0xf0 || out[1] !== 0x00 || out[2] !== 0x01 || out[3] !== 0x74 || out[4] !== MODEL) return [];
    const fn = out[5];
    if (opts.rejectFn !== undefined && fn === opts.rejectFn) return [env(0x64, [fn, 0x04])]; // reject this op
    if (fn === 0x0d) return [env(0x0d, [...enc14(42), 0x53, 0x4d, 0x4f, 0x4b, 0x45])]; // preset 42 "SMOKE"
    if (fn === 0x13) {
      // STATUS_DUMP: the device's placed-block list as `id_lo id_hi dd` triples
      // (SYSEX-MAP fn=0x13). dd=0x40 = engaged, channel A, 4 channels. The probe
      // gates the reverb tests AND set_block (before/after placement) on this
      // list, so it must reflect `placed` live — after the sub=0x32 insert of
      // Drive (118), the fresh 0x13 reply must include it.
      return [env(0x13, [...placed].flatMap((id) => [...enc14(id), 0x40]))];
    }
    if (fn === 0x1f) {
      const eff = dec14(out[6], out[7]);
      if (!placed.has(eff)) return [];
      return burst(eff, eff === REVERB ? REVERB_ITEMS : 4);
    }
    if (fn === 0x01) {
      const sub = out[6];
      const eff = dec14(out[8], out[9]);
      const pid = dec14(out[10], out[11]);
      if (sub === 0x09) { // discrete: float32(ordinal) at bytes 12-16
        const f = decode5SeptetFloat32(out[12], out[13], out[14], out[15], out[16]);
        const ordinal = Math.round(f);
        if (reflect) state.set(`${eff}:${pid}`, ordinal);
        // device echoes the ordinal normalized as ordinal/(count-1)
        return opts.emitEcho && pid === 0 ? [echo(eff, pid, ordinal / (REVERB_ITEMS - 1))] : [];
      }
      if (sub === 0x52) { // drag float (continuous)
        const norm = decode5SeptetFloat32(out[12], out[13], out[14], out[15], out[16]);
        if (reflect) state.set(`${eff}:${pid}`, Math.round(norm * 65535));
        return opts.emitEcho ? [echo(eff, pid, norm)] : [];
      }
      if (sub === 0x32) { const e = dec14(out[8], out[9]); if (e !== 0) placed.add(e); return []; }
      return [];
    }
    if (fn === 0x0a) return []; // bypass accepted
    if (fn === 0x0c) return [env(0x0c, [0x01])]; // scene reply: active scene = 1 (matches what the probe sets)
    return [];
  };

  const base = mockConnect({ responder, ackLatencyMs: 1 });
  const sent: number[][] = [];
  return { ...base, sent, send: (b: number[]) => { sent.push([...b]); base.send(b); } };
}

const failures: string[] = [];
function check(name: string, pass: boolean, detail = ''): void {
  console.log(`  ${pass ? '✓' : '✗'} ${name}`);
  if (!pass) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

const TIMING = { pollMs: 80, setMs: 80, queryMs: 80, settleMs: 5 };
// FM9-true reverb paramIds (the mock simulates an FM9: mix=0, type=10). The
// probe takes these via opts — paramIds are device-specific across the family.
const REVERB_IDS = { mixParamId: 0, typeParamId: 10 };
const CONT_TOOL = 'set_param continuous (reverb.mix, 52 00 float (shipped continuous set_param form))';
// The safety reload is the SysEx-native fn=0x01 sub=0x27 preset switch (NOT a
// Program Change — PC is 7-bit and truncates presets >127; FM3 field test 2026-06-12).
const isSysExPresetSwitch = (m: number[]): boolean => m[0] === 0xf0 && m[4] === MODEL && m[5] === 0x01 && m[6] === 0x27;

async function main(): Promise<void> {
  // Scenario 1: cooperative + echoing.
  const conn1 = makeDevice({ reflect: true, emitEcho: true });
  const r1 = await runVerifyProbe({ conn: conn1, modelByte: MODEL, gridRows: 6, label: 'FM9 (mock)', reverbIds: REVERB_IDS, timing: TIMING });
  const t = (name: string): { status: string; data?: unknown } | undefined => r1.results.find((x) => x.tool === name);
  console.log('\nScenario 1 (cooperative + echo):');
  check('restore point = preset 42', r1.activePreset === 42, String(r1.activePreset));
  check('restore confirmed (reload landed back)', r1.restoreConfirmed === true);
  check('continuous 52 00 float form PASS', t(CONT_TOOL)?.status === 'pass');
  check('continuous echo was parsed (data.echoNormalized set)', typeof (t(CONT_TOOL)?.data as { echoNormalized?: number })?.echoNormalized === 'number');
  check('enum PASS (discrete float32(ordinal) 45)', t('set_param (enum, reverb.type)')?.status === 'pass');
  check('set_bypass PASS', t('set_bypass (reverb)')?.status === 'pass');
  check('switch_scene PASS', t('switch_scene')?.status === 'pass');
  check('set_block PASS', t('set_block')?.status === 'pass');
  check('save_preset SKIPPED', t('save_preset')?.status === 'skipped');
  check('no FAIL verdicts', r1.summary.failed === 0, JSON.stringify(r1.summary));
  check('safety reload (SysEx sub=0x27 preset switch) was sent', conn1.sent.some(isSysExPresetSwitch));
  conn1.close();

  // Scenario 2: device rejects set_bypass (fn 0x0A) with 0x64.
  const conn2 = makeDevice({ reflect: true, emitEcho: false, rejectFn: 0x0a });
  const r2 = await runVerifyProbe({ conn: conn2, modelByte: MODEL, gridRows: 6, label: 'FM9 (mock)', reverbIds: REVERB_IDS, timing: TIMING });
  console.log('\nScenario 2 (device rejects set_bypass):');
  check('set_bypass recorded FAIL on 0x64 reject', r2.results.find((x) => x.tool === 'set_bypass (reverb)')?.status === 'fail');
  conn2.close();

  // Scenario 3: device echoes but does NOT reflect on poll -> continuous PASSes via echo.
  const conn3 = makeDevice({ reflect: false, emitEcho: true });
  const r3 = await runVerifyProbe({ conn: conn3, modelByte: MODEL, gridRows: 6, label: 'FM9 (mock)', reverbIds: REVERB_IDS, timing: TIMING });
  console.log('\nScenario 3 (echo-only, no reflect):');
  const contNoReflect = r3.results.find((x) => x.tool === CONT_TOOL);
  check('continuous PASSes via echo when read-back does not move', contNoReflect?.status === 'pass', JSON.stringify(contNoReflect));
  conn3.close();

  console.log('');
  if (failures.length === 0) {
    console.log('✓ PASS: gen3-verify-probe runs end-to-end and its verdict logic (pass, echo, reject) is exercised.');
    process.exit(0);
  }
  console.log(`✗ FAIL (${failures.length}):\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
main().catch((e) => { console.error('Fatal:', e); process.exit(99); });
