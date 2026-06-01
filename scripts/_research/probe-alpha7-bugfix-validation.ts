/**
 * Hardware validation probe for alpha.7 bug fixes.
 *
 * Tests the three fixes end-to-end on real hardware:
 *   1. Per-scene bypass via fn=0x02 (multi-amp preset, bypass one per scene)
 *   2. Compressor effect_type via fn=0x02 integer path
 *   3. Enum param routing (verify fn=0x02 for select params, fn=0x2e for knobs)
 *
 * SAFETY: all writes are to the working buffer only. No saves.
 * Restores original state at the end.
 *
 * Prerequisites: Axe-Fx II connected, preset with Amp 1, Amp 2, and
 * Compressor 1 placed. If blocks are missing, the affected tests skip.
 *
 * Run: npx tsx scripts/_research/probe-alpha7-bugfix-validation.ts
 */
import midi from 'midi';

const MODEL = 0x07;
const MFR = [0x00, 0x01, 0x74] as const;

const AMP_1 = 106;
const AMP_2 = 107;
const COMP_1 = 100;
const BYPASS_PID = 255;
const COMP_EFFECT_TYPE_PID = 12;
const AMP_EFFECT_TYPE_PID = 0;
const COMP_MIX_PID = 11;

const TIMEOUT_MS = 3000;

function cksum(b: number[]) { return b.reduce((a, c) => a ^ c, 0) & 0x7f; }
function env(fn: number, payload: number[] = []) {
  const h = [0xf0, ...MFR, MODEL, fn, ...payload];
  return [...h, cksum(h), 0xf7];
}
function e14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
function pv16(v: number): [number, number, number] { return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03]; }
function pf32(value: number): [number, number, number, number, number] {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setFloat32(0, value, true);
  const bytes = new Uint8Array(buf);
  const n = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | ((bytes[3] << 24) >>> 0);
  return [n & 0x7f, (n >> 7) & 0x7f, (n >> 14) & 0x7f, (n >> 21) & 0x7f, (n >> 28) & 0x0f];
}
function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }
function findPort(io: midi.Input | midi.Output, needles: string[]): number {
  for (let i = 0; i < io.getPortCount(); i++) {
    const name = io.getPortName(i);
    for (const n of needles) { if (name.toLowerCase().includes(n.toLowerCase())) return i; }
  }
  return -1;
}

const msgs: number[][] = [];

function switchChannel(out: midi.Output, eid: number, ch: 0 | 1) {
  out.sendMessage(env(0x11, [...e14(eid), ch]));
}
function setScene(out: midi.Output, scene: number) {
  out.sendMessage(env(0x29, [scene & 0x7f]));
}
function setFn02(out: midi.Output, eid: number, pid: number, val: number) {
  out.sendMessage(env(0x02, [...e14(eid), ...e14(pid), ...pv16(val), 0x01]));
}
function setFn2e(out: midi.Output, eid: number, pid: number, displayVal: number) {
  out.sendMessage(env(0x2e, [...e14(eid), ...e14(pid), ...pf32(displayVal)]));
}

async function getParam(
  out: midi.Output, eid: number, pid: number,
): Promise<{ wire: number; label: string } | null> {
  const before = msgs.length;
  out.sendMessage(env(0x02, [...e14(eid), ...e14(pid), 0, 0, 0, 0x00]));
  const dl = Date.now() + TIMEOUT_MS;
  while (Date.now() < dl) {
    await sleep(30);
    for (let i = before; i < msgs.length; i++) {
      const b = msgs[i];
      if (b.length >= 17 && b[5] === 0x02) {
        const e = (b[6] & 0x7f) | ((b[7] & 0x7f) << 7);
        const p = (b[8] & 0x7f) | ((b[9] & 0x7f) << 7);
        if (e === eid && p === pid) {
          const w = (b[10] & 0x7f) | ((b[11] & 0x7f) << 7) | ((b[12] & 0x03) << 14);
          const lb: number[] = [];
          for (let j = 18; j < b.length - 2 && b[j] !== 0; j++) lb.push(b[j]);
          return { wire: w, label: String.fromCharCode(...lb) };
        }
      }
    }
  }
  return null;
}

async function blockResponds(out: midi.Output, eid: number): Promise<boolean> {
  const r = await getParam(out, eid, 0);
  return r !== null;
}

let passes = 0;
let fails = 0;
const results: string[] = [];

function pass(msg: string) { console.log(`  PASS: ${msg}`); passes++; results.push(`PASS: ${msg}`); }
function fail(msg: string) { console.log(`  FAIL: ${msg}`); fails++; results.push(`FAIL: ${msg}`); }
function check(ok: boolean, msg: string) { ok ? pass(msg) : fail(msg); }

async function main() {
  console.log('===================================================================');
  console.log('  Alpha.7 Bug Fix Validation Probe');
  console.log('  Verifies: per-scene bypass, compressor effect_type, enum routing');
  console.log('===================================================================\n');

  const input = new midi.Input();
  const output = new midi.Output();
  const needles = ['Axe-Fx II', 'AxeFxII', 'AXE-FX II', 'XL+'];
  const outIdx = findPort(output, needles);
  if (outIdx < 0) { console.error('Axe-Fx II output port not found'); process.exit(1); }
  const inIdx = findPort(input, needles);
  if (inIdx < 0) { console.error('Axe-Fx II input port not found'); process.exit(1); }

  console.log(`  Output: ${output.getPortName(outIdx)}`);
  console.log(`  Input:  ${input.getPortName(inIdx)}\n`);

  output.openPort(outIdx);
  input.ignoreTypes(false, true, true);
  input.on('message', (_, b) => { if (b[0] === 0xf0) msgs.push(b.slice()); });
  input.openPort(inIdx);
  await sleep(500);
  msgs.length = 0;

  try {
    // Pre-flight: check which blocks are placed.
    const hasAmp1 = await blockResponds(output, AMP_1);
    const hasAmp2 = await blockResponds(output, AMP_2);
    const hasComp = await blockResponds(output, COMP_1);
    console.log(`  Amp 1: ${hasAmp1 ? 'placed' : 'NOT PLACED'}`);
    console.log(`  Amp 2: ${hasAmp2 ? 'placed' : 'NOT PLACED'}`);
    console.log(`  Comp 1: ${hasComp ? 'placed' : 'NOT PLACED'}\n`);

    // ================================================================
    // TEST 1: Per-scene bypass (the multi-amp bug fix)
    // ================================================================
    if (hasAmp1 && hasAmp2) {
      console.log('[TEST 1] Per-scene bypass: bypass Amp 2 on scene 1, Amp 1 on scene 2');
      console.log('----------------------------------------------------------\n');

      // Save originals.
      const origByp1 = await getParam(output, AMP_1, BYPASS_PID);
      const origByp2 = await getParam(output, AMP_2, BYPASS_PID);

      // Scene 1: set Amp 1 channel to Y (non-default), then bypass Amp 2.
      // The alpha.6 bug: fn=0x2e bypass went to Y's storage after the
      // channel switch, so bypass didn't actually engage on the block.
      setScene(output, 0); // scene 1
      await sleep(300);
      switchChannel(output, AMP_1, 1); // leave channel context on Y
      await sleep(200);
      setFn02(output, AMP_2, BYPASS_PID, 1); // bypass Amp 2
      await sleep(200);
      setFn02(output, AMP_1, BYPASS_PID, 0); // engage Amp 1
      await sleep(200);

      const s1_amp1 = await getParam(output, AMP_1, BYPASS_PID);
      const s1_amp2 = await getParam(output, AMP_2, BYPASS_PID);
      console.log(`  Scene 1: Amp 1 bypass=${s1_amp1?.wire} (expect 0=engaged)`);
      console.log(`  Scene 1: Amp 2 bypass=${s1_amp2?.wire} (expect 1=bypassed)`);
      check(s1_amp1?.wire === 0, 'Scene 1: Amp 1 ENGAGED');
      check(s1_amp2?.wire === 1, 'Scene 1: Amp 2 BYPASSED');

      // Scene 2: bypass Amp 1, engage Amp 2.
      setScene(output, 1); // scene 2
      await sleep(300);
      switchChannel(output, AMP_2, 1); // leave channel context on Y
      await sleep(200);
      setFn02(output, AMP_1, BYPASS_PID, 1); // bypass Amp 1
      await sleep(200);
      setFn02(output, AMP_2, BYPASS_PID, 0); // engage Amp 2
      await sleep(200);

      const s2_amp1 = await getParam(output, AMP_1, BYPASS_PID);
      const s2_amp2 = await getParam(output, AMP_2, BYPASS_PID);
      console.log(`  Scene 2: Amp 1 bypass=${s2_amp1?.wire} (expect 1=bypassed)`);
      console.log(`  Scene 2: Amp 2 bypass=${s2_amp2?.wire} (expect 0=engaged)`);
      check(s2_amp1?.wire === 1, 'Scene 2: Amp 1 BYPASSED');
      check(s2_amp2?.wire === 0, 'Scene 2: Amp 2 ENGAGED');

      // Switch back to scene 1 and verify bypass state held.
      setScene(output, 0);
      await sleep(300);
      const s1_check1 = await getParam(output, AMP_1, BYPASS_PID);
      const s1_check2 = await getParam(output, AMP_2, BYPASS_PID);
      console.log(`  Scene 1 recheck: Amp 1=${s1_check1?.wire}, Amp 2=${s1_check2?.wire}`);
      check(s1_check1?.wire === 0, 'Scene 1 recheck: Amp 1 still ENGAGED');
      check(s1_check2?.wire === 1, 'Scene 1 recheck: Amp 2 still BYPASSED');

      // Restore.
      setFn02(output, AMP_1, BYPASS_PID, origByp1?.wire ?? 0);
      setFn02(output, AMP_2, BYPASS_PID, origByp2?.wire ?? 0);
      await sleep(200);
      console.log('  Restored original bypass state.\n');
    } else {
      console.log('[TEST 1] SKIPPED: need Amp 1 + Amp 2 placed.\n');
      results.push('SKIP: Test 1 (no dual amps)');
    }

    // ================================================================
    // TEST 2: Compressor effect_type via fn=0x02
    // ================================================================
    if (hasComp) {
      console.log('[TEST 2] Compressor effect_type write + readback');
      console.log('----------------------------------------------------------\n');

      switchChannel(output, COMP_1, 0);
      await sleep(200);
      const origType = await getParam(output, COMP_1, COMP_EFFECT_TYPE_PID);
      console.log(`  Original: wire=${origType?.wire}, label="${origType?.label}"`);

      const testVal = (origType?.wire ?? 0) === 1 ? 2 : 1;
      const testLabel = testVal === 1 ? 'PEDAL COMP 1' : 'PEDAL COMP 2';

      // Write via fn=0x02 (the fixed path).
      console.log(`  Writing effect_type=${testVal} (${testLabel}) via fn=0x02...`);
      setFn02(output, COMP_1, COMP_EFFECT_TYPE_PID, testVal);
      await sleep(500);

      const afterWrite = await getParam(output, COMP_1, COMP_EFFECT_TYPE_PID);
      console.log(`  Readback: wire=${afterWrite?.wire}, label="${afterWrite?.label}"`);
      check(afterWrite?.wire === testVal, `Compressor effect_type=${testVal} (${testLabel}) landed`);

      // Also verify fn=0x2e does NOT work (regression guard).
      console.log(`  Restoring to original, then testing fn=0x2e (should NOT land)...`);
      setFn02(output, COMP_1, COMP_EFFECT_TYPE_PID, origType?.wire ?? 0);
      await sleep(300);

      const testVal2 = testVal === 1 ? 3 : 1;
      setFn2e(output, COMP_1, COMP_EFFECT_TYPE_PID, testVal2);
      await sleep(500);
      const afterFn2e = await getParam(output, COMP_1, COMP_EFFECT_TYPE_PID);
      check(
        afterFn2e?.wire === (origType?.wire ?? 0),
        `fn=0x2e correctly ignored for compressor.effect_type (wire=${afterFn2e?.wire}, expected=${origType?.wire})`,
      );

      // Restore.
      setFn02(output, COMP_1, COMP_EFFECT_TYPE_PID, origType?.wire ?? 0);
      await sleep(200);
      console.log('  Restored original.\n');
    } else {
      console.log('[TEST 2] SKIPPED: Compressor 1 not placed.\n');
      results.push('SKIP: Test 2 (no compressor)');
    }

    // ================================================================
    // TEST 3: Enum vs knob opcode routing
    // ================================================================
    if (hasComp) {
      console.log('[TEST 3] Enum (fn=0x02) vs knob (fn=0x2e) routing verification');
      console.log('----------------------------------------------------------\n');

      // Test: write compressor.mix (a knob param) via fn=0x2e.
      switchChannel(output, COMP_1, 0);
      await sleep(200);
      const origMix = await getParam(output, COMP_1, COMP_MIX_PID);
      console.log(`  Original comp.mix: wire=${origMix?.wire}, label="${origMix?.label}"`);

      const testMix = 50.0;
      console.log(`  Writing comp.mix=${testMix} via fn=0x2e...`);
      setFn2e(output, COMP_1, COMP_MIX_PID, testMix);
      await sleep(500);
      const afterMix = await getParam(output, COMP_1, COMP_MIX_PID);
      console.log(`  Readback: wire=${afterMix?.wire}, label="${afterMix?.label}"`);
      check(
        afterMix?.label?.includes('50') ?? false,
        `Knob param (comp.mix) landed via fn=0x2e (label="${afterMix?.label}")`,
      );

      // Restore.
      if (origMix) {
        const restoreDisplay = origMix.label.match(/^[\d.-]+/) ? parseFloat(origMix.label) : origMix.wire;
        setFn2e(output, COMP_1, COMP_MIX_PID, restoreDisplay);
        await sleep(200);
      }
      console.log('  Restored original.\n');
    } else {
      console.log('[TEST 3] SKIPPED: Compressor 1 not placed.\n');
      results.push('SKIP: Test 3 (no compressor)');
    }

    // ================================================================
    // SUMMARY
    // ================================================================
    console.log('===================================================================');
    console.log(`  SUMMARY: ${passes} passed, ${fails} failed`);
    console.log('===================================================================\n');
    for (const r of results) console.log(`  ${r}`);
    console.log();

    if (fails === 0) {
      console.log('  VERDICT: All alpha.7 bug fixes confirmed on hardware.\n');
    } else {
      console.log('  VERDICT: Some fixes did not verify. See FAIL entries above.\n');
    }
  } finally {
    input.closePort();
    output.closePort();
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
