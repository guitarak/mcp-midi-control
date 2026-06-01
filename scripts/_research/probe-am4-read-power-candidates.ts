// probe-am4-read-power-candidates.ts — disambiguate which internal param drives
// the device's "Power Tube Type" dropdown. Reads the candidate Power-Amp params
// (amp.power_type 0x005d = editor "Power Type"; amp.tubes 0x0095 = editor
// "Tubes"/possibly "Power Tube Type"). Run once for a baseline, have the operator
// nudge "Power Tube Type" one click on the DEVICE, run again — whichever value
// CHANGED is the param behind "Power Tube Type".
//
// Read-only. Usage: npx tsx scripts/_research/probe-am4-read-power-candidates.ts

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const CANDIDATES = ['tubes', 'hardness', 'grid_bias'];

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };
  console.log('Power-Amp candidate reads (nudge "Power Tube Type" between runs; the one that CHANGES is it):\n');
  for (const name of CANDIDATES) {
    try {
      const r = await AM4_DESCRIPTOR.reader.getParam(ctx, 'amp', name);
      console.log(`  amp.${name}: wire=${r.wire_value} display=${JSON.stringify(r.display_value)} unit=${r.unit}`);
    } catch (err) {
      console.log(`  amp.${name}: read failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  conn.close();
}

void main();
