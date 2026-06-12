// verify-axe-fx-ii-getpreset-channel-walk.ts
//
// Gated test: P3b-getpreset-channel-walk (READ-path analog of
// verify-paramsbychannel-emission.ts, which only covers the WRITE path).
//
// Catches the "get_preset does not return all channel state" regression
// class, fully offline. This is the read-side blind spot the alpha.17
// founder test surfaced: get_preset({include_channel_state:true}) is the
// ONLY path that returns both X and Y for a channel-bearing block, and
// NOTHING in CI exercised it:
//   - verify-paramsbychannel-emission.ts covers apply_preset EMITTING
//     per-channel ops (write).
//   - verify-response-shape-parity.ts drives getPreset(ctx) with NO
//     options (default = active-channel-only), and the shipped II mock
//     returns a fixed value for every fn 0x02 GET and pretends every block
//     is on channel X, so the inactive-Y walk branch never ran.
//
// So if the X/Y decode silently breaks (Y dropped, Y mirrors X, Y partial,
// channel_status wrong), no test fails. This file closes that gap with a
// purpose-built fake connection whose fn 0x1F dump is CHANNEL-BLOCKED x2 with
// DISTINCT X (quarter 0) and Y (quarter 1) values for one channel-bearing
// block (Drive), then asserts:
//   1. default get_preset  → params_by_channel:{X} + channel_status:'active'
//      (default stays X-only; fails if someone silently surfaces Y by default).
//   2. get_preset({include_channel_state:true}) →
//        - channel_status === 'all_channels'
//        - params_by_channel has BOTH X and Y, same key set
//        - at least the two knob params (gain calibrated, tone opaque)
//          come back DISTINCT between X and Y (proves Y is read from quarter 1
//          of the dump, not a copy of the X quarter).
//
// Wire model (matches packages/fractal-gen2/src/descriptor/reader.ts getPreset):
//   - fn 0x20 GET_GRID_LAYOUT → one Drive 1 (id 133) placed, routed.
//   - fn 0x0E QUERY_STATES    → one engaged/X record (active channel = X
//                                at zero round-trips, the default path).
//   - fn 0x0F GET_PRESET_NAME → "Chan Walk Test".
//   - fn 0x1F SYSEX_GET_ALL_PARAMS → 0x74/0x75/0x76 triple carrying a
//                                CHANNEL-BLOCKED x2 body: quarter 0 = X,
//                                quarter 1 = Y (itemCount = stride * 2). The
//                                reader decodes BOTH channels from this one
//                                dump; there is no per-param fn 0x02 Y-walk.
//   - fn 0x29 SCENE_NUMBER     → scene 1.
//
// Run:
//   npx tsx scripts/verify-axe-fx-ii-getpreset-channel-walk.ts
//
// Status: offline, no hardware. Exits 0 on pass, non-zero on any failure.

// Importing the descriptor registers the Axe-Fx II param-kind resolver as
// an import-time side effect (same as the live server boot), so decodeWire
// is available for calibrated knobs.
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';
import type { MidiConnection } from '@mcp-midi-control/core/midi/transport.js';
import type { DispatchCtx, PresetSnapshot } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  AXE_FX_II_BLOCKS,
  KNOWN_PARAMS,
  AXE_FX_II_XL_PLUS_MODEL_ID,
  type AxeFxIIBlock,
  type AxeFxIIParam,
} from 'fractal-midi/gen2/axe-fx-ii';

let failures = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK   -- ${label}`);
  } else {
    failures++;
    console.error(`  FAIL -- ${label}${detail ? `: ${detail}` : ''}`);
  }
}

// ── Wire-byte helpers (host-emulating-device side) ───────────────────────
const F0 = 0xf0;
const F7 = 0xf7;
const MFR = [0x00, 0x01, 0x74];
const MODEL = AXE_FX_II_XL_PLUS_MODEL_ID; // 0x07

function encode14(v: number): [number, number] {
  return [v & 0x7f, (v >> 7) & 0x7f];
}
function pack16(v: number): [number, number, number] {
  return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03];
}
function cksum(headFromF0: number[]): number {
  // XOR of every byte after F0 through the last payload byte, & 0x7f.
  return headFromF0.slice(1).reduce((a, b) => a ^ b, 0) & 0x7f;
}
function frame(payloadAfterModel: number[]): number[] {
  const head = [F0, ...MFR, MODEL, ...payloadAfterModel];
  return [...head, cksum(head), F7];
}

// ── Fixture target: Drive 1 (channel-bearing) ────────────────────────────
const drive: AxeFxIIBlock | undefined = AXE_FX_II_BLOCKS.find((b) => b.name === 'Drive 1');
check('fixture: Drive 1 block exists and canBypass (channel-bearing)', drive?.canBypass === true, `drive=${JSON.stringify(drive)}`);
if (drive === undefined) { reportAndExit(); throw new Error('no drive block'); }
const DRIVE_ID = drive.id;
const DRIVE_GROUP = drive.groupCode;

// Build the (paramId → param) index for the Drive group, exactly as the
// reader's buildGroupParamIndex does (position-as-paramId overlay).
const driveParams = new Map<number, AxeFxIIParam>();
for (const key of Object.keys(KNOWN_PARAMS)) {
  const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
  if (p.groupCode === DRIVE_GROUP) driveParams.set(p.paramId, p);
}
const maxParamId = Math.max(...driveParams.keys());

// Distinct X / Y wire values per paramId. Both stay inside 0..65534 and the
// +20000 offset guarantees a different value (and, for monotonic decoders,
// a different display) on every param.
function xWire(paramId: number): number {
  return (10000 + paramId * 137) % 50000;
}
function yWire(paramId: number): number {
  return (xWire(paramId) + 20000) % 50000;
}

// fn 0x1F CHANNEL-BLOCKED x2 dump: quarter 0 = X, quarter 1 = Y, at
// `channel * stride + paramId` with `stride = maxParamId + 1`. The reader
// decodes X from quarter 0 and Y from quarter 1 of this ONE dump (no per-param
// fn 0x02 Y-walk, no channel-state mutation). Gaps stay 0 and the reader
// skips them (no registered paramId at that index).
const STRIDE = maxParamId + 1;
const dumpValues: number[] = new Array(STRIDE * 2).fill(0);
for (const paramId of driveParams.keys()) {
  dumpValues[paramId] = xWire(paramId);            // quarter 0 = X
  dumpValues[STRIDE + paramId] = yWire(paramId);   // quarter 1 = Y
}

// ── Fake connection ──────────────────────────────────────────────────────
// One handler set drives both onMessage subscribers (readAllParams) and
// receiveSysExMatching predicates. send() synthesizes the device's reply
// frames for a recognised request and dispatches them, in order, on the
// next tick (so the caller's listener is registered first).
function makeFakeConn(): MidiConnection {
  const handlers = new Set<(bytes: number[]) => void>();
  // Per-effect current channel: 0 = X, 1 = Y. Default X.
  const channel = new Map<number, number>();

  function dispatch(frames: number[][]): void {
    if (frames.length === 0) return;
    setImmediate(() => {
      for (const f of frames) {
        for (const h of [...handlers]) {
          try { h(f); } catch { /* swallow */ }
        }
      }
    });
  }

  function responsesFor(out: number[]): number[][] {
    if (out[0] !== F0 || out[1] !== MFR[0] || out[2] !== MFR[1] || out[3] !== MFR[2]) return [];
    const fn = out[5];

    // fn 0x20 GET_GRID_LAYOUT → 48 cells, Drive 1 at (col 3, row 2), routed.
    if (fn === 0x20) {
      const cells = new Array(48 * 4).fill(0x00);
      const cellIdx = (3 - 1) * 4 + (2 - 1); // column-major, 4 rows/col
      const off = cellIdx * 4;
      cells[off] = DRIVE_ID & 0x7f;
      cells[off + 1] = (DRIVE_ID >> 7) & 0x7f;
      cells[off + 2] = 0x01; // routingFlags != 0 → input cabled (not unrouted)
      cells[off + 3] = 0x00;
      return [frame([0x20, ...cells])];
    }

    // fn 0x0E QUERY_STATES → one record, engaged + channel X. NOTE: this
    // response carries NO checksum (parser drops only the trailing F7).
    if (fn === 0x0e) {
      const tag = 0x01 | 0x02; // bit0 engaged=1, bit1 set ⇒ channel X
      const rec = [tag, 0x10, 0x00, 0x00, 0x00]; // state28 arbitrary (single block)
      return [[F0, ...MFR, MODEL, 0x0e, ...rec, F7]];
    }

    // fn 0x0F GET_PRESET_NAME.
    if (fn === 0x0f) {
      const name = Array.from('Chan Walk Test', (c) => c.charCodeAt(0));
      return [frame([0x0f, ...name, 0x00])];
    }

    // fn 0x1F SYSEX_GET_ALL_PARAMS → 0x74 header + 0x75 chunk + 0x76 footer.
    // Channel-blocked x2: itemCount = stride * 2 (X quarter then Y quarter).
    if (fn === 0x1f) {
      const effectId = (out[6] & 0x7f) | ((out[7] & 0x7f) << 7);
      if (effectId !== DRIVE_ID) return []; // unplaced block → device NACK (timeout)
      const itemCount = dumpValues.length;
      const header = frame([0x74, ...encode14(effectId), ...encode14(itemCount), 0x01]);
      const packed: number[] = [];
      for (const v of dumpValues) packed.push(...pack16(v));
      const chunk = frame([0x75, ...encode14(itemCount), ...packed]);
      const footer = frame([0x76]);
      return [header, chunk, footer];
    }

    // fn 0x11 SET/GET_BLOCK_CHANNEL. Request: [..]6,7=eff 8=chan 9=action.
    if (fn === 0x11) {
      const effectId = (out[6] & 0x7f) | ((out[7] & 0x7f) << 7);
      const action = out[9];
      if (action === 0x01) { // SET — record, no reply (matches live device)
        channel.set(effectId, out[8] & 0x7f);
        return [];
      }
      const chan = channel.get(effectId) ?? 0; // GET — echo current
      return [frame([0x11, ...encode14(effectId), chan & 0x7f])];
    }

    // fn 0x02 GET_BLOCK_PARAMETER (action 0x00 only). Channel-aware: return
    // the Y wire value while the block sits on Y (the inactive-channel walk),
    // X otherwise. SET (action 0x01) gets no reply.
    if (fn === 0x02) {
      const action = out[13];
      if (action !== 0x00) return [];
      const effectId = (out[6] & 0x7f) | ((out[7] & 0x7f) << 7);
      const paramId = (out[8] & 0x7f) | ((out[9] & 0x7f) << 7);
      const onY = (channel.get(effectId) ?? 0) === 1;
      const wire = onY ? yWire(paramId) : xWire(paramId);
      const label = onY ? `Y${wire}` : `X${wire}`;
      const labelBytes = Array.from(label, (c) => c.charCodeAt(0));
      return [frame([
        0x02, ...encode14(effectId), ...encode14(paramId),
        ...pack16(wire),
        0x00, 0x00, 0x00, 0x00, 0x00, // 5 unknown bytes
        ...labelBytes, 0x00,
      ])];
    }

    // fn 0x29 SCENE_NUMBER (query) → scene 0 (display 1).
    if (fn === 0x29) {
      return [frame([0x29, 0x00, 0x00, 0x00])];
    }

    return [];
  }

  return {
    send: (bytes) => dispatch(responsesFor(bytes)),
    receiveSysEx: () => Promise.reject(new Error('receiveSysEx not used by getPreset')),
    receiveSysExMatching: (predicate, timeoutMs = 800) =>
      new Promise<number[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          handlers.delete(handler);
          reject(new Error(`fake II transport: no response within ${timeoutMs}ms`));
        }, timeoutMs);
        const handler = (b: number[]) => {
          if (b[0] !== F0 || !predicate(b)) return;
          clearTimeout(timer);
          handlers.delete(handler);
          resolve(b);
        };
        handlers.add(handler);
      }),
    onMessage: (handler) => {
      handlers.add(handler);
      return () => { handlers.delete(handler); };
    },
    hasInput: true,
    close: () => { handlers.clear(); },
  };
}

function reportAndExit(): void {
  if (failures === 0) {
    console.log('\nverify-axe-fx-ii-getpreset-channel-walk: all assertions passed.');
    process.exit(0);
  }
  console.error(`\nverify-axe-fx-ii-getpreset-channel-walk: ${failures} failure(s).`);
  process.exit(1);
}

// ── Drive the reader ─────────────────────────────────────────────────────
const reader = AXEFX2_DESCRIPTOR.reader;
check('reader implements getPreset', typeof reader.getPreset === 'function');

async function main(): Promise<void> {
  if (reader.getPreset === undefined) { reportAndExit(); return; }

  // 1. DEFAULT path → active channel only.
  {
    const ctx: DispatchCtx = { conn: makeFakeConn(), descriptor: AXEFX2_DESCRIPTOR };
    let snap: PresetSnapshot | undefined;
    try {
      snap = await reader.getPreset(ctx);
    } catch (err) {
      check('default get_preset resolves', false, err instanceof Error ? err.message : String(err));
    }
    if (snap !== undefined) {
      check('default get_preset resolves', true);
      const slot = snap.slots.find((s) => s.block_type === 'drive');
      check('default: drive slot present', slot !== undefined, `slots=${JSON.stringify(snap.slots.map((s) => s.block_type))}`);
      check(
        "default: channel_status === 'active' (active-channel attribution, parked-perf default)",
        slot?.channel_status === 'active',
        `channel_status=${slot?.channel_status}`,
      );
      check(
        'default: params_by_channel has X only (no slow inactive-Y walk on the default path)',
        slot?.params_by_channel?.X !== undefined && slot?.params_by_channel?.Y === undefined,
        `params_by_channel keys=${slot?.params_by_channel ? Object.keys(slot.params_by_channel).join(',') : 'undefined'}`,
      );
    }
  }

  // 2. include_channel_state:true → full X + Y walk (the regression target).
  {
    const ctx: DispatchCtx = { conn: makeFakeConn(), descriptor: AXEFX2_DESCRIPTOR };
    let snap: PresetSnapshot | undefined;
    try {
      snap = await reader.getPreset(ctx, { include_channel_state: true });
    } catch (err) {
      check('include_channel_state get_preset resolves', false, err instanceof Error ? err.message : String(err));
    }
    if (snap !== undefined) {
      check('include_channel_state get_preset resolves', true);
      const slot = snap.slots.find((s) => s.block_type === 'drive');
      check('walk: drive slot present', slot !== undefined);

      const pbc = slot?.params_by_channel;
      check(
        "walk: channel_status === 'all_channels' (Y read, not dropped)",
        slot?.channel_status === 'all_channels',
        `channel_status=${slot?.channel_status}`,
      );
      check(
        'walk: params_by_channel has BOTH X and Y',
        pbc?.X !== undefined && pbc?.Y !== undefined,
        `keys=${pbc ? Object.keys(pbc).join(',') : 'undefined'}`,
      );

      if (pbc?.X !== undefined && pbc?.Y !== undefined) {
        const xKeys = Object.keys(pbc.X).sort();
        const yKeys = Object.keys(pbc.Y).sort();
        check(
          'walk: X and Y cover the SAME param set (Y walk is complete, not partial)',
          xKeys.length > 0 && xKeys.join(',') === yKeys.join(','),
          `xKeys=[${xKeys.join(',')}] yKeys=[${yKeys.join(',')}]`,
        );

        // gain: calibrated knob (displayMin/Max 0..10) → decodeWire numeric.
        // Distinct X/Y wire ⇒ distinct display ⇒ proves Y is a genuine
        // inactive-channel read, not a copy of the fn 0x1F X dump.
        check(
          'walk: gain differs between X and Y (calibrated knob; Y not mirrored from X)',
          pbc.X.gain !== undefined && pbc.Y.gain !== undefined && pbc.X.gain !== pbc.Y.gain,
          `X.gain=${pbc.X.gain} Y.gain=${pbc.Y.gain}`,
        );
        // tone: opaque knob (no calibration) → raw wire integer on both sides.
        check(
          'walk: tone differs between X and Y (opaque knob; raw wire distinct)',
          pbc.X.tone !== undefined && pbc.Y.tone !== undefined && pbc.X.tone !== pbc.Y.tone,
          `X.tone=${pbc.X.tone} Y.tone=${pbc.Y.tone}`,
        );
      }
    }
  }

  reportAndExit();
}

void main();
