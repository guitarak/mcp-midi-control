/**
 * AM4 deep-verify probe for the 2026-06-09 cache-oracle catalog work.
 *
 * Verifies, against live AM4 hardware, the three batches that shipped or
 * were drafted from the solved effectDefinitions cache walk:
 *
 *   1. The 98 regenerated amp/cab rows + 3 unit-fix rows
 *      (accuracy-pass-ops.json, kind='set').
 *   2. The 10 drafted amp GHOST params (AMP_GHOST_PARAMS).
 *   3. The 56 drafted system-param upgrades (SYSTEM_PARAM_UPDATES),
 *      graded against BOTH the shipped and the proposed entry.
 *   4. The two flagged conflicts: amp.cab_master_level (scale 10 vs 100)
 *      and amp.cab_zoom (read-only check).
 *
 * # Pass A (default, READ-ONLY)
 *
 * For every target key: short read (fn 0x01 action 0x0E, Q15 u32) plus
 * long read (action 0x0D, 40-byte descriptor). The descriptor is mostly
 * undecoded (SYSEX-MAP 6a: only byte 22 = bypass flag is known), so the
 * probe records it whole, scans it for printable-ASCII runs and for
 * float32 words, and uses anything it finds as a best-effort oracle.
 *
 * ORACLE HONESTY NOTE: the AM4's decoded read paths carry NO device
 * display label (RE-WORKFLOW.md: "enum get_param returns the raw index";
 * the label-echo in CLAUDE.md's verification list is the Axe-Fx II fn
 * 0x02 GET response). This probe therefore:
 *   - fires ONE fn 0x02 GET capability probe at startup (gen-2 transfer
 *     hypothesis, query flag only, read-only). If the AM4 answers with a
 *     labeled gen-2-shaped response, that label becomes the per-param
 *     oracle for the whole run, and that is itself a headline finding.
 *   - otherwise grades pass A on range-sanity + descriptor heuristics
 *     and leaves the strong grading to pass B, which needs no label.
 *
 * # Pass B (--write-midpoints, SELF-RESTORING)
 *
 * Taper discrimination that uses the DEVICE'S OWN display-to-register
 * mapping as the oracle, no label and no human eyes needed:
 *
 *   - MESSAGE_SET (action 0x0001) writes the unit-scaled display value
 *     (hardware-anchored: AM4-Edit captures write float32(3.4) for a Hz
 *     param, float32(0.085) for 85 ms).
 *   - The 0x0E read returns the NORMALIZED register (u32/65534 in [0,1]).
 *   - So writing the log10-midpoint display value (the geometric mean)
 *     must read back u32 = 32767 if the device's taper is log10, or the
 *     linear position (far away for decade ranges) if it is linear.
 *
 * Per log10 key ON A PLACED BLOCK ONLY: read original, write geo-mean
 * display, read back, classify log10/linear/unresolved, restore the
 * original register (verified by re-read; SET_NORM fallback), continue.
 * Also exercises the 6 GHOST type-code enums: ordinal round-trip for
 * index 0 + mid index, readback-clamp probe at rosterLen to measure the
 * device table size against the cache roster (labels are NOT readable
 * over MIDI on AM4; size + writability is what is automatable).
 *
 * Safety:
 *   - NO save frames (action 0x1B never built), NO preset switches, NO
 *     scene switches, NO bank changes, NO location writes.
 *   - Every mutation records the original register first and restores it
 *     after, with a verifying re-read. Abort path restores everything
 *     written so far before exiting.
 *   - Writes are rate-limited (>= 60 ms between wire transactions).
 *   - The working buffer is left value-identical, but the AM4's own
 *     "buffer edited" flag may end up set. Do NOT save afterward; switch
 *     presets (or power-cycle) to discard if the flag matters.
 *
 * # Run
 *
 *   npx tsx scripts/_research/probe-am4-deep-verify.ts                    # pass A only
 *   npx tsx scripts/_research/probe-am4-deep-verify.ts --write-midpoints  # pass A + pass B
 *   npx tsx scripts/_research/probe-am4-deep-verify.ts --port "am4"       # port override
 *   npx tsx scripts/_research/probe-am4-deep-verify.ts --only amp.low_cut # filter keys (prefix match)
 *   npx tsx scripts/_research/probe-am4-deep-verify.ts --ops-json <path>  # ops list override
 *
 * Prereqs: AM4 on + USB connected, AM4-Edit CLOSED (it owns the port and
 * its polling pollutes the inbound stream).
 *
 * # Output
 *
 *   samples/captured/probe-am4-deep-verify-findings.md
 *   samples/captured/probe-am4-deep-verify-results.json
 *   samples/captured/probe-am4-deep-verify-raw.syx
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { guardAgainstRunningEditors } from '../_lib/editor-guard.js';
import { connect, type MidiConnection } from '../../packages/core/src/midi/transport.js';
import {
  KNOWN_PARAMS,
  decode,
  encode,
  roundDisplayValue,
  type Param,
} from '../../packages/fractal-midi/src/am4/params.js';
import {
  AMP_GHOST_PARAMS,
  SYSTEM_PARAM_UPDATES,
} from '../../packages/fractal-midi/src/am4/cacheOracleParams.generated.js';
import {
  AM4_MODEL_ID,
  BLOCK_SLOT_PID_HIGH_BASE,
  BLOCK_SLOT_PID_LOW,
  buildReadParam,
  buildSetFloatParam,
  buildSetParamNorm,
  isReadResponse,
  isReadResponseLong,
  isWriteEcho,
  parseReadResponse,
  READ_TYPE_LONG,
  READ_VALUE_DENOMINATOR,
  type ParamId,
} from '../../packages/fractal-midi/src/am4/setParam.js';
import { BLOCK_NAMES_BY_VALUE } from '../../packages/fractal-midi/src/am4/blockTypes.js';
import { unpackValueChunked } from '../../packages/fractal-midi/src/shared/packValue.js';
import { fractalChecksum } from '../../packages/fractal-midi/src/shared/checksum.js';

// ── Tunables ─────────────────────────────────────────────────────────

const READ_TIMEOUT_MS = 300;
const WRITE_ACK_TIMEOUT_MS = 300;
const RATE_LIMIT_MS = 60;
const RESTORE_TOLERANCE_TICKS = 32; // Q15 + float32 round-trip residue ceiling
const TAPER_CLASSIFY_TOLERANCE_TICKS = 1500; // ~2.3% of range
const TAPER_LOW_CONTRAST_TICKS = 3000; // hypotheses too close to call

const DEFAULT_NEEDLES = ['am4'] as const;
const DEFAULT_OPS_JSON = 'samples/captured/local-caches-2026-06-09/accuracy-pass-ops.json';
const OUT_DIR = 'samples/captured';
const OUT_BASE = 'probe-am4-deep-verify';

// ── Small helpers ────────────────────────────────────────────────────

const P = KNOWN_PARAMS as unknown as Record<string, Param>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

function f32FromBytes(b: readonly number[], offset: number): number {
  const view = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 4; i++) view.setUint8(i, b[offset + i] ?? 0);
  return view.getFloat32(0, true);
}

/** Unit scale (display = internal * scale) recovered from the codec's own encode. */
function unitScale(p: Param): number {
  if (p.unit === 'enum') return 1;
  const e = encode(p, 1);
  return e === 0 ? 1 : 1 / e;
}

/** Printable-ASCII runs of length >= 3 inside a raw byte array. */
function asciiRuns(raw: readonly number[]): string[] {
  const runs: string[] = [];
  let cur: number[] = [];
  for (const b of raw) {
    if (b >= 0x20 && b <= 0x7e) {
      cur.push(b);
    } else {
      if (cur.length >= 3) runs.push(String.fromCharCode(...cur));
      cur = [];
    }
  }
  if (cur.length >= 3) runs.push(String.fromCharCode(...cur));
  return runs;
}

/** Parse the leading number out of a device-style label ("200.0 Hz" -> 200). */
function parseLabelNumber(label: string): number | undefined {
  const m = label.trim().match(/^[-+]?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

// ── Wire session ─────────────────────────────────────────────────────

interface ShortRead {
  ok: boolean;
  u32?: number;
  norm?: number; // u32 / 65534
  f32?: number; // raw 4 bytes as float32 LE
  raw4?: number[];
  error?: string;
}

interface LongRead {
  ok: boolean;
  raw40?: number[];
  floats?: number[]; // 10 float32 LE words
  ascii?: string[];
  error?: string;
}

class Am4Session {
  readonly rawLog: number[] = [];
  constructor(readonly conn: MidiConnection) {}

  private log(bytes: readonly number[]): void {
    for (const b of bytes) this.rawLog.push(b);
  }

  async readShort(pid: ParamId): Promise<ShortRead> {
    const req = buildReadParam(pid);
    this.log(req);
    const respPromise = this.conn.receiveSysExMatching(
      (resp) => isReadResponse(req, resp),
      READ_TIMEOUT_MS,
    );
    this.conn.send(req);
    try {
      const resp = await respPromise;
      this.log(resp);
      const parsed = parseReadResponse(resp);
      const u32 = parsed.asUInt32LE();
      return {
        ok: true,
        u32,
        norm: u32 / READ_VALUE_DENOMINATOR,
        f32: f32FromBytes(Array.from(parsed.rawValue), 0),
        raw4: Array.from(parsed.rawValue),
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await sleep(RATE_LIMIT_MS);
    }
  }

  async readLong(pid: ParamId): Promise<LongRead> {
    const req = buildReadParam(pid, READ_TYPE_LONG);
    this.log(req);
    const respPromise = this.conn.receiveSysExMatching(
      (resp) => isReadResponseLong(req, resp),
      READ_TIMEOUT_MS,
    );
    this.conn.send(req);
    try {
      const resp = await respPromise;
      this.log(resp);
      // 64-byte frame: bytes 16..61 are the 46 packed wire bytes carrying
      // 40 raw descriptor bytes (hdr4 = 0x0028).
      const packed = Uint8Array.from(resp.slice(16, 62));
      const raw40 = Array.from(unpackValueChunked(packed, 40));
      const floats: number[] = [];
      for (let off = 0; off + 4 <= 40; off += 4) floats.push(f32FromBytes(raw40, off));
      return { ok: true, raw40, floats, ascii: asciiRuns(raw40) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      await sleep(RATE_LIMIT_MS);
    }
  }

  /**
   * MESSAGE_SET write of a unit-scaled internal float. Waits for the
   * 64-byte write-echo ack (non-fatal on timeout; the follow-up read is
   * the real verification).
   */
  async writeInternal(pid: ParamId, internal: number): Promise<{ acked: boolean }> {
    const msg = buildSetFloatParam(pid, internal);
    this.log(msg);
    const ackPromise = this.conn.receiveSysExMatching(
      (resp) => isWriteEcho(msg, resp),
      WRITE_ACK_TIMEOUT_MS,
    );
    this.conn.send(msg);
    let acked = true;
    try {
      const ack = await ackPromise;
      this.log(ack);
    } catch {
      acked = false;
    }
    await sleep(RATE_LIMIT_MS);
    return { acked };
  }

  /** MESSAGE_SET_NORM write of a raw normalized [0,1] value (restore fallback). */
  async writeNorm(pid: ParamId, normalized: number): Promise<{ acked: boolean }> {
    const clamped = Math.min(1, Math.max(0, normalized));
    const msg = buildSetParamNorm(pid, clamped);
    this.log(msg);
    const ackPromise = this.conn.receiveSysExMatching(
      (resp) => isWriteEcho(msg, resp),
      WRITE_ACK_TIMEOUT_MS,
    );
    this.conn.send(msg);
    let acked = true;
    try {
      const ack = await ackPromise;
      this.log(ack);
    } catch {
      acked = false;
    }
    await sleep(RATE_LIMIT_MS);
    return { acked };
  }
}

// ── fn 0x02 capability probe (gen-2 transfer hypothesis, READ-ONLY) ─

interface Fn02Capability {
  supported: boolean;
  classification: string;
  sampleFrameHex?: string;
  label?: string;
}

function buildAm4Fn02Query(pidLow: number, pidHigh: number): number[] {
  // Axe-Fx II GET/SET_BLOCK_PARAMETER_VALUE shape with the AM4 model byte:
  // F0 00 01 74 15 02 [pL pL] [pH pH] [v v v] [00=query] [cs] F7.
  // Query flag ONLY; this probe never sends the set flag (0x01).
  const head = [
    0xf0, 0x00, 0x01, 0x74, AM4_MODEL_ID, 0x02,
    pidLow & 0x7f, (pidLow >> 7) & 0x7f,
    pidHigh & 0x7f, (pidHigh >> 7) & 0x7f,
    0x00, 0x00, 0x00,
    0x00,
  ];
  return [...head, fractalChecksum(head), 0xf7];
}

async function probeFn02(session: Am4Session, pidLow: number, pidHigh: number): Promise<Fn02Capability> {
  const collected: number[][] = [];
  const unsub = session.conn.onMessage((bytes) => {
    if (bytes[0] === 0xf0) collected.push(bytes.slice());
  });
  const req = buildAm4Fn02Query(pidLow, pidHigh);
  session.rawLog.push(...req);
  session.conn.send(req);
  await sleep(500);
  unsub();
  for (const f of collected) session.rawLog.push(...f);

  const isAm4 = (f: number[]) =>
    f.length >= 7 && f[1] === 0x00 && f[2] === 0x01 && f[3] === 0x74 && f[4] === AM4_MODEL_ID;
  const fn02 = collected.find((f) => isAm4(f) && f[5] === 0x02 && f.length > 16);
  if (fn02) {
    const runs = asciiRuns(fn02.slice(10, fn02.length - 2));
    return {
      supported: runs.length > 0,
      classification: runs.length > 0
        ? 'LABELED RESPONSE: the AM4 answers gen-2 fn 0x02 queries with a label. Headline finding; use as oracle.'
        : 'fn 0x02 echoed without a decodable label.',
      sampleFrameHex: hex(fn02),
      label: runs[0],
    };
  }
  const nack = collected.find((f) => isAm4(f) && f[5] === 0x64 && f[6] === 0x02);
  if (nack) {
    return {
      supported: false,
      classification: `NACK: fn 0x64 multipurpose response, result_code 0x${(nack[7] ?? 0).toString(16)}. fn 0x02 recognized but rejected.`,
      sampleFrameHex: hex(nack),
    };
  }
  return {
    supported: false,
    classification: collected.length === 0
      ? 'SILENT: no inbound frame in 500 ms. fn 0x02 unsupported (matches SYSEX-MAP "unused by AM4-Edit").'
      : `No fn 0x02 / NACK frame; ${collected.length} unrelated frame(s) observed.`,
  };
}

/** Per-param fn 0x02 labeled read, only used when the capability probe hit. */
async function readFn02Label(session: Am4Session, pid: ParamId): Promise<string | undefined> {
  let label: string | undefined;
  const unsub = session.conn.onMessage((bytes) => {
    if (
      bytes[0] === 0xf0 && bytes[4] === AM4_MODEL_ID && bytes[5] === 0x02 &&
      bytes.length > 16 && label === undefined
    ) {
      const runs = asciiRuns(bytes.slice(10, bytes.length - 2));
      if (runs.length > 0) label = runs[runs.length - 1];
    }
  });
  session.conn.send(buildAm4Fn02Query(pid.pidLow, pid.pidHigh));
  await sleep(150);
  unsub();
  await sleep(RATE_LIMIT_MS);
  return label;
}

// ── Target list assembly ─────────────────────────────────────────────

type TargetSource = 'regen98' | 'ghost10' | 'system56' | 'conflict';

interface Target {
  key: string;
  source: TargetSource;
  /** Entry used for the primary decode (shipped for regen/conflict, proposed for ghost/system). */
  param: Param;
  /** For system56: the shipped catalog entry, graded in parallel. */
  shippedParam?: Param;
  note?: string;
}

interface OpsFile {
  ops: Array<[string, { kind: string; addScaling?: boolean }]>;
  flagged: string[];
  removed: string[];
}

function loadOps(path: string): OpsFile {
  if (!existsSync(path)) {
    console.error(
      `ERROR: ops JSON not found at ${path}.\n` +
      `This file is produced by scripts/_research/am4-catalog-accuracy-apply.ts ` +
      `(see docs/_private/AM4-CATALOG-ACCURACY-PASS-2026-06-09.md). ` +
      `Pass --ops-json <path> if it moved.`,
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as OpsFile;
}

function buildTargets(ops: OpsFile, onlyPrefix?: string): Target[] {
  const targets: Target[] = [];
  const pushUnique = new Set<string>();
  const add = (t: Target) => {
    if (pushUnique.has(t.key)) return;
    if (onlyPrefix && !t.key.startsWith(onlyPrefix)) return;
    pushUnique.add(t.key);
    targets.push(t);
  };

  // 1. Regenerated rows (kind='set'; the removed row is gone from the catalog).
  for (const [key, op] of ops.ops) {
    if (op.kind !== 'set') continue;
    const param = P[key];
    if (param === undefined) {
      console.warn(`  warn: ops 'set' key ${key} not in KNOWN_PARAMS; skipping`);
      continue;
    }
    add({ key, source: 'regen98', param });
  }

  // 2. GHOST drafts (NOT in KNOWN_PARAMS; the drafted entry is the prediction).
  for (const [key, param] of Object.entries(AMP_GHOST_PARAMS as Record<string, Param>)) {
    add({ key, source: 'ghost10', param, note: 'drafted (unshipped) cache-oracle entry' });
  }

  // 3. System-param upgrades (proposed entry primary, shipped graded too).
  for (const [key, param] of Object.entries(SYSTEM_PARAM_UPDATES as Record<string, Param>)) {
    add({ key, source: 'system56', param, shippedParam: P[key] });
  }

  // 4. Conflicts.
  if (P['amp.cab_master_level']) {
    add({
      key: 'amp.cab_master_level', source: 'conflict', param: P['amp.cab_master_level'],
      note: 'scale 10 (shipped, session-41 screenshot) vs scale 100 (cache percent). Round-trip cannot discriminate (both store normalized [0,1]); the descriptor float scan or one front-panel glance settles it. Both candidate displays reported.',
    });
  }
  if (P['amp.cab_zoom']) {
    add({
      key: 'amp.cab_zoom', source: 'conflict', param: P['amp.cab_zoom'],
      note: 'hardware-confirmed display-only IR-graph zoom; cache carries an unlabeled 0..1 float. Read-only check.',
    });
  }
  return targets;
}

// ── Pass A ───────────────────────────────────────────────────────────

type VerdictA =
  | 'PASS'
  | 'FAIL'
  | 'NO-ORACLE-RANGE-OK'
  | 'NO-ORACLE-RANGE-FAIL'
  | 'AMBIGUOUS'
  | 'SKIP-UNPLACED'
  | 'NO-ACK';

interface PassAResult {
  key: string;
  source: TargetSource;
  placed: boolean;
  verdict: VerdictA;
  u32?: number;
  norm?: number;
  f32?: number;
  decodedDisplay?: number | string;
  shippedDecodedDisplay?: number | string;
  oracleLabel?: string;
  descriptorAscii?: string[];
  descriptorFloats?: number[];
  descriptorHex?: string;
  detail: string;
}

function oneTickDisplay(p: Param, norm: number): number {
  const tick = 1 / READ_VALUE_DENOMINATOR;
  return Math.abs(decode(p, Math.min(1, norm + tick)) - decode(p, norm));
}

function gradeContinuous(p: Param, norm: number, label?: string): { verdict: VerdictA; detail: string; display: number | string } {
  const displayFull = decode(p, norm);
  const display = roundDisplayValue(p, displayFull);
  const lo = Math.min(p.displayMin, p.displayMax);
  const hi = Math.max(p.displayMin, p.displayMax);
  const slack = Math.max(oneTickDisplay(p, norm), (hi - lo) * 1e-4);
  const inRange = displayFull >= lo - slack && displayFull <= hi + slack;
  if (label !== undefined) {
    const labelNum = parseLabelNumber(label);
    if (labelNum !== undefined && typeof display === 'number') {
      // Tolerance: one display step at the label's printed precision, plus one wire tick.
      const decimals = (label.split('.')[1] ?? '').replace(/[^0-9].*$/, '').length;
      const tol = Math.max(10 ** -decimals, oneTickDisplay(p, norm)) * 1.000001;
      if (Math.abs(labelNum - displayFull) <= tol) {
        return { verdict: 'PASS', detail: `device label "${label}" matches decode ${display}`, display };
      }
      return { verdict: 'FAIL', detail: `device label "${label}" vs decode ${display} (tol ${tol})`, display };
    }
    return { verdict: 'AMBIGUOUS', detail: `label "${label}" not numeric; decode ${display}`, display };
  }
  return {
    verdict: inRange ? 'NO-ORACLE-RANGE-OK' : 'NO-ORACLE-RANGE-FAIL',
    detail: inRange
      ? `decode ${display} in [${p.displayMin}..${p.displayMax}]; no label oracle on this read path`
      : `decode ${display} OUTSIDE [${p.displayMin}..${p.displayMax}]; range or taper suspect`,
    display,
  };
}

async function runPassA(
  session: Am4Session,
  targets: Target[],
  placedBlocks: ReadonlySet<string>,
  fn02: Fn02Capability,
): Promise<PassAResult[]> {
  const results: PassAResult[] = [];
  let i = 0;
  for (const t of targets) {
    i++;
    const placed = t.param.block === 'global' || placedBlocks.has(t.param.block);
    const pid: ParamId = { pidLow: t.param.pidLow, pidHigh: t.param.pidHigh };
    const short = await session.readShort(pid);
    const long = await session.readLong(pid);
    const fn02Label = fn02.supported ? await readFn02Label(session, pid) : undefined;

    const r: PassAResult = {
      key: t.key,
      source: t.source,
      placed,
      verdict: 'NO-ACK',
      detail: '',
      descriptorAscii: long.ascii,
      descriptorFloats: long.floats?.map((f) => Number(f.toPrecision(6))),
      descriptorHex: long.raw40 ? hex(long.raw40) : undefined,
      oracleLabel: fn02Label ?? long.ascii?.[0],
    };

    if (!short.ok) {
      r.verdict = 'NO-ACK';
      r.detail = `short read failed: ${short.error}${long.ok ? ' (long read DID answer)' : ''}`;
      results.push(r);
      report(i, targets.length, r);
      continue;
    }
    r.u32 = short.u32;
    r.norm = Number(short.norm!.toPrecision(7));
    r.f32 = Number(short.f32!.toPrecision(7));

    if (t.param.unit === 'enum') {
      const roster = t.param.enumValues ?? {};
      const n = Object.keys(roster).length;
      const ordinal = short.u32!;
      const name = roster[ordinal];
      r.decodedDisplay = name ?? ordinal;
      if (name !== undefined) {
        r.verdict = 'PASS';
        r.detail = `ordinal ${ordinal} -> "${name}" (roster n=${n})`;
      } else {
        // Try the float32-packed-enum interpretation (amp channel-selector pattern).
        const asF = Math.round(short.f32!);
        const fName = Number.isFinite(short.f32!) && roster[asF];
        if (fName) {
          r.verdict = 'AMBIGUOUS';
          r.detail = `u32 ${ordinal} not in roster, but float32 ${short.f32} -> "${fName}" (derived-state register?)`;
        } else {
          r.verdict = 'FAIL';
          r.detail = `ordinal ${ordinal} outside roster n=${n} (f32=${short.f32})`;
        }
      }
    } else {
      const g = gradeContinuous(t.param, short.norm!, fn02Label);
      r.verdict = g.verdict;
      r.detail = g.detail;
      r.decodedDisplay = g.display;
      // System params: grade the shipped entry in parallel and report both.
      if (t.shippedParam && t.shippedParam.unit !== 'enum') {
        const gs = gradeContinuous(t.shippedParam, short.norm!, fn02Label);
        r.shippedDecodedDisplay = gs.display;
        r.detail += ` | shipped-entry decode ${gs.display} (${gs.verdict})`;
      } else if (t.shippedParam && t.shippedParam.unit === 'enum') {
        r.shippedDecodedDisplay = t.shippedParam.enumValues?.[short.u32!] ?? short.u32!;
      }
      // Globals: also surface the float32-LE interpretation (SYSEX-MAP records
      // GLOBAL_USBLEVEL1 as "float32 LE, displayed verbatim").
      if (t.param.block === 'global') {
        r.detail += ` | f32-LE interpretation ${short.f32}`;
      }
      // Conflict special case: print both scale hypotheses.
      if (t.key === 'amp.cab_master_level') {
        const d10 = short.norm! * 10;
        const d100 = short.norm! * 100;
        r.detail += ` | scale-10 display ${d10.toFixed(2)} vs scale-100 display ${d100.toFixed(1)}; compare against the front panel / AM4-Edit at this moment to settle the conflict`;
      }
    }
    if (!placed) {
      r.verdict = 'SKIP-UNPLACED';
      r.detail = `block '${t.param.block}' not placed in any slot; register reads ACK but working-buffer semantics are not guaranteed (phantom-param caveat). Data recorded, not graded. | ${r.detail}`;
    }
    results.push(r);
    report(i, targets.length, r);
  }
  return results;
}

function report(i: number, n: number, r: PassAResult): void {
  const v = r.verdict.padEnd(20);
  console.log(
    `[${String(i).padStart(3)}/${n}] ${v} ${r.key}` +
    (r.u32 !== undefined ? ` u32=${r.u32}` : '') +
    (r.decodedDisplay !== undefined ? ` -> ${r.decodedDisplay}` : ''),
  );
}

// ── Pass B: taper discrimination + enum rosters ──────────────────────

interface PassBResult {
  key: string;
  kind: 'taper' | 'enum-roster' | 'skipped';
  verdict: string;
  detail: string;
  origU32?: number;
  midU32?: number;
  expectedLog?: number;
  expectedLin?: number;
  restored?: boolean;
  restoreMethod?: string;
  restoreDeltaTicks?: number;
}

interface RestoreLedgerEntry {
  key: string;
  pid: ParamId;
  origU32: number;
  param: Param;
}

async function restoreParam(
  session: Am4Session,
  entry: RestoreLedgerEntry,
  winningTaper?: 'log10' | 'linear',
): Promise<{ restored: boolean; method: string; deltaTicks: number }> {
  const origNorm = entry.origU32 / READ_VALUE_DENOMINATOR;
  const attempts: Array<{ method: string; run: () => Promise<unknown> }> = [];

  const setViaTaper = (taper: 'log10' | 'linear') => async () => {
    const p = entry.param;
    const lo = p.displayMin;
    const hi = p.displayMax;
    const display = taper === 'log10' && lo > 0 && hi > 0 && hi !== lo
      ? lo * Math.pow(hi / lo, origNorm)
      : lo + origNorm * (hi - lo);
    await session.writeInternal(entry.pid, encode(p, display));
  };

  if (winningTaper) attempts.push({ method: `MESSAGE_SET (${winningTaper})`, run: setViaTaper(winningTaper) });
  attempts.push({ method: 'MESSAGE_SET_NORM', run: async () => { await session.writeNorm(entry.pid, origNorm); } });
  const catalogTaper: 'log10' | 'linear' = entry.param.scaling === 'log10' ? 'log10' : 'linear';
  if (winningTaper !== catalogTaper) attempts.push({ method: `MESSAGE_SET (catalog ${catalogTaper})`, run: setViaTaper(catalogTaper) });
  const other: 'log10' | 'linear' = catalogTaper === 'log10' ? 'linear' : 'log10';
  if (winningTaper !== other) attempts.push({ method: `MESSAGE_SET (${other})`, run: setViaTaper(other) });

  let lastDelta = Number.MAX_SAFE_INTEGER;
  for (const a of attempts) {
    await a.run();
    const check = await session.readShort(entry.pid);
    if (check.ok) {
      lastDelta = Math.abs(check.u32! - entry.origU32);
      if (lastDelta <= RESTORE_TOLERANCE_TICKS) {
        return { restored: true, method: a.method, deltaTicks: lastDelta };
      }
    }
  }
  return { restored: false, method: 'all attempts', deltaTicks: lastDelta };
}

async function runTaperCase(
  session: Am4Session,
  key: string,
  param: Param,
  ledger: RestoreLedgerEntry[],
): Promise<PassBResult> {
  const pid: ParamId = { pidLow: param.pidLow, pidHigh: param.pidHigh };
  const orig = await session.readShort(pid);
  if (!orig.ok) {
    return { key, kind: 'taper', verdict: 'NO-ACK', detail: `original read failed: ${orig.error}; nothing written` };
  }
  const entry: RestoreLedgerEntry = { key, pid, origU32: orig.u32!, param };
  ledger.push(entry);

  const lo = param.displayMin;
  const hi = param.displayMax;
  if (!(lo > 0 && hi > 0 && hi !== lo)) {
    ledger.pop();
    return { key, kind: 'taper', verdict: 'SKIP', detail: `range [${lo}..${hi}] not log10-eligible; nothing written` };
  }
  // Geometric-mean display value: our log10 decode at normalized 0.5.
  const dGeo = lo * Math.sqrt(hi / lo);
  const expectedLog = Math.round(0.5 * READ_VALUE_DENOMINATOR); // 32767
  const expectedLin = Math.round(((dGeo - lo) / (hi - lo)) * READ_VALUE_DENOMINATOR);
  const contrast = Math.abs(expectedLog - expectedLin);

  await session.writeInternal(pid, encode(param, dGeo));
  const mid = await session.readShort(pid);

  let verdict: string;
  let detail: string;
  let winner: 'log10' | 'linear' | undefined;
  if (!mid.ok) {
    verdict = 'NO-ACK';
    detail = `midpoint readback failed: ${mid.error}`;
  } else {
    const dLog = Math.abs(mid.u32! - expectedLog);
    const dLin = Math.abs(mid.u32! - expectedLin);
    if (contrast < TAPER_LOW_CONTRAST_TICKS) {
      verdict = 'LOW-CONTRAST';
      detail = `log/linear predictions only ${contrast} ticks apart; observed ${mid.u32}`;
    } else if (dLog <= TAPER_CLASSIFY_TOLERANCE_TICKS && dLog < dLin) {
      verdict = 'LOG10-CONFIRMED';
      winner = 'log10';
      detail = `wrote display ${dGeo.toPrecision(5)}; read u32 ${mid.u32} (log10 predicts ${expectedLog}, linear ${expectedLin})`;
    } else if (dLin <= TAPER_CLASSIFY_TOLERANCE_TICKS && dLin < dLog) {
      verdict = 'LINEAR-REFUTES-LOG10';
      winner = 'linear';
      detail = `wrote display ${dGeo.toPrecision(5)}; read u32 ${mid.u32} matches LINEAR (${expectedLin}); log10 predicted ${expectedLog}. Catalog scaling for this key is wrong or the range is wrong`;
    } else {
      verdict = 'UNRESOLVED';
      detail = `read u32 ${mid.u32}; neither log10 (${expectedLog}) nor linear (${expectedLin}) within ${TAPER_CLASSIFY_TOLERANCE_TICKS} ticks. Possible range mismatch or clamped write`;
    }
  }

  const restore = await restoreParam(session, entry, winner);
  ledger.splice(ledger.indexOf(entry), 1);
  return {
    key, kind: 'taper', verdict, detail,
    origU32: orig.u32, midU32: mid.u32,
    expectedLog, expectedLin,
    restored: restore.restored, restoreMethod: restore.method, restoreDeltaTicks: restore.deltaTicks,
  };
}

async function runEnumRosterCase(
  session: Am4Session,
  key: string,
  param: Param,
  ledger: RestoreLedgerEntry[],
): Promise<PassBResult> {
  const pid: ParamId = { pidLow: param.pidLow, pidHigh: param.pidHigh };
  const roster = param.enumValues ?? {};
  const n = Object.keys(roster).length;
  const orig = await session.readShort(pid);
  if (!orig.ok) {
    return { key, kind: 'enum-roster', verdict: 'NO-ACK', detail: `original read failed: ${orig.error}; nothing written` };
  }
  // Refuse to write if we cannot restore confidently (derived-state registers).
  let origOrdinal = orig.u32!;
  if (origOrdinal >= n + 4) {
    const asF = Math.round(orig.f32!);
    if (Number.isFinite(orig.f32!) && asF >= 0 && asF < n) {
      origOrdinal = asF;
    } else {
      return {
        key, kind: 'enum-roster', verdict: 'SKIP-UNRESTORABLE',
        detail: `original readback ${orig.u32} (f32 ${orig.f32}) is not a plausible ordinal (roster n=${n}); refusing to write what cannot be restored`,
        origU32: orig.u32,
      };
    }
  }
  const entry: RestoreLedgerEntry = { key, pid, origU32: orig.u32!, param };
  ledger.push(entry);

  const samples = [0, Math.floor(n / 2)];
  const lines: string[] = [];
  let roundTripOk = true;
  for (const ord of samples) {
    await session.writeInternal(pid, ord);
    const back = await session.readShort(pid);
    const got = back.ok ? back.u32 : undefined;
    const ok = got === ord;
    roundTripOk = roundTripOk && ok;
    lines.push(`ordinal ${ord} ("${roster[ord] ?? '?'}"): readback ${got} ${ok ? 'OK' : 'MISMATCH'}`);
  }
  // Clamp probe: write rosterLen (first invalid index per the cache); the
  // enum-sweep clamp rule says the device clamps at its real table end.
  await session.writeInternal(pid, n);
  const clampBack = await session.readShort(pid);
  let clampLine: string;
  if (!clampBack.ok) clampLine = `clamp probe at ${n}: no readback`;
  else if (clampBack.u32 === n - 1) clampLine = `clamp probe at ${n}: clamped to ${n - 1}; device table size MATCHES cache roster (n=${n})`;
  else if (clampBack.u32 === n) clampLine = `clamp probe at ${n}: accepted; device table is LARGER than the cache roster (n=${n})`;
  else clampLine = `clamp probe at ${n}: readback ${clampBack.u32} (unexpected)`;
  lines.push(clampLine);

  // Restore the original ordinal. Accept either the raw original u32 or the
  // recovered ordinal on readback (covers float32-packed-enum registers whose
  // u32 view is derived state, like the amp channel selector).
  await session.writeInternal(pid, origOrdinal);
  const check = await session.readShort(pid);
  const restored = check.ok && (check.u32 === orig.u32 || check.u32 === origOrdinal);
  ledger.splice(ledger.indexOf(entry), 1);

  return {
    key, kind: 'enum-roster',
    verdict: roundTripOk ? (clampBack.ok && clampBack.u32 === n - 1 ? 'ROSTER-SIZE-CONFIRMED' : 'ROUND-TRIP-OK') : 'ROUND-TRIP-MISMATCH',
    detail: lines.join(' | ') + ' | NOTE: labels are not readable over MIDI on AM4; label text needs one front-panel glance',
    origU32: orig.u32,
    restored,
    restoreMethod: 'MESSAGE_SET (ordinal)',
    restoreDeltaTicks: check.ok ? Math.abs(check.u32! - orig.u32!) : undefined,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  guardAgainstRunningEditors(args); // editor-held port + our traffic = WinMM wedge; --ignore-editors overrides
  const argOf = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined;
  };
  const writeMidpoints = args.includes('--write-midpoints');
  const portNeedle = argOf('--port');
  const opsPath = argOf('--ops-json') ?? DEFAULT_OPS_JSON;
  const onlyPrefix = argOf('--only');

  const ops = loadOps(opsPath);
  const targets = buildTargets(ops, onlyPrefix);
  const log10Keys = ops.ops
    .filter(([k, v]) => (v.kind === 'flip' || v.addScaling === true) && P[k]?.scaling === 'log10' && P[k]?.unit !== 'enum')
    .map(([k]) => k)
    .filter((k) => !onlyPrefix || k.startsWith(onlyPrefix));
  const ghostEnumKeys = Object.entries(AMP_GHOST_PARAMS as Record<string, Param>)
    .filter(([, p]) => p.unit === 'enum')
    .map(([k]) => k)
    .filter((k) => !onlyPrefix || k.startsWith(onlyPrefix));

  const passACount = targets.length * 2; // short + long read each (fn02 adds 1 more if supported)
  const passBCount = writeMidpoints ? log10Keys.length * 6 + ghostEnumKeys.length * 10 : 0;

  console.log('AM4 deep-verify probe (cache-oracle catalog verification)');
  console.log('=========================================================');
  console.log('WHAT THIS RUN WILL DO:');
  console.log(`  Pass A (read-only): ${targets.length} params x 2 reads (0x0E short + 0x0D long descriptor)`);
  console.log('  plus one fn 0x02 capability probe (query flag only, read-only).');
  if (writeMidpoints) {
    console.log(`  Pass B (--write-midpoints): ${log10Keys.length} log10 taper cases (placed blocks only)`);
    console.log(`  and ${ghostEnumKeys.length} GHOST enum-roster cases (amp placed only).`);
    console.log('  Every mutation is read first and restored after, with verify re-reads.');
    console.log('  NO saves, NO preset/scene/bank switches, NO location writes, ever.');
    console.log('  The working buffer is left value-identical; the device dirty flag may set.');
    console.log('  Do NOT save afterward. Audible blips of ~0.3 s per pass-B write are expected.');
  } else {
    console.log('  Pass B disabled (pass --write-midpoints to enable). Zero writes this run.');
  }
  const est = Math.ceil(((passACount + passBCount) * (RATE_LIMIT_MS + 70)) / 1000);
  console.log(`  Estimated wire transactions: ~${passACount + passBCount}, ~${est}s.`);
  console.log('');

  const needles = portNeedle ? [portNeedle] : [...DEFAULT_NEEDLES];
  const conn = connect({
    needles,
    notFoundLeadIn: `AM4 not found (needles: ${needles.join(', ')}). Close AM4-Edit; pass --port <substring> to override.`,
  });
  const session = new Am4Session(conn);
  const ledger: RestoreLedgerEntry[] = [];

  try {
    await sleep(300); // settle, drop any boot chatter

    // Working-buffer layout: which blocks are placed (phantom-param gate).
    const placedBlocks = new Set<string>();
    const layout: string[] = [];
    for (const position of [1, 2, 3, 4] as const) {
      const r = await session.readShort({
        pidLow: BLOCK_SLOT_PID_LOW,
        pidHigh: BLOCK_SLOT_PID_HIGH_BASE + (position - 1),
      });
      const name = r.ok ? (BLOCK_NAMES_BY_VALUE[r.u32!] ?? 'none') : `read-failed(${r.error})`;
      layout.push(`slot ${position}: ${name}`);
      if (r.ok && name !== 'none') placedBlocks.add(name);
    }
    console.log('Working-buffer layout (read first, per the phantom-param caveat):');
    for (const l of layout) console.log(`  ${l}`);
    console.log(`  placed blocks: ${[...placedBlocks].join(', ') || '(none)'}\n`);

    // fn 0x02 capability probe (gen-2 transfer hypothesis), read-only.
    const fn02Anchor: Param | undefined = P['global.tuningref'] ?? targets[0]?.param;
    const fn02: Fn02Capability = fn02Anchor !== undefined
      ? await probeFn02(session, fn02Anchor.pidLow, fn02Anchor.pidHigh)
      : { supported: false, classification: 'skipped (no anchor param available)' };
    console.log(`fn 0x02 capability probe: ${fn02.classification}`);
    if (fn02.sampleFrameHex) console.log(`  frame: ${fn02.sampleFrameHex}`);
    console.log('');

    // Pass A.
    console.log(`Pass A: ${targets.length} params`);
    const passA = await runPassA(session, targets, placedBlocks, fn02);

    // Pass B.
    const passB: PassBResult[] = [];
    if (writeMidpoints) {
      console.log(`\nPass B: log10 taper discrimination (${log10Keys.length} candidate keys)`);
      for (const key of log10Keys) {
        const param = P[key];
        const blockPlaced = param.block === 'global' || placedBlocks.has(param.block);
        if (!blockPlaced) {
          passB.push({ key, kind: 'skipped', verdict: 'SKIP-UNPLACED', detail: `block '${param.block}' not placed; phantom-param writes do not land in the working buffer` });
          continue;
        }
        const r = await runTaperCase(session, key, param, ledger);
        passB.push(r);
        console.log(`  ${r.verdict.padEnd(22)} ${key}  ${r.restored === false ? '!! RESTORE FAILED' : ''}`);
        if (r.verdict === 'NO-ACK') {
          console.log('  Aborting pass B taper loop on wire failure (abort-and-restore policy).');
          break;
        }
      }

      console.log(`\nPass B: GHOST enum rosters (${ghostEnumKeys.length} enums, amp block)`);
      if (!placedBlocks.has('amp')) {
        console.log('  amp not placed; skipping all GHOST enum cases.');
        for (const key of ghostEnumKeys) {
          passB.push({ key, kind: 'skipped', verdict: 'SKIP-UNPLACED', detail: 'amp not placed' });
        }
      } else {
        for (const key of ghostEnumKeys) {
          const param = (AMP_GHOST_PARAMS as Record<string, Param>)[key];
          const r = await runEnumRosterCase(session, key, param, ledger);
          passB.push(r);
          console.log(`  ${r.verdict.padEnd(22)} ${key}  ${r.restored === false ? '!! RESTORE FAILED' : ''}`);
          if (r.verdict === 'NO-ACK') {
            console.log('  Aborting pass B enum loop on wire failure.');
            break;
          }
        }
      }
    }

    // ── Artifacts ────────────────────────────────────────────────────
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-raw.syx`, Uint8Array.from(session.rawLog));
    writeFileSync(
      `${OUT_DIR}/${OUT_BASE}-results.json`,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        layout, placedBlocks: [...placedBlocks],
        fn02Capability: fn02,
        passA, passB,
      }, undefined, 2),
    );

    const count = (v: string) => passA.filter((r) => r.verdict === v).length;
    const md: string[] = [
      '# AM4 deep-verify probe findings',
      '',
      `> Generated by \`scripts/_research/probe-am4-deep-verify.ts\` at ${new Date().toISOString()}`,
      '',
      `Layout: ${layout.join('; ')}`,
      '',
      `## fn 0x02 capability probe (gen-2 transfer hypothesis)`,
      '',
      fn02.classification,
      fn02.sampleFrameHex ? `\nFrame: \`${fn02.sampleFrameHex}\`` : '',
      '',
      '## Pass A summary',
      '',
      `| Verdict | Count |`,
      `|---|---|`,
      ...(['PASS', 'FAIL', 'AMBIGUOUS', 'NO-ORACLE-RANGE-OK', 'NO-ORACLE-RANGE-FAIL', 'SKIP-UNPLACED', 'NO-ACK'] as const)
        .map((v) => `| ${v} | ${count(v)} |`),
      '',
      'Note: the AM4 echoes no display label on its decoded read paths, so',
      'NO-ORACLE verdicts are range-sanity only. The 0x0D descriptor dump per',
      'param (raw hex + float32 scan + ASCII scan, in the JSON) is captured for',
      'offline decode of the 40-byte descriptor format.',
      '',
      '## Pass A per-param',
      '',
      '| Key | Source | Verdict | u32 | Decode | Detail |',
      '|---|---|---|---|---|---|',
      ...passA.map((r) =>
        `| ${r.key} | ${r.source} | ${r.verdict} | ${r.u32 ?? ''} | ${r.decodedDisplay ?? ''} | ${r.detail.replace(/\|/g, '/')} |`),
      '',
    ];
    if (writeMidpoints) {
      md.push(
        '## Pass B (write-midpoints) per-key',
        '',
        '| Key | Kind | Verdict | orig u32 | mid u32 | expect log/lin | Restored | Detail |',
        '|---|---|---|---|---|---|---|---|',
        ...passB.map((r) =>
          `| ${r.key} | ${r.kind} | ${r.verdict} | ${r.origU32 ?? ''} | ${r.midU32 ?? ''} | ${r.expectedLog ?? ''}/${r.expectedLin ?? ''} | ${r.restored === undefined ? 'n/a' : r.restored ? `yes (${r.restoreMethod}, d=${r.restoreDeltaTicks})` : 'NO'} | ${r.detail.replace(/\|/g, '/')} |`),
        '',
      );
      const unrestored = passB.filter((r) => r.restored === false);
      if (unrestored.length > 0) {
        md.push('### RESTORE FAILURES (manual attention needed)', '', ...unrestored.map((r) => `- ${r.key}: orig u32 ${r.origU32}`), '');
      }
    }
    writeFileSync(`${OUT_DIR}/${OUT_BASE}-findings.md`, md.join('\n'));

    console.log(`\nWrote ${OUT_DIR}/${OUT_BASE}-findings.md`);
    console.log(`Wrote ${OUT_DIR}/${OUT_BASE}-results.json`);
    console.log(`Wrote ${OUT_DIR}/${OUT_BASE}-raw.syx`);
    const failures = passA.filter((r) => r.verdict === 'FAIL' || r.verdict === 'NO-ORACLE-RANGE-FAIL').length;
    console.log(`\nPass A: ${passA.length} params, ${failures} flagged.`);
    if (writeMidpoints) {
      const confirmed = passB.filter((r) => r.verdict === 'LOG10-CONFIRMED').length;
      const refuted = passB.filter((r) => r.verdict === 'LINEAR-REFUTES-LOG10').length;
      console.log(`Pass B: ${confirmed} log10 confirmed, ${refuted} refuted, ${passB.filter((r) => r.verdict.startsWith('SKIP')).length} skipped.`);
    }
  } catch (err) {
    console.error('\nFATAL:', err instanceof Error ? err.message : err);
    if (ledger.length > 0) {
      console.error(`Attempting emergency restore of ${ledger.length} outstanding mutation(s)...`);
      for (const entry of [...ledger]) {
        try {
          const r = await restoreParam(session, entry);
          console.error(`  ${entry.key}: ${r.restored ? `restored via ${r.method}` : `RESTORE FAILED (delta ${r.deltaTicks} ticks); orig u32 was ${entry.origU32}`}`);
        } catch (e2) {
          console.error(`  ${entry.key}: restore attempt threw (${e2 instanceof Error ? e2.message : e2}); orig u32 was ${entry.origU32}`);
        }
      }
    }
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
