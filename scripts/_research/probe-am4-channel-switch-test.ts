/**
 * AM4 channel-blocked ORIENTATION — controlled-switch test (REVERSIBLE).
 *
 * Settles "fixed A/B/C/D" vs "sliding (quarter 0 = active)": poll the reverb dump,
 * switch the reverb block to channel B (via the channel-aware reader's pre-read
 * switch), poll again, compare, then restore to A.
 *   - FIXED order  → quarters UNCHANGED (dump always reports A/B/C/D in place).
 *   - SLIDING      → quarters REORDER (quarter 0 becomes B's value).
 * Reversible: restores channel A at the end. Does not save.
 */
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const AM4_MODEL = 0x15, REVERB_EFF = 66, MIX_PIDHIGH = 1;
const cks = (b: number[]): number => b.reduce((a, x) => a ^ x, 0) & 0x7f;
const enc14 = (n: number): number[] => [n & 0x7f, (n >> 7) & 0x7f];
const dec14 = (lo: number, hi: number): number => (lo & 0x7f) | ((hi & 0x7f) << 7);
const unpack = (a: number, b: number, c: number): number => (a & 0x7f) | ((b & 0x7f) << 7) | ((c & 0x03) << 14);

function poll(conn: DispatchCtx['conn'], ms = 400): Promise<number[]> {
  return new Promise((resolve) => {
    const frames: number[][] = [];
    const unsub = conn.onMessage((by) => frames.push([...by]));
    const head = [0xf0, 0x00, 0x01, 0x74, AM4_MODEL, 0x1f, ...enc14(REVERB_EFF)];
    conn.send([...head, cks(head), 0xf7]);
    setTimeout(() => {
      unsub?.();
      const vals: number[] = [];
      for (const b of frames.filter((f) => f[4] === AM4_MODEL && f[5] === 0x75)) {
        for (let i = 8; i + 3 <= b.length - 2; i += 3) vals.push(unpack(b[i], b[i + 1], b[i + 2]));
      }
      resolve(vals);
    }, ms);
  });
}
const quarters = (vals: number[]): number[] => {
  const stride = vals.length / 4;
  return [0, 1, 2, 3].map((c) => vals[c * stride + MIX_PIDHIGH]);
};

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx = { conn, descriptor: AM4_DESCRIPTOR } as unknown as DispatchCtx;
  const reader = AM4_DESCRIPTOR.reader!;

  const before = quarters(await poll(conn));
  console.log(`reverb.mix quarters BEFORE (active A): ${before.join(' / ')}`);

  // Switch reverb to channel B (reader's channel arg triggers a pre-read switch).
  await reader.getParam(ctx, 'reverb', 'mix', 'B');
  const afterB = quarters(await poll(conn));
  console.log(`reverb.mix quarters AFTER switch to B:  ${afterB.join(' / ')}`);

  // Restore to A.
  await reader.getParam(ctx, 'reverb', 'mix', 'A');
  const restored = quarters(await poll(conn));
  console.log(`reverb.mix quarters AFTER restore to A: ${restored.join(' / ')}`);
  conn.close?.();

  const unchanged = before.every((v, i) => v === afterB[i]);
  console.log('\n── Verdict ──');
  if (unchanged) {
    console.log('✅ FIXED ORDER A/B/C/D: switching the active channel did NOT move the quarters. The dump always reports all four channels in fixed A/B/C/D order; quarter 0 = A. get_preset can attribute quarters directly as A/B/C/D.');
  } else {
    console.log('🔸 SLIDING: switching channels REORDERED the quarters. Quarter 0 follows the active channel. get_preset must read the active-channel selector to attribute the others.');
    console.log(`   (before B=${before[1]}; after, quarter0=${afterB[0]} — if that equals before's B, quarter 0 slid to the active channel.)`);
  }
}
main().catch((e) => { console.error('failed:', e); process.exitCode = 1; });
