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
export { resolveEnumValues, enumOverlayStats } from './enumOverlay.js';
export type { EnumOverlayEntry, EnumProvenance } from './enumOverlay.js';

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
  buildSetParameter,
  buildGetParameter,
  buildSetParameterBypass,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  buildSetGridCell,
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
} from './setParam.js';
export type {
  LooperAction,
  LooperState,
  StatusDumpEntry,
  AxeFxIIIParameterFrameKind,
} from './setParam.js';
