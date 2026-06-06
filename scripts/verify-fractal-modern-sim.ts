/**
 * Codec-backed gen-3 device-simulator golden (M0, offline).
 *
 * Proves the simulator's response builders match the device wire shape with NO
 * editor and NO loopMIDI, so a shape error is caught here rather than as a
 * confusing non-render at M1. Two tiers:
 *
 *   - ALWAYS-RUN shape checks against a committed compact fixture
 *     (`scripts/fixtures/gen3-sim-frames.json`, a handful of real FM9 device
 *     frames): the render-gate frames (sub=0x2e layout map, sub=0x01 block
 *     descriptor) serve byte-identical under checksum recompute; the decoded
 *     frames (sub=0x7b placed-flag, fn=0x1F burst, sub=0x37 stream) project
 *     with the right length, echo, and channel-blocked value layout.
 *
 *   - CAPTURE-GATED full sweep against the gitignored connect+sync capture: feed
 *     every editor query to SimDevice and assert each served frame matches the
 *     paired device frame's length + echoed address bytes. Skipped (not failed)
 *     when the capture is absent, so `npm test` stays green on a fresh clone.
 *
 * The fn=0x1F head is 12 bytes (no flag byte; byte 10 is the checksum) and the
 * burst reassembles to itemCount = 4 × paramCount values — both asserted here.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  buildBroadcastBurst,
  recomputeGen3Checksum,
  parseBurstHead,
  GEN3_RESPONSE_LENGTHS,
  GEN3_MODEL_FM9,
  gen3Decode14,
} from '@mcp-midi-control/fractal-modern/simResponders.js';
import { assembleGen3BlockBulkRead } from 'fractal-midi/axe-fx-iii';
import { SimDevice, type CaptureFrame } from './_research/sim/SimDevice.js';
import { FM9_CONFIG } from '@mcp-midi-control/fractal-modern/configs/fm9.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, 'fixtures/gen3-sim-frames.json');
const CAPTURE = path.resolve(
  __dirname,
  '..',
  'samples/captured/decoded/fm9-capture3-enum-sweep-2026-06-03.frames.json',
);

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`  FAIL: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
const toBytes = (hex: string): number[] => hex.trim().split(/\s+/).map((b) => parseInt(b, 16));
const eq = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
const frame = (dir: 'OUT' | 'IN', hex: string): CaptureFrame => {
  const b = toBytes(hex);
  return { dir, fn: b[5], sub: b[6], len: b.length, hex };
};

interface Fixture {
  model_byte: number;
  placed_flag_eff58: { query: string; response: string };
  block_descriptor_eff58: { query: string; response: string };
  layout_map_2e: { query: string; response: string };
  stream_37: { query: string; response: string }[];
  bulk_read_eff66: { poll: string; burst: string[] };
}

console.log('fractal-modern sim golden (M0, offline)');

// ── Tier 1: always-run shape checks against the committed fixture ──────────
const fx = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Fixture;
ok('fixture model byte is FM9 0x12', fx.model_byte === GEN3_MODEL_FM9);

// Build a minimal SimDevice seeded from the fixture frames only.
const seedFrames: CaptureFrame[] = [
  frame('OUT', fx.placed_flag_eff58.query),
  frame('IN', fx.placed_flag_eff58.response),
  frame('OUT', fx.block_descriptor_eff58.query),
  frame('IN', fx.block_descriptor_eff58.response),
  frame('OUT', fx.layout_map_2e.query),
  frame('IN', fx.layout_map_2e.response),
  frame('OUT', fx.bulk_read_eff66.poll),
  ...fx.bulk_read_eff66.burst.map((h) => frame('IN', h)),
];
const sim = new SimDevice(FM9_CONFIG);
sim.seedFromCaptureFrames(seedFrames);

// Render-gate frames serve VERBATIM (checksum recompute is a no-op on a frame
// whose body is unchanged → byte-identical to the captured device frame).
{
  const captured = toBytes(fx.block_descriptor_eff58.response);
  const served = sim.handle(toBytes(fx.block_descriptor_eff58.query));
  ok('sub=0x01 descriptor served as one frame', served.length === 1);
  ok('sub=0x01 descriptor is byte-identical to capture', served.length === 1 && eq(served[0], captured));
  ok('sub=0x01 length gate (115)', served[0]?.length === GEN3_RESPONSE_LENGTHS[0x01]);
  ok('sub=0x01 echoes query bytes 5..11',
    served.length === 1 && eq(served[0].slice(5, 12), toBytes(fx.block_descriptor_eff58.query).slice(5, 12)));
}
{
  const captured = toBytes(fx.layout_map_2e.response);
  const served = sim.handle(toBytes(fx.layout_map_2e.query));
  ok('sub=0x2e layout map is byte-identical to capture', served.length === 1 && eq(served[0], captured));
  ok('sub=0x2e length gate (755)', served[0]?.length === GEN3_RESPONSE_LENGTHS[0x2e]);
}

// Placed-flag: verbatim for the seeded (un-mutated) block, with the placed marker.
{
  const served = sim.handle(toBytes(fx.placed_flag_eff58.query));
  ok('sub=0x7b placed length gate (23)', served[0]?.length === GEN3_RESPONSE_LENGTHS[0x7b]);
  ok('sub=0x7b placed marker is nonzero', (served[0][12] | served[0][13]) !== 0);
  ok('sub=0x7b echoes the query address',
    eq(served[0].slice(5, 12), toBytes(fx.placed_flag_eff58.query).slice(5, 12)));
}
// An unseeded effect projects an absent (all-zero) placed-flag. The editor
// never polls 0x7b for an absent block in the capture, so the all-zero shape is
// the builder's hypothesis (confirmed live at M4); this asserts the projector.
{
  const q = toBytes(fx.placed_flag_eff58.query);
  q[8] = 0x64; // address effect 100, which the sim has no block for
  q[9] = 0x00;
  const served = sim.handle(q);
  ok('sub=0x7b absent-block marker is zero', (served[0][12] | served[0][13]) === 0);
  ok('sub=0x7b absent still length 23', served[0].length === GEN3_RESPONSE_LENGTHS[0x7b]);
}

// Stream: a free-running counter, so two consecutive polls differ.
{
  const q = toBytes(fx.stream_37[0].query);
  const a = sim.handle(q);
  const b = sim.handle(q);
  ok('sub=0x37 stream length gate (23)', a[0]?.length === GEN3_RESPONSE_LENGTHS[0x37]);
  ok('sub=0x37 stream advances between polls', !eq(a[0], b[0]));
}

// fn=0x1F burst: 12-byte head (no flag byte), reassembles to itemCount values.
{
  const burst = fx.bulk_read_eff66.burst.map(toBytes);
  const reconstructed = assembleGen3BlockBulkRead(burst, GEN3_MODEL_FM9);
  ok('captured burst head decodes blockId 66', reconstructed.blockId === 66);
  ok('captured burst itemCount 292 = 73 × 4', reconstructed.itemCount === 292);
  ok('captured burst delivers itemCount values', reconstructed.values.length === reconstructed.itemCount);
  ok('captured 0x74 head is 12 bytes (no flag byte)', burst[0].length === 12);

  // Project the SAME values back into a burst and prove it round-trips.
  const projected = buildBroadcastBurst(GEN3_MODEL_FM9, {
    blockId: 66,
    itemCount: reconstructed.itemCount,
    values: reconstructed.values,
  });
  const head = parseBurstHead(projected[0]);
  ok('projected head is 12 bytes (no flag byte)', projected[0].length === 12);
  ok('projected head blockId/itemCount round-trip', head.blockId === 66 && head.itemCount === 292);
  const reAssembled = assembleGen3BlockBulkRead(projected, GEN3_MODEL_FM9);
  ok('projected burst reassembles to the same values',
    reAssembled.values.length === reconstructed.values.length
    && reAssembled.values.every((v, i) => v === reconstructed.values[i]));
  ok('projected burst passes the reader truncation guard',
    reAssembled.values.length >= reAssembled.itemCount);
  // Channel-blocked stride: 292 / 4 = 73; channel-A copy of paramId 0 is value[0].
  const stride = reconstructed.itemCount / 4;
  ok('channel stride is 73', stride === 73);
  ok('channel-B copy of paramId 0 is at index stride',
    reconstructed.values[stride] !== undefined);
}

// SimDevice routes a seeded fn=0x1F poll to the verbatim burst.
{
  const served = sim.handle(toBytes(fx.bulk_read_eff66.poll));
  ok('fn=0x1F poll returns the full burst', served.length === fx.bulk_read_eff66.burst.length);
  ok('fn=0x1F first served frame is the 0x74 head', served[0]?.[5] === 0x74);
}

// ── Tier 2: capture-gated full sweep ──────────────────────────────────────
if (existsSync(CAPTURE)) {
  const frames = JSON.parse(readFileSync(CAPTURE, 'utf8')) as CaptureFrame[];
  const full = new SimDevice(FM9_CONFIG);
  full.seedFromCaptureFrames(frames);

  // The render-gate subs are STABLE single-frame reads (one response shape per
  // address); their length must match exactly or the grid will not draw. The
  // other fn=0x01 subs in this enum-sweep capture (sub=0x01's reverb-selected
  // 172-byte variant, sub=0x1f's sequential enum-label stream, the typed
  // GET/enum reads) are STATEFUL/sequential: the same address returns different
  // frames as the editor walks dropdowns, so a first-wins address store can't
  // reproduce a given sequential frame. Those are the M3 enum-harvest surface,
  // not render-gating, so their length divergence is reported, not failed. The
  // echo-of-bytes-5..11 invariant is hard-asserted on EVERY served frame.
  const RENDER_GATE_SUBS = new Set([0x2e, 0x7b, 0x1a, 0x1b, 0x2a, 0x4b]);
  let echoChecked = 0;
  let echoFails = 0;
  let gateChecked = 0;
  let gateLenFails = 0;
  const softLen = new Map<number, { n: number; match: number }>();
  for (let i = 0; i < frames.length - 1; i++) {
    const q = frames[i];
    if (q.dir !== 'OUT' || q.fn !== 0x01) continue;
    let resp: CaptureFrame | undefined;
    for (let j = i + 1; j < Math.min(frames.length, i + 6); j++) {
      if (frames[j].dir === 'IN' && frames[j].fn === 0x01 && frames[j].sub === q.sub) {
        resp = frames[j];
        break;
      }
    }
    if (!resp) continue;
    const qb = toBytes(q.hex);
    const served = full.handle(qb);
    if (served.length === 0) continue; // write sub-actions return nothing
    const rb = toBytes(resp.hex);
    echoChecked++;
    if (!eq(served[0].slice(5, 12), qb.slice(5, 12))) echoFails++;
    if (RENDER_GATE_SUBS.has(q.sub)) {
      gateChecked++;
      if (served[0].length !== rb.length) {
        gateLenFails++;
        if (gateLenFails <= 5) {
          console.error(`    render-gate sub=0x${q.sub.toString(16)} eff ` +
            `${gen3Decode14(qb[8], qb[9])}: len ${served[0].length} vs ${rb.length}`);
        }
      }
    } else {
      const s = softLen.get(q.sub) ?? { n: 0, match: 0 };
      s.n++;
      if (served[0].length === rb.length) s.match++;
      softLen.set(q.sub, s);
    }
  }
  ok(`capture sweep: echo invariant on all ${echoChecked} served fn=0x01 frames`, echoFails === 0,
    echoFails > 0 ? `${echoFails} echo mismatches` : '');
  ok(`capture sweep: render-gate subs length-match (${gateChecked} frames)`, gateLenFails === 0,
    gateLenFails > 0 ? `${gateLenFails} length mismatches` : '');
  const softSummary = [...softLen.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([s, v]) => `0x${s.toString(16)}:${v.match}/${v.n}`)
    .join(' ');
  console.log(`  (stateful/sequential subs, length-match rate, reported only: ${softSummary})`);
} else {
  console.log('  (capture-gated sweep skipped — gitignored capture not present)');
}

console.log(`\nfractal-modern sim golden: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
