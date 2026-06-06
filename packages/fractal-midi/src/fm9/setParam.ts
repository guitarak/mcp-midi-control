/**
 * Fractal FM9 SysEx wire builders — FOUNDATION-VERIFICATION STUB.
 *
 * Cloned from `src/axe-fx-iii/setParam.ts` (the III is the protocol
 * sibling: same modern Fractal SysEx family, same v1.4-style function
 * surface). This stub deliberately ships ONLY the foundation surface:
 *
 *   - envelope + checksum framing
 *   - device identification (Universal Device Inquiry + QUERY PATCH NAME)
 *   - preset switch (standard MIDI Program Change + Bank Select)
 *   - scene switch (function 0x0C)
 *   - STATUS DUMP (function 0x13, read-only framing probe)
 *   - 0x64 MULTIPURPOSE_RESPONSE error-channel parsing
 *
 * The full parameter SET/GET path (fn=0x01), block placement, preset
 * name/store, looper, tempo, and tuner builders land AFTER the model
 * byte and envelope framing are confirmed on real FM9 hardware and the
 * FM9-Edit catalog mining pass runs (see
 * `docs/research/fractal-midi-extraction-plan.md` §"Adding FM9").
 */
import { fractalChecksum } from '../shared/checksum.js';

/**
 * FM9 model byte — 🟢 HARDWARE-VERIFIED (2026-06-06, foundation probe
 * against a real FM9, FW with 512 preset slots).
 *
 * The unit answered a QUERY PATCH NAME request built with 0x12 and
 * echoed 0x12 at pos 4 of the response, checksum valid:
 *
 *   >> f0 00 01 74 12 0d 7f 7f 1a f7
 *   << f0 00 01 74 12 0d 1d 03 ... (name + number of the active preset, 413)
 *
 * Originally hypothesized from `docs/research/fractal-midi-extraction-plan.md`
 * §"Adding FM9" (III = 0x10, FM3 = 0x11, FM9 = 0x12) — hypothesis
 * confirmed on first contact. Every builder and predicate in this file
 * derives from this one constant.
 */
export const FM9_MODEL_ID = 0x12;

/** SysEx framing bytes shared across the entire modern Fractal family. */
const SYSEX_START = 0xf0;
const SYSEX_END = 0xf7;
const FRACTAL_MFR_PREFIX = [0x00, 0x01, 0x74] as const;

// ── Function-ID bytes (carried over from the III's v1.4-style spec) ─
//
// Fractal publishes a "MIDI for Third-Party Devices" PDF per device;
// the FM9 edition documents the same function surface as the III's
// v1.4 (scene/name/looper/tempo/tuner/status). These constants are the
// subset the foundation stub exercises.

export const FN_SET_GET_SCENE = 0x0c;
export const FN_QUERY_PATCH_NAME = 0x0d;
export const FN_QUERY_SCENE_NAME = 0x0e;
export const FN_STATUS_DUMP = 0x13;

/**
 * 0x64 MULTIPURPOSE_RESPONSE — the family's error channel.
 *
 *   `F0 00 01 74 [model] 64 [echoed_fn] [result_code] [cs] F7`
 *
 * On the III this is the rejection path for malformed / unsupported
 * SysEx; the FM9 is expected to behave identically (same firmware
 * lineage). Receiving one of these with our hypothesized model byte
 * echoed back is itself evidence the model byte is RIGHT (the unit
 * parsed the envelope far enough to reject the function).
 */
export const FN_MULTIPURPOSE_RESPONSE = 0x64;

/** Query sentinel — when this is the value byte, the device responds with current state. */
export const QUERY_SENTINEL = 0x7f;

/**
 * 0x01 PARAMETER_SETGET — the family's parameter read/write opcode.
 * Cloned from the III codec (where the SET shape is byte-verified
 * against 10 public captures; see the III's `setParam.ts` for the
 * full evidence chain). On the FM9 both directions are 🟡 untested:
 *   - SET: not exercised — FM9 writes are gated until the
 *     calibration step.
 *   - GET: hypothesized shape (SET layout with value zeroed), same
 *     hypothesis as the III. Read-only — safe to attempt; a silent
 *     timeout means "GET not supported," not an error.
 */
export const FN_PARAMETER_SETGET = 0x01;

/** Parameter SETGET sub-action codes (pos 6-7 of the envelope). */
const SUB_ACTION_SET_TYPED: readonly [number, number] = [0x09, 0x00];

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
 * Build an envelope: `F0 00 01 74 [FM9_MODEL_ID] [function] [payload...]
 * [checksum] F7`. Checksum covers everything from `F0` through the
 * last payload byte (XOR-7bit).
 */
function buildEnvelope(fn: number, payload: readonly number[]): number[] {
  return buildEnvelopeWithModel(FM9_MODEL_ID, fn, payload);
}

/**
 * Research-only variant of `buildEnvelope` that takes an explicit model
 * byte. Exists so the hardware foundation probe can sweep candidate
 * model bytes with a read-only query and report which one the unit
 * answers — do NOT use in production paths; everything shipped goes
 * through `buildEnvelope` / `FM9_MODEL_ID`.
 */
export function buildEnvelopeWithModel(
  modelId: number,
  fn: number,
  payload: readonly number[],
): number[] {
  if (!Number.isInteger(modelId) || modelId < 0 || modelId > 0x7f) {
    throw new Error(`buildEnvelopeWithModel: modelId ${modelId} out of range (0..127)`);
  }
  const body = [SYSEX_START, ...FRACTAL_MFR_PREFIX, modelId, fn, ...payload];
  const checksum = fractalChecksum(body);
  return [...body, checksum, SYSEX_END];
}

// ── 0x01 PARAMETER_SETGET ──────────────────────────────────────────

/**
 * Pack a 16-bit unsigned value into the wire's three 7-bit septets
 * (low 7, next 7, top 2). Family-shared encoding; see the III codec
 * for capture provenance.
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
 * SET PARAMETER (function 0x01, sub-action 09 00 — typed input).
 * 23-byte envelope, cloned from the III's byte-verified builder with
 * the FM9 model byte. 🟡 NOT yet exercised against FM9 hardware —
 * writes are gated until the calibration step; this builder exists so
 * goldens and the calibration pass have a stable target.
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
 * GET PARAMETER (function 0x01, sub-action 09 00 with value=0).
 * 🟡 Hypothesis (same as the III's — no public GET capture exists for
 * either device). Read-only. Treat a missing response within ~800 ms
 * as "GET not supported on this firmware," not a tool error.
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

/** Predicate: inbound fn=0x01 PARAMETER frame (any sub-action). */
export function isSetGetParameterResponse(bytes: readonly number[]): boolean {
  return isFm9Frame(bytes, FN_PARAMETER_SETGET);
}

// ── fn=0x01 GET response (HARDWARE-DECODED on FM9, 2026-06-06) ─────
//
// The FM9 ANSWERS the GET hypothesis — the first GET-response capture
// in the entire III family (no public III capture exists). Three
// captured 60-byte frames, byte-decoded:
//
//   pos 0-5:   F0 00 01 74 12 01
//   payload:
//     [0-1]   sub-action echo (09 00)
//     [2-3]   effectId (14-bit LE)
//     [4-5]   paramId  (14-bit LE)
//     [6-10]  value: 5-septet LSB-first packing of the param's
//             internal 32-bit IEEE-754 float (e.g. 0x3F000000 = 0.5
//             for a centered bipolar param)
//     [11-12] zeros (modifier slot?)
//     [13-14] display-string buffer length (14-bit LE; 32 observed)
//     [15..]  packValueChunked(display string) — the device's OWN
//             display text ("ENGAGED", "0.0100", "0.0"), 8→7
//             sliding-window packed, space/NUL padded
//   then checksum + F7.
//
// CRITICAL EVIDENCE that GET does not write: a GET (value field zero)
// against a param holding internal 0.5 returned 0.5 — the device
// retained its value rather than accepting a SET-to-0.
//
// ⚠️ paramId binding caveat: the response for catalog
// DISTORT_MASTER (III paramId 5) displayed "ENGAGED" (a toggle) —
// the FM9's per-family param NUMBERING diverges from the III
// catalog. Treat name→paramId mappings as unverified until the FM9
// calibration pass sweeps ids read-only and rebinds them by display
// string.

/** Decode a 5-septet LSB-first packing of a 32-bit value. */
function decode5Septet32(b: readonly number[]): number {
  return (
    ((b[0] & 0x7f) >>> 0) |
    ((b[1] & 0x7f) << 7) |
    ((b[2] & 0x7f) << 14) |
    ((b[3] & 0x7f) << 21) |
    ((b[4] & 0x7f) << 28)
  ) >>> 0;
}

/** Reinterpret a u32 as an IEEE-754 float32. */
function bitsToFloat32(bits: number): number {
  const buf = new ArrayBuffer(4);
  new DataView(buf).setUint32(0, bits, true);
  return new DataView(buf).getFloat32(0, true);
}

/**
 * Sliding-window 8→7 unpack (AM4-shared scheme; mirrors
 * `shared/packValue.ts:unpackValueChunked` — duplicated here so the
 * fm9 module stays dependency-light within the package).
 */
function unpackChunked(wire: readonly number[], rawLen: number): number[] {
  const out = new Array<number>(rawLen).fill(0);
  let rawPos = 0;
  let wirePos = 0;
  while (rawPos < rawLen) {
    const thisChunkRaw = Math.min(7, rawLen - rawPos);
    const thisChunkWire = thisChunkRaw === 7 ? 8 : thisChunkRaw + 1;
    for (let i = 0; i < thisChunkWire; i++) {
      const k = i + 1;
      const b = (wire[wirePos + i] ?? 0) & 0x7f;
      if (i > 0 && rawPos + i - 1 < rawLen) {
        out[rawPos + i - 1] |= ((~(0x7f >> k) & b) >> (8 - k)) & 0xff;
      }
      if (i < thisChunkRaw && rawPos + i < rawLen) {
        out[rawPos + i] = (b << k) & 0xff;
      }
    }
    rawPos += thisChunkRaw;
    wirePos += thisChunkWire;
  }
  return out;
}

/** True when an fn=0x01 frame is the long GET-response shape (carries a display string). */
export function isGetParameterResponse(bytes: readonly number[]): boolean {
  if (!isSetGetParameterResponse(bytes)) return false;
  const payload = bytes.slice(6, -2);
  if (payload.length < 17) return false;
  // Not a STATE_BROADCAST, and the string-length field is non-zero.
  if (payload[0] === 0x04 && payload[1] === 0x01) return false;
  const strLen = (payload[13] & 0x7f) | ((payload[14] & 0x7f) << 7);
  return strLen > 0 && payload.length >= 15 + strLen + Math.ceil(strLen / 7);
}

/**
 * Parse the hardware-decoded fn=0x01 GET response. Returns the
 * param's internal IEEE float, its raw u32 bits, and the device's own
 * display string (ground truth #2 per the repo's verification
 * hierarchy).
 */
export function parseGetParameterResponse(bytes: readonly number[]): {
  effectId: number;
  paramId: number;
  /** Internal normalized value as IEEE-754 float32. */
  internalValue: number;
  /** Raw u32 bit pattern of the float (for goldens / debugging). */
  valueBits: number;
  /** The device's own display text, trailing space/NUL trimmed. */
  displayString: string;
} {
  if (!isGetParameterResponse(bytes)) {
    throw new Error(`parseGetParameterResponse: not an fn=0x01 GET response (len=${bytes.length})`);
  }
  const payload = bytes.slice(6, -2);
  const strLen = (payload[13] & 0x7f) | ((payload[14] & 0x7f) << 7);
  const raw = unpackChunked(payload.slice(15), strLen);
  let end = raw.length;
  while (end > 0 && (raw[end - 1] === 0 || raw[end - 1] === 0x20)) end--;
  const valueBits = decode5Septet32(payload.slice(6, 11));
  return {
    effectId: decode14(payload[2], payload[3]),
    paramId: decode14(payload[4], payload[5]),
    internalValue: bitsToFloat32(valueBits),
    valueBits,
    displayString: String.fromCharCode(...raw.slice(0, end)),
  };
}

/** Discriminator for `parseSetGetParameterResponse` results. */
export type FM9ParameterFrameKind = 'set_echo' | 'state_broadcast';

/**
 * Parse an inbound fn=0x01 PARAMETER frame. Two shapes (family-shared
 * layout, see the III codec for capture provenance):
 *   • sub-action `09 00` / `52 00`: SET/GET echo — effectId at payload
 *     pos 2-3, paramId at 4-5, value at 9-11 (packValue16).
 *   • sub-action `04 01`: STATE_BROADCAST — no paramId slot; value at
 *     pos 6-7 as a 2-septet pair. paramId reported as 0.
 */
export function parseSetGetParameterResponse(bytes: readonly number[]): {
  kind: FM9ParameterFrameKind;
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
    return {
      kind: 'state_broadcast',
      effectId: decode14(payload[2], payload[3]),
      paramId: 0,
      value: decode14(payload[6], payload[7]),
      subAction,
    };
  }
  return {
    kind: 'set_echo',
    effectId: decode14(payload[2], payload[3]),
    paramId: decode14(payload[4], payload[5]),
    value: unpackValue16(payload[9], payload[10], payload[11]),
    subAction,
  };
}

// ── Universal Device Inquiry (MIDI standard, not Fractal-specific) ──

/**
 * MIDI Universal Non-Realtime Device Inquiry:
 *
 *   `F0 7E 7F 06 01 F7`   (7F = "all devices" broadcast channel)
 *
 * Every conformant device answers with an Identity Reply
 * (`F0 7E [ch] 06 02 [mfr...] [family lo hi] [member lo hi]
 * [sw1..sw4] F7`). This is the model-byte-independent identification
 * primitive: it works even if `FM9_MODEL_ID` is wrong, because the
 * request carries no Fractal model byte at all.
 */
export function buildDeviceInquiry(): number[] {
  return [0xf0, 0x7e, 0x7f, 0x06, 0x01, 0xf7];
}

export function isDeviceInquiryResponse(bytes: readonly number[]): boolean {
  return bytes.length >= 6
    && bytes[0] === 0xf0
    && bytes[1] === 0x7e
    && bytes[3] === 0x06
    && bytes[4] === 0x02
    && bytes[bytes.length - 1] === 0xf7;
}

/**
 * Parse a Universal Identity Reply. Layout after the `06 02` header:
 * manufacturer ID (1 byte, or 3 bytes when the first is 0x00 — Fractal
 * is the 3-byte `00 01 74`), then family code (14-bit LE pair), family
 * member (14-bit LE pair), then software revision bytes.
 */
export function parseDeviceInquiryResponse(bytes: readonly number[]): {
  channel: number;
  manufacturerId: number[];
  familyCode: number;
  familyMember: number;
  softwareRevision: number[];
} {
  if (!isDeviceInquiryResponse(bytes)) {
    throw new Error(`parseDeviceInquiryResponse: not an Identity Reply (len=${bytes.length})`);
  }
  const channel = bytes[2] & 0x7f;
  let i = 5;
  const manufacturerId =
    bytes[i] === 0x00 ? [bytes[i], bytes[i + 1], bytes[i + 2]] : [bytes[i]];
  i += manufacturerId.length;
  const familyCode = decode14(bytes[i] ?? 0, bytes[i + 1] ?? 0);
  const familyMember = decode14(bytes[i + 2] ?? 0, bytes[i + 3] ?? 0);
  const softwareRevision = bytes.slice(i + 4, -1).map((b) => b & 0x7f);
  return { channel, manufacturerId, familyCode, familyMember, softwareRevision };
}

// ── Generic Fractal-frame inspector ────────────────────────────────

/**
 * Inspect ANY modern-Fractal-family frame (`F0 00 01 74 [model] [fn]
 * ... F7`) without asserting a model byte. The hardware probe uses
 * this to report the model byte the unit ACTUALLY emits — ground truth
 * for `FM9_MODEL_ID`.
 */
export function parseFractalFrame(bytes: readonly number[]): {
  modelId: number;
  fn: number;
  payload: number[];
  checksumOk: boolean;
} | undefined {
  if (bytes.length < 8) return undefined;
  if (bytes[0] !== SYSEX_START) return undefined;
  if (bytes[1] !== FRACTAL_MFR_PREFIX[0]) return undefined;
  if (bytes[2] !== FRACTAL_MFR_PREFIX[1]) return undefined;
  if (bytes[3] !== FRACTAL_MFR_PREFIX[2]) return undefined;
  if (bytes[bytes.length - 1] !== SYSEX_END) return undefined;
  const expected = fractalChecksum(bytes.slice(0, -2));
  return {
    modelId: bytes[4] & 0x7f,
    fn: bytes[5] & 0x7f,
    payload: bytes.slice(6, -2).map((b) => b & 0x7f),
    checksumOk: (bytes[bytes.length - 2] & 0x7f) === expected,
  };
}

// ── Preset switch: standard MIDI Program Change + Bank Select ──────

/**
 * Switch the active preset via standard MIDI: CC0 (Bank MSB) + CC32
 * (Bank LSB) + Program Change. Identical mechanism to the III — the
 * family has no SysEx preset-switch in the public spec.
 *
 * Range 0..511: the FM9 ships 512 preset slots per the FM9 Owner's
 * Manual (vs. 1024 on the III Mark II). presetNumber 0..127 = bank 0
 * PC 0..127, 128..255 = bank 1, etc.
 *
 * BANK GOES IN CC0 (MSB) — HARDWARE-VERIFIED on a real FM9
 * (foundation probe, 2026-06-06): the unit reads the bank number from
 * CC0 directly and IGNORES CC32. The III codec's convention
 * (bank = (CC0 << 7) | CC32, so banks 0..127 ride in CC32) left the
 * FM9 on bank 0 — requesting preset 412 sent CC0=0 / CC32=3 / PC=28
 * and the unit landed on preset 28. With CC0=3 the same PC lands on
 * 412. CC32 is still sent (as 0) for spec completeness.
 *
 * NOTE for the III descriptor: the FM9 evidence suggests the III's
 * `buildSwitchPresetPC` (bank in CC32) may have the same latent
 * mis-bank on real III hardware — flagged for a III owner to verify,
 * not changed here.
 */
export function buildSwitchPresetPC(
  presetNumber: number,
  channel: number = 1,
): number[] {
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 511) {
    throw new Error(
      `buildSwitchPresetPC: presetNumber ${presetNumber} out of range (0..511 on FM9).`,
    );
  }
  if (!Number.isInteger(channel) || channel < 1 || channel > 16) {
    throw new Error(`buildSwitchPresetPC: channel ${channel} out of range (1..16).`);
  }
  const ch0 = (channel - 1) & 0x0f;
  const bank = Math.floor(presetNumber / 128);
  const pc = presetNumber % 128;
  return [
    0xb0 | ch0, 0x00, bank & 0x7f,        // CC 0 = Bank Select — FM9 reads THIS (hardware-verified)
    0xb0 | ch0, 0x20, 0x00,               // CC 32 — FM9 ignores it (hardware-verified); sent as 0
    0xc0 | ch0, pc & 0x7f,                // Program Change
  ];
}

// ── 0x0C SET/GET SCENE ─────────────────────────────────────────────

/**
 * SET SCENE (function 0x0C). `sceneIndex` is 0..7. Per the III spec
 * the SET also echoes the resulting scene back.
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
 *   Request:  `F0 00 01 74 [model] 0D [dd dd preset#] [cs] F7`
 *   Current:  `F0 00 01 74 [model] 0D 7F 7F [cs] F7`
 *   Response: `F0 00 01 74 [model] 0D [nn nn preset#] [name...] [cs] F7`
 *
 * This is the foundation stub's Fractal-native identification probe:
 * a read-only query whose response carries the unit's own model byte
 * at pos 4 AND proves the function surface matches the III family.
 */
export function buildQueryPatchName(
  presetNumber: number | 'current',
): number[] {
  if (presetNumber === 'current') {
    return buildEnvelope(FN_QUERY_PATCH_NAME, [QUERY_SENTINEL, QUERY_SENTINEL]);
  }
  if (!Number.isInteger(presetNumber) || presetNumber < 0 || presetNumber > 511) {
    throw new Error(
      `buildQueryPatchName: presetNumber ${presetNumber} out of range (0..511 on FM9).`,
    );
  }
  return buildEnvelope(FN_QUERY_PATCH_NAME, encode14(presetNumber));
}

// ── 0x13 STATUS DUMP ───────────────────────────────────────────────

/**
 * STATUS DUMP (function 0x13). One-shot, read-only snapshot of the
 * current scene's state across all blocks in the preset. Response is
 * a sequence of `id id dd` triples — the foundation probe uses it to
 * check whether the FM9's response framing matches the III family.
 */
export function buildStatusDump(): number[] {
  return buildEnvelope(FN_STATUS_DUMP, []);
}

// ── Response predicates + parsers ──────────────────────────────────

function isFm9Frame(bytes: readonly number[], fn: number): boolean {
  if (bytes.length < 7) return false;
  if (bytes[0] !== SYSEX_START) return false;
  if (bytes[1] !== FRACTAL_MFR_PREFIX[0]) return false;
  if (bytes[2] !== FRACTAL_MFR_PREFIX[1]) return false;
  if (bytes[3] !== FRACTAL_MFR_PREFIX[2]) return false;
  if (bytes[4] !== FM9_MODEL_ID) return false;
  if (bytes[5] !== fn) return false;
  if (bytes[bytes.length - 1] !== SYSEX_END) return false;
  return true;
}

/**
 * Decode an ASCII payload that's space- or null-padded. Fractal name
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

export function isSetGetSceneResponse(bytes: readonly number[]): boolean {
  return isFm9Frame(bytes, FN_SET_GET_SCENE);
}
export function isQueryPatchNameResponse(bytes: readonly number[]): boolean {
  return isFm9Frame(bytes, FN_QUERY_PATCH_NAME);
}
export function isStatusDumpResponse(bytes: readonly number[]): boolean {
  return isFm9Frame(bytes, FN_STATUS_DUMP);
}
export function isMultipurposeResponse(bytes: readonly number[]): boolean {
  return isFm9Frame(bytes, FN_MULTIPURPOSE_RESPONSE);
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
 *   `F0 00 01 74 [model] 0D [nn nn preset#] [dd*32 name] [cs] F7`
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
 * Parse a 0x64 MULTIPURPOSE_RESPONSE frame. Payload is `[echoed_fn, result_code]`.
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
 * Human-readable label for a known `result_code` byte. Table mined
 * from the AxeEdit III binary's `MIDI_ERROR_*` string table (see the
 * III codec's `describeMultipurposeResultCode` for the evidence
 * chain); the FM9's firmware shares the lineage, so the indices are
 * expected to match. Returns `undefined` for codes ≥ 0x1C.
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
 * Per the III v1.4 PDF: `dd` bit 0 = bypass, bits 3:1 = channel, bits
 * 6:4 = number of channels supported.
 */
export interface StatusDumpEntry {
  effectId: number;
  bypassed: boolean;
  channel: number;
  channelCount: number;
}

/**
 * Parse a 0x13 STATUS_DUMP response into a list of per-block entries.
 *
 * Wire shape per the III v1.4 PDF:
 *   `F0 00 01 74 [model] 13 [id id dd]* [cs] F7`
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
