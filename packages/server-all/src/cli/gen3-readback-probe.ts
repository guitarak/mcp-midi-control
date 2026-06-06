#!/usr/bin/env node
/**
 * Gen-3 Fractal read-back probe — a READ-ONLY, tester-runnable diagnostic
 * for the FM9, FM3, and Axe-Fx III (one codec family, model byte aside).
 *
 * Ships in the release so an owner can confirm our gen-3 read path on real
 * hardware in one step (via `installer/<device>-probe.cmd`) — no Wireshark,
 * no editor, no menu clicking. It connects over USB MIDI, polls the active
 * preset's blocks, and writes a JSON file to email back.
 *
 * Two jobs, both READ-ONLY (this probe NEVER sends a SET / store / save —
 * only bulk-read polls and a value GET, neither of which mutates device
 * state; consistent with the project's probe-is-read-only policy):
 *
 *   JOB 1 — verify the read path. For each addressable block we send the
 *     fn=0x1F block bulk-read poll and collect the 0x74/0x75/0x76
 *     state-broadcast burst it triggers (~1 ms later).
 *     `assembleGen3BlockBulkRead` turns the burst into a paramId-indexed
 *     value array. First broad hardware confirmation of get_param /
 *     get_preset across many blocks (today only reverb is spot-checked).
 *
 *   JOB 2 — the GET-response experiment that could close the enum
 *     name->raw-id gap. We fire the canonical fn=0x01 sub=0x09 GET at
 *     Reverb 1's TYPE param (effectId 66, paramId 10) and log what comes
 *     back. Ground truth (FM9): that param's "Medium Spring" is RAW enum id
 *     524 but ORDINAL 16 on the broadcast. If the GET response carries 524,
 *     the raw-id space is reachable by passive reads and we can solve
 *     name->raw-id for the whole family with no editor capture. If it
 *     carries 16 (or nothing), the editor + Wireshark capture stays the
 *     route.
 *
 * Usage:
 *   node dist/cli/gen3-readback-probe.js <fm9|fm3|axe-fx-iii> [output.json]
 *   (dev) npm run fm9:probe -- [output.json]   (and fm3:/axefx3:)
 *
 * Exit codes: 0 = ran and wrote the report; 1 = bad device / no port found.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  connectFM9,
  connectFM3,
  connectAxeFxIII,
  toHex,
  type MidiConnection,
} from '@mcp-midi-control/fractal-modern/midi.js';
import {
  AXE_FX_III_BLOCKS,
  type AxeFxIIIBlock,
  buildBlockBulkReadPoll,
  assembleGen3BlockBulkRead,
  isGen3BroadcastFrame,
  buildGetParameter,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  buildQueryPatchName,
  buildGetScene,
  buildGetTempo,
  buildStatusDump,
} from 'fractal-midi/axe-fx-iii';

// Universal MIDI Identity Request (not Fractal-specific): F0 7E 7F 06 01 F7.
// Every class-compliant device should reply with F0 7E <ch> 06 02 <mfr…>
// <family> <member> <version…> F7 — confirms the device is alive and reports
// its firmware without the owner typing it. 100% read-only, standard MIDI.
const IDENTITY_REQUEST = [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];

interface DeviceSpec {
  label: string;
  modelByte: number;
  connect: () => MidiConnection;
}
const DEVICES: Record<string, DeviceSpec> = {
  fm9: { label: 'FM9', modelByte: 0x12, connect: connectFM9 },
  fm3: { label: 'FM3', modelByte: 0x11, connect: connectFM3 },
  'axe-fx-iii': { label: 'Axe-Fx III', modelByte: 0x10, connect: connectAxeFxIII },
};

// Reverb 1 TYPE — our one ground-truth enum: "Medium Spring" = raw 524 / ordinal 16.
const REVERB_EFFECT_ID = 66;
const REVERB_TYPE_PARAM_ID = 10;
const GROUND_TRUTH = { name: 'Medium Spring', rawId: 524, ordinal: 16, enumCount: 79 };

// Per-poll listen window. Bursts arrive ~1 ms after the poll; 400 ms is a
// generous ceiling that also bounds the worst case for un-placed blocks
// (which simply return nothing and time out cleanly).
const POLL_WINDOW_MS = 400;
const GET_WINDOW_MS = 600;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// argv[2] = device key (fm9 / fm3 / axe-fx-iii); argv[3] = optional output path.
const deviceKey = (process.argv[2] ?? '').toLowerCase();
const device = DEVICES[deviceKey];
if (!device) {
  console.error(`Usage: gen3-readback-probe <fm9|fm3|axe-fx-iii> [output.json]`);
  console.error(`Unknown device "${process.argv[2] ?? '(none)'}".`);
  process.exit(1);
}
const MODEL = device.modelByte;
const outArg = process.argv[3] ?? `${deviceKey}-probe-output.json`;
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);

console.error(`${device.label} read-back probe (READ-ONLY — never writes/saves your presets)`);

let conn: MidiConnection;
try {
  conn = device.connect();
} catch (err) {
  // connect throws a device-specific "not found" message with driver /
  // port-exclusivity hints already filled in.
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!conn.hasInput) {
  console.error(`\nFound a ${device.label} output port but no input port — the probe needs`);
  console.error('to read replies. Unplug/replug the USB cable and try again.');
  conn.close();
  process.exit(1);
}

// One persistent listener; each send slices off only frames that arrived
// in its window. `connect` reassembles fragmented SysEx before delivery.
const inbound: number[][] = [];
conn.onMessage((bytes) => { if (bytes[0] === 0xf0) inbound.push(bytes); });

/**
 * Send `bytes`, then collect every SysEx that arrives until either `windowMs`
 * elapses or `doneWhen(framesSoFar)` returns true. The early-exit lets a
 * completed burst (terminated by its 0x76 END frame) return in ~1 ms instead
 * of waiting out the full window; un-placed blocks that never reply still
 * cost the full `windowMs` so we can record them as silent.
 */
async function sendAndCollect(
  bytes: number[],
  windowMs: number,
  doneWhen?: (frames: number[][]) => boolean,
): Promise<number[][]> {
  const startLen = inbound.length;
  conn!.send(bytes);
  const deadline = Date.now() + windowMs;
  for (;;) {
    const frames = inbound.slice(startLen);
    if (doneWhen && frames.length > 0 && doneWhen(frames)) return frames;
    if (Date.now() >= deadline) return frames;
    await sleep(15);
  }
}

interface BlockResult {
  block: string;
  groupCode: string;
  effectId: number;
  framesReceived: number;
  headFrames: number;
  bodyFrames: number;
  endFrames: number;
  blockId?: number;
  itemCount?: number;
  valueCount?: number;
  reverbTypeOrdinal?: number; // reverb block only: positional record[10]
  assembled: boolean;
  error?: string;
}

async function runJob1(): Promise<BlockResult[]> {
  const targets = AXE_FX_III_BLOCKS.filter(
    (b): b is AxeFxIIIBlock & { firstId: number } =>
      b.firstId !== null && (b as AxeFxIIIBlock).addressable !== false,
  );
  console.error(`\nJOB 1 — polling ${targets.length} block types (instance 1)…`);
  const results: BlockResult[] = [];
  for (const b of targets) {
    const effectId = b.firstId;
    let frames: number[][];
    try {
      frames = await sendAndCollect(
        buildBlockBulkReadPoll(effectId, MODEL),
        POLL_WINDOW_MS,
        (fs) => fs.some((f) => isGen3BroadcastFrame(f, 0x76, MODEL)), // burst terminator
      );
    } catch (err) {
      results.push({
        block: b.name, groupCode: b.groupCode, effectId,
        framesReceived: 0, headFrames: 0, bodyFrames: 0, endFrames: 0,
        assembled: false, error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const heads = frames.filter((f) => isGen3BroadcastFrame(f, 0x74, MODEL));
    const bodies = frames.filter((f) => isGen3BroadcastFrame(f, 0x75, MODEL));
    const ends = frames.filter((f) => isGen3BroadcastFrame(f, 0x76, MODEL));
    const r: BlockResult = {
      block: b.name, groupCode: b.groupCode, effectId,
      framesReceived: frames.length,
      headFrames: heads.length, bodyFrames: bodies.length, endFrames: ends.length,
      assembled: false,
    };
    if (heads.length > 0) {
      try {
        const burst = assembleGen3BlockBulkRead(frames, MODEL);
        r.blockId = burst.blockId;
        r.itemCount = burst.itemCount;
        r.valueCount = burst.values.length;
        r.assembled = true;
        if (effectId === REVERB_EFFECT_ID) r.reverbTypeOrdinal = burst.values[REVERB_TYPE_PARAM_ID];
      } catch (err) {
        r.error = err instanceof Error ? err.message : String(err);
      }
    }
    results.push(r);
    const tag = r.assembled
      ? `block=${r.blockId} items=${r.itemCount} values=${r.valueCount}`
      : (frames.length ? `${frames.length} frames, not assembled` : 'no response (likely not placed)');
    console.error(`  ${b.name.padEnd(18)} eff=${String(effectId).padStart(3)} → ${tag}`);
  }
  return results;
}

interface GetExperiment {
  effectId: number;
  paramId: number;
  request: string;
  framesReceived: number;
  frames: Array<{ kind: string; hex: string; effectId?: number; paramId?: number; value?: number }>;
  verdict: string;
}

async function runJob2(): Promise<GetExperiment> {
  console.error(`\nJOB 2 — GET experiment on Reverb 1 TYPE (eff ${REVERB_EFFECT_ID}, pid ${REVERB_TYPE_PARAM_ID})…`);
  const req = buildGetParameter(REVERB_EFFECT_ID, REVERB_TYPE_PARAM_ID, MODEL);
  const frames = await sendAndCollect(req, GET_WINDOW_MS);
  const decoded: GetExperiment['frames'] = [];
  const carriedValues: number[] = [];

  for (const f of frames) {
    if (isSetGetParameterResponse(f, MODEL)) {
      try {
        const p = parseSetGetParameterResponse(f, MODEL);
        decoded.push({ kind: `fn01:${p.kind}`, hex: toHex(f), effectId: p.effectId, paramId: p.paramId, value: p.value });
        carriedValues.push(p.value);
      } catch {
        decoded.push({ kind: 'fn01:unparsed', hex: toHex(f) });
      }
    } else if (
      isGen3BroadcastFrame(f, 0x74, MODEL)
      || isGen3BroadcastFrame(f, 0x75, MODEL)
      || isGen3BroadcastFrame(f, 0x76, MODEL)
    ) {
      decoded.push({ kind: 'broadcast', hex: toHex(f) });
    } else {
      decoded.push({ kind: 'other', hex: toHex(f) });
    }
  }

  // If the GET triggered a broadcast burst, the reverb-type ordinal lives at
  // record[10]. Pull it so the verdict can compare against ground truth too.
  // CAVEAT: broadcast positional index == catalog paramId is only verified for
  // REVERB_MIX (paramId 0). It is FALSIFIED for the amp/DISTORT block (paramId
  // 2 -> index 149; FM9 capture 2026-06-04). This probe's verdict cross-checks
  // multiple candidate values, so it tolerates the index being off, but do not
  // copy `values[paramId]` into a shipping read path — see reader.ts guard.
  if (frames.some((f) => isGen3BroadcastFrame(f, 0x74, MODEL))) {
    try {
      const burst = assembleGen3BlockBulkRead(frames, MODEL);
      if (burst.values[REVERB_TYPE_PARAM_ID] !== undefined) carriedValues.push(burst.values[REVERB_TYPE_PARAM_ID]);
    } catch { /* not a clean burst — ignore */ }
  }

  let verdict: string;
  if (frames.length === 0) {
    verdict = 'NO RESPONSE — sub=0x09 GET not honored on this firmware. Read path is broadcast-only; raw-id route needs the FM9-Edit capture.';
  } else if (carriedValues.includes(GROUND_TRUTH.rawId)) {
    verdict = `JACKPOT — a response carried RAW id ${GROUND_TRUTH.rawId}. GET reaches the raw-id space; name->raw-id is solvable by probe across all enums.`;
  } else if (carriedValues.includes(GROUND_TRUTH.ordinal)) {
    verdict = `ORDINAL only — a response carried ${GROUND_TRUTH.ordinal} (the broadcast ordinal), not raw ${GROUND_TRUTH.rawId}. Raw-id still needs the FM9-Edit capture.`;
  } else {
    verdict = `RESPONDED but carried neither ${GROUND_TRUTH.rawId} (raw) nor ${GROUND_TRUTH.ordinal} (ordinal) — current reverb type differs, or a new field layout. Inspect frames.`;
  }
  console.error(`  ${frames.length} frame(s). ${verdict}`);
  return { effectId: REVERB_EFFECT_ID, paramId: REVERB_TYPE_PARAM_ID, request: toHex(req), framesReceived: frames.length, frames: decoded, verdict };
}

// ── JOB 0: documented-query sweep ──────────────────────────────────
//
// Fire each documented v1.4 query (and the universal MIDI Identity
// Request) and record the RAW reply. These commands are documented for
// the III but have NEVER been confirmed on ANY gen-3 hardware, so this
// is pure discovery: which documented reads actually answer, and with
// what frame shape. All READ-ONLY (queries + identity; none mutate
// state). We log raw bytes and decode offline rather than trust the
// model-byte-specific parsers, since the reply shape is what we're here
// to learn.
interface QueryResult {
  query: string;
  request: string;
  responded: boolean;
  responseFns: string[]; // function byte of each reply frame (hex)
  responses: string[]; // raw hex of each reply frame
}

async function runJob0(): Promise<QueryResult[]> {
  const queries: Array<{ name: string; bytes: number[] }> = [
    { name: 'midi_identity_request', bytes: IDENTITY_REQUEST },
    { name: 'query_patch_name (fn=0x0D)', bytes: buildQueryPatchName('current', MODEL) },
    { name: 'get_active_scene (fn=0x0C)', bytes: buildGetScene(MODEL) },
    { name: 'get_tempo (fn=0x14)', bytes: buildGetTempo(MODEL) },
    { name: 'status_dump (fn=0x13)', bytes: buildStatusDump(MODEL) },
  ];
  console.error('\nJOB 0 — documented-query sweep (which spec reads answer on hardware)…');
  const results: QueryResult[] = [];
  for (const q of queries) {
    const frames = await sendAndCollect(q.bytes, GET_WINDOW_MS);
    const r: QueryResult = {
      query: q.name,
      request: toHex(q.bytes),
      responded: frames.length > 0,
      responseFns: frames.map((f) => (f[5] !== undefined ? `0x${f[5].toString(16)}` : '?')),
      responses: frames.map((f) => toHex(f)),
    };
    results.push(r);
    console.error(`  ${q.name.padEnd(28)} → ${r.responded ? `${frames.length} reply frame(s) [fn ${r.responseFns.join(',')}]` : 'no response'}`);
  }
  return results;
}

async function main(): Promise<void> {
  const job0 = await runJob0();
  const job1 = await runJob1();
  const job2 = await runJob2();
  const placed = job1.filter((r) => r.assembled);
  const answeredQueries = job0.filter((q) => q.responded).map((q) => q.query);

  const report = {
    probe: 'gen3-readback-probe',
    version: 2,
    device: device.label,
    capturedAt: new Date().toISOString(),
    modelByte: MODEL,
    groundTruth: GROUND_TRUTH,
    note: 'READ-ONLY diagnostic. Job0 = documented-query sweep (raw replies). Job1 = fn=0x1F poll → 0x74/0x75/0x76 burst decode. Job2 = sub=0x09 GET-response experiment on reverb type.',
    summary: {
      documentedQueriesAnswered: answeredQueries,
      blocksPolled: job1.length,
      blocksWithData: placed.length,
      reverbTypeOrdinalObserved: job1.find((r) => r.effectId === REVERB_EFFECT_ID)?.reverbTypeOrdinal,
      getExperimentVerdict: job2.verdict,
    },
    job0_documentedQueries: job0,
    job1_blockReads: job1,
    job2_getExperiment: job2,
  };

  fs.writeFileSync(outPath, JSON.stringify(report, undefined, 2));
  conn!.close();

  console.error(`\n✓ Wrote ${outPath}`);
  console.error(`  Documented queries answered: ${answeredQueries.length ? answeredQueries.join(', ') : '(none)'}`);
  console.error(`  ${placed.length}/${job1.length} block types returned data.`);
  console.error(`  GET experiment: ${job2.verdict}`);
  console.error('\nPlease email me this JSON file. Thank you!');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  try { conn?.close(); } catch { /* ignore */ }
  process.exit(1);
});
