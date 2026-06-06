/**
 * Gen-3 WRITE-VERIFY probe, core logic (transport-injectable, no process / fs).
 *
 * `runVerifyProbe` drives every shipped gen-3 write op against the LOADED preset
 * and reads the result back to confirm the device ACCEPTS AND APPLIES our
 * writes. The headline question is whether set_param works for continuous knobs.
 * Because the editor uses TWO different wire shapes for a continuous value, the
 * probe tests BOTH and reports each verdict:
 *   - the typed `09 00` integer form (`buildSetParameter`, the form our shipped
 *     set_param actually emits), and
 *   - the mouse-drag `52 00` float32 form (what FM9-Edit emits for a knob drag;
 *     built here byte-for-byte from the captured frame layout).
 * Whichever the device accepts tells us if the shipped continuous path is right
 * or must switch to the float form.
 *
 * SAFETY (hard invariants):
 *   - NEVER saves / stores (no store op anywhere in this module).
 *   - Establishes a RESTORE POINT first (reads the active preset number); if it
 *     cannot, runs READ-ONLY and skips every write test. `onRestorePoint` is
 *     fired with that number so the CLI can also reload on Ctrl-C.
 *   - RELOADS the active preset at the end (the master undo: reloading from flash
 *     discards the working buffer), then RE-READS the preset number and warns if
 *     it does not match (e.g. the device has PC-Mapping on, which would defeat
 *     the reload).
 */
import type { MidiConnection } from '@mcp-midi-control/fractal-modern/midi.js';
import { toHex } from '@mcp-midi-control/fractal-modern/midi.js';
import { fractalChecksum } from 'fractal-midi/shared';
import {
  buildBlockBulkReadPoll,
  assembleGen3BlockBulkRead,
  isGen3BroadcastFrame,
  buildSetParameter,
  parseGen3SetValueEcho,
  pack5Septet32,
  buildSetBypass,
  buildSetScene,
  buildGetScene,
  buildSetGridCell,
  buildSwitchPresetPC,
  buildQueryPatchName,
  isQueryPatchNameResponse,
  parseQueryPatchNameResponse,
} from 'fractal-midi/axe-fx-iii';

const REVERB_EFFECT_ID = 66;
const REVERB_MIX_PARAM_ID = 0;
const REVERB_TYPE_PARAM_ID = 10;
const REVERB_TYPE_GROUND_TRUTH = { rawId: 524, ordinal: 16, name: 'Medium Spring' };
const DRIVE_EFFECT_ID = 118;

const POLL_WINDOW_MS = 400;
const SET_ECHO_WINDOW_MS = 400;
const QUERY_WINDOW_MS = 600;
const SETTLE_MS = 120;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Reusable IEEE-754 float32 <-> uint32 view (mirrors the codec's decoder), so
// the probe can build the captured `52 00` mouse-drag form, whose value is a
// 5-septet-LE float32 of the normalized [0,1] knob position at bytes 12-16.
const _f32 = new Float32Array(1);
const _u32 = new Uint32Array(_f32.buffer);
function buildDragSetFloat(eff: number, pid: number, normalized: number, model: number): number[] {
  _f32[0] = Math.max(0, Math.min(1, normalized));
  const [s0, s1, s2, s3, s4] = pack5Septet32(_u32[0]);
  const enc14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
  // Byte-for-byte the captured FM9 drag frame: F0 00 01 74 <model> 01 52 00
  // <eff:2> <pid:2> <float:5> 00 00 00 00 <cks> F7.
  const body = [0xf0, 0x00, 0x01, 0x74, model, 0x01, 0x52, 0x00, ...enc14(eff), ...enc14(pid), s0, s1, s2, s3, s4, 0x00, 0x00, 0x00, 0x00];
  return [...body, fractalChecksum(body), 0xf7];
}

export interface VerifyProbeOptions {
  conn: MidiConnection;
  modelByte: number;
  gridRows: number;
  label: string;
  timing?: { pollMs?: number; setMs?: number; queryMs?: number; settleMs?: number };
  log?: (line: string) => void;
  /** Fired once the restore point (active preset number) is known, so the CLI
   *  can reload it on Ctrl-C. Not called if the preset number is unreadable. */
  onRestorePoint?: (presetNumber: number) => void;
}

export interface TestResult { tool: string; status: 'pass' | 'fail' | 'skipped'; detail: string; data?: unknown }

export interface VerifyReport {
  probe: 'gen3-verify-probe';
  version: 1;
  device: string;
  modelByte: number;
  activePreset?: number;
  presetName?: string;
  restoreConfirmed?: boolean;
  note: string;
  summary: { passed: number; failed: number; skipped: number };
  results: TestResult[];
}

export async function runVerifyProbe(opts: VerifyProbeOptions): Promise<VerifyReport> {
  const { conn, modelByte: MODEL, gridRows, label } = opts;
  const log = opts.log ?? ((): void => {});
  const pollMs = opts.timing?.pollMs ?? POLL_WINDOW_MS;
  const setMs = opts.timing?.setMs ?? SET_ECHO_WINDOW_MS;
  const queryMs = opts.timing?.queryMs ?? QUERY_WINDOW_MS;
  const settleMs = opts.timing?.settleMs ?? SETTLE_MS;

  const inbound: number[][] = [];
  const unsub = conn.onMessage((bytes) => { if (bytes[0] === 0xf0) inbound.push(bytes); });

  const results: TestResult[] = [];
  let activePreset: number | undefined;
  let presetName: string | undefined;
  let restoreConfirmed: boolean | undefined;

  async function sendAndCollect(
    bytes: number[], windowMs: number, doneWhen?: (frames: number[][]) => boolean,
  ): Promise<number[][]> {
    const startLen = inbound.length;
    conn.send(bytes);
    const deadline = Date.now() + windowMs;
    for (;;) {
      const frames = inbound.slice(startLen);
      if (doneWhen && frames.length > 0 && doneWhen(frames)) return frames;
      if (Date.now() >= deadline) return frames;
      await sleep(15);
    }
  }

  async function pollBlock(effectId: number): Promise<{ itemCount: number; values: number[] } | undefined> {
    const frames = await sendAndCollect(
      buildBlockBulkReadPoll(effectId, MODEL), pollMs,
      (fs) => fs.some((f) => isGen3BroadcastFrame(f, 0x76, MODEL)),
    );
    if (!frames.some((f) => isGen3BroadcastFrame(f, 0x74, MODEL))) return undefined;
    try {
      const burst = assembleGen3BlockBulkRead(frames, MODEL);
      return { itemCount: burst.itemCount, values: burst.values };
    } catch {
      return undefined;
    }
  }

  /** Send a SET (caller-built frame), capture any 0x64 reject + 60-byte echo. */
  async function sendSetAndCaptureEcho(
    frame: number[], effectId: number, paramId: number,
  ): Promise<{ rejected: boolean; echo?: { normalizedValue: number } }> {
    const frames = await sendAndCollect(frame, setMs);
    let echo: { normalizedValue: number } | undefined;
    let rejected = false;
    for (const f of frames) {
      if (f[5] === 0x64) { rejected = true; continue; }
      try {
        const e = parseGen3SetValueEcho(f);
        if (e.effectId === effectId && e.paramId === paramId) echo = { normalizedValue: e.normalizedValue };
      } catch { /* not an echo frame */ }
    }
    return { rejected, echo };
  }

  function record(tool: string, status: TestResult['status'], detail: string, data?: unknown): void {
    results.push({ tool, status, detail, data });
    const mark = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'skip';
    log(`  [${mark}] ${tool}: ${detail}`);
  }

  // One continuous-form sub-test: set reverb.mix to `targetWire`, read it back,
  // and judge. `form` is the human label; `frame` the bytes to send.
  async function continuousFormTest(form: string, frame: number[], targetWire: number, origMix: number): Promise<void> {
    const { rejected, echo } = await sendSetAndCaptureEcho(frame, REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID);
    await sleep(settleMs);
    const after = await pollBlock(REVERB_EFFECT_ID);
    const readBack = after?.values[REVERB_MIX_PARAM_ID];
    const expectedNorm = targetWire / 65535;
    const echoMatches = echo !== undefined && Math.abs(echo.normalizedValue - expectedNorm) < 0.02;
    const readMatches = readBack !== undefined && Math.abs(readBack - targetWire) <= 256;
    const data = { form, sentWire: targetWire, echoNormalized: echo?.normalizedValue, expectedNorm, readBackWire: readBack, origWire: origMix };
    const tool = `set_param continuous (reverb.mix, ${form})`;
    if (rejected) {
      record(tool, 'fail', `device REJECTED the ${form} SET with a 0x64. This wire shape is not accepted for a continuous param.`, data);
    } else if (readMatches) {
      record(tool, 'pass', `wrote ${targetWire}, read back ${readBack}` + (echo ? `, echoed ${echo.normalizedValue.toFixed(4)} (expected ~${expectedNorm.toFixed(4)})` : ' (no value-echo)') + '. This form lands.', data);
    } else if (echoMatches) {
      record(tool, 'pass', `device echoed ${echo!.normalizedValue.toFixed(4)} (expected ~${expectedNorm.toFixed(4)}); read-back ${readBack ?? 'n/a'}. Echo confirms the value.`, data);
    } else {
      record(tool, 'fail', `wrote ${targetWire}, read back ${readBack ?? 'no response'}, echo ${echo?.normalizedValue.toFixed(4) ?? 'none'} (expected ~${expectedNorm.toFixed(4)}). This form was not applied.`, data);
    }
    // Restore the original mix using the same form, before the next sub-test.
    if (form.startsWith('typed')) await sendSetAndCaptureEcho(buildSetParameter(REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID, origMix, MODEL), REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID);
    else await sendSetAndCaptureEcho(buildDragSetFloat(REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID, origMix / 65535, MODEL), REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID);
    await sleep(settleMs);
  }

  async function runWriteTests(): Promise<void> {
    const reverb = await pollBlock(REVERB_EFFECT_ID);
    if (reverb === undefined) {
      record('set_param/set_bypass (reverb tests)', 'skipped',
        'Reverb 1 (eff 66) is not in the loaded preset. Load a preset that contains a Reverb block, then re-run for the param tests.');
    } else {
      const origMix = reverb.values[REVERB_MIX_PARAM_ID] ?? 0;
      const target = origMix < 32768 ? 49152 : 16384;

      // T1 (HEADLINE): test BOTH continuous wire shapes so the report says which
      // the device accepts. typed = what shipped set_param emits; drag/float =
      // what FM9-Edit emits for a knob.
      await continuousFormTest('typed 09 00 int (shipped set_param form)', buildSetParameter(REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID, target, MODEL), target, origMix);
      await continuousFormTest('drag 52 00 float (editor knob form)', buildDragSetFloat(REVERB_EFFECT_ID, REVERB_MIX_PARAM_ID, target / 65535, MODEL), target, origMix);

      // T2: set_param ENUM round-trip on Reverb Type (raw 524 -> ordinal 16).
      // Not individually restored (we lack the original type's raw-id); the
      // end-of-probe reload is the restore for this and the bypass/scene tests.
      const enumRes = await sendSetAndCaptureEcho(buildSetParameter(REVERB_EFFECT_ID, REVERB_TYPE_PARAM_ID, REVERB_TYPE_GROUND_TRUTH.rawId, MODEL), REVERB_EFFECT_ID, REVERB_TYPE_PARAM_ID);
      await sleep(settleMs);
      const afterType = await pollBlock(REVERB_EFFECT_ID);
      const typeOrdinal = afterType?.values[REVERB_TYPE_PARAM_ID];
      const enumData = { sentRawId: REVERB_TYPE_GROUND_TRUTH.rawId, expectedOrdinal: REVERB_TYPE_GROUND_TRUTH.ordinal, readBackOrdinal: typeOrdinal };
      if (enumRes.rejected) {
        record('set_param (enum, reverb.type)', 'fail', 'device REJECTED the enum SET (0x64).', enumData);
      } else if (typeOrdinal === REVERB_TYPE_GROUND_TRUTH.ordinal) {
        record('set_param (enum, reverb.type)', 'pass', `set raw ${REVERB_TYPE_GROUND_TRUTH.rawId}, read back ordinal ${typeOrdinal} = "${REVERB_TYPE_GROUND_TRUTH.name}". Enum SET-by-raw-id lands.`, enumData);
      } else {
        record('set_param (enum, reverb.type)', 'fail', `set raw ${REVERB_TYPE_GROUND_TRUTH.rawId}, expected ordinal ${REVERB_TYPE_GROUND_TRUTH.ordinal}, read back ${typeOrdinal ?? 'no response'}.`, enumData);
      }

      // T3: set_bypass round-trip (toggle bypassed then re-engage). Bypass state
      // is not in the bulk-read body, so we can only confirm "no rejection".
      const byp1 = await sendAndCollect(buildSetBypass(REVERB_EFFECT_ID, true, MODEL), setMs);
      await sleep(settleMs);
      await sendAndCollect(buildSetBypass(REVERB_EFFECT_ID, false, MODEL), setMs);
      const bypRejected = byp1.some((f) => f[5] === 0x64);
      record('set_bypass (reverb)', bypRejected ? 'fail' : 'pass',
        bypRejected ? 'device REJECTED the bypass write (0x64).' : 'bypass toggle accepted (no 0x64). Confirm audibly: the reverb should have muted then returned.');
    }

    // T4: switch_scene (to scene 2, query active scene, return to scene 1). The
    // end-of-probe reload restores the preset's saved active scene.
    const sceneReply = await sendAndCollect(buildSetScene(1, MODEL), queryMs);
    await sleep(settleMs);
    const sceneQuery = await sendAndCollect(buildGetScene(MODEL), queryMs);
    await sendAndCollect(buildSetScene(0, MODEL), queryMs);
    const sceneRejected = sceneReply.some((f) => f[5] === 0x64);
    const sceneEcho = sceneQuery.find((f) => f[5] === 0x0c);
    const sceneByte = sceneEcho?.[6];
    const sceneApplied = sceneByte === 1; // we set wire scene 1 (display scene 2)
    record('switch_scene', sceneRejected ? 'fail' : (sceneEcho && !sceneApplied ? 'fail' : 'pass'),
      sceneRejected ? 'device REJECTED switch_scene (0x64).'
        : sceneEcho ? `set wire scene 1; active-scene query read back ${sceneByte}${sceneApplied ? ' (matches)' : ' (MISMATCH)'}.`
          : 'accepted (no 0x64); scene-query reply not observed, so application is unconfirmed.',
      { sceneQueryReply: sceneQuery.map(toHex) });

    // T5: set_block. Only run if our test cell's block type (Drive) is NOT
    // already present, so we never clear a block the user already had. Place a
    // Drive, confirm a Drive appears, then clear it; the reload is the backstop.
    if ((await pollBlock(DRIVE_EFFECT_ID)) !== undefined) {
      record('set_block', 'skipped', 'a Drive block is already in this preset, so the placement test would risk clearing it. Load a preset without a Drive to test set_block.');
    } else {
      const cell = { row: 1, col: gridRows === 6 ? 14 : 12, rows: gridRows };
      const placeReply = await sendAndCollect(buildSetGridCell({ ...cell, blockId: DRIVE_EFFECT_ID }, MODEL), setMs);
      await sleep(settleMs);
      const drivePresent = (await pollBlock(DRIVE_EFFECT_ID)) !== undefined;
      if (drivePresent) await sendAndCollect(buildSetGridCell({ ...cell, blockId: 0 }, MODEL), setMs); // clear only what we placed
      const placeRejected = placeReply.some((f) => f[5] === 0x64);
      record('set_block', placeRejected ? 'fail' : (drivePresent ? 'pass' : 'fail'),
        placeRejected ? 'device REJECTED set_block (0x64).'
          : drivePresent ? `placed Drive at r${cell.row}c${cell.col} and a poll then found it. Block placement lands.` : 'sent the insert but a poll did not find a Drive (cell may have been occupied, or placement was not applied).',
        { cell });
    }

    record('save_preset', 'skipped',
      'not auto-tested (it would overwrite a preset on your device). To verify manually: make a change, save to an EMPTY location, and confirm it persists after a power cycle.');
  }

  // Read the active preset number BEFORE any write, then re-read after the reload.
  async function readActivePreset(): Promise<{ number: number; name: string } | undefined> {
    const frames = await sendAndCollect(buildQueryPatchName('current', MODEL), queryMs);
    const frame = frames.find((f) => isQueryPatchNameResponse(f, MODEL));
    if (!frame) return undefined;
    try {
      const p = parseQueryPatchNameResponse(frame, MODEL);
      return { number: p.presetNumber, name: p.name };
    } catch { return undefined; }
  }

  try {
    const start = await readActivePreset();
    if (start === undefined) {
      log('\nCould not read the active preset number; a safe restore point cannot be established.');
      log('Skipping all WRITE tests (read-only run). Close the editor, connect the device, re-run.');
      record('restore_point', 'skipped', 'active preset number unreadable; write tests skipped for safety.');
    } else {
      activePreset = start.number;
      presetName = start.name;
      opts.onRestorePoint?.(activePreset);
      log(`\nRestore point: preset ${activePreset}${presetName ? ` "${presetName.trim()}"` : ''}. Running write tests...\n`);
      try {
        await runWriteTests();
      } finally {
        // Master undo: reload the active preset to discard the working buffer,
        // then confirm we landed back on it (PC-Mapping or a missed PC would
        // leave us elsewhere with the working buffer NOT restored).
        conn.send(buildSwitchPresetPC(activePreset));
        await sleep(settleMs);
        const back = await readActivePreset();
        restoreConfirmed = back?.number === activePreset;
        if (restoreConfirmed) {
          log(`\nReloaded preset ${activePreset} to discard all probe changes.`);
        } else {
          record('restore_check', 'fail', `after the restore Program Change, the active preset read back as ${back?.number ?? 'unknown'}, not ${activePreset}. If your device has MIDI > PC Mapping ON, turn it OFF and manually reload preset ${activePreset} to discard the probe's working-buffer changes.`);
          log(`\nWARNING: could not confirm the reload. Manually reload preset ${activePreset} on the device.`);
        }
      }
    }
  } finally {
    unsub();
  }

  return {
    probe: 'gen3-verify-probe',
    version: 1,
    device: label,
    modelByte: MODEL,
    activePreset,
    presetName: presetName?.trim(),
    restoreConfirmed,
    note: 'WRITE-VERIFY round-trip. Never saves; reloads the active preset at the end to discard changes. T1 tests BOTH continuous wire forms (typed 09 00 int = shipped set_param; drag 52 00 float = editor knob) so the report says which the device accepts.',
    summary: {
      passed: results.filter((r) => r.status === 'pass').length,
      failed: results.filter((r) => r.status === 'fail').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    },
    results,
  };
}
