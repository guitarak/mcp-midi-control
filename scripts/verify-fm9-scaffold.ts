/**
 * FM9 foundation-scaffold verifier (hardware-free).
 *
 * Byte-exact goldens for the FM9 codec stub plus structural checks on
 * the descriptor. The envelope goldens are HAND-COMPUTED from the
 * family framing rule (`F0 00 01 74 [model] [fn] [payload...] [xor7
 * checksum] F7`) using the hypothesized model byte 0x12 — they verify
 * the BUILDERS are internally consistent, not that the model byte is
 * right. Hardware verification of the model byte is a separate step
 * (see the FM9_MODEL_ID doc comment in fractal-midi/fm9).
 *
 * Also asserts family parity: building the same function with the
 * III's model byte through `buildEnvelopeWithModel` must reproduce the
 * III codec's own output byte-for-byte, proving the FM9 stub is a
 * faithful clone of the III's framing.
 */
import {
  FM9_MODEL_ID,
  FN_SET_GET_SCENE,
  buildDeviceInquiry,
  buildEnvelopeWithModel,
  buildGetScene,
  buildQueryPatchName,
  buildSetScene,
  buildStatusDump,
  buildSwitchPresetPC,
  isQueryPatchNameResponse,
  parseFractalFrame,
} from 'fractal-midi/fm9';
import {
  AXE_FX_III_MODEL_ID,
  buildGetScene as iiiBuildGetScene,
} from 'fractal-midi/axe-fx-iii';
import { FM9_DESCRIPTOR } from '@mcp-midi-control/fm9/descriptor.js';

let failures = 0;

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

function check(label: string, actual: string, expected: string): void {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`);
  if (!ok) {
    console.log(`       built:    ${actual}`);
    console.log(`       expected: ${expected}`);
  }
}

function checkTrue(label: string, cond: boolean): void {
  if (!cond) failures += 1;
  console.log(`  ${cond ? 'OK  ' : 'FAIL'} ${label}`);
}

console.log('=== FM9 codec stub: byte-exact envelope goldens (model byte 0x12, hardware-verified 2026-06-06) ===');
checkTrue(`FM9_MODEL_ID is 0x12 (hardware-verified)`, FM9_MODEL_ID === 0x12);
check('buildSetScene(0)', hex(buildSetScene(0)), 'f0000174120c001bf7');
check('buildSetScene(7)', hex(buildSetScene(7)), 'f0000174120c071cf7');
check('buildGetScene()', hex(buildGetScene()), 'f0000174120c7f64f7');
check("buildQueryPatchName('current')", hex(buildQueryPatchName('current')), 'f0000174120d7f7f1af7');
check('buildQueryPatchName(5)', hex(buildQueryPatchName(5)), 'f0000174120d05001ff7');
check('buildStatusDump()', hex(buildStatusDump()), 'f0000174121304f7');
check('buildDeviceInquiry()', hex(buildDeviceInquiry()), 'f07e7f0601f7');

console.log('=== Preset switch: standard MIDI PC + Bank Select ===');
// Bank rides in CC0 (MSB) — HARDWARE-VERIFIED on a real FM9 (the unit
// ignores CC32; see buildSwitchPresetPC's doc comment).
check('buildSwitchPresetPC(5)', hex(buildSwitchPresetPC(5)), 'b00000b02000c005');
check('buildSwitchPresetPC(130)', hex(buildSwitchPresetPC(130)), 'b00001b02000c002');
check('buildSwitchPresetPC(511)', hex(buildSwitchPresetPC(511)), 'b00003b02000c07f');
checkTrue('buildSwitchPresetPC(512) throws (FM9 has 512 slots)', (() => {
  try { buildSwitchPresetPC(512); return false; } catch { return true; }
})());

console.log('=== Family parity: FM9 framing === III framing with the model byte swapped ===');
check(
  'buildEnvelopeWithModel(III model, 0x0C, [0x7f]) === III buildGetScene()',
  hex(buildEnvelopeWithModel(AXE_FX_III_MODEL_ID, FN_SET_GET_SCENE, [0x7f])),
  hex(iiiBuildGetScene()),
);

console.log('=== Predicates + frame inspector ===');
const fm9NameFrame = buildQueryPatchName('current');
const iiiStyleFrame = buildEnvelopeWithModel(AXE_FX_III_MODEL_ID, 0x0d, [0x7f, 0x7f]);
checkTrue('isQueryPatchNameResponse accepts a 0x12-model 0x0D frame', isQueryPatchNameResponse(fm9NameFrame));
checkTrue('isQueryPatchNameResponse rejects a 0x10-model 0x0D frame', !isQueryPatchNameResponse(iiiStyleFrame));
const inspected = parseFractalFrame(iiiStyleFrame);
checkTrue('parseFractalFrame reports modelId of an arbitrary family frame', inspected?.modelId === AXE_FX_III_MODEL_ID);
checkTrue('parseFractalFrame validates the checksum', inspected?.checksumOk === true);

console.log('=== Descriptor structure (foundation scaffold) ===');
checkTrue("id === 'fm9'", FM9_DESCRIPTOR.id === 'fm9');
checkTrue("preset_class === 'layout'", FM9_DESCRIPTOR.preset_class === 'layout');
const matches = (name: string): boolean =>
  FM9_DESCRIPTOR.port_match.some((m) =>
    typeof m.pattern === 'string' ? name.toLowerCase().includes(m.pattern.toLowerCase()) : m.pattern.test(name));
checkTrue("port_match matches 'FM9 MIDI Out'", matches('FM9 MIDI Out'));
checkTrue("port_match matches 'Fractal Audio FM9'", matches('Fractal Audio FM9'));
checkTrue("port_match matches 'FM-9'", matches('FM-9'));
checkTrue("port_match does NOT match 'Axe-Fx III MIDI'", !matches('Axe-Fx III MIDI'));
checkTrue("port_match does NOT match 'Fractal AM4'", !matches('Fractal AM4'));
checkTrue('blocks map is EMPTY (no catalog mined yet)', Object.keys(FM9_DESCRIPTOR.blocks).length === 0);
checkTrue('grid is 4×14 (per FRACTAL-PRESET-SCHEMA.md, column count unverified)',
  FM9_DESCRIPTOR.capabilities.grid?.rows === 4 && FM9_DESCRIPTOR.capabilities.grid?.cols === 14);
checkTrue('8 scenes, channels A..D', FM9_DESCRIPTOR.capabilities.scene_count === 8
  && (FM9_DESCRIPTOR.capabilities.channel_names ?? []).join('') === 'ABCD');
checkTrue('writer.buildSwitchPreset(5) emits the PC sequence',
  hex(FM9_DESCRIPTOR.writer.buildSwitchPreset!(5)) === 'b00000b02000c005');
checkTrue('writer.buildSwitchScene(1) emits scene wire 0',
  hex(FM9_DESCRIPTOR.writer.buildSwitchScene!(1)) === 'f0000174120c001bf7');
checkTrue('writer.buildSetParam refuses (no catalog)', (() => {
  try { FM9_DESCRIPTOR.writer.buildSetParam('amp', 'gain', 0); return false; } catch { return true; }
})());

if (failures > 0) {
  console.error(`\nverify-fm9-scaffold: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nverify-fm9-scaffold: all checks passed.');
