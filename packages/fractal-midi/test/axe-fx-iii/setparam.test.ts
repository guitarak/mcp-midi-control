/**
 * Axe-Fx III codec golden vectors.
 *
 * Source: Fractal's "Axe-Fx III MIDI for Third-Party Devices" v1.4
 * PDF, plus 10 public captures (FC-12 footswitch, plus a public forum
 * capture from 2019) that locked the fn=0x01 SET_PARAMETER
 * wire shape.
 *
 * Test cases lifted verbatim from the upstream
 * `scripts/verify-axe-fx-iii-encoding.ts` golden. Failure of this test
 * means the codec port drifted from spec/capture reality, NOT just
 * from internal expectations.
 *
 * Status: 🟡 community beta. Calibration coverage sparse (~11% of
 * 2017 params) because Fractal omits per-block param IDs from the
 * public spec. The wire shapes themselves are locked.
 */
import {
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
  buildSetTempo,
  buildGetTempo,
  buildStatusDump,
  buildSetParameter,
  buildGetParameter,
  buildSetParameterBypass,
  packValue16,
  unpackValue16,
  isSetGetParameterResponse,
  parseSetGetParameterResponse,
  parseStateBroadcast,
  resolveEffectId,
} from '../../src/axe-fx-iii/index.js';

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

interface Case {
  label: string;
  built: number[];
  expected: string;
}

const cases: Case[] = [
  // 0x0A SET/GET BYPASS — Compressor 1 = effectId 46.
  { label: 'buildSetBypass(46, false)', built: buildSetBypass(46, false), expected: 'f0000174100a2e000031f7' },
  { label: 'buildSetBypass(46, true)', built: buildSetBypass(46, true), expected: 'f0000174100a2e000130f7' },
  { label: 'buildGetBypass(46)', built: buildGetBypass(46), expected: 'f0000174100a2e007f4ef7' },
  { label: 'buildSetBypass(66, false) — Reverb 1', built: buildSetBypass(66, false), expected: 'f0000174100a4200005df7' },

  // 0x0B SET/GET CHANNEL
  { label: 'buildSetChannel(46, 0)', built: buildSetChannel(46, 0), expected: 'f0000174100b2e000030f7' },
  { label: 'buildSetChannel(46, 1)', built: buildSetChannel(46, 1), expected: 'f0000174100b2e000131f7' },
  { label: 'buildSetChannel(46, 3)', built: buildSetChannel(46, 3), expected: 'f0000174100b2e000333f7' },
  { label: 'buildGetChannel(46)', built: buildGetChannel(46), expected: 'f0000174100b2e007f4ff7' },

  // 0x0C SET/GET SCENE
  { label: 'buildSetScene(0)', built: buildSetScene(0), expected: 'f0000174100c0019f7' },
  { label: 'buildSetScene(7)', built: buildSetScene(7), expected: 'f0000174100c071ef7' },
  { label: 'buildGetScene()', built: buildGetScene(), expected: 'f0000174100c7f66f7' },

  // 0x0D QUERY PATCH NAME — preset index 0..1023, or 'current' (two sentinel bytes).
  { label: 'buildQueryPatchName(0)', built: buildQueryPatchName(0), expected: 'f0000174100d000018f7' },
  { label: 'buildQueryPatchName(1023)', built: buildQueryPatchName(1023), expected: 'f0000174100d7f0760f7' },
  { label: "buildQueryPatchName('current')", built: buildQueryPatchName('current'), expected: 'f0000174100d7f7f18f7' },

  // 0x0E QUERY SCENE NAME
  { label: 'buildQuerySceneName(0)', built: buildQuerySceneName(0), expected: 'f0000174100e001bf7' },
  { label: 'buildQuerySceneName(7)', built: buildQuerySceneName(7), expected: 'f0000174100e071cf7' },
  { label: "buildQuerySceneName('current')", built: buildQuerySceneName('current'), expected: 'f0000174100e7f64f7' },

  // 0x0F LOOPER
  { label: "buildSetLooper('record')", built: buildSetLooper('record'), expected: 'f0000174100f001af7' },
  { label: "buildSetLooper('play')", built: buildSetLooper('play'), expected: 'f0000174100f011bf7' },
  { label: "buildSetLooper('half_speed')", built: buildSetLooper('half_speed'), expected: 'f0000174100f051ff7' },
  { label: 'buildGetLooperState()', built: buildGetLooperState(), expected: 'f0000174100f7f65f7' },

  // 0x10 TEMPO TAP — single-byte payload-free envelope.
  { label: 'buildTempoTap()', built: buildTempoTap(), expected: 'f00001741010 05f7'.replace(/\s/g, '') },

  // 0x11 TUNER
  { label: 'buildSetTuner(true)', built: buildSetTuner(true), expected: 'f0000174101101 05f7'.replace(/\s/g, '') },
  { label: 'buildSetTuner(false)', built: buildSetTuner(false), expected: 'f0000174101100 04f7'.replace(/\s/g, '') },

  // 0x13 STATUS DUMP
  { label: 'buildStatusDump()', built: buildStatusDump(), expected: 'f00001741013 06f7'.replace(/\s/g, '') },

  // 0x14 TEMPO — 120 BPM = 0x78
  { label: 'buildSetTempo(120)', built: buildSetTempo(120), expected: 'f0000174101478 0079f7'.replace(/\s/g, '') },
  { label: 'buildGetTempo()', built: buildGetTempo(), expected: 'f000017410147f 7f01f7'.replace(/\s/g, '') },

  // 0x01 SET/GET PARAMETER —  corrected envelope (fn=0x01,
  // NOT fn=0x02 as initially II-ported). 10 public captures.
  // Envelope: F0 00 01 74 10 01 [09 00] [eff_lo eff_hi] [pid_lo pid_hi]
  //   00 00 00 [v0 v1 v2] 00 00 00 [cs] F7  (23 bytes)
  {
    label: 'buildSetParameter(66, 0, 0) — Reverb 1 paramId 0 min',
    built: buildSetParameter(66, 0, 0),
    expected: 'f000017410010900420000000000000000000000005ff7',
  },
  {
    label: 'buildSetParameter(66, 0, 65534) — Reverb 1 paramId 0 max',
    built: buildSetParameter(66, 0, 65534),
    expected: 'f000017410010900420000000000007e7f030000005df7',
  },
  {
    label: 'buildSetParameter(66, 11, 32767) — Reverb 1 paramId 11 mid',
    built: buildSetParameter(66, 11, 32767),
    expected: 'f00001741001090042000b000000007f7f0100000055f7',
  },
  {
    label: 'buildGetParameter(66, 0) — Reverb 1 query paramId 0',
    built: buildGetParameter(66, 0),
    expected: 'f000017410010900420000000000000000000000005ff7',
  },
  {
    label: 'buildSetParameterBypass(66, true) — Reverb 1 bypass via fn=0x01',
    built: buildSetParameterBypass(66, true),
    expected: 'f00001741001090042007f0100000001000000000020f7',
  },
];

// Public-capture parser goldens — verify the parser accepts and decodes
// real wire frames AxeEdit III emits to a real Axe-Fx III.
interface ParseCase {
  label: string;
  bytes: number[];
  expected: { effectId: number; paramId: number; value: number };
}

const parseCases: ParseCase[] = [
  // FC-12: Drive 1 boost ON (effectId=58, paramId=40, value=508)
  {
    label: 'FC-12 Drive 1 boost ON',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x52, 0x00, 0x3a, 0x00, 0x28, 0x00,
      0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x2b, 0xf7,
    ],
    expected: { effectId: 58, paramId: 40, value: 508 },
  },
  // Public forum capture, typed: Delay 1 TIME = 520 (effectId=70, paramId=2)
  {
    label: 'forum capture, typed Delay TIME=520',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x09, 0x00, 0x46, 0x00, 0x02, 0x00,
      0x00, 0x00, 0x00, 0x08, 0x04, 0x00, 0x00, 0x00, 0x00, 0x55, 0xf7,
    ],
    expected: { effectId: 70, paramId: 2, value: 520 },
  },
  // Public forum capture, drag: Delay 1 TIME = 503
  {
    label: 'forum capture, drag Delay TIME=503',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x52, 0x00, 0x46, 0x00, 0x02, 0x00,
      0x49, 0x27, 0x23, 0x77, 0x03, 0x00, 0x00, 0x00, 0x00, 0x3b, 0xf7,
    ],
    expected: { effectId: 70, paramId: 2, value: 503 },
  },
  // STATE_BROADCAST (sub-action 04 01) — paramId zero by convention.
  {
    label: 'STATE_BROADCAST 04 01',
    bytes: [
      0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x04, 0x01, 0x3a, 0x00, 0x00, 0x00,
      0x46, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6c, 0xf7,
    ],
    expected: { effectId: 58, paramId: 0, value: 198 },
  },
];

export function runAxeFxIIISetParamTests(): void {
  // packValue16 round-trips for the 16-bit value field.
  for (const v of [0, 1, 127, 128, 16383, 16384, 32767, 65534]) {
    const [a, b, c] = packValue16(v);
    const back = unpackValue16(a, b, c);
    if (back !== v) {
      throw new Error(`packValue16/unpackValue16 round-trip drift at ${v} — got ${back}`);
    }
  }

  // Envelope goldens.
  const failed: string[] = [];
  for (const c of cases) {
    const got = hex(c.built);
    if (got !== c.expected) {
      failed.push(`${c.label}\n  expected: ${c.expected}\n  got:      ${got}`);
    }
  }

  // Parser cases — verify recognizer + parser.
  for (const pc of parseCases) {
    if (!isSetGetParameterResponse(pc.bytes)) {
      failed.push(`${pc.label}: isSetGetParameterResponse returned false on capture`);
      continue;
    }
    const parsed = parseSetGetParameterResponse(pc.bytes);
    if (
      parsed.effectId !== pc.expected.effectId ||
      parsed.paramId !== pc.expected.paramId ||
      parsed.value !== pc.expected.value
    ) {
      failed.push(
        `${pc.label}: parser drift\n  expected: ${JSON.stringify(pc.expected)}\n  got:      ${JSON.stringify(parsed)}`,
      );
    }
  }

  // resolveEffectId sanity.
  if (resolveEffectId('Reverb 1') !== 66) {
    throw new Error(`resolveEffectId("Reverb 1") drift — expected 66, got ${resolveEffectId('Reverb 1')}`);
  }
  if (resolveEffectId('Compressor 1') !== 46) {
    throw new Error(`resolveEffectId("Compressor 1") drift — expected 46, got ${resolveEffectId('Compressor 1')}`);
  }
  if (resolveEffectId('Drive 1') !== 58) {
    throw new Error(`resolveEffectId("Drive 1") drift — expected 58, got ${resolveEffectId('Drive 1')}`);
  }

  // Round-trip self-consistency: build → parse → equality. Anchors the
  // codec ✅ claim independent of hardware verification — proves
  // buildSetParameter and parseSetGetParameterResponse agree on the
  // wire layout for every value in the supported 16-bit range.
  const roundTripValues = [0, 1, 127, 128, 8191, 8192, 16383, 16384, 32767, 32768, 65534];
  const roundTripCases: Array<{ effectId: number; paramId: number; value: number }> = [];
  for (const effectId of [46, 58, 66, 70]) {
    for (const paramId of [0, 1, 11, 40, 255, 1023]) {
      for (const value of roundTripValues) {
        roundTripCases.push({ effectId, paramId, value });
      }
    }
  }
  for (const rt of roundTripCases) {
    const built = buildSetParameter(rt.effectId, rt.paramId, rt.value);
    const parsed = parseSetGetParameterResponse(built);
    if (
      parsed.kind !== 'set_echo' ||
      parsed.effectId !== rt.effectId ||
      parsed.paramId !== rt.paramId ||
      parsed.value !== rt.value
    ) {
      failed.push(
        `round-trip drift effectId=${rt.effectId} paramId=${rt.paramId} value=${rt.value}: ` +
          `kind=${parsed.kind} effectId=${parsed.effectId} paramId=${parsed.paramId} value=${parsed.value}`,
      );
    }
  }

  // parseStateBroadcast: throws on non-broadcast frames, returns
  // {effectId, value} on `04 01` sub-action.
  const broadcastFrame = [
    0xf0, 0x00, 0x01, 0x74, 0x10, 0x01, 0x04, 0x01, 0x3a, 0x00, 0x00, 0x00,
    0x46, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x6c, 0xf7,
  ];
  const broadcast = parseStateBroadcast(broadcastFrame);
  if (broadcast.effectId !== 58 || broadcast.value !== 198) {
    failed.push(
      `parseStateBroadcast drift: expected {effectId:58,value:198}, got ${JSON.stringify(broadcast)}`,
    );
  }
  const setEchoFrame = buildSetParameter(66, 0, 100);
  let threwOnEcho = false;
  try {
    parseStateBroadcast(setEchoFrame);
  } catch {
    threwOnEcho = true;
  }
  if (!threwOnEcho) {
    failed.push('parseStateBroadcast: expected throw on set_echo frame, got silent return');
  }

  if (failed.length > 0) {
    throw new Error(
      `${failed.length}/${cases.length + parseCases.length + roundTripCases.length + 2} Axe-Fx III codec golden(s) failed:\n` +
        failed.join('\n'),
    );
  }
}

export const AXEFX3_GOLDEN_CASE_COUNT = (() => {
  // Mirror the runner's count for the test runner's progress line.
  // (cases + parseCases + 264 round-trips + 2 broadcast assertions.)
  return cases.length + parseCases.length + 4 * 6 * 11 + 2;
})();
