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
 * FM9 model byte — ⚠️ HYPOTHESIS, NOT HARDWARE-VERIFIED.
 *
 * Source: `docs/research/fractal-midi-extraction-plan.md` §"Adding FM9"
 * assigns 0x12 by analogy (III = 0x10, FM3 = 0x11, FM9 = "next"). The
 * III codec header also lists FM9 as 0x12, but neither claim traces to
 * a Fractal-published table or a captured FM9 frame. The plan doc and
 * the III header could both descend from the same guess.
 *
 * VERIFY on hardware before trusting: the FM9's response to a Universal
 * Device Inquiry (`buildDeviceInquiry`) and the model byte at pos 4 of
 * any frame the unit emits (e.g. its QUERY PATCH NAME response) are
 * ground truth. If the unit reports something else, change THIS ONE
 * CONSTANT — every builder and predicate in this file derives from it.
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
    0xb0 | ch0, 0x00, (bank >> 7) & 0x7f, // CC 0 = Bank MSB
    0xb0 | ch0, 0x20, bank & 0x7f,        // CC 32 = Bank LSB
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
