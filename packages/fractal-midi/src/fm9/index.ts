// Barrel for fractal-midi/fm9.
//
// **Status: 🟡 foundation-verification stub.** Cloned from the
// Axe-Fx III codec (same modern Fractal SysEx family). Ships ONLY the
// protocol-foundation surface: envelope framing, device identification
// (Universal Device Inquiry + QUERY PATCH NAME), preset switch (MIDI
// PC + Bank Select), scene switch (0x0C), STATUS DUMP (0x13), and the
// 0x64 MULTIPURPOSE_RESPONSE error channel.
//
// The model byte (`FM9_MODEL_ID = 0x12`) is a HYPOTHESIS pending
// hardware verification — see the constant's doc comment in
// `setParam.ts`. NO block roster, NO param catalog, NO parameter
// SET/GET path yet: those land after the foundation is confirmed on
// real FM9 hardware and the FM9-Edit mining pass runs.

export {
  FM9_MODEL_ID,
  FN_SET_GET_SCENE,
  FN_QUERY_PATCH_NAME,
  FN_QUERY_SCENE_NAME,
  FN_STATUS_DUMP,
  FN_MULTIPURPOSE_RESPONSE,
  QUERY_SENTINEL,
  buildEnvelopeWithModel,
  buildDeviceInquiry,
  isDeviceInquiryResponse,
  parseDeviceInquiryResponse,
  parseFractalFrame,
  buildSwitchPresetPC,
  buildSetScene,
  buildGetScene,
  buildQueryPatchName,
  buildStatusDump,
  isSetGetSceneResponse,
  isQueryPatchNameResponse,
  isStatusDumpResponse,
  isMultipurposeResponse,
  parseSceneResponse,
  parseQueryPatchNameResponse,
  parseMultipurposeResponse,
  describeMultipurposeResultCode,
  parseStatusDumpResponse,
} from './setParam.js';
export type { StatusDumpEntry } from './setParam.js';
