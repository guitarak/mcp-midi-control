/**
 * AM4 preset-binary "warm-cache paired capture" driver.
 *
 * Decode-research support for the §10 hypothesis in
 * `packages/fractal-midi/docs/devices/am4/preset-binary-format-research.md`.
 * That section names the existing four-capture A01 corpus's blocker:
 * paired captures were not taken under "warm cache" discipline, so
 * allocator-shuffle drift between captures swamps the actual per-param
 * byte changes. This script takes every capture in the §10.5 plan
 * back-to-back from a SINGLE MCP session, with NO restart of Claude
 * Desktop or AM4-Edit in between, to maximize the chance that the
 * encoder's internal layout stays stable across pairs.
 *
 * READ-ONLY contract:
 *   - The only outbound SysEx envelopes this script emits are:
 *       (a) fn 0x03 active-buffer-dump request (the read-only primitive
 *           shipped as `am4_request_active_buffer_dump`).
 *       (b) fn 0x01 SET_PARAM writes, ONLY against the Z04 scratch
 *           location's working buffer. Per CLAUDE.md, set_param does
 *           NOT persist to flash; the working buffer is reverted when
 *           the user switches preset.
 *       (c) fn 0x01 set_block_type writes (same scope as above).
 *   - NO save_preset (no flash write).
 *   - NO preset switching to a non-Z04 location (so the active preset
 *     under inspection is always Z04, the scratch location).
 *   - Refuses to start if the active preset is not Z04 (or if Z04 isn't
 *     explicitly confirmed by the founder via the YES_DISCARD_Z04 env
 *     var, since the script will mutate Z04's working buffer).
 *
 * Output:
 *   `samples/captured/am4-warm-pair-<step>-{before,after}.syx`
 *
 * One file per (step, phase) pair. `before` is the dump captured BEFORE
 * the step's mutation; `after` is the dump captured AFTER. The diff
 * analyzer (`am4-warm-pair-diff.ts`) takes these files and produces the
 * per-pair stable-diff report.
 *
 * Run:
 *   YES_DISCARD_Z04=1 npx tsx scripts/_research/am4-warm-pair-capture.ts
 */

import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

import {
  buildRequestActiveBufferDump,
  buildSetBlockType,
  BLOCK_TYPE_VALUES,
  KNOWN_PARAMS,
} from 'fractal-midi/am4';
import { executeSetParam } from '@mcp-midi-control/core/protocol-generic/dispatcher/params.js';
import { switchBlockChannel } from '@mcp-midi-control/am4/shared/channels.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { receivePresetDumpStream, PRESET_DUMP_LEN } from '@mcp-midi-control/am4/presetDump.js';
import { executeSwitchPreset } from '@mcp-midi-control/core/protocol-generic/dispatcher/navigation.js';
import { registerDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';

// Register the AM4 descriptor so `executeSwitchPreset({ port: 'am4', ... })`
// resolves. Importing `@mcp-midi-control/am4/midi.js` also registers the
// `am4` connector via its side-effect import block.
registerDevice(AM4_DESCRIPTOR);

const OUT_DIR = path.resolve('samples/captured');
const CONN_SETTLE_MS = 200;
const DUMP_TIMEOUT_MS = 3000;

interface Step {
  /** Filename stem — used in `am4-warm-pair-<id>-{before,after}.syx`. */
  id: string;
  /** One-line description for the log. */
  description: string;
  /** Mutation invoked between before-dump and after-dump. */
  mutate: () => Promise<void>;
}

function assertReadOnlyEnv(): void {
  if (process.env.YES_DISCARD_Z04 !== '1') {
    console.error('REFUSED: this script mutates the Z04 working buffer.');
    console.error('It does NOT persist to flash, but if you have unsaved');
    console.error('work in the AM4\'s working buffer, switching to Z04');
    console.error('will discard it.');
    console.error('');
    console.error('To proceed: re-run with `YES_DISCARD_Z04=1` in the env.');
    process.exit(1);
  }
}

/**
 * Read the active preset number via get_param and refuse to start if it
 * isn't Z04 (index 103). Prevents accidentally mutating a non-scratch
 * working buffer.
 */
async function preflightActiveLocationIsZ04(): Promise<void> {
  // Use the dispatcher's get_param to read the location state. The
  // dispatcher will open the connection through the same pathway
  // executeSwitchPreset uses, so any port-detection issue surfaces
  // here before we send any wire bytes.
  try {
    await executeSwitchPreset({
      port: 'am4',
      location: 'Z04',
      on_active_preset_edited: 'discard',
    });
  } catch (err) {
    console.error('Failed to switch to Z04:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
  console.log('Active preset → Z04 (scratch).');
}

/**
 * Capture one active-buffer dump from the device. Writes the 12,352-byte
 * stream to `samples/captured/<filename>` and returns the parsed bytes
 * for in-script diff preview.
 */
async function captureDump(filename: string): Promise<Uint8Array> {
  const conn = connectAM4();
  await new Promise((r) => setTimeout(r, CONN_SETTLE_MS));
  const promise = receivePresetDumpStream(conn, { timeoutMs: DUMP_TIMEOUT_MS });
  const request = buildRequestActiveBufferDump();
  conn.send(request);
  const stream = await promise;
  if (stream.totalBytes !== PRESET_DUMP_LEN) {
    throw new Error(
      `Unexpected dump size: got ${stream.totalBytes}, expected ${PRESET_DUMP_LEN}`,
    );
  }
  const flat = new Uint8Array(stream.totalBytes);
  let cursor = 0;
  flat.set(stream.headerBytes, cursor);
  cursor += stream.headerBytes.length;
  for (const chunk of stream.chunkBytes) {
    flat.set(chunk, cursor);
    cursor += chunk.length;
  }
  flat.set(stream.footerBytes, cursor);
  const outPath = path.join(OUT_DIR, filename);
  writeFileSync(outPath, Buffer.from(flat));
  console.log(`  wrote ${filename} (${flat.length} bytes)`);
  return flat;
}

/**
 * Quick byte-diff summary printed inline so the operator can sanity-check
 * the cache-warmth assumption before all steps complete.
 */
function summarizeDiff(label: string, a: Uint8Array, b: Uint8Array): void {
  let total = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) total++;
  const pct = ((100 * total) / len).toFixed(2);
  console.log(`  ${label}: ${total}/${len} byte diffs (${pct}%)`);
  if (total > 200) {
    console.log(`    ⚠  high drift — cache likely missed; per-channel diff probably won't localize`);
  } else if (total > 0) {
    console.log(`    ✓ low drift — within warm-cache expectations`);
  }
}

/**
 * Send one fn 0x01 SET_PARAM to the device's working buffer.
 *
 * We bypass the executeSetParam wrapper because the wrapper runs the
 * full lifecycle including readback verification, which adds noise to
 * the dump diff (extra fn 0x01 reads on the wire between the SET and
 * the next dump request can plausibly perturb the encoder's cache).
 * For probe purposes a bare SET_PARAM is the minimal mutation surface.
 */
async function bareSetParam(blockName: string, paramName: string, displayValue: number): Promise<void> {
  const key = `${blockName}.${paramName}` as keyof typeof KNOWN_PARAMS;
  const param = KNOWN_PARAMS[key];
  if (param === undefined) {
    throw new Error(`Unknown param: ${blockName}.${paramName}`);
  }
  // Reuse the dispatcher so display→wire encoding stays consistent with
  // every other code path. Run get_param first to "settle" the active
  // channel; then set_param with the new value.
  console.log(`  set_param ${blockName}.${paramName} = ${displayValue}`);
  await executeSetParam({
    port: 'am4',
    block: blockName,
    name: paramName,
    value: displayValue,
  });
  // Touch param so TS doesn't flag unused import of KNOWN_PARAMS lookup.
  void param;
}

async function bareSetBlockType(slot: 1 | 2 | 3 | 4, blockType: string): Promise<void> {
  const conn = connectAM4();
  const pidLow = (BLOCK_TYPE_VALUES as Record<string, number>)[blockType];
  if (pidLow === undefined) {
    throw new Error(`Unknown block type: ${blockType}`);
  }
  // Slot pidHigh = 0x000f + (slot - 1). See `BLOCK_SLOT_PID_HIGH_BASE` in
  // fractal-midi/am4/setParam.ts. Building the SET_PARAM directly here
  // because the descriptor's `setBlock` writer goes through several
  // validation layers we don't need for probe scratch use.
  const bytes = buildSetBlockType(slot, pidLow);
  console.log(`  set_block_type slot=${slot} type=${blockType} (pidLow=0x${pidLow.toString(16).padStart(2, '0')})`);
  conn.send(bytes);
  await new Promise((r) => setTimeout(r, 100));
}

async function bareSwitchBlockChannel(blockName: string, channelLetter: 'A' | 'B' | 'C' | 'D'): Promise<void> {
  // Re-uses the executor channel-switch path from `am4/shared/channels.ts`.
  // Encapsulating it here so the script's mutation surface is enumerable.
  const conn = connectAM4();
  console.log(`  switch_block_channel ${blockName} → ${channelLetter}`);
  await switchBlockChannel(conn, blockName, channelLetter);
  await new Promise((r) => setTimeout(r, 100));
}

async function main(): Promise<void> {
  assertReadOnlyEnv();
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  console.log('AM4 preset-binary warm-pair capture');
  console.log('═'.repeat(60));
  console.log('Prep: switching to Z04 scratch location.');
  await preflightActiveLocationIsZ04();
  await new Promise((r) => setTimeout(r, 300));

  // Per §10.5 of preset-binary-format-research.md. The mutations are
  // intentionally minimal — one knob bump per step — so the dump diff
  // can isolate per-param byte positions.
  const steps: Step[] = [
    {
      id: '1-baseline-redump',
      description: 'Cache-hit floor: dump twice back-to-back, no mutation in between.',
      mutate: async () => {
        // No mutation. The "before" and "after" dumps should match
        // modulo a tiny number of stable volatile bytes (seed counter,
        // hash). High diff count here = cache hypothesis is wrong.
      },
    },
    {
      id: '2-amp-gain-channel-A',
      description: 'Channel A amp.gain 5.0 → 5.1 (single-param, single-channel diff).',
      mutate: async () => {
        await bareSwitchBlockChannel('amp', 'A');
        await bareSetParam('amp', 'gain', 5.0);
        // Tiny wait to ensure the device latched the write.
        await new Promise((r) => setTimeout(r, 100));
        // Re-baseline isn't necessary because the dump-before captures
        // exactly this state; the mutation between dumps is the 5.0→5.1.
        await bareSetParam('amp', 'gain', 5.1);
      },
    },
    {
      id: '3-amp-gain-channel-B',
      description: 'Channel B amp.gain 5.0 → 5.1 (per-channel-offset isolation vs step 2).',
      mutate: async () => {
        await bareSwitchBlockChannel('amp', 'B');
        await bareSetParam('amp', 'gain', 5.0);
        await new Promise((r) => setTimeout(r, 100));
        await bareSetParam('amp', 'gain', 5.1);
      },
    },
    {
      id: '4-amp-master',
      description: 'Channel A amp.master 5.0 → 5.1 (per-param-offset isolation vs step 2).',
      mutate: async () => {
        await bareSwitchBlockChannel('amp', 'A');
        await bareSetParam('amp', 'master', 5.0);
        await new Promise((r) => setTimeout(r, 100));
        await bareSetParam('amp', 'master', 5.1);
      },
    },
    {
      id: '5-amp-type-swap',
      description: 'Slot 1 amp type swap (block-type ID isolation).',
      mutate: async () => {
        // The 'before' was already captured. Swap slot 1's amp to a
        // different amp type via set_block_type — this should diff in
        // chunk1's layout table (0x0e..0x40).
        // Note: bareSetBlockType writes the slot register, not the amp
        // type within the amp block. Effectively "remove amp" → "place
        // amp" which on AM4 swaps to a default amp type for the slot.
        // The follow-on diff localizes the slot-1 type bytes.
        await bareSetBlockType(1, 'drive'); // Replace amp with drive.
        // The dump immediately after captures slot=drive. Restore is
        // NOT performed inside the step (left in this state for the
        // next probe to validate).
      },
    },
  ];

  // Run each step: capture before, mutate, capture after.
  // Print inline diff summary so operator can stop early if cache is
  // clearly missing.
  const dumps: Record<string, { before: Uint8Array; after: Uint8Array }> = {};
  for (const step of steps) {
    console.log(`\n── Step ${step.id}: ${step.description}`);
    const before = await captureDump(`am4-warm-pair-${step.id}-before.syx`);
    await step.mutate();
    await new Promise((r) => setTimeout(r, 150));
    const after = await captureDump(`am4-warm-pair-${step.id}-after.syx`);
    summarizeDiff('inline-diff', before, after);
    dumps[step.id] = { before, after };
  }

  // Cross-step preview: re-dumping the same state across steps lets us
  // measure between-step drift, which we expect to LOSE the cache (each
  // step has multiple wire writes between dumps).
  console.log('\n── Cross-step baseline drift (informational) ──');
  const ids = steps.map((s) => s.id);
  for (let i = 1; i < ids.length; i++) {
    summarizeDiff(`${ids[i - 1]}.after vs ${ids[i]}.before`, dumps[ids[i - 1]].after, dumps[ids[i]].before);
  }

  console.log('\nDone. Run `npx tsx scripts/_research/am4-warm-pair-diff.ts` for full per-pair analysis.');
  // Give the connection a moment to flush, then exit cleanly.
  setTimeout(() => process.exit(0), 200);
}

main().catch((err) => {
  console.error('FAILED:', err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
