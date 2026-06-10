/**
 * HW-132 probe: Axe-Fx II fn 0x03 PATCH_DUMP source semantics.
 *
 * Two questions from the 0.3.0 dev test (2026-06-10):
 *   1. RELOAD SIDE EFFECT: does requesting fn 0x03 for the active slot
 *      reload the STORED preset into the working buffer, destroying
 *      unsaved edits? (Evidence: fn 0x0F buffer name flipped to the
 *      stored name right after the dump request in the live session.)
 *   2. EDIT-BUFFER SENTINEL: does fn 0x03 accept the AM4-style
 *      `0x7F 0x7F` payload as an edit-buffer dump request? If yes, the
 *      II export dirty-gate can be replaced with a true buffer export.
 *
 * Self-restoring: the only mutation is a working-buffer RENAME
 * (fn 0x09, hardware-verified buffer-scope), and the script finishes by
 * re-switching to the original preset, which discards the buffer. No
 * STORE (fn 0x1D) is ever sent.
 *
 * Run: npx tsx scripts/probe-axefx2-hw132-export-source.ts
 */
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
} from 'fractal-midi/axe-fx-ii';
import { fractalChecksum } from 'fractal-midi/shared';
import { guardAgainstRunningEditors } from './_lib/editor-guard.js';

const FN_PATCH_DUMP = 0x03;
const FN_PATCH_HEADER = 0x77;
const FN_PATCH_CHUNK = 0x78;
const FN_PATCH_FOOTER = 0x79;
const FN_MULTIPURPOSE = 0x64;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function buildPatchDumpRequestRaw(hi: number, lo: number): number[] {
  const head = [0xf0, 0x00, 0x01, 0x74, AXE_FX_II_XL_PLUS_MODEL_ID, FN_PATCH_DUMP, hi, lo];
  return [...head, fractalChecksum(head), 0xf7];
}

function isPatchFrame(b: number[]): boolean {
  return b.length >= 6 && b[0] === 0xf0 && b[4] === AXE_FX_II_XL_PLUS_MODEL_ID
    && (b[5] === FN_PATCH_HEADER || b[5] === FN_PATCH_CHUNK || b[5] === FN_PATCH_FOOTER);
}

async function main(): Promise<void> {
  guardAgainstRunningEditors();
  const conn = connect({
    needles: ['axe-fx', 'axefx'],
    notFoundLeadIn: 'Axe-Fx II not visible.',
  });
  const findings: string[] = [];

  const readName = async (): Promise<string> => {
    const p = conn.receiveSysExMatching(isGetPresetNameResponse, 1500);
    conn.send(buildGetPresetName());
    return parseGetPresetNameResponse(await p).trimEnd();
  };

  // ── Canary: active preset number (abort cleanly on no response) ──
  console.log('canary: GET_PRESET_NUMBER …');
  const numP = conn.receiveSysExMatching(isGetPresetNumberResponse, 2000);
  conn.send(buildGetPresetNumber());
  const wirePreset = parseGetPresetNumberResponse(await numP).presetNumber;
  console.log(`  active wire preset = ${wirePreset} (display slot ${wirePreset + 1})`);
  await sleep(80);

  const baselineName = await readName();
  console.log(`  buffer name (baseline) = "${baselineName}"`);
  await sleep(80);

  // ── Phase 1: reload side effect ──────────────────────────────────
  console.log('\nPHASE 1: dirty the buffer (rename only), then request fn 0x03 dump of the active slot');
  conn.send(buildSetPresetName('HW132 PROBE'));
  await sleep(200);
  const dirtyName = await readName();
  console.log(`  buffer name after rename = "${dirtyName}"`);
  if (dirtyName !== 'HW132 PROBE') {
    console.log('  WARN: rename did not echo; continuing anyway.');
  }
  await sleep(80);

  const storedFrames: number[][] = [];
  const storedDone = new Promise<void>((resolve) => {
    const unsub = conn.onMessage((bytes) => {
      if (!isPatchFrame(bytes)) return;
      storedFrames.push([...bytes]);
      if (bytes[5] === FN_PATCH_FOOTER) { unsub(); resolve(); }
    });
    setTimeout(() => { unsub(); resolve(); }, 6000);
  });
  conn.send(buildPatchDumpRequestRaw((wirePreset >> 7) & 0x7f, wirePreset & 0x7f));
  await storedDone;
  console.log(`  fn 0x03 (active slot) returned ${storedFrames.length} frame(s)`);
  await sleep(150);

  const postDumpName = await readName();
  console.log(`  buffer name after dump request = "${postDumpName}"`);
  if (postDumpName === 'HW132 PROBE') {
    findings.push('RELOAD: NOT confirmed — buffer name survived the fn 0x03 request (the 2026-06-10 flip needs another explanation).');
  } else {
    // Any name other than the probe rename means the request replaced
    // the buffer contents (with the STORED preset's name — which may
    // differ from the pre-probe buffer name if the buffer held unsaved
    // user state like SHIVA SPLIT).
    findings.push(`RELOAD: CONFIRMED — fn 0x03 dump request replaced the working buffer (rename lost; buffer now reads "${postDumpName}", i.e. the stored preset).`);
  }
  await sleep(150);

  // ── Phase 2: 0x7F 0x7F sentinel probe ────────────────────────────
  console.log('\nPHASE 2: rename buffer again, then request fn 0x03 with the AM4-style 7F 7F sentinel');
  conn.send(buildSetPresetName('HW132 EB'));
  await sleep(200);
  console.log(`  buffer name = "${await readName()}"`);
  await sleep(80);

  const sentinelFrames: number[][] = [];
  let nack: number[] | undefined;
  const sentinelDone = new Promise<void>((resolve) => {
    const unsub = conn.onMessage((bytes) => {
      if (bytes.length >= 6 && bytes[0] === 0xf0 && bytes[4] === AXE_FX_II_XL_PLUS_MODEL_ID && bytes[5] === FN_MULTIPURPOSE) {
        nack = [...bytes];
      }
      if (!isPatchFrame(bytes)) return;
      sentinelFrames.push([...bytes]);
      if (bytes[5] === FN_PATCH_FOOTER) { unsub(); resolve(); }
    });
    setTimeout(() => { unsub(); resolve(); }, 5000);
  });
  conn.send(buildPatchDumpRequestRaw(0x7f, 0x7f));
  await sentinelDone;
  console.log(`  sentinel returned ${sentinelFrames.length} frame(s)${nack ? `, MULTIPURPOSE_RESPONSE [${nack.slice(5, 9).map((b) => b.toString(16)).join(' ')}]` : ''}`);

  if (sentinelFrames.length > 0) {
    const flat = (fs: number[][]) => fs.flat();
    const a = flat(storedFrames);
    const b = flat(sentinelFrames);
    const sameAsStored = a.length === b.length && a.every((v, i) => v === b[i]);
    if (sameAsStored) {
      findings.push('SENTINEL: returned a dump BYTE-IDENTICAL to the stored-slot dump — it is NOT an edit-buffer dump (buffer was renamed at request time).');
    } else {
      findings.push(`SENTINEL: returned ${sentinelFrames.length} frames DIFFERENT from the stored dump — possible EDIT-BUFFER DUMP. Save the bytes and decode before celebrating (could also be a different slot).`);
    }
  } else if (nack !== undefined) {
    findings.push(`SENTINEL: rejected with MULTIPURPOSE_RESPONSE ${JSON.stringify(nack.slice(6, 8))} — no edit-buffer dump via 7F 7F.`);
  } else {
    findings.push('SENTINEL: no response (silence) — no edit-buffer dump via 7F 7F.');
  }
  await sleep(150);
  const postSentinelName = await readName();
  console.log(`  buffer name after sentinel = "${postSentinelName}"`);
  if (postSentinelName !== 'HW132 EB') {
    findings.push(`SENTINEL SIDE EFFECT: buffer name changed to "${postSentinelName}" after the 7F 7F request.`);
  }

  // ── Restore: reload the original preset (discards probe renames) ──
  console.log('\nrestore: switch back to the original preset (discards buffer renames)');
  conn.send(buildSwitchPreset(wirePreset));
  await sleep(400);
  const restoredName = await readName();
  console.log(`  buffer name after restore = "${restoredName}" (expected "${baselineName}")`);
  if (restoredName !== baselineName) {
    findings.push(`RESTORE: name reads "${restoredName}", baseline was "${baselineName}" — check the front panel.`);
  }

  console.log('\n── FINDINGS ──');
  for (const f of findings) console.log(`  • ${f}`);
  conn.close();
}

main().catch((err) => {
  console.error(`probe failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
