// probe-am4-enum-typefix.ts — READ-ONLY hardware confirmation for the
// alpha.17 AM4 enum-as-float fix (HW-127, first half).
//
// Reads the four params that were mis-registered unit:'count' (now flipped
// to unit:'enum') and prints what get_param returns. Expectation AFTER the
// fix: display_value is a small INTEGER index (e.g. 0/1/2), unit:'enum' —
// NOT the old ~0.00193 fraction. This validates the unit-flip on real
// hardware. It does NOT mutate anything (no set_param), so it's safe to run
// alongside the live MCP server (the AM4 port binds lazily per call).
//
// Run (AM4 connected, a preset with compressor + amp placed loaded):
//   npx tsx scripts/_research/probe-am4-enum-typefix.ts
//
// Labels are a SEPARATE collaborative step: AM4 does not echo an ASCII label
// over MIDI (get_param returns the raw index), so index->label capture needs
// the founder to read the front-panel / AM4-Edit dropdown while indices are
// swept. This probe only confirms the type-flip + reports the current index.

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const TARGETS: Array<{ block: string; name: string }> = [
  { block: 'compressor', name: 'knee_type' },
  { block: 'compressor', name: 'detector_type' },
  { block: 'amp', name: 'preamp_tube_type' },
  { block: 'amp', name: 'in_eq_type' },
  // power_type is the suspected same-class param, still unit:'count' — read it
  // too so we can see whether it also looks like a small index (fraction = still count).
  { block: 'amp', name: 'power_type' },
];

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };
  console.log('AM4 enum type-fix confirmation (read-only):\n');
  for (const t of TARGETS) {
    try {
      const r = await AM4_DESCRIPTOR.reader.getParam(ctx, t.block, t.name);
      const verdict = r.unit === 'enum'
        ? (typeof r.display_value === 'number' && Number.isInteger(r.display_value)
            ? 'OK enum→integer index (fix working)'
            : `enum but display=${JSON.stringify(r.display_value)}`)
        : (typeof r.display_value === 'number' && r.display_value < 1 && r.display_value > 0
            ? 'STILL FRACTION (count bug) — not flipped'
            : `unit=${r.unit} display=${JSON.stringify(r.display_value)}`);
      console.log(`  ${t.block}.${t.name}: wire=${r.wire_value} display=${JSON.stringify(r.display_value)} unit=${r.unit}  → ${verdict}`);
    } catch (err) {
      console.log(`  ${t.block}.${t.name}: read failed — ${err instanceof Error ? err.message : String(err)} (block likely not placed on the active preset)`);
    }
  }
  conn.close();
  console.log('\nNote: AM4 does not echo enum labels over MIDI; index→label capture is the collaborative front-panel sweep (HW-127).');
}

void main();
