// probe-am4-place-compressor.ts — place a Compressor block in AM4 slot 1 so
// the knee_type / detector_type enum sweep has a LIVE, front-panel-visible
// target. The stored A01 chain is Drv/Amp/Dly/Rev (no compressor), and the
// AM4 returns compressor param registers even when the block is NOT placed
// (phantom-param gap), so a successful get_param does NOT prove placement —
// this verifies via getBlockLayoutSnapshot (actual slot read).
//
// Working-buffer only (unsaved). Reload A01 on the device to undo.
//
// Usage (AM4 connected, AM4-Edit closed):
//   npx tsx scripts/_research/probe-am4-place-compressor.ts [slot=1]

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildSetBlockType, BLOCK_TYPE_VALUES } from 'fractal-midi/am4';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const slot = Number(process.argv[2] ?? '1') as 1 | 2 | 3 | 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };

  console.log(`Placing Compressor (0x${BLOCK_TYPE_VALUES.compressor.toString(16)}) in slot ${slot}...`);
  conn.send(buildSetBlockType(slot, BLOCK_TYPE_VALUES.compressor));
  await sleep(600);

  try {
    const snap = await AM4_DESCRIPTOR.reader.getBlockLayoutSnapshot(ctx);
    const placed = [...snap.placedBlocks];
    console.log(`  placed blocks now: [${placed.join(', ')}]`);
    if (placed.includes('compressor')) {
      console.log('  ✓ Compressor is PLACED — it will appear in the device chain.');
    } else {
      console.log('  ✗ Compressor NOT in the layout snapshot — placement may have failed; retry or pick another slot.');
    }
  } catch (err) {
    console.log(`  layout read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  conn.close();
  console.log('\nOn the device: the chain should now show Cmp in that slot. Navigate to Compressor -> Knee Type, then tell me to sweep.');
  console.log('(To undo later: reload preset A1 on the device.)');
}

void main();
