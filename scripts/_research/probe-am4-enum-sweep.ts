// probe-am4-enum-sweep.ts — collaborative wire-index -> label sweep for an
// AM4 enum param (HW-127). AM4 echoes no label over MIDI, so this sets each
// wire index on the device and the HUMAN reads the resulting label off the
// DEVICE FRONT PANEL (ground truth), in order. That yields the wire-ordered
// enum table the dropdown display order and the binary both fail to give.
//
// Uses the codec buildSetParam directly: for unit:'enum' the codec encode() is
// identity (returns the index), so it writes a raw index even though the param
// currently has empty enumValues (the descriptor encoder would reject it).
//
// SELF-RESTORING: reads the current index first, sweeps 0..MAX, restores it.
// Mutates the working buffer transiently (unsaved); reload the preset if it
// is interrupted mid-sweep.
//
// Usage (AM4 connected, AM4-Edit CLOSED so the server owns the port):
//   npx tsx scripts/_research/probe-am4-enum-sweep.ts compressor.knee_type
//
// The operator must navigate the DEVICE front panel to the param's page
// (e.g. Compressor -> Config -> Knee Type) and watch it change each step.

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildSetParam, KNOWN_PARAMS } from 'fractal-midi/am4';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const MAX_INDEX = 11;          // sweep 0..11 (covers all known tables + clamp)
const STEP_MS = 2500;          // dwell so the operator can read each label
const LEAD_IN_MS = 4000;       // grace period after launch to get on the page

const key = process.argv[2];
if (!key || !(key in KNOWN_PARAMS)) {
  console.error(`Pass a valid AM4 param key. Got: ${JSON.stringify(key)}`);
  console.error('e.g. compressor.knee_type | compressor.detector_type | amp.preamp_tube_type | amp.in_eq_type');
  process.exit(1);
}
const [block, name] = key.split('.');

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };

  // Read current index to restore at the end.
  let original = 0;
  try {
    const r = await AM4_DESCRIPTOR.reader.getParam(ctx, block, name);
    original = typeof r.display_value === 'number' ? r.display_value : 0;
  } catch (err) {
    console.error(`Could not read current ${key} (block placed + active?): ${err instanceof Error ? err.message : String(err)}`);
    conn.close();
    process.exit(1);
  }

  console.log(`\n=== Sweeping ${key} (current index ${original}) ===`);
  console.log(`Watch the DEVICE front panel page for "${name}" and note the label at each step.`);
  console.log(`Starting in ${LEAD_IN_MS / 1000}s... get on the page now.\n`);
  await sleep(LEAD_IN_MS);
  for (let i = 0; i <= MAX_INDEX; i++) {
    conn.send(buildSetParam(key as keyof typeof KNOWN_PARAMS, i));
    // Read back to see where the device clamps (readback stops rising). NOTE:
    // clamp-on-MIDI-set is NOT universal — knee/detector/preamp_tube/in_eq DO
    // clamp, but amp.eq_location does NOT (the device stores out-of-range
    // values), so for those the human's knob-rotation read is the authoritative
    // table size, not this clamp.
    let readback = i;
    try {
      const rb = await AM4_DESCRIPTOR.reader.getParam(ctx, block, name);
      readback = typeof rb.display_value === 'number' ? rb.display_value : i;
    } catch { /* ignore */ }
    const clamp = readback !== i ? `  (device clamped -> ${readback}; table likely ends at ${readback})` : '';
    console.log(`  set index ${String(i).padStart(2)}  -> readback ${readback}${clamp}   <-- read the label now`);
    await sleep(STEP_MS);
  }

  // Restore.
  conn.send(buildSetParam(key as keyof typeof KNOWN_PARAMS, original));
  console.log(`\nRestored ${key} to index ${original}.`);
  console.log('Report the labels you saw, in index order (0,1,2,...), and where it stopped changing.');
  conn.close();
}

void main();
