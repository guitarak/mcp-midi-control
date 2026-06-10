/**
 * AM4 miscellaneous open-items probe. Two independent experiments:
 *
 * (a) DOUBLE-DUMP DETERMINISM. Request the active-buffer preset dump
 *     (fn 0x03 -> 0x77/0x78/0x79 stream, 6 messages, ~12,352 bytes)
 *     twice back to back with no edits in between, byte-diff the two
 *     streams, and report count + offsets (with frame attribution) of
 *     every differing byte. Closes the "AM4 dump encoder is
 *     non-deterministic" open item with quantified evidence (today the
 *     claim lives as an unquantified comment in
 *     packages/am4/src/descriptor/reader.ts dumpActivePresetBinary).
 *     Read-only: a dump request mutates nothing.
 *
 * (b) 0x0E-vs-0x0D BYPASS READ. For one PLACED block (never amp: on the
 *     AMP block pidHigh 0x0003 is the BOOST register, not bypass):
 *       1. read bypass via 0x0D long form (live state, decoded) and via
 *          0x0E short form (documented as static, SYSEX-MAP 6a),
 *       2. toggle bypass via the hardware-verified buildSetBlockBypass
 *          write path,
 *       3. re-read BOTH forms and compare (does 0x0E track now?),
 *       4. toggle back, verify restore via 0x0D.
 *     Self-restoring; one audible bypass blip (~0.5 s) on the chosen
 *     block. Also dumps the full 64-byte 0x0D frames for both states
 *     with differing offsets, feeding the 40-byte-descriptor decode.
 *
 * Safety: NO save frames, NO preset/scene/bank switches, NO location
 * writes. The only mutation is one block-bypass toggle, restored and
 * verified. Abort path restores the bypass before exiting.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-misc-opens.ts                 # both experiments
 *   npx tsx scripts/_research/probe-am4-misc-opens.ts --skip-bypass   # dump determinism only (zero writes)
 *   npx tsx scripts/_research/probe-am4-misc-opens.ts --port "am4"    # port override
 *
 * Prereqs: AM4 on + USB connected, AM4-Edit CLOSED.
 *
 * # Output
 *
 *   samples/captured/probe-am4-misc-opens-findings.md
 *   samples/captured/probe-am4-misc-opens-results.json
 *   samples/captured/probe-am4-misc-opens-dump{1,2}.syx
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import { connect, type MidiConnection } from '../../packages/core/src/midi/transport.js';
import {
  AM4_MODEL_ID,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  buildReadParam,
  buildRequestActiveBufferDump,
  buildSetBlockBypass,
  isReadResponse,
  isReadResponseLong,
  isWriteEcho,
  parseLongReadBypassFlag,
  parseReadResponse,
  READ_TYPE_LONG,
  type ParamId,
} from '../../packages/fractal-midi/src/am4/setParam.js';
import {
  BLOCK_NAMES_BY_VALUE,
  BLOCK_TYPE_VALUES,
  type BlockTypeName,
} from '../../packages/fractal-midi/src/am4/blockTypes.js';

const READ_TIMEOUT_MS = 300;
const WRITE_ACK_TIMEOUT_MS = 300;
const RATE_LIMIT_MS = 60;
const DUMP_TIMEOUT_MS = 4000;
const DEFAULT_NEEDLES = ['am4'] as const;
const OUT_DIR = 'samples/captured';
const OUT_BASE = 'probe-am4-misc-opens';
const BYPASS_PID_HIGH = 0x0003;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

async function readShortU32(conn: MidiConnection, pid: ParamId): Promise<number> {
  const req = buildReadParam(pid);
  const respPromise = conn.receiveSysExMatching((resp) => isReadResponse(req, resp), READ_TIMEOUT_MS);
  conn.send(req);
  const resp = await respPromise;
  await sleep(RATE_LIMIT_MS);
  return parseReadResponse(resp).asUInt32LE();
}

async function readLongFrame(conn: MidiConnection, pid: ParamId): Promise<number[]> {
  const req = buildReadParam(pid, READ_TYPE_LONG);
  const respPromise = conn.receiveSysExMatching((resp) => isReadResponseLong(req, resp), READ_TIMEOUT_MS);
  conn.send(req);
  const resp = await respPromise;
  await sleep(RATE_LIMIT_MS);
  return resp;
}

// ── (a) Double dump ──────────────────────────────────────────────────

interface DumpStream {
  frames: number[][];
  flat: number[];
  fnCounts: Record<string, number>;
  durationMs: number;
}

function isAm4Fn(bytes: number[], fns: readonly number[]): boolean {
  return (
    bytes.length >= 7 && bytes[0] === 0xf0 &&
    bytes[1] === 0x00 && bytes[2] === 0x01 && bytes[3] === 0x74 &&
    bytes[4] === AM4_MODEL_ID && fns.includes(bytes[5])
  );
}

async function collectDump(conn: MidiConnection): Promise<DumpStream> {
  const frames: number[][] = [];
  let resolveDone!: () => void;
  const done = new Promise<void>((res) => { resolveDone = res; });
  const unsub = conn.onMessage((bytes) => {
    if (isAm4Fn(bytes, [0x77, 0x78, 0x79])) {
      frames.push(bytes.slice());
      if (bytes[5] === 0x79) resolveDone();
    }
  });
  const started = Date.now();
  const timer = setTimeout(() => resolveDone(), DUMP_TIMEOUT_MS);
  conn.send(buildRequestActiveBufferDump());
  await done;
  clearTimeout(timer);
  unsub();
  const flat: number[] = [];
  for (const f of frames) for (const b of f) flat.push(b);
  const fnCounts: Record<string, number> = {};
  for (const f of frames) {
    const k = `0x${f[5].toString(16)}`;
    fnCounts[k] = (fnCounts[k] ?? 0) + 1;
  }
  return { frames, flat, fnCounts, durationMs: Date.now() - started };
}

interface DumpDiff {
  sameLength: boolean;
  len1: number;
  len2: number;
  frameCount1: number;
  frameCount2: number;
  differingBytes: number;
  /** First 200 differing offsets with frame attribution. */
  offsets: Array<{ flatOffset: number; frame: number; fn: string; offsetInFrame: number; b1: number; b2: number }>;
  perFrameDiffCounts: Array<{ frame: number; fn: string; diffs: number }>;
}

function diffDumps(d1: DumpStream, d2: DumpStream): DumpDiff {
  const n = Math.min(d1.flat.length, d2.flat.length);
  const offsets: DumpDiff['offsets'] = [];
  let differing = Math.abs(d1.flat.length - d2.flat.length);

  // Map flat offset -> (frame index, offset in frame) for stream 1.
  const frameOfOffset: Array<{ frame: number; fn: string; offsetInFrame: number }> = [];
  {
    let fi = 0;
    let off = 0;
    for (const f of d1.frames) {
      for (let j = 0; j < f.length; j++) {
        frameOfOffset[off + j] = { frame: fi, fn: `0x${f[5].toString(16)}`, offsetInFrame: j };
      }
      off += f.length;
      fi++;
    }
  }
  const perFrame = new Map<number, { fn: string; diffs: number }>();
  for (let i = 0; i < n; i++) {
    if (d1.flat[i] !== d2.flat[i]) {
      differing++;
      const loc = frameOfOffset[i] ?? { frame: -1, fn: '?', offsetInFrame: -1 };
      if (offsets.length < 200) {
        offsets.push({ flatOffset: i, frame: loc.frame, fn: loc.fn, offsetInFrame: loc.offsetInFrame, b1: d1.flat[i], b2: d2.flat[i] });
      }
      const e = perFrame.get(loc.frame) ?? { fn: loc.fn, diffs: 0 };
      e.diffs++;
      perFrame.set(loc.frame, e);
    }
  }
  return {
    sameLength: d1.flat.length === d2.flat.length,
    len1: d1.flat.length,
    len2: d2.flat.length,
    frameCount1: d1.frames.length,
    frameCount2: d2.frames.length,
    differingBytes: differing,
    offsets,
    perFrameDiffCounts: [...perFrame.entries()].map(([frame, e]) => ({ frame, fn: e.fn, diffs: e.diffs })).sort((a, b) => a.frame - b.frame),
  };
}

// ── (b) Bypass 0x0E vs 0x0D ─────────────────────────────────────────

interface BypassExperiment {
  ran: boolean;
  skipReason?: string;
  block?: string;
  blockPidLow?: number;
  before?: { long: boolean; longFrameHex: string; shortU32: number };
  after?: { long: boolean; longFrameHex: string; shortU32: number };
  shortTracked?: boolean;
  longTracked?: boolean;
  longFrameDiffOffsets?: number[];
  restoredVerified?: boolean;
}

async function writeBypass(conn: MidiConnection, blockPidLow: number, bypassed: boolean): Promise<void> {
  const msg = buildSetBlockBypass(blockPidLow, bypassed);
  const ackPromise = conn.receiveSysExMatching((resp) => isWriteEcho(msg, resp), WRITE_ACK_TIMEOUT_MS);
  conn.send(msg);
  try { await ackPromise; } catch { /* readback is the real verification */ }
  await sleep(RATE_LIMIT_MS);
}

async function runBypassExperiment(conn: MidiConnection, placed: BlockTypeName[]): Promise<BypassExperiment> {
  const candidate = placed.find((b) => b !== 'amp' && b !== ('none' as BlockTypeName));
  if (candidate === undefined) {
    return {
      ran: false,
      skipReason: 'no placed non-amp block (amp pidHigh 0x0003 is BOOST, not bypass); load a preset with a drive/delay/reverb block and re-run',
    };
  }
  const blockPidLow = BLOCK_TYPE_VALUES[candidate];
  const pid: ParamId = { pidLow: blockPidLow, pidHigh: BYPASS_PID_HIGH };

  // Before state, both read forms.
  const longFrame1 = await readLongFrame(conn, pid);
  const state1 = parseLongReadBypassFlag(longFrame1);
  const short1 = await readShortU32(conn, pid);

  let restoredVerified = false;
  try {
    // Toggle.
    await writeBypass(conn, blockPidLow, !state1);
    const longFrame2 = await readLongFrame(conn, pid);
    const state2 = parseLongReadBypassFlag(longFrame2);
    const short2 = await readShortU32(conn, pid);

    // Restore + verify.
    await writeBypass(conn, blockPidLow, state1);
    const longFrame3 = await readLongFrame(conn, pid);
    restoredVerified = parseLongReadBypassFlag(longFrame3) === state1;

    const diffOffsets: number[] = [];
    for (let i = 0; i < Math.min(longFrame1.length, longFrame2.length); i++) {
      if (longFrame1[i] !== longFrame2[i]) diffOffsets.push(i);
    }
    return {
      ran: true,
      block: candidate,
      blockPidLow,
      before: { long: state1, longFrameHex: hex(longFrame1), shortU32: short1 },
      after: { long: state2, longFrameHex: hex(longFrame2), shortU32: short2 },
      shortTracked: short1 !== short2,
      longTracked: state2 === !state1,
      longFrameDiffOffsets: diffOffsets,
      restoredVerified,
    };
  } catch (err) {
    // Abort path: best-effort restore before propagating.
    try {
      await writeBypass(conn, blockPidLow, state1);
      const check = await readLongFrame(conn, pid);
      restoredVerified = parseLongReadBypassFlag(check) === state1;
    } catch { /* report below */ }
    throw new Error(
      `bypass experiment failed mid-flight (${err instanceof Error ? err.message : err}); ` +
      `restore ${restoredVerified ? 'verified' : 'NOT verified, check ' + candidate + ' bypass on the device'}`,
    );
  }
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  guardAgainstRunningEditors(args); // editor-held port + our traffic = WinMM wedge; --ignore-editors overrides
  const argOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const skipBypass = args.includes('--skip-bypass');
  const portNeedle = argOf('--port');

  console.log('AM4 misc open-items probe');
  console.log('=========================');
  console.log('WHAT THIS RUN WILL DO:');
  console.log('  (a) Two active-buffer dump requests (fn 0x03, read-only), byte-diffed.');
  if (skipBypass) {
    console.log('  (b) SKIPPED (--skip-bypass). Zero writes this run.');
  } else {
    console.log('  (b) One bypass toggle on one placed non-amp block, read via 0x0D and');
    console.log('      0x0E before/after, then restored and verified. One audible blip.');
  }
  console.log('  NO saves, NO preset/scene/bank switches, NO location writes.');
  console.log('  Estimated: ~16 wire transactions plus 2 dump streams, ~10-15 s total.');
  console.log('');

  const needles = portNeedle ? [portNeedle] : [...DEFAULT_NEEDLES];
  const conn = connect({
    needles,
    notFoundLeadIn: `AM4 not found (needles: ${needles.join(', ')}). Close AM4-Edit; pass --port <substring> to override.`,
  });

  try {
    await sleep(300);

    // Layout first (read-before-write discipline + the bypass target pick).
    const placed: BlockTypeName[] = [];
    const layout: string[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const u32 = await readShortU32(conn, {
        pidLow: BLOCK_SLOT_PID_LOW,
        pidHigh: BLOCK_SLOT_PID_HIGH_BASE + (position - 1),
      });
      const name = BLOCK_NAMES_BY_VALUE[u32] ?? ('none' as BlockTypeName);
      layout.push(`slot ${position}: ${name}`);
      if (name !== 'none') placed.push(name);
    }
    console.log('Working-buffer layout:');
    for (const l of layout) console.log(`  ${l}`);
    console.log('');

    // (a) Double dump.
    console.log('(a) Dump 1 of 2 ...');
    const dump1 = await collectDump(conn);
    console.log(`    ${dump1.frames.length} frames, ${dump1.flat.length} bytes, ${dump1.durationMs} ms (${JSON.stringify(dump1.fnCounts)})`);
    await sleep(500);
    console.log('(a) Dump 2 of 2 ...');
    const dump2 = await collectDump(conn);
    console.log(`    ${dump2.frames.length} frames, ${dump2.flat.length} bytes, ${dump2.durationMs} ms (${JSON.stringify(dump2.fnCounts)})`);
    const diff = diffDumps(dump1, dump2);
    console.log(
      `    diff: ${diff.differingBytes} differing byte(s)` +
      (diff.sameLength ? '' : ` (LENGTH MISMATCH ${diff.len1} vs ${diff.len2})`),
    );
    for (const pf of diff.perFrameDiffCounts) {
      console.log(`      frame ${pf.frame} (fn ${pf.fn}): ${pf.diffs} diffs`);
    }

    // (b) Bypass experiment.
    let bypass: BypassExperiment = { ran: false, skipReason: '--skip-bypass' };
    if (!skipBypass) {
      console.log('\n(b) Bypass 0x0E-vs-0x0D experiment ...');
      bypass = await runBypassExperiment(conn, placed);
      if (!bypass.ran) {
        console.log(`    SKIPPED: ${bypass.skipReason}`);
      } else {
        console.log(`    block: ${bypass.block} (pidLow 0x${bypass.blockPidLow!.toString(16)})`);
        console.log(`    0x0D long read tracked the toggle: ${bypass.longTracked ? 'YES' : 'NO'}`);
        console.log(`    0x0E short read moved: ${bypass.shortTracked ? `YES (${bypass.before!.shortU32} -> ${bypass.after!.shortU32})` : `NO (static ${bypass.before!.shortU32}, matches SYSEX-MAP 6a)`}`);
        console.log(`    0x0D 64-byte frame diff offsets: ${bypass.longFrameDiffOffsets!.join(', ') || '(none)'}`);
        console.log(`    restore verified: ${bypass.restoredVerified ? 'YES' : 'NO, CHECK DEVICE'}`);
      }
    }

    // ── Artifacts ────────────────────────────────────────────────────
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-dump1.syx`, Uint8Array.from(dump1.flat));
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-dump2.syx`, Uint8Array.from(dump2.flat));
    writeFileSync(
      `${OUT_DIR}/${OUT_BASE}-results.json`,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        layout,
        dump1: { frames: dump1.frames.length, bytes: dump1.flat.length, fnCounts: dump1.fnCounts, durationMs: dump1.durationMs },
        dump2: { frames: dump2.frames.length, bytes: dump2.flat.length, fnCounts: dump2.fnCounts, durationMs: dump2.durationMs },
        diff,
        bypass,
      }, undefined, 2),
    );

    const md: string[] = [
      '# AM4 misc open-items probe findings',
      '',
      `> Generated by \`scripts/_research/probe-am4-misc-opens.ts\` at ${new Date().toISOString()}`,
      '',
      `Layout: ${layout.join('; ')}`,
      '',
      '## (a) Double-dump determinism',
      '',
      `- Dump 1: ${dump1.frames.length} frames, ${dump1.flat.length} bytes (${JSON.stringify(dump1.fnCounts)})`,
      `- Dump 2: ${dump2.frames.length} frames, ${dump2.flat.length} bytes (${JSON.stringify(dump2.fnCounts)})`,
      `- Differing bytes: **${diff.differingBytes}**${diff.sameLength ? '' : ` (length mismatch ${diff.len1} vs ${diff.len2})`}`,
      '',
      diff.differingBytes === 0
        ? 'VERDICT: byte-deterministic across back-to-back dumps. The "non-deterministic encoder" caveat in dumpActivePresetBinary can be tightened.'
        : 'VERDICT: NOT byte-deterministic. Per-frame and per-offset detail below; the differing offsets are candidates for free-running counters/noise fields, and any byte-diff-based dump analysis must mask them.',
      '',
      '### Per-frame diff counts',
      '',
      '| Frame | fn | Diff bytes |',
      '|---|---|---|',
      ...diff.perFrameDiffCounts.map((pf) => `| ${pf.frame} | ${pf.fn} | ${pf.diffs} |`),
      '',
      `### Differing offsets (first ${diff.offsets.length})`,
      '',
      '| Flat offset | Frame | fn | Offset in frame | Dump1 | Dump2 |',
      '|---|---|---|---|---|---|',
      ...diff.offsets.map((o) =>
        `| ${o.flatOffset} | ${o.frame} | ${o.fn} | ${o.offsetInFrame} | 0x${o.b1.toString(16).padStart(2, '0')} | 0x${o.b2.toString(16).padStart(2, '0')} |`),
      '',
      '## (b) Bypass 0x0E vs 0x0D',
      '',
    ];
    if (!bypass.ran) {
      md.push(`SKIPPED: ${bypass.skipReason}`);
    } else {
      md.push(
        `Block: **${bypass.block}** (pidLow 0x${bypass.blockPidLow!.toString(16)}, pidHigh 0x0003)`,
        '',
        `- 0x0D long read tracked the bypass toggle: **${bypass.longTracked ? 'YES' : 'NO'}**`,
        `- 0x0E short read moved across the toggle: **${bypass.shortTracked ? 'YES' : 'NO'}** (before ${bypass.before!.shortU32}, after ${bypass.after!.shortU32})`,
        `- Restore verified via 0x0D: **${bypass.restoredVerified ? 'YES' : 'NO'}**`,
        '',
        `0x0D frame diff offsets (toggle): ${bypass.longFrameDiffOffsets!.join(', ') || '(none)'}`,
        '',
        '0x0D frame before: ' + '`' + bypass.before!.longFrameHex + '`',
        '',
        '0x0D frame after: ' + '`' + bypass.after!.longFrameHex + '`',
        '',
        'The non-byte-22 diff offsets are descriptor metadata that swaps with',
        'state (SYSEX-MAP 6a); the two full frames above feed the 40-byte',
        'descriptor decode.',
      );
    }
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-findings.md`, md.join('\n'));
    console.log(`\nWrote ${OUT_DIR}/${OUT_BASE}-findings.md`);
    console.log(`Wrote ${OUT_DIR}/${OUT_BASE}-results.json`);
    console.log(`Wrote ${OUT_DIR}/${OUT_BASE}-dump1.syx + -dump2.syx`);
  } catch (err) {
    console.error('\nFATAL:', err instanceof Error ? err.message : err);
    conn.close();
    process.exit(1);
  }

  conn.close();
  process.exit(0);
}

main().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
