// probe-am4-amp-enum-channelB.ts — verify AM4 amp enum table ORDER against
// the AM4-Edit channel-B dropdown the founder screenshotted (FW 2.00).
//
// The active-channel read was confounded (editor was VIEWING channel B, but
// get_param read the active scene's channel). Reading channel B explicitly
// should return the index of what the editor showed on B:
//   preamp_tube_type → 6 (ECC83)      in_eq_type    → 2 (Peaking)
//   geq_type         → ? (8 Band Var Q)  compressor_type → ? (Output)
// The last two have EXISTING (suspect) tables; this read reveals the true
// wire index of the editor-shown value, disambiguating display-order vs
// wire-order.
//
// INVASIVE: get_param(channel:'B') switches the amp to channel B and does NOT
// restore. After running, reload the preset (or switch scene) to restore the
// active channel. Founder said "probe as needed"; AM4 is connected.
//
// Run: npx tsx scripts/_research/probe-am4-amp-enum-channelB.ts

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const AMP_ENUMS = ['preamp_tube_type', 'in_eq_type', 'geq_type', 'compressor_type'];

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };
  console.log('AM4 amp enum read on CHANNEL B (matches the editor screenshots):\n');
  for (const name of AMP_ENUMS) {
    try {
      const r = await AM4_DESCRIPTOR.reader.getParam(ctx, 'amp', name, 'B');
      console.log(`  amp.${name} [B]: wire=${r.wire_value} display=${JSON.stringify(r.display_value)}`);
    } catch (err) {
      console.log(`  amp.${name} [B]: read failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  conn.close();
  console.log('\nExpected if dropdown order == wire index: preamp_tube_type=6 (ECC83), in_eq_type=2 (Peaking).');
  console.log('geq_type / compressor_type: compare the returned index to the editor value (8 Band Var Q / Output).');
  console.log('NOTE: amp is now left on channel B — reload the preset / switch scene to restore the active channel.');
}

void main();
