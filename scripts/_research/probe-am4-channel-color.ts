// probe-am4-channel-color.ts — discover the wire-index -> LED color mapping
// for the AM4's per-amp-channel color params (amp.channel_a_color .. _d_color).
//
// WHAT TO DO:
//   1. Put the AM4 into AMP MODE (footswitch 1 selects channel A).
//      You should see a colored LED under each footswitch.
//   2. Run this script.
//   3. When each line prints "set index N -> OBSERVE", look at the
//      CHANNEL A footswitch LED and report the color you see.
//   4. When the color stops changing (same as a prior index), you've found the
//      end of the table.
//
// SELF-RESTORING: reads the current value first, restores at the end.
// Safe to interrupt — reload preset A01 if needed.
//
// Usage:
//   npx tsx scripts/_research/probe-am4-channel-color.ts
//
// Optional args:
//   --max N        sweep 0..N (default 9)
//   --step-ms N    dwell per step in ms (default 3000)
//   --channel B    which color param to sweep: a|b|c|d (default a)

import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildSetParam, KNOWN_PARAMS } from 'fractal-midi/am4';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const args = process.argv.slice(2);
function flag(name: string, def: string): string {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] !== undefined ? args[i + 1] : def;
}
const MAX_INDEX = parseInt(flag('--max', '9'), 10);
const STEP_MS   = parseInt(flag('--step-ms', '3000'), 10);
const CH        = flag('--channel', 'a').toLowerCase();

const KEYS: Record<string, string> = {
  a: 'amp.channel_a_color',
  b: 'amp.channel_b_color',
  c: 'amp.channel_c_color',
  d: 'amp.channel_d_color',
};
const key = KEYS[CH];
if (!key) {
  console.error(`--channel must be a|b|c|d, got: ${CH}`);
  process.exit(1);
}
const [block, name] = key.split('.');
const LEAD_IN_MS = 5000;

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx: DispatchCtx = { conn, descriptor: AM4_DESCRIPTOR };

  // Try to read the current value so we can restore it. PATCH reads may not
  // return the actual value — that's fine, we'll restore to 0 as fallback.
  let original = 0;
  try {
    const r = await AM4_DESCRIPTOR.reader.getParam(ctx, block, name);
    if (typeof r.display_value === 'number') original = Math.round(r.display_value);
    console.log(`Current channel_${CH}_color (read): ${original}`);
  } catch (err) {
    console.log(`Read of current color failed (PATCH reads may be unsupported): ${err instanceof Error ? err.message : err}`);
    console.log('Will restore to index 0 at the end.');
  }

  console.log(`\n=== AM4 channel ${CH.toUpperCase()} LED color sweep ===`);
  console.log('Switch AM4 to AMP MODE now — watch the footswitch LED for channel', CH.toUpperCase() + '.');
  console.log('Each index will be held for', STEP_MS / 1000, 'seconds.');
  console.log(`Starting sweep (index 0..${MAX_INDEX}) in ${LEAD_IN_MS / 1000}s...\n`);
  await sleep(LEAD_IN_MS);

  for (let i = 0; i <= MAX_INDEX; i++) {
    const bytes = buildSetParam(key as keyof typeof KNOWN_PARAMS, i);
    conn.send(bytes);
    process.stdout.write(`  index ${String(i).padStart(2)}  ->  OBSERVE the LED (${STEP_MS / 1000}s)...  `);
    await sleep(STEP_MS);
    process.stdout.write('DONE\n');
  }

  // Restore
  conn.send(buildSetParam(key as keyof typeof KNOWN_PARAMS, original));
  console.log(`\nRestored channel_${CH}_color to index ${original}.`);
  console.log('\n--- REPORT THE COLOR YOU SAW AT EACH INDEX ---');
  console.log('Format: 0=Red, 1=Orange, 2=Yellow, 3=Green, ...');
  conn.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
