/**
 * AM4 channel-blocked ORIENTATION probe (READ-ONLY).
 *
 * Confirmed already: the AM4 fn=0x1F dump is channel-blocked ×4
 * (probe-am4-channel-blocked.ts). Open question: is quarter 0 always channel A
 * (FIXED order A/B/C/D), or is quarter 0 the ACTIVE channel (sliding)? This gates
 * whether get_preset can attribute all four quarters as A/B/C/D directly.
 *
 * Method (no writes, no channel switches — reads the CURRENT active channel):
 *   1. Read the amp block's active channel via the channel-aware reader.
 *   2. Read several amp tone knobs via the channel-aware reader (= active channel).
 *   3. Raw fn=0x1F poll the amp tone chunk (effectId 58 = pidLow 0x3a), decode the
 *      four channel quarters (stride = itemCount/4) at each knob's pidHigh.
 *   4. For each knob, find which quarter matches the active-channel reading.
 *   If every knob's match lands on quarter == active-channel-index → FIXED A/B/C/D
 *   order (quarter 0 = A). If every match lands on quarter 0 → quarter 0 = ACTIVE.
 *
 * Definitive when the active channel is NOT A. If active == A, the result is
 * consistent with both models (re-run after selecting B/C/D on the front panel).
 *
 * Prereq: AM4 connected, AM4-Edit closed, port free.
 * Run: npx tsx scripts/_research/probe-am4-channel-orientation.ts
 */
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import type { DispatchCtx } from '@mcp-midi-control/core/protocol-generic/types.js';

const AM4_MODEL = 0x15;
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FN_GET_ALL_PARAMS = 0x1f;
// Reverb (eff 66) instead of amp: the amp channel SELECTOR decode is broken
// (returns a raw wire, not a letter), but reverb's channel reads correctly, and
// reverb.mix (pidHigh 1) has all-four-distinct quarters in this preset.
const BLOCK = 'reverb';
const AMP_TONE_EFFECTID = 66; // pidLow 0x42 (reverb chunk)

const KNOBS: Array<{ name: string; pidHigh: number }> = [
  { name: 'mix', pidHigh: 1 }, { name: 'balance', pidHigh: 2 },
  { name: 'time', pidHigh: 11 }, { name: 'size', pidHigh: 15 },
  { name: 'early_level', pidHigh: 17 }, { name: 'late_level', pidHigh: 18 },
];
const CH_INDEX: Record<string, number> = { A: 0, B: 1, C: 2, D: 3 };

function fractalChecksum(b: number[]): number { return b.reduce((a, x) => a ^ x, 0) & 0x7f; }
function enc14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
function dec14(lo: number, hi: number): number { return (lo & 0x7f) | ((hi & 0x7f) << 7); }
function unpack16(b0: number, b1: number, b2: number): number {
  return (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}
function buildPoll(effectId: number): number[] {
  const head = [SYSEX_START, 0x00, 0x01, 0x74, AM4_MODEL, FN_GET_ALL_PARAMS, ...enc14(effectId)];
  return [...head, fractalChecksum(head), SYSEX_END];
}

/** Send a raw fn=0x1F poll on the production connection, collect the burst. */
function rawPoll(conn: DispatchCtx['conn'], effectId: number, ms = 400): Promise<{ itemCount: number; values: number[] }> {
  return new Promise((resolve) => {
    const frames: number[][] = [];
    const unsub = conn.onMessage((bytes) => { frames.push([...bytes]); });
    conn.send(buildPoll(effectId));
    setTimeout(() => {
      unsub?.();
      const ours = frames.filter((b) => b.length >= 7 && b[0] === 0xf0 && b[4] === AM4_MODEL);
      const head = ours.find((b) => b[5] === 0x74);
      const values: number[] = [];
      for (const b of ours) {
        if (b[5] !== 0x75) continue;
        for (let i = 8; i + 3 <= b.length - 2; i += 3) values.push(unpack16(b[i], b[i + 1], b[i + 2]));
      }
      resolve({ itemCount: head ? dec14(head[8], head[9]) : 0, values });
    }, ms);
  });
}

async function main(): Promise<void> {
  const conn = connectAM4();
  const ctx = { conn, descriptor: AM4_DESCRIPTOR } as unknown as DispatchCtx;
  const reader = AM4_DESCRIPTOR.reader;
  if (reader.getParam === undefined) throw new Error('AM4 reader has no getParam');

  // 1. Active channel of the amp block.
  const chRead = await reader.getParam(ctx, BLOCK, 'channel');
  const chDisp = String(chRead.display_value).trim().toUpperCase();
  const activeIdx = CH_INDEX[chDisp];
  console.log(`Active amp channel: ${chRead.display_value} (index ${activeIdx ?? '?'})`);

  // 2. Active-channel readings for each knob (channel-aware fn=0x02 GET).
  const active: Record<string, number> = {};
  for (const k of KNOBS) {
    try { active[k.name] = Number((await reader.getParam(ctx, BLOCK, k.name)).wire_value); }
    catch { /* skip knobs not exposed on the active amp type */ }
  }

  // 3. Raw fn=0x1F dump for the amp tone chunk.
  const dump = await rawPoll(conn, AMP_TONE_EFFECTID);
  conn.close?.();
  if (dump.itemCount === 0 || dump.values.length === 0) {
    console.log('No amp dump returned — is the amp placed? Try a preset with an Amp block.');
    return;
  }
  const stride = dump.itemCount / 4;
  console.log(`Amp tone dump: itemCount=${dump.itemCount} stride=${stride} (FM9 amp stride=147; AM4≠FM9 confirms per-device param counts)\n`);

  // 4. For each knob, find which quarter matches the active-channel reading.
  console.log('knob      activeWire   quarters A/B/C/D (wire)            matchQuarter');
  const matches: number[] = [];
  for (const k of KNOBS) {
    if (active[k.name] === undefined || k.pidHigh >= stride) continue;
    const q = [0, 1, 2, 3].map((c) => dump.values[c * stride + k.pidHigh]);
    // active reading is asInternalFloat ([0,1]); quarters are u16 — compare in [0,1].
    const target = active[k.name];
    const matchIdx = q.map((v) => Math.abs(v / 65534 - target)).reduce((best, d, i, arr) => (d < arr[best] ? i : best), 0);
    matches.push(matchIdx);
    console.log(
      k.name.padEnd(9), String(target.toFixed(4)).padEnd(12), q.join('/').padEnd(33),
      `quarter ${matchIdx}${q.every((v) => v === q[0]) ? ' (all equal — uninformative)' : ''}`,
    );
  }

  // 5. Verdict.
  const informative = matches.length > 0;
  const allMatchActive = informative && activeIdx !== undefined && matches.every((m) => m === activeIdx);
  const allMatchZero = informative && matches.every((m) => m === 0);
  console.log('\n── Verdict ──');
  if (!informative) {
    console.log('No informative knobs (amp not placed, or all quarters equal). Re-run with a preset whose amp varies per channel.');
  } else if (activeIdx === 0) {
    console.log(`Active channel is A — matches landed on quarter ${[...new Set(matches)].join('/')}. Consistent with quarter-0=A but NOT disambiguating (select B/C/D on the panel and re-run).`);
  } else if (allMatchActive) {
    console.log(`✅ FIXED ORDER A/B/C/D: every knob's active-channel value sits at quarter ${activeIdx} = the active channel index. Quarter 0 = A. get_preset can attribute all four quarters directly.`);
  } else if (allMatchZero) {
    console.log('🔸 SLIDING: active-channel value sits at quarter 0 regardless of active channel index. Quarter 0 = ACTIVE channel, not A. get_preset must resolve the active channel to attribute the others.');
  } else {
    console.log(`Mixed matches ${JSON.stringify(matches)} (active index ${activeIdx}). Inspect the per-knob table above.`);
  }
}

main().catch((err) => { console.error('Probe failed:', err); process.exitCode = 1; });
