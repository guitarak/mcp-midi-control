/**
 * Axe-Fx III SysEx wire builders.
 *
 * BEFORE EDITING THIS FILE, READ:
 *   - `docs/SYSEX-MAP-AXE-FX-III.md`   (project spec summary + known bugs)
 *   - `docs/manuals/AxeFx3-MIDI-3rdParty.txt`  (Fractal v1.4 PDF, extracted)
 *
 * The v1.4 PDF is the only public spec Fractal ships for the III's
 * third-party MIDI surface. It IS in this repo as extracted text.
 * Don't web-search or guess opcodes — grep the .txt first.
 *
 * Envelope: `F0 00 01 74 0x10 [function] [payload...] [checksum] F7`.
 * Same modern Fractal family as AM4 (model 0x15), FM3 (0x11), FM9
 * (0x12), VP4 (0x14) — III is 0x10.
 *
 * Function-byte map (all opcodes documented in the PDF):
 *   - 0x0A SET/GET BYPASS         (id id dd)
 *   - 0x0B SET/GET CHANNEL        (id id dd)
 *   - 0x0C SET/GET SCENE          (dd)
 *   - 0x0D QUERY PATCH NAME       (dd dd — preset number; returns nn nn + 32-char name)
 *   - 0x0E QUERY SCENE NAME       (dd — scene index; returns nn + 32-char name)
 *   - 0x0F SET/GET LOOPER STATE   (dd — button index; returns state bitfield)
 *   - 0x10 TEMPO TAP              (no payload; also the "tempo down-beat" push frame)
 *   - 0x11 TUNER ON/OFF           (dd; push variant carries note/string/cents)
 *   - 0x13 STATUS DUMP            (no payload; returns id id dd triples)
 *   - 0x14 SET/GET TEMPO          (dd dd — BPM)
 *
 * NOT documented in v1.4 (deliberately omitted by Fractal):
 *   - SET_PRESET / SWITCH_PRESET — use MIDI Program Change (CC0/CC32 + PC).
 *   - SET_PARAMETER_VALUE (0x02) — family inference only; param-IDs not public.
 *   - STORE_PRESET / SAVE — multi-frame envelope (0x77/0x78/0x79) per
 *     community RE; not in v1.4.
 *   - SET_PRESET_NAME / SET_SCENE_NAME — names are query-only.
 */
import { fractalChecksum } from '../shared/checksum.js';

/** Axe-Fx III model byte. From Fractal's published spec. */
export const AXE_FX_III_MODEL_ID = 0x10;

/** SysEx framing bytes shared across the entire modern Fractal family. */
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR_PREFIX = [0x00, 0x01, 0x74] as const;

// ── Function-ID bytes from the Axe-Fx III spec v1.4 ────────────────

export const FN_SET_GET_BYPASS = 0x0a;
export const FN_SET_GET_CHANNEL = 0x0b;
export const FN_SET_GET_SCENE = 0x0c;
export const FN_QUERY_PATCH_NAME = 0x0d;
export const FN_QUERY_SCENE_NAME = 0x0e;
export const FN_SET_GET_LOOPER = 0x0f;
export const FN_TEMPO_TAP = 0x10;
export const FN_TUNER_ON_OFF = 0x11;
export const FN_STATUS_DUMP = 0x13;
export const FN_SET_GET_TEMPO = 0x14;

/**
 * 0x64 MULTIPURPOSE_RESPONSE — the III's error channel.
 *
 * When the III receives a malformed SysEx or an unsupported function it
 * replies with:
 *
 *   `F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7`   (10 bytes)
 *
 * `echoed_fn` is the function byte the host sent that the device
 * rejected; `result_code` is the device's reason byte (0x00 has been
 * seen for "general / checksum error", 0x05 has been seen for "NACK"
 * during preset-store experiments). Wire shape is documented in v1.4
 * and confirmed against a 2018 community capture — see
 * `docs/axefx3-fn01-decode.md`.
 */
export const FN_MULTIPURPOSE_RESPONSE = 0x64;

/**
 * 0x01 PARAMETER_SETGET — III parameter-write opcode (NOT the II's
 * 0x02 opcode). **Not in the v1.4 III spec** (Fractal deliberately
 * omits parameter writes), but the wire shape is byte-verified
 * against 10 community-captured frames spanning two effect blocks
 * and two sub-action codes — see `docs/axefx3-set-parameter-captures.md`.
 *
 * Evidence chain (pivot 2026-05-18):
 *   • FC-12 footswitch captures (4 frames): Drive 1/2
 *     boost ON/OFF. Effect IDs 58/59 (`ID_DISTORT1` / `ID_DISTORT2`),
 *     paramId 40, sub-action `52 00` (mouse-drag). Already decoded
 *     into the field-layout table in `docs/axefx3-fn01-decode.md`.
 *   • Mountain Utilities forum captures (6 frames, from a public
 *     forum capture 2019-03-13): AxeEdit III writing Delay 1 TIME. Effect ID 70
 *     (`ID_DELAY1`), paramId 2. Four frames sub-action `52 00`
 *     (mouse-drag, intermediate values mid-drag) + two frames
 *     sub-action `09 00` (typed-input, final value). All 10 frames
 *     are 23 bytes, checksums validate, fields decode cleanly.
 *   •  Ghidra mining: opcode 0x01 appears in the III
 *     message-builder caller list — firmware code path is present.
 *
 * Earlier sessions (85+86) shipped `FN_SET_PARAMETER = 0x02` as a
 * II→III model-byte-swap port. That was WRONG — the III uses fn=0x01
 * with a 2-byte sub-action discriminator, NOT fn=0x02. 
 * reverted to the byte-verified envelope.
 *
 * Sub-actions seen on the wire:
 *   • `09 00` — typed-input SET (clean envelope, drag-context bytes
 *     zero). This is what we ship for `buildSetParameter`.
 *   • `52 00` — mouse-drag SET (drag-context bytes at pos 12-14
 *     carry cursor delta). Identical semantically; we don't emit
 *     this shape — the device accepts either.
 *   • `04 01` — STATE_BROADCAST (device→host, unsolicited state
 *     stream emitted on parameter change). NOT a sync SET response
 *     — the III appears to have no documented synchronous response
 *     to fn=0x01 SET.
 *
 * Status: 🟢 SET verified against 10 public captures, ready to ship.
 * GET shape still 🟡 — no captured GET frames exist on the open web
 * as of ; the implementation uses `09 00` with value=0 as
 * a hypothesis, matching the SET shape with an empty value field.
 */
export const FN_PARAMETER_SETGET = 0x01;

/** III parameter SETGET sub-action codes (pos 6-7 of the envelope). */
const SUB_ACTION_SET_TYPED: readonly [number, number] = [0x09, 0x00];
const SUB_ACTION_STATE_BROADCAST: readonly [number, number] = [0x04, 0x01];

/** Query sentinel — when this is the value byte, the device responds with current state. */
export const QUERY_SENTINEL = 0x7f;

// ── Encoding helpers ───────────────────────────────────────────────

/**
 * Encode a 14-bit value as a 2-byte septet pair (low 7 bits, then high
 * 7 bits — little-endian). Preset numbers, BPMs, and effect IDs across
 * the Fractal family use this.
 */
function encode14(n: number): [number, number] {
  if (!Number.isInteger(n) || n < 0 || n > 0x3fff) {
    throw new Error(`encode14: ${n} out of range (0..16383)`);
  }
  return [n & 0x7f, (n >> 7) & 0x7f];
}

/** Decode a 2-byte septet pair (low 7 bits then high 7 bits) into a 14-bit integer. */
function decode14(lo: number, hi: number): number {
  return (lo & 0x7f) | ((hi & 0x7f) << 7);
}

/**
 * Build an envelope: `F0 00 01 74 [model] [function] [payload...]
 * [checksum] F7`. Checksum covers everything from `F0` through the
 * last payload byte (XOR-7bit).
 */
function buildEnvelope(fn: number, payload: readonly number[]): number[] {
  const body = [SYSEX_START, ...FRACTAL_MFR_PREFIX, AXE_FX_III_MODEL_ID, fn, ...payload];
  const checksum = fractalChecksum(body);
  return [...body, checksum, SYSEX_END];
}

// ── 0x01 PARAMETER_SETGET ─────────────────────────────────────────
//
// Per cookbook entry [[iii-fn01-set-parameter-envelope]], AxeEdit
// III's editor-side builder FUN_14033ec70 (Ghidra dump
// `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
// L1325-1531, re-confirmed at
// `ghidra-axe-edit-iii-actions-and-shapes.txt` L22641-22850) defines
// the fn=0x01 payload as a 6-field structure:
//
//   { action14, blockId14, paramId14, value32, modifier14, tailCount14, tail[] }
//
// Field widths in the editor's own emission: action/block/param/
// modifier/tailCount each 2-byte LSB-first septet pair (14-bit
// unsigned, via [[septet-14bit]]); value32 a 5-byte LSB-first
// 5-septet 32-bit unsigned (via `pack5Septet32`); tail[] variable
// raw bytes (length = tailCount14).
//
// What the shipped `buildSetParameter` actually emits is the
// captured FC-12 / typed-input layout — byte-verified against all 10
// public captures in `docs/devices/axe-fx-iii/set-parameter-captures.md`:
//
//   pos 0-5:   F0 00 01 74 10 01            (envelope + fn=0x01)
//   pos 6-7:   action14 / sub-action        (09 00 typed, 52 00 mouse-drag)
//   pos 8-9:   blockId14 / effect ID
//   pos 10-11: paramId14
//   pos 12-14: three zero bytes             (mouse-drag carries cursor
//                                            context here; typed-input
//                                            and all captures-of-record
//                                            are zero)
//   pos 15-17: value (3-byte packValue16)   (value's low 14 bits at
//                                            pos 15-16; pos 17 is the
//                                            16-bit overflow nibble,
//                                            zero in every capture)
//   pos 18-20: three zero bytes
//   pos 21:    checksum
//   pos 22:    F7
//
// This layout does NOT match a literal `pack5Septet32` at pos 12-16
// — the captured frames place value's low bytes at pos 15-16 (3 zero
// bytes preceding) while FUN_14033ec70 would place them at pos
// 12-13. Both layouts share action14 / blockId14 / paramId14 (pos
// 6-11) but diverge in the post-paramId region. For 14-bit values
// with modifier=0 and tail=[], we ship the captured layout because
// it is byte-verified; firmware acceptance of the FUN_14033ec70
// alternative (modifier, tail, >14-bit values) is unverified and
// not exposed in the public API. See cookbook refinement-history
// dated 2026-05-22 for the structural reconciliation.

/**
 * Pack a 16-bit unsigned value into the wire's three 7-bit septets.
 *
 *   septet 0 = bits 6..0   (lowest seven bits)
 *   septet 1 = bits 13..7  (next seven bits)
 *   septet 2 = bits 15..14 (top two bits, zero-padded into a 7-bit byte)
 *
 * Valid input range 0..65534 (16-bit minus one — II wiki convention,
 * carried forward to the III on the assumption param-value ranges
 * scaled with firmware). All observed III captures use 14-bit values
 * (pos 17 always zero); the 16-bit slot exists in the envelope shape
 * but isn't exercised by any public capture yet.
 */
export function packValue16(value: number): [number, number, number] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new Error(`packValue16 input out of range: ${value}`);
  }
  return [
    value & 0x7f,
    (value >> 7) & 0x7f,
    (value >> 14) & 0x03,
  ];
}

/** Inverse of `packValue16`. Inputs may have unused upper bits — masked. */
export function unpackValue16(b0: number, b1: number, b2: number): number {
  return ((b0 & 0x7f)) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
}

/**
 * Pack a 32-bit unsigned value into five 7-bit septets, LSB-first.
 *
 * Mirrors FUN_14033ec70 in AxeEdit III (the editor's canonical fn=0x01
 * payload builder) — Ghidra dump
 * `samples/captured/decoded/ghidra-axe-edit-iii-store-preset.txt`
 * L1463-1467:
 *
 *   pbVar4[6]  = (v >> 0)  & 0x7f
 *   pbVar4[7]  = (v >> 7)  & 0x7f
 *   pbVar4[8]  = (v >> 14) & 0x7f
 *   pbVar4[9]  = (v >> 21) & 0x7f
 *   pbVar4[10] = (v >> 28)
 *
 * Range: 0..2^32-1. For values in 0..16383, bytes 0-1 carry the low
 * 14 bits LSB-first and bytes 2-4 are zero (the low-14-bit prefix is
 * identical to `packValue16(v).slice(0, 2)`).
 *
 * 🟡 Pure helper — NOT used by `buildSetParameter` on the wire. The
 * shipped builder emits the FC-12 / typed-input layout (3 zero bytes
 * + `packValue16` + 3 zero bytes), byte-verified against 10 public
 * captures. `pack5Septet32` is exposed for advanced callers who have
 * hardware-tested confidence in the FUN_14033ec70 layout (e.g. for
 * modifier or tail slots) and want to compose their own frames. Do
 * NOT wire this into a SET path without a captured frame to validate
 * against. See cookbook entry [[iii-fn01-set-parameter-envelope]]
 * refinement-history 2026-05-22.
 */
export function pack5Septet32(value: number): [number, number, number, number, number] {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`pack5Septet32 input out of range (0..2^32-1): ${value}`);
  }
  return [
    (value >>> 0) & 0x7f,
    (value >>> 7) & 0x7f,
    (value >>> 14) & 0x7f,
    (value >>> 21) & 0x7f,
    (value >>> 28) & 0x7f,
  ];
}

/**
 * SET PARAMETER (function 0x01, sub-action 0x09 0x00 — typed input).
 *
 * Internal 6-field model (per FUN_14033ec70 in AxeEdit III; see
 * cookbook entry [[iii-fn01-set-parameter-envelope]]):
 *
 *   { action14, blockId14, paramId14, value32, modifier14, tailCount14, tail[] }
 *
 * Emitted wire bytes (FC-12 / typed-input layout, byte-verified):
 *
 *   `F0 00 01 74 10 01 09 00 [id_lo id_hi] [pid_lo pid_hi]
 *    00 00 00 [v0 v1 v2] 00 00 00 [cs] F7`
 *
 * 23 bytes. Byte-verified against all 10 public captures in
 * `docs/devices/axe-fx-iii/set-parameter-captures.md` (4 FC-12
 * footswitch frames + 6 Mountain Utilities forum frames from a public
 * forum capture (2019), AxeEdit III). The mouse-drag form (sub-action `52 00`)
 * carries non-zero context at pos 12-14 — the device accepts either,
 * but typed-input is the clean shape appropriate for programmatic
 * writes.
 *
 * The 6-field model's `modifier14`, `tailCount14`, and `tail[]` slots
 * (and the wide value32 form of Field D) are NOT exposed in the
 * public API yet: no public capture exercises them, no III owner has
 * confirmed device acceptance, and shipping an opt-in code path that
 * silently emits untested bytes would be a real regression risk. To
 * enable them, capture an AxeEdit III frame that uses the relevant
 * slot (or get hardware-tested confirmation from a III owner), then
 * add a hardware-verified golden alongside the goldens in
 * `set-parameter-captures.md`. Field-D / value32 caveat: AxeEdit III
 * packs the value as a 32-bit LSB-first 5-septet (see `pack5Septet32`
 * helper); firmware acceptance of values requiring >14 bits is
 * unverified.
 *
 * 🟢 Outbound wire shape verified across 10 public captures spanning
 * two effect blocks (Drive 1/2, Delay 1) and two paramIds (40 boost,
 * 2 TIME). The device's RESPONSE shape (sync echo or async
 * STATE_BROADCAST `04 01`) is not in any public capture — wrap with
 * `sendAndWatchForError` to surface 0x64 rejects, but don't expect a
 * synchronous SET echo.
 */
export function buildSetParameter(
  effectId: number,
  paramId: number,
  value: number,
): number[] {
  return buildEnvelope(FN_PARAMETER_SETGET, [
    ...SUB_ACTION_SET_TYPED,
    ...encode14(effectId),
    ...encode14(paramId),
    0x00, 0x00, 0x00,
    ...packValue16(value),
    0x00, 0x00, 0x00,
  ]);
}

/**
 * GET PARAMETER (function 0x01, sub-action 0x09 0x00 with value=0).
 *
 * 🟡 Hypothesis only — no public GET capture exists. The send shape
 * mirrors SET with the value field zeroed, on the theory that the III
 * either echoes the param's current value or emits a `04 01`
 * STATE_BROADCAST asynchronously. Callers should treat a missing
 * response within ~250 ms as "GET not supported on this firmware,"
 * not as a tool error, and fall back to 0x13 STATUS_DUMP or
 * STATE_BROADCAST listening.
 */
export function buildGetParameter(effectId: number, paramId: number): number[] {
  return buildEnvelope(FN_PARAMETER_SETGET, [
    ...SUB_ACTION_SET_TYPED,
    ...encode14(effectId),
    ...encode14(paramId),
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
    0x00, 0x00, 0x00,
  ]);
}

/**
 * Block-bypass via PARAMETER_SETGET (paramId 255 is the bypass
 * register per Axe-Fx II wiki — III binding unverified). The III
 * v1.4 spec exposes a separate 0x0A SET_BYPASS opcode — prefer that
 * one for production bypass writes. This builder exists as a
 * fallback for the 0x02-port era and is kept compatible with the
 * pivoted fn=0x01 envelope.
 *
 * 🟡 III-untested specifically for paramId=255 binding.
 */
export function buildSetParameterBypass(effectId: number, bypassed: boolean): number[] {
  return buildSetParameter(effectId, 255, bypassed ? 1 : 0);
}

/**
 * Predicate: is this an inbound fn=0x01 PARAMETER frame? Accepts any
 * sub-action — `52 00` (echo of host SET, observed in passive sniffs),
 * `04 01` (STATE_BROADCAST), or `09 00` (theoretically a host
 * typed-input echo). The parser disambiguates by sub-action.
 */
export function isSetGetParameterResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_PARAMETER_SETGET);
}

/**
 * Discriminator for `parseSetGetParameterResponse` results so callers can
 * branch on the sub-action without re-reading the sub-action bytes.
 *
 * - `'set_echo'` — sub-action `09 00` or `52 00`. Both `paramId` and
 *   `value` are populated. Round-trip self-consistent with
 *   `buildSetParameter`.
 * - `'state_broadcast'` — sub-action `04 01`. `paramId` is reported as
 *   `0` because the wire frame omits the field; track the last-SET
 *   paramId in the caller and attribute the broadcast value to it.
 */
export type AxeFxIIIParameterFrameKind = 'set_echo' | 'state_broadcast';

/**
 * Parse an inbound fn=0x01 PARAMETER frame. Returns
 * `{ kind, effectId, paramId, value, subAction }`.
 *
 * Two response shapes seen in captures:
 *   • Sub-action `52 00` (23 bytes): host-SET echo. effId at pos 2-3
 *     of payload, paramId at 4-5, value at 9-11 (packValue16). Round-
 *     trip self-consistent with `buildSetParameter`.
 *   • Sub-action `04 01` (23 bytes): STATE_BROADCAST. effId at
 *     pos 2-3, paramId field is zero (the broadcast doesn't carry
 *     it), value at 6-7 as a 2-septet LS-first pair.
 *
 * For `04 01` STATE_BROADCAST frames we return `paramId: 0` to
 * signal the caller that paramId is unknown — they should track
 * which param was last SET to attribute the broadcast value.
 *
 * For consumers that prefer an explicit broadcast handler, see
 * `parseStateBroadcast`, which throws on non-broadcast frames.
 */
export function parseSetGetParameterResponse(bytes: readonly number[]): {
  kind: AxeFxIIIParameterFrameKind;
  effectId: number;
  paramId: number;
  value: number;
  subAction: number;
} {
  if (!isSetGetParameterResponse(bytes)) {
    throw new Error(`parseSetGetParameterResponse: not a fn=0x01 frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 15) {
    throw new Error(`parseSetGetParameterResponse: payload too short (${payload.length}B; expected ≥15)`);
  }
  const subAction = (payload[0] & 0x7f) | ((payload[1] & 0x7f) << 7);
  if (payload[0] === 0x04 && payload[1] === 0x01) {
    // STATE_BROADCAST — different field layout (no paramId slot, value
    // at pos 6-7 as a 2-septet pair, optional flag at pos 8).
    return {
      kind: 'state_broadcast',
      effectId: decode14(payload[2], payload[3]),
      paramId: 0,
      value: decode14(payload[6], payload[7]),
      subAction,
    };
  }
  // SET / SET-echo layout (sub-action `09 00` or `52 00`).
  return {
    kind: 'set_echo',
    effectId: decode14(payload[2], payload[3]),
    paramId: decode14(payload[4], payload[5]),
    value: unpackValue16(payload[9], payload[10], payload[11]),
    subAction,
  };
}

/**
 * Parse the async `04 01` STATE_BROADCAST sub-action specifically.
 * Throws on any other sub-action.
 *
 * Use this when listening for the III's unsolicited state-change push
 * (the closest thing the III has to a GET response — the device emits
 * a broadcast whenever a parameter changes, whether the change was
 * driven by the host, by the front panel, or by another editor).
 *
 * Caller must track which paramId was last SET on this effectId to
 * attribute the broadcast value — the broadcast frame does NOT echo
 * the paramId.
 */
export function parseStateBroadcast(bytes: readonly number[]): {
  effectId: number;
  value: number;
} {
  const parsed = parseSetGetParameterResponse(bytes);
  if (parsed.kind !== 'state_broadcast') {
    throw new Error(
      `parseStateBroadcast: frame is sub-action 0x${parsed.subAction.toString(16).padStart(4, '0')}, not 0x0104 STATE_BROADCAST`,
    );
  }
  return { effectId: parsed.effectId, value: parsed.value };
}

// ── 0x05 SET_GRID_CELL ─────────────────────────────────────────────
//
// 🟡 NOT in v1.4 III spec. Wire shape ported from the Axe-Fx II's
// hardware-verified encoder. The II uses 0x05 to place a block at a
// grid cell (or clear it with blockId=0); whether III firmware honors
// this opcode is unverified. Rejections arrive as 0x64
// MULTIPURPOSE_RESPONSE with result_code 0x04 (msg not recognized).

const FN_SET_GRID_CELL = 0x05;

/**
 * SET_GRID_CELL (function 0x05). Places `blockId` at cell (row, col).
 *
 *   `F0 00 01 74 10 05 [blockId_lo blockId_hi] [cell_idx] [0x00] [cs] F7`
 *
 * cell_idx = (col - 1) * rows + (row - 1) — column-major. The II uses
 * 4-row grids so cell_idx = (col-1)*4 + (row-1). The III runs a 4×14
 * grid in Mark II firmware; the cell index shape is the same.
 *
 * 🟡 III-untested. The 8-byte payload was rejected by II firmware as
 * "payload too short" — the II's encoder always sends 4 payload bytes
 * (blockId_lo, blockId_hi, cell_idx, reserved=0). We mirror that.
 */
export function buildSetGridCell(opts: {
  row: number;
  col: number;
  blockId: number;
}): number[] {
  const { row, col, blockId } = opts;
  if (!Number.isInteger(row) || row < 1 || row > 4) {
    throw new Error(`buildSetGridCell: row out of range (1..4): ${row}`);
  }
  if (!Number.isInteger(col) || col < 1 || col > 14) {
    throw new Error(`buildSetGridCell: col out of range (1..14): ${col}`);
  }
  if (!Number.isInteger(blockId) || blockId < 0 || blockId > 0x3fff) {
    throw new Error(`buildSetGridCell: blockId out of range (0..16383): ${blockId}`);
  }
  const cellIdx = (col - 1) * 4 + (row - 1);
  return buildEnvelope(FN_SET_GRID_CELL, [
    blockId & 0x7f,
    (blockId >> 7) & 0x7f,
    cellIdx & 0x7f,
    0x00, // reserved per II convention
  ]);
}

// ── 0x09 SET_PRESET_NAME ───────────────────────────────────────────
//
// 🟡 NOT in v1.4 III spec — names are query-only there. Wire shape
// ported from the Axe-Fx II (function 0x09 takes 32 ASCII chars of
// the new working-buffer preset name). The III may honor it because
// the same firmware family handles 0x0D QUERY_PATCH_NAME; we test
// here and surface rejections.

const FN_SET_PRESET_NAME = 0x09;

/**
 * SET_PRESET_NAME (function 0x09) — set the working-buffer preset name.
 * Name is padded to 32 ASCII-printable chars (space-padded). The II
 * uses this for the working buffer only; pairing with 0x1D STORE_PRESET
 * is what persists the rename to flash.
 *
 * 🟡 III-untested.
 */
export function buildSetPresetName(name: string): number[] {
  if (name.length > 32) {
    throw new Error(`buildSetPresetName: name too long (max 32): "${name}" (${name.length})`);
  }
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new Error(`buildSetPresetName: non-printable char at position ${i}: 0x${c.toString(16)}`);
    }
  }
  const padded = name.padEnd(32, ' ');
  return buildEnvelope(FN_SET_PRESET_NAME, [
    ...Array.from(padded, (c) => c.charCodeAt(0)),
  ]);
}

// ── 0x1D STORE_PRESET ──────────────────────────────────────────────
//
// 🟡 NOT in v1.4 III spec — Fractal's published III save envelope is
// the multi-frame 0x77/0x78/0x79 chain (community RE, hypothesis-only;
// requires Huffman-compressed preset content). The II's 0x1D STORE
// command is a much simpler 10-byte envelope: "persist the current
// working buffer to slot N" with no preset payload — the device just
// commits whatever's in the working buffer.
//
// We try the 0x1D shape here because: (a) it's safe — wrong opcode
// emits a 0x64 rejection, no flash impact; (b) the III's firmware
// family probably still has the 0x1D code path; (c) if III honors it,
// users get save-to-slot without the Huffman work.
//
// Wire envelope (matches II):
//
//   `F0 00 01 74 10 1D [preset_high] [preset_low] [cs] F7`
//
// preset_high = (n >> 7) & 0x7F, preset_low = n & 0x7F. MSB-first
// byte ordering per II convention (and per the III's own 0x14
// GET_TEMPO response, which uses MSB-first).

const FN_STORE_PRESET = 0x1d;

/** STORE_PRESET (function 0x1D). 🟡 III-untested. */
export function buildStorePreset(presetNumber: number): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 0x3fff) {
    throw new Error(`buildStorePreset: preset out of range (0..16383): ${presetNumber}`);
  }
  const high = (presetNumber >> 7) & 0x7f;
  const low = presetNumber & 0x7f;
  return buildEnvelope(FN_STORE_PRESET, [high, low]);
}

// ── MIDI Program Change (preset switch via standard MIDI) ──────────
//
// The III v1.4 spec says: "To CHANGE the active preset on the III via
// MIDI, use standard Program Change messages (with CC 0 + CC 32 Bank
// Select for slots > 127)." This is NOT a SysEx envelope — it's
// 3 short MIDI messages back-to-back. The III is documented to honor
// these without any firmware-version caveats.

/**
 * Build the short-MIDI byte sequence to switch the III to preset
 * `presetNumber` (0..1023). Returns 9 bytes:
 *
 *   `B0 00 bankMsb`     (Control Change 0 = Bank Select MSB)
 *   `B0 20 bankLsb`     (Control Change 32 = Bank Select LSB)
 *   `C0 programNumber`  (Program Change on channel 1)
 *
 * Default MIDI channel is 1 (0x0 in the channel nibble). The III
 * listens on its globally-configured MIDI channel — users with a
 * non-default channel will need to call `axefx3_switch_preset` with
 * a `channel` arg (1..16) on a future iteration. For now we default
 * to channel 1, which matches Fractal's factory setting.
 *
 * Per the III v1.4 PDF: 1024 presets are addressed across 8 banks of
 * 128 each. presetNumber 0..127 = bank 0 PC 0..127, presetNumber
 * 128..255 = bank 1 PC 0..127, etc. CC0 carries the bank's MSB and
 * CC32 carries the LSB; both are 7-bit values, so bank = (CC0 << 7)
 * | CC32. The III ignores CC0 when bank fits in CC32 (just CC32 + PC
 * is sufficient for presets 0..16383), but spec-correct usage sends
 * both — we do.
 */
export function buildSwitchPresetPC(
  presetNumber: number,
  channel: number = 1,
): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 1023) {
    throw new Error(
      `buildSwitchPresetPC: presetNumber ${presetNumber} out of range (0..1023).`,
    );
  }
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
    throw new Error(`buildSwitchPresetPC: channel ${channel} out of range (1..16).`);
  }
  const ch0 = (channel - 1) & 0x0f;
  const bank = Math.floor(presetNumber / 128);
  const pc = presetNumber % 128;
  return [
    0xb0 | ch0, 0x00, (bank >> 7) & 0x7f, // CC 0 = Bank MSB
    0xb0 | ch0, 0x20, bank & 0x7f,        // CC 32 = Bank LSB
    0xc0 | ch0, pc & 0x7f,                // Program Change
  ];
}

// ── 0x0A SET/GET BYPASS ────────────────────────────────────────────

/**
 * SET BYPASS (function 0x0A). Targets the active scene only — per
 * spec the III's bypass writes don't carry a scene argument.
 *
 *   `F0 00 01 74 10 0A [id_lo] [id_hi] [dd] [cs] F7`
 *
 * `dd=0` engaged, `dd=1` bypassed.
 */
export function buildSetBypass(effectId: number, bypassed: boolean): number[] {
  return buildEnvelope(FN_SET_GET_BYPASS, [
    ...encode14(effectId),
    bypassed ? 1 : 0,
  ]);
}

/** GET BYPASS (function 0x0A with `dd=0x7F`). Device responds with same envelope shape. */
export function buildGetBypass(effectId: number): number[] {
  return buildEnvelope(FN_SET_GET_BYPASS, [
    ...encode14(effectId),
    QUERY_SENTINEL,
  ]);
}

// ── 0x0B SET/GET CHANNEL ───────────────────────────────────────────

/**
 * SET CHANNEL (function 0x0B). Targets the active scene only.
 * `channel` is 0..3 mapping to A..D.
 *
 *   `F0 00 01 74 10 0B [id_lo] [id_hi] [channel] [cs] F7`
 */
export function buildSetChannel(
  effectId: number,
  channel: 0 | 1 | 2 | 3,
): number[] {
  if (!Number.isInteger(channel) || channel < 0 || channel > 3) {
    throw new Error(`buildSetChannel: channel ${channel} out of range (0..3 = A..D)`);
  }
  return buildEnvelope(FN_SET_GET_CHANNEL, [
    ...encode14(effectId),
    channel,
  ]);
}

/** GET CHANNEL (function 0x0B with `dd=0x7F`). */
export function buildGetChannel(effectId: number): number[] {
  return buildEnvelope(FN_SET_GET_CHANNEL, [
    ...encode14(effectId),
    QUERY_SENTINEL,
  ]);
}

// ── 0x0C SET/GET SCENE ─────────────────────────────────────────────

/**
 * SET SCENE (function 0x0C). `sceneIndex` is 0..7. Spec also says
 * "Returns: ... where dd is the current scene" — so SET also echoes.
 */
export function buildSetScene(sceneIndex: number): number[] {
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 7) {
    throw new Error(`buildSetScene: sceneIndex ${sceneIndex} out of range (0..7)`);
  }
  return buildEnvelope(FN_SET_GET_SCENE, [sceneIndex & 0x7f]);
}

/** GET SCENE (function 0x0C with `dd=0x7F`). */
export function buildGetScene(): number[] {
  return buildEnvelope(FN_SET_GET_SCENE, [QUERY_SENTINEL]);
}

// ── 0x0D QUERY PATCH NAME ──────────────────────────────────────────

/**
 * QUERY PATCH NAME (function 0x0D).
 *
 *   Request:  `F0 00 01 74 10 0D [dd dd preset#] [cs] F7`
 *   Current:  `F0 00 01 74 10 0D 7F 7F [cs] F7`
 *   Response: `F0 00 01 74 10 0D [nn nn preset#] [dd*32 name] [cs] F7`
 *
 * Pass a preset number 0..1023 (Mark II) / 0..511 (Mark I) to look
 * up that preset's name, or `'current'` to query the active preset.
 * Response contains BOTH the preset number AND the name — there's no
 * separate "get preset number" function in the v1.4 spec.
 *
 * NB: this is NOT a preset-switching command. To CHANGE the active
 * preset on the III via MIDI, use standard Program Change messages
 * (with CC 0 + CC 32 Bank Select for slots > 127). The III has no
 * SysEx preset-switch in the v1.4 public spec.
 */
export function buildQueryPatchName(
  presetNumber: number | 'current',
): number[] {
  if (presetNumber === 'current') {
    return buildEnvelope(FN_QUERY_PATCH_NAME, [QUERY_SENTINEL, QUERY_SENTINEL]);
  }
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 1023) {
    throw new Error(
      `buildQueryPatchName: presetNumber ${presetNumber} out of range (0..1023).`,
    );
  }
  return buildEnvelope(FN_QUERY_PATCH_NAME, encode14(presetNumber));
}

// ── 0x0E QUERY SCENE NAME ──────────────────────────────────────────

/**
 * QUERY SCENE NAME (function 0x0E).
 *
 *   Request:  `F0 00 01 74 10 0E [dd scene] [cs] F7`
 *   Current:  `F0 00 01 74 10 0E 7F [cs] F7`
 *   Response: `F0 00 01 74 10 0E [nn scene] [dd*32 name] [cs] F7`
 *
 * No SET variant in the spec.
 */
export function buildQuerySceneName(sceneIndex: number | 'current'): number[] {
  if (sceneIndex === 'current') {
    return buildEnvelope(FN_QUERY_SCENE_NAME, [QUERY_SENTINEL]);
  }
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || sceneIndex > 7) {
    throw new Error(
      `buildQuerySceneName: sceneIndex ${sceneIndex} out of range (0..7).`,
    );
  }
  return buildEnvelope(FN_QUERY_SCENE_NAME, [sceneIndex & 0x7f]);
}

// ── 0x0F SET/GET LOOPER STATE ──────────────────────────────────────

export type LooperAction =
  | 'record'    // 0
  | 'play'      // 1
  | 'undo'      // 2
  | 'once'      // 3
  | 'reverse'   // 4
  | 'half_speed'; // 5

const LOOPER_ACTION_VALUES: Record<LooperAction, number> = {
  record: 0,
  play: 1,
  undo: 2,
  once: 3,
  reverse: 4,
  half_speed: 5,
};

/**
 * SET LOOPER (function 0x0F). Triggers a looper "button press":
 *
 *   `F0 00 01 74 10 0F [dd button] [cs] F7`
 *
 * Buttons per spec: 0=Record, 1=Play, 2=Undo, 3=Once, 4=Reverse,
 * 5=Half-speed.
 */
export function buildSetLooper(action: LooperAction): number[] {
  return buildEnvelope(FN_SET_GET_LOOPER, [LOOPER_ACTION_VALUES[action]]);
}

/**
 * GET LOOPER STATE (function 0x0F with `dd=0x7F`). Returns a state
 * bitfield: bit 0=Record, 1=Play, 2=Overdub, 3=Once, 4=Reverse,
 * 5=Half-speed.
 */
export function buildGetLooperState(): number[] {
  return buildEnvelope(FN_SET_GET_LOOPER, [QUERY_SENTINEL]);
}

// ── 0x10 TEMPO TAP ─────────────────────────────────────────────────

/**
 * TEMPO TAP (function 0x10). Single-shot, no payload. Each call
 * counts as one tap-tempo press; the III computes BPM from the
 * inter-tap interval the same way as the front-panel TAP button.
 */
export function buildTempoTap(): number[] {
  return buildEnvelope(FN_TEMPO_TAP, []);
}

// ── 0x11 TUNER ON/OFF ──────────────────────────────────────────────

/** TUNER ON/OFF (function 0x11). */
export function buildSetTuner(on: boolean): number[] {
  return buildEnvelope(FN_TUNER_ON_OFF, [on ? 1 : 0]);
}

// ── 0x13 STATUS DUMP ───────────────────────────────────────────────

/**
 * STATUS DUMP (function 0x13). One-shot snapshot of the current
 * scene's state across all effect blocks in the preset. Response is
 * a sequence of `id id dd` triples — see `parseStatusDumpResponse`.
 */
export function buildStatusDump(): number[] {
  return buildEnvelope(FN_STATUS_DUMP, []);
}

// ── 0x14 SET/GET TEMPO ─────────────────────────────────────────────

/**
 * SET TEMPO (function 0x14). BPM as a 14-bit value (LS-first septet
 * pair). Range per spec is implicitly 0..16383; in practice the III
 * accepts ~30..250 BPM (front-panel range).
 */
export function buildSetTempo(bpm: number): number[] {
  if (!Number.isInteger(bpm) || bpm < 0 || bpm > 0x3fff) {
    throw new Error(`buildSetTempo: bpm ${bpm} out of range (0..16383)`);
  }
  return buildEnvelope(FN_SET_GET_TEMPO, encode14(bpm));
}

/** GET TEMPO (function 0x14 with `dd dd = 7F 7F`). */
export function buildGetTempo(): number[] {
  return buildEnvelope(FN_SET_GET_TEMPO, [QUERY_SENTINEL, QUERY_SENTINEL]);
}

// ── Response predicates + parsers ──────────────────────────────────

function isAxeFxIIIFrame(bytes: readonly number[], fn: number): boolean {
  if (bytes.length < 7) return false;
  if (bytes[0] !== SYSEX_START) return false;
  if (bytes[1] !== FRACTAL_MFR_PREFIX[0]) return false;
  if (bytes[2] !== FRACTAL_MFR_PREFIX[1]) return false;
  if (bytes[3] !== FRACTAL_MFR_PREFIX[2]) return false;
  if (bytes[4] !== AXE_FX_III_MODEL_ID) return false;
  if (bytes[5] !== fn) return false;
  if (bytes[bytes.length - 1] !== SYSEX_END) return false;
  return true;
}

/**
 * Decode an ASCII payload that's space- or null-padded. III name
 * responses are 32-char ASCII fields padded with spaces.
 */
function decodeName(bytes: readonly number[]): string {
  let end = bytes.length;
  while (end > 0) {
    const b = bytes[end - 1];
    if (b !== 0x00 && b !== 0x20) break;
    end -= 1;
  }
  return String.fromCharCode(...bytes.slice(0, end));
}

export function isSetGetBypassResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_BYPASS);
}
export function isSetGetChannelResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_CHANNEL);
}
export function isSetGetSceneResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_SCENE);
}
export function isQueryPatchNameResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_QUERY_PATCH_NAME);
}
export function isQuerySceneNameResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_QUERY_SCENE_NAME);
}
export function isSetGetLooperResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_LOOPER);
}
export function isStatusDumpResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_STATUS_DUMP);
}
export function isSetGetTempoResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_SET_GET_TEMPO);
}
export function isMultipurposeResponse(bytes: readonly number[]): boolean {
  return isAxeFxIIIFrame(bytes, FN_MULTIPURPOSE_RESPONSE);
}

/**
 * Parse a 0x0A SET/GET BYPASS response. Payload is `[id_lo, id_hi, dd]`.
 */
export function parseBypassResponse(bytes: readonly number[]): {
  effectId: number;
  bypassed: boolean;
} {
  if (!isSetGetBypassResponse(bytes)) {
    throw new Error(`parseBypassResponse: not a 0x0A frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 3) throw new Error(`parseBypassResponse: payload too short`);
  return {
    effectId: decode14(payload[0], payload[1]),
    bypassed: (payload[2] & 0x01) !== 0,
  };
}

/** Parse a 0x0B SET/GET CHANNEL response. */
export function parseChannelResponse(bytes: readonly number[]): {
  effectId: number;
  channel: number;
} {
  if (!isSetGetChannelResponse(bytes)) {
    throw new Error(`parseChannelResponse: not a 0x0B frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 3) throw new Error(`parseChannelResponse: payload too short`);
  return {
    effectId: decode14(payload[0], payload[1]),
    channel: payload[2] & 0x07,
  };
}

/** Parse a 0x0C SET/GET SCENE response. Payload is `[scene]`. */
export function parseSceneResponse(bytes: readonly number[]): { scene: number } {
  if (!isSetGetSceneResponse(bytes)) {
    throw new Error(`parseSceneResponse: not a 0x0C frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 1) throw new Error('parseSceneResponse: empty payload');
  return { scene: payload[0] & 0x07 };
}

/**
 * Parse a 0x0D QUERY PATCH NAME response.
 *
 *   `F0 00 01 74 10 0D [nn nn preset#] [dd*32 name] [cs] F7`
 *
 * Returns both the preset number AND the 32-char name (trimmed).
 */
export function parseQueryPatchNameResponse(bytes: readonly number[]): {
  presetNumber: number;
  name: string;
} {
  if (!isQueryPatchNameResponse(bytes)) {
    throw new Error(`parseQueryPatchNameResponse: not a 0x0D frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 2) {
    throw new Error(`parseQueryPatchNameResponse: payload too short (${payload.length}B)`);
  }
  const presetNumber = decode14(payload[0], payload[1]);
  const name = decodeName(payload.slice(2));
  return { presetNumber, name };
}

/**
 * Parse a 0x0E QUERY SCENE NAME response.
 *
 *   `F0 00 01 74 10 0E [nn scene] [dd*32 name] [cs] F7`
 */
export function parseQuerySceneNameResponse(bytes: readonly number[]): {
  scene: number;
  name: string;
} {
  if (!isQuerySceneNameResponse(bytes)) {
    throw new Error(`parseQuerySceneNameResponse: not a 0x0E frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length === 0) throw new Error('parseQuerySceneNameResponse: empty payload');
  const scene = payload[0] & 0x07;
  const name = decodeName(payload.slice(1));
  return { scene, name };
}

/**
 * Parse a 0x0F SET/GET LOOPER STATE response. dd is a bitfield:
 * bit0=Record, 1=Play, 2=Overdub, 3=Once, 4=Reverse, 5=Half-speed.
 */
export interface LooperState {
  recording: boolean;
  playing: boolean;
  overdubbing: boolean;
  once: boolean;
  reverse: boolean;
  halfSpeed: boolean;
  raw: number;
}

export function parseLooperStateResponse(bytes: readonly number[]): LooperState {
  if (!isSetGetLooperResponse(bytes)) {
    throw new Error(`parseLooperStateResponse: not a 0x0F frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length === 0) throw new Error('parseLooperStateResponse: empty payload');
  const dd = payload[0] & 0x7f;
  return {
    recording:    (dd & 0x01) !== 0,
    playing:      (dd & 0x02) !== 0,
    overdubbing:  (dd & 0x04) !== 0,
    once:         (dd & 0x08) !== 0,
    reverse:      (dd & 0x10) !== 0,
    halfSpeed:    (dd & 0x20) !== 0,
    raw: dd,
  };
}

/** Parse a 0x14 SET/GET TEMPO response. Payload is the BPM as a septet pair. */
export function parseTempoResponse(bytes: readonly number[]): { bpm: number } {
  if (!isSetGetTempoResponse(bytes)) {
    throw new Error(`parseTempoResponse: not a 0x14 frame`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 2) throw new Error('parseTempoResponse: payload too short');
  return { bpm: decode14(payload[0], payload[1]) };
}

/**
 * Parse a 0x64 MULTIPURPOSE_RESPONSE frame. Payload is `[echoed_fn, result_code]`.
 *
 *   `F0 00 01 74 10 64 [echoed_fn] [result_code] [cs] F7`
 *
 * Known `result_code` meanings (incomplete — Fractal doesn't publish a
 * full table):
 *   - `0x00` — general / checksum error
 *   - `0x05` — NACK (seen during preset-store experiments)
 *
 * Anything else surfaces as the raw byte. Callers convert this to a
 * warning string in their tool response.
 */
export function parseMultipurposeResponse(bytes: readonly number[]): {
  echoedFn: number;
  resultCode: number;
} {
  if (!isMultipurposeResponse(bytes)) {
    throw new Error(`parseMultipurposeResponse: not a 0x64 frame (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  if (payload.length < 2) {
    throw new Error(`parseMultipurposeResponse: payload too short (${payload.length}B)`);
  }
  return { echoedFn: payload[0] & 0x7f, resultCode: payload[1] & 0x7f };
}

/**
 * Human-readable label for a known `result_code` byte. Returns
 * `undefined` for codes not yet documented; callers fall back to the
 * raw hex value.
 *
 * Source: AxeEdit III 1.14.31 release binary contains a contiguous
 * 8-byte-aligned `MIDI_ERROR_*` string table at `.rdata` offset
 * 0x597108 onward. Entries are accessed by result_code as index.
 * Index 0 = `MIDI_ERROR_BAD_CHKSUM` matches the empirically-verified
 * 0x64 frame whose host-side trigger was a malformed checksum, so the
 * index → result_code mapping is high-confidence. Codes 0x00..0x1B
 * are populated; anything ≥ 0x1C returns undefined.
 *
 * See `docs/axefx3-fn01-decode.md` "0x64 result codes" for the full
 * decode + index-table evidence.
 */
export function describeMultipurposeResultCode(code: number): string | undefined {
  switch (code & 0x7f) {
    case 0x00: return 'bad checksum (MIDI_ERROR_BAD_CHKSUM)';
    case 0x01: return 'wrong SysEx manufacturer ID (MIDI_ERROR_WRONG_SYSEX_ID)';
    case 0x02: return 'wrong model number (MIDI_ERROR_WRONG_MODEL_NUM)';
    case 0x03: return 'bad argument (MIDI_ERROR_BAD_ARGUMENT)';
    case 0x04: return 'message not recognized (MIDI_ERROR_MSG_NOT_RECOGNIZED)';
    case 0x05: return 'invalid effect ID (MIDI_ERROR_INVALID_FXID)';
    case 0x06: return 'invalid parameter ID (MIDI_ERROR_INVALID_PARAMID)';
    case 0x07: return 'effect not in use in this preset (MIDI_ERROR_FX_NOT_IN_USE)';
    case 0x08: return 'no modifier slots left (MIDI_ERROR_NO_MODIFIERS_LEFT)';
    case 0x09: return 'wrong count (MIDI_ERROR_WRONG_COUNT)';
    case 0x0a: return 'effect not routable here (MIDI_ERROR_FX_NOT_ROUTABLE)';
    case 0x0b: return 'bad grid position (MIDI_ERROR_BAD_GRID_POS)';
    case 0x0c: return 'DSP overload (MIDI_ERROR_DSP_OVERLOAD)';
    case 0x0d: return 'function failed (MIDI_ERROR_FUNCTION_FAIL)';
    case 0x0e: return 'invalid patch number (MIDI_ERROR_INVALID_PATCHNUM)';
    case 0x0f: return 'illegal message (MIDI_ERROR_ILLEGAL_MSG)';
    case 0x10: return 'bad message length (MIDI_ERROR_BAD_MSG_LENGTH)';
    case 0x11: return 'image size incorrect (MIDI_ERROR_IMAGE_SIZE_INCORRECT)';
    case 0x12: return 'bad image checksum (MIDI_ERROR_BAD_IMAGE_CHKSUM)';
    case 0x13: return 'not ready for firmware update (MIDI_ERROR_NOT_RDY_FOR_FW_UPD)';
    case 0x14: return 'buffer overrun (MIDI_ERROR_BUFFER_OVERRUN)';
    case 0x15: return 'invalid cab number (MIDI_ERROR_INVALID_CABNUM)';
    case 0x16: return 'invalid modifier ID (MIDI_ERROR_INVALID_MODIFIERID)';
    case 0x17: return 'invalid bank number (MIDI_ERROR_INVALID_BANKNUM)';
    case 0x18: return 'firmware already current (MIDI_ERROR_FIRMWARE_ALREADY_CURRENT)';
    case 0x19: return 'command not supported (MIDI_ERROR_CMD_NOT_SUPPORTED)';
    case 0x1a: return 'null data (MIDI_ERROR_NULL_DATA)';
    case 0x1b: return 'flash write failed (MIDI_ERROR_FLASH_WRITE_FAILED)';
    default:   return undefined;
  }
}

/**
 * One block's row in a STATUS_DUMP response.
 *
 * Per v1.4 PDF: `dd` bit 0 = bypass, bits 3:1 = channel (0..7; current
 * max is 3), bits 6:4 = number of channels supported (0..7).
 */
export interface StatusDumpEntry {
  /** 14-bit effect ID per v1.4 PDF Appendix 1. */
  effectId: number;
  /** True if the block is bypassed in the active scene. */
  bypassed: boolean;
  /** Current channel index (0..7). Most blocks expose 2 or 4 channels. */
  channel: number;
  /** Number of channels this block supports (0..7). */
  channelCount: number;
}

/**
 * Parse a 0x13 STATUS_DUMP response into a list of per-block entries.
 *
 * Wire shape per v1.4 PDF:
 *   `F0 00 01 74 10 13 [id id dd]* [cs] F7`
 */
export function parseStatusDumpResponse(bytes: readonly number[]): StatusDumpEntry[] {
  if (!isStatusDumpResponse(bytes)) {
    throw new Error(
      `parseStatusDumpResponse: not a valid 0x13 frame (len=${bytes.length})`,
    );
  }
  const payload = bytes.slice(6, -2);
  if (payload.length % 3 !== 0) {
    throw new Error(
      `parseStatusDumpResponse: payload length ${payload.length} not a ` +
        'multiple of 3 — STATUS_DUMP frames are id-id-dd triples.',
    );
  }
  const entries: StatusDumpEntry[] = [];
  for (let i = 0; i < payload.length; i += 3) {
    const idLo = payload[i] & 0x7f;
    const idHi = payload[i + 1] & 0x7f;
    const dd = payload[i + 2] & 0x7f;
    entries.push({
      effectId: decode14(idLo, idHi),
      bypassed: (dd & 0x01) !== 0,
      channel: (dd >> 1) & 0x07,
      channelCount: (dd >> 4) & 0x07,
    });
  }
  return entries;
}
