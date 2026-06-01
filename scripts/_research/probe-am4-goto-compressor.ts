// probe-am4-goto-compressor.ts — navigate the AM4 to a preset with a
// compressor block so the knee_type / detector_type enum sweep has a live
// target. Switches to A01 (CCRL, which carries the compressor per the alpha.17
// session), then confirms by reading knee_type back (a successful read = the
// block is placed). Reports the current index so the sweep can restore it.
//
// Usage (AM4 connected, AM4-Edit closed):
//   npx tsx scripts/_research/probe-am4-goto-compressor.ts [A01]

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildSwitchPreset, parseLocationCode, formatLocationCode } from 'fractal-midi/am4';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const code = (process.argv[2] ?? 'A01').toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const idx = parseLocationCode(code);
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };

  console.log(`Switching AM4 to ${formatLocationCode(idx)} (index ${idx})...`);
  conn.send(buildSwitchPreset(idx));
  await sleep(700); // let the preset load

  for (const name of ['knee_type', 'detector_type']) {
    try {
      const r = await AM4_DESCRIPTOR.reader.getParam(ctx, 'compressor', name);
      console.log(`  compressor.${name}: current index ${r.display_value} (block is PLACED — sweep target ready)`);
    } catch (err) {
      console.log(`  compressor.${name}: read failed — ${err instanceof Error ? err.message : String(err)}`);
      console.log('  => the compressor may not be placed on this preset; pick another or place one.');
    }
  }
  conn.close();
  console.log('\nIf the reads succeeded, navigate the DEVICE front panel to Compressor -> Knee Type, then tell me to run the sweep.');
}

void main();
