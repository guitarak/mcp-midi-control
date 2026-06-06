// verify-am4-channel-color-apply.ts
//
// Gated test: AM4 channel LED color via apply_preset.
//
// apply_preset's amp slot accepts a per-channel `color` (or `led_color`)
// key inside its channel map and routes it to the letter-specific param
// amp.channel_<a|b|c|d>_color, so a whole preset including footswitch
// colors applies in ONE tool call instead of a trailing set_params.
// Added 2026-06-06 after dev-laptop testing
// (docs/_private/0.2.0-dev-test-2026-06-06.md): the agent had to make a
// separate set_params call for colors because it could not route them
// through apply_preset.
//
// This is an offline op-emission check: build the prepared write list and
// assert the color keys resolved to the correct letter-specific color
// params, and that `color` on a non-amp block is rejected.
//
// Run: npx tsx scripts/verify-am4-channel-color-apply.ts

import {
  prepareApplyPresetWrites,
  type ApplyPresetPreparedWrite,
} from '@mcp-midi-control/am4/tools/applyExecutor.js';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

type ParamWrite = Extract<ApplyPresetPreparedWrite, { kind: 'param' }>;

// ── Build an amp slot with per-channel colors alongside audio params ────
const { prepared } = prepareApplyPresetWrites({
  slots: [
    {
      position: 2,
      block_type: 'amp',
      channels: {
        A: { type: 'Shiver Clean', gain: 3, color: 'Purple' },
        B: { type: 'Friedman BE', gain: 6, led_color: 'Green' },
        C: { type: 'Brit 800 2203 High', gain: 7 },
      },
    },
  ],
});

const paramOps = prepared.filter((p): p is ParamWrite => p.kind === 'param');

function colorOp(key: string): ParamWrite | undefined {
  return paramOps.find((p) => p.key === key);
}

const aColor = colorOp('amp.channel_a_color');
const bColor = colorOp('amp.channel_b_color');

check(
  'channel A `color: "Purple"` routed to amp.channel_a_color (wire 6)',
  aColor !== undefined && /Purple/.test(aColor.display) && aColor.resolved === 6,
  `op=${JSON.stringify(aColor && { key: aColor.key, display: aColor.display, resolved: aColor.resolved })}`,
);
check(
  'channel B `led_color: "Green"` routed to amp.channel_b_color (wire 3)',
  bColor !== undefined && /Green/.test(bColor.display) && bColor.resolved === 3,
  `op=${JSON.stringify(bColor && { key: bColor.key, display: bColor.display, resolved: bColor.resolved })}`,
);
check(
  'channel C (no color key) emits NO color write',
  colorOp('amp.channel_c_color') === undefined,
  `unexpected channel_c_color op`,
);
check(
  'the amp audio params (type/gain) still emit alongside colors',
  paramOps.some((p) => p.key === 'amp.gain') && paramOps.some((p) => p.key === 'amp.type'),
  `keys=${paramOps.map((p) => p.key).join(', ')}`,
);

// ── color on a non-amp block must be rejected ──────────────────────────
let threw = false;
try {
  prepareApplyPresetWrites({
    slots: [
      {
        position: 3,
        block_type: 'delay',
        channels: { A: { type: 'Digital Stereo', color: 'Blue' } },
      },
    ],
  });
} catch (err) {
  threw = /color/i.test(err instanceof Error ? err.message : String(err));
}
check('`color` on a non-amp block throws a helpful error', threw);

if (failures === 0) {
  console.log('\nverify-am4-channel-color-apply: all assertions passed.');
  process.exit(0);
}
console.error(`\nverify-am4-channel-color-apply: ${failures} failure(s).`);
process.exit(1);
