// Barrel for fractal-midi/axe-fx-iii.
//
// **Status: 🟡 community beta.** The III protocol layer is scaffolded
// from Fractal's published "Axe-Fx III MIDI for Third-Party Devices"
// v1.4 PDF and the AxeEdit III editor assets. Wire envelopes are
// byte-verified against 10 public captures (FC-12 and a public
// forum capture); per-effect param-ID calibration is sparse (~11%) because
// Fractal deliberately omits per-block param IDs from the public
// spec. Use with that caveat.

// Data — block roster + flat param table (2017 params from AxeEdit
// III's `__block_layout.xml` mining).
export {
  AXE_FX_III_BLOCKS,
  resolveBlock,
  resolveEffectId,
} from './blockTypes.js';
export type { AxeFxIIIBlock, ConfidenceTag } from './blockTypes.js';
export { PARAMS, PARAMS_BY_FAMILY, PARAM_BY_KEY, FAMILIES } from './params.js';
export type { Unit, Param } from './params.js';

// Enum vocabulary overlay — universal Fractal conventions + AM4-
// verified shared symbols + III-specific direct overrides. See
// `enumOverlay.ts` for evidence chain and provenance tagging.
export { resolveEnumValues, resolveEffectTypeEnum, enumOverlayStats } from './enumOverlay.js';
export type { EnumOverlayEntry, EnumProvenance } from './enumOverlay.js';

// Gen-3 enum set-by-name resolver (BK-093 write leg), capture-pending
// scaffold. name → ordinal (offline) → raw-id (empty table until the FM9
// getBlockString sweep lands). See `enumRawId.ts`.
export {
  resolveGen3EnumOrdinal,
  resolveGen3EnumNameToRawId,
  GEN3_ENUM_ORDINAL_TO_RAW_ID,
} from './enumRawId.js';
export type { Gen3EnumRawIdTable, Gen3EnumRawIdResolution } from './enumRawId.js';

// Codec — wire-byte builders + parsers. Function-code constants
// re-exported for callers building custom envelopes.
export {
  AXE_FX_III_MODEL_ID,
  FN_SET_GET_BYPASS,
  FN_SET_GET_CHANNEL,
  FN_SET_GET_SCENE,
  FN_QUERY_PATCH_NAME,
  FN_QUERY_SCENE_NAME,
  FN_SET_GET_LOOPER,
  FN_TEMPO_TAP,
  FN_TUNER_ON_OFF,
  FN_STATUS_DUMP,
  FN_SET_GET_TEMPO,
  FN_MULTIPURPOSE_RESPONSE,
  FN_PARAMETER_SETGET,
  QUERY_SENTINEL,
  packValue16,
  unpackValue16,
  pack5Septet32,
  unpack5Septet32,
  decode5SeptetFloat32,
  parseGen3SetValueEcho,
  buildSetParameter,
  buildGetParameter,
  buildSetParameterBypass,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  isGetParameterResponse,
  parseGetParameterResponse,
  buildSetGridCell,
  buildSetGridRouting,
  ROUTING_OP_CONNECT,
  ROUTING_OP_DISCONNECT,
  buildSetPresetName,
  buildStorePreset,
  buildSwitchPresetPC,
  buildSetBypass,
  buildGetBypass,
  buildSetChannel,
  buildGetChannel,
  buildSetScene,
  buildGetScene,
  buildQueryPatchName,
  buildQuerySceneName,
  buildSetLooper,
  buildGetLooperState,
  buildTempoTap,
  buildSetTuner,
  buildStatusDump,
  buildSetTempo,
  buildGetTempo,
  isSetGetBypassResponse,
  isSetGetChannelResponse,
  isSetGetSceneResponse,
  isQueryPatchNameResponse,
  isQuerySceneNameResponse,
  isSetGetLooperResponse,
  isStatusDumpResponse,
  isSetGetTempoResponse,
  isMultipurposeResponse,
  parseBypassResponse,
  parseChannelResponse,
  parseSceneResponse,
  parseQueryPatchNameResponse,
  parseQuerySceneNameResponse,
  parseLooperStateResponse,
  parseTempoResponse,
  parseMultipurposeResponse,
  describeMultipurposeResultCode,
  parseStatusDumpResponse,
  parseStateBroadcast,
  parseGen3StateBroadcastHead,
  parseGen3StateBroadcastBody,
  buildBlockBulkReadPoll,
  buildRequestPresetDump,
  isGen3BroadcastFrame,
  assembleGen3BlockBulkRead,
  FN_BLOCK_BULK_READ,
  FN_REQUEST_PRESET_DUMP,
  createModernFractalCodec,
} from './setParam.js';
export type {
  LooperAction,
  LooperState,
  StatusDumpEntry,
  AxeFxIIIParameterFrameKind,
  Gen3BlockBulkRead,
  ModernFractalCodec,
  Gen3BankSelectMode,
} from './setParam.js';
