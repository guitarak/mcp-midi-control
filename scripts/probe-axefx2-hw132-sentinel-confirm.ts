/**
 * HW-132 phase 3: confirm fn 0x03 `7F 7F` is a true EDIT-BUFFER dump.
 *
 * Phase 2 of the first probe showed the sentinel returns a 66-frame dump
 * that (a) differs from the stored-slot dump and (b) does NOT reload the
 * working buffer. This probe pins it down:
 *   1. Dump with buffer renamed "EB ALPHA", dump again renamed
 *      "EB BRAVO": if the bytes track the live rename, the dump source
 *      is the working buffer, not any stored slot.
 *   2. Header-frame inspection: stored dump header carries
 *      [bank, preset, 0x00, 0x20]; what does the sentinel header carry?
 *   3. Round-trip: push the "EB ALPHA" dump back (same push path as
 *      import_preset), then read the buffer name — "EB ALPHA" proves the
 *      dump is a valid re-importable buffer snapshot.
 *
 * Self-restoring: buffer renames only; ends by re-switching to the
 * original preset. No STORE (fn 0x1D) ever sent. Dumps saved under
 * samples/captured/hw132/.
 *
 * Run: npx tsx scripts/probe-axefx2-hw132-sentinel-confirm.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { connect } from '@mcp-midi-control/core/midi/transport.js';
import {
  AXE_FX_II_XL_PLUS_MODEL_ID,
  buildGetPresetName,
  buildGetPresetNumber,
  buildSetPresetName,
  buildSwitchPreset,
  isGetPresetNameResponse,
  isGetPresetNumberResponse,
  parseGetPresetNameResponse,
  parseGetPresetNumberResponse,
} from 'fractal-midi/gen2/axe-fx-ii';
import { fractalChecksum } from 'fractal-midi/shared';
import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

const FN_PATCH_DUMP = 0x03;
const FN_PATCH_HEADER = 0x77;
const FN_PATCH_CHUNK = 0x78;
const FN_PATCH_FOOTER = 0x79;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const hex = (b: number[]) => b.map((v) => v.toString(16).padStart(2, '0')).join(' ');

function buildDumpReq(hi: number, lo: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, AXE_FX_II_XL_PLUS_MODEL_ID, FN_PATCH_DUMP, hi, lo];
  return [...head, fractalChecksum(head), 0xf7];
}

function isPatchFrame(b: number[]): boolean {
  return b.length >= 6 && b[0] === 0xf0 && b[4] === AXE_FX_II_XL_PLUS_MODEL_ID
    && (b[5] === FN_PATCH_HEADER || b[5] === FN_PATCH_CHUNK || b[5] === FN_PATCH_FOOTER);
}

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const conn = connect({ needles: ['axe-fx', 'axefx'], notFoundLeadIn: 'Axe-Fx II not visible.' });
  const outDir = path.join('samples', 'captured', 'hw132');
  mkdirSync(outDir, { recursive: true });
  const findings: string[] = [];

  const readName = async (): Promise<string> => {
    const p = conn.receiveSysExMatching(isGetPresetNameResponse, 1500);
    conn.send(buildGetPresetName());
    return parseGetPresetNameResponse(await p).trimEnd();
  };
  const collectDump = (hi: number, lo: number): Promise<number[][]> =>
    new Promise((resolve) => {
      const frames: number[][] = [];
      const unsub = conn.onMessage((bytes) => {
        if (!isPatchFrame(bytes)) return;
        frames.push([...bytes]);
        if (bytes[5] === FN_PATCH_FOOTER) { unsub(); resolve(frames); }
      });
      setTimeout(() => { unsub(); resolve(frames); }, 6000);
      conn.send(buildDumpReq(hi, lo));
    });

  // Baseline
  const numP = conn.receiveSysExMatching(isGetPresetNumberResponse, 2000);
  conn.send(buildGetPresetNumber());
  const wirePreset = parseGetPresetNumberResponse(await numP).presetNumber;
  await sleep(80);
  const baselineName = await readName();
  console.log(`active wire preset ${wirePreset}, buffer name "${baselineName}"`);
  await sleep(80);

  // 1. Sentinel dump with name "EB ALPHA"
  conn.send(buildSetPresetName('EB ALPHA'));
  await sleep(200);
  const dumpA = await collectDump(0x7f, 0x7f);
  console.log(`sentinel dump A ("EB ALPHA"): ${dumpA.length} frames, header payload [${hex(dumpA[0]?.slice(6, 12) ?? [])}]`);
  await sleep(150);

  // 2. Sentinel dump with name "EB BRAVO"
  conn.send(buildSetPresetName('EB BRAVO'));
  await sleep(200);
  const dumpB = await collectDump(0x7f, 0x7f);
  console.log(`sentinel dump B ("EB BRAVO"): ${dumpB.length} frames, header payload [${hex(dumpB[0]?.slice(6, 12) ?? [])}]`);
  await sleep(150);

  // 3. Stored dump for header comparison
  const dumpS = await collectDump((wirePreset >> 7) & 0x7f, wirePreset & 0x7f);
  console.log(`stored dump      ("${baselineName}"): ${dumpS.length} frames, header payload [${hex(dumpS[0]?.slice(6, 12) ?? [])}]`);
  // NOTE: the stored-dump request reloads the buffer (phase-1 finding),
  // so the buffer is now back to the stored preset. That's fine — the
  // round-trip push below overwrites it anyway.
  await sleep(150);

  const flat = (fs: number[][]) => fs.flat();
  const a = flat(dumpA); const b = flat(dumpB); const s = flat(dumpS);
  const eq = (x: number[], y: number[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  let firstDiff = -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { if (a[i] !== b[i]) { firstDiff = i; break; } }
  console.log(`A vs B: ${eq(a, b) ? 'IDENTICAL' : `DIFFER (first diff at flat offset ${firstDiff})`}; A vs stored: ${eq(a, s) ? 'IDENTICAL' : 'DIFFER'}`);
  if (!eq(a, b)) {
    findings.push('TRACKING: sentinel dumps track live buffer renames (A != B) — the 7F 7F dump reads the WORKING BUFFER.');
  } else {
    findings.push('TRACKING: A == B despite different buffer names — the 7F 7F dump does NOT track the buffer; treat as not-an-edit-buffer dump.');
  }

  writeFileSync(path.join(outDir, 'sentinel-eb-alpha.syx'), Buffer.from(a));
  writeFileSync(path.join(outDir, 'sentinel-eb-bravo.syx'), Buffer.from(b));
  writeFileSync(path.join(outDir, `stored-slot-${wirePreset}.syx`), Buffer.from(s));
  console.log(`dumps saved to ${outDir}/`);

  // 4. Round-trip: push dump A back to the buffer (paced frame stream,
  //    same shape import_preset uses), then read the name.
  if (!eq(a, b) && dumpA.length === 66) {
    console.log('round-trip: pushing dump A (EB ALPHA) back to the working buffer …');
    for (const frame of dumpA) {
      conn.send(frame);
      await sleep(15);
    }
    await sleep(500);
    const rtName = await readName();
    console.log(`  buffer name after push = "${rtName}"`);
    if (rtName === 'EB ALPHA') {
      findings.push('ROUND-TRIP: pushing the sentinel dump restored the buffer state (name "EB ALPHA") — the dump is a valid re-importable edit-buffer snapshot.');
    } else {
      findings.push(`ROUND-TRIP: after pushing dump A the buffer reads "${rtName}", not "EB ALPHA" — push path needs the proper ack-paced importer or the dump is not re-importable as-is.`);
    }
  }

  // Restore original preset (discard probe buffer state)
  conn.send(buildSwitchPreset(wirePreset));
  await sleep(400);
  console.log(`restored: buffer name = "${await readName()}" (expected "${baselineName}")`);

  console.log('\n── FINDINGS ──');
  for (const f of findings) console.log(`  • ${f}`);
  conn.close();
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
