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
  FM9_BLOCKS,
  FM9_FAMILIES,
  FM9_UNRESOLVED_PARAMS,
  PARAMS,
  PARAMS_BY_FAMILY,
  resolveBlockByEffectId,
  resolveEffectId,
  buildSetParameter,
  parseSetGetParameterResponse,
  isGetParameterResponse,
  parseGetParameterResponse,
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

console.log('=== Mined catalog (FM9-Edit XML + III-shared addressing) ===');
checkTrue(`44 families present (got ${FM9_FAMILIES.length})`, FM9_FAMILIES.length === 44);
checkTrue(`catalog carries >1500 params (got ${PARAMS.length})`, PARAMS.length > 1500);
checkTrue(`4 unresolved FM9-divergent params (got ${FM9_UNRESOLVED_PARAMS.length})`, FM9_UNRESOLVED_PARAMS.length === 4);
checkTrue('Amp block binds the DISTORT family', FM9_BLOCKS.find((b) => b.name === 'Amp')?.family === 'DISTORT');
checkTrue('Drive block binds the FUZZ family', FM9_BLOCKS.find((b) => b.name === 'Drive')?.family === 'FUZZ');
checkTrue('DISTORT family has the amp knobs (MASTER present)',
  (PARAMS_BY_FAMILY['DISTORT'] ?? []).some((p) => p.name === 'DISTORT_MASTER'));
checkTrue("resolveEffectId('Amp', 1) === 58", resolveEffectId('Amp', 1) === 58);
checkTrue("resolveEffectId('Drive', 2) === 119", resolveEffectId('Drive', 2) === 119);
checkTrue("resolveEffectId('Delay', 2) === 71", resolveEffectId('Delay', 2) === 71);
checkTrue('resolveBlockByEffectId(66) → Reverb instance 1', (() => {
  const r = resolveBlockByEffectId(66);
  return r?.block.name === 'Reverb' && r?.instance === 1;
})());
checkTrue('resolveBlockByEffectId(201) → Preset FC instance 2 (non-grid; cross-checked vs FM9-Edit)', (() => {
  const r = resolveBlockByEffectId(201);
  return r?.block.name === 'Preset FC' && r?.instance === 2 && r?.block.addressable === false;
})());
checkTrue('fn=0x01 SET builder round-trips through the parser', (() => {
  const parsed = parseSetGetParameterResponse(buildSetParameter(58, 5, 1234));
  return parsed.kind === 'set_echo' && parsed.effectId === 58 && parsed.paramId === 5 && parsed.value === 1234;
})());
checkTrue('fn=0x01 SET frame checksum validates', parseFractalFrame(buildSetParameter(58, 5, 1234))?.checksumOk === true);

console.log('=== fn=0x01 GET response — hardware-captured goldens (FM9, 2026-06-06) ===');
// Three live captures from the catalog-stage read-only probe. The GET
// response carries the internal IEEE float (5-septet LSB) + the
// device's own display string (8→7 sliding-window packed).
const GET_AMP = [0xf0,0x00,0x01,0x74,0x12,0x01,0x09,0x00,0x3a,0x00,0x05,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x20,0x00,0x22,0x53,0x48,0x74,0x0a,0x1d,0x0a,0x44,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x14,0xf7];
const GET_DLY = [0xf0,0x00,0x01,0x74,0x12,0x01,0x09,0x00,0x46,0x00,0x11,0x00,0x00,0x00,0x00,0x78,0x03,0x00,0x00,0x20,0x00,0x18,0x0b,0x46,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x46,0xf7];
checkTrue('captured amp GET frame is recognized as a GET response', isGetParameterResponse(GET_AMP));
checkTrue('captured amp GET decodes: id 58/5, value 0.0, display "ENGAGED"', (() => {
  const p = parseGetParameterResponse(GET_AMP);
  return p.effectId === 58 && p.paramId === 5 && p.valueBits === 0 && p.displayString === 'ENGAGED';
})());
checkTrue('captured delay GET decodes: id 70/17, internal 0.5, display "0.0"', (() => {
  const p = parseGetParameterResponse(GET_DLY);
  return p.effectId === 70 && p.paramId === 17 && p.valueBits === 0x3f000000
    && p.internalValue === 0.5 && p.displayString === '0.0';
})());
checkTrue('23-byte SET echo is NOT misclassified as a GET response',
  !isGetParameterResponse(buildSetParameter(58, 5, 1234)));

console.log('=== Descriptor structure (catalog stage) ===');
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
const blockCount = Object.keys(FM9_DESCRIPTOR.blocks).length;
checkTrue(`blocks schema populated (${blockCount} blocks)`, blockCount >= 40);
checkTrue("amp block exposes 'master' + 'presence' (DISTORT family)",
  'master' in (FM9_DESCRIPTOR.blocks['amp']?.params ?? {}) && 'presence' in (FM9_DESCRIPTOR.blocks['amp']?.params ?? {}));
checkTrue("drive block exposes 'drive' (FUZZ family)", 'drive' in (FM9_DESCRIPTOR.blocks['drive']?.params ?? {}));
checkTrue("reverb block exposes 'time' + 'mix'",
  'time' in (FM9_DESCRIPTOR.blocks['reverb']?.params ?? {}) && 'mix' in (FM9_DESCRIPTOR.blocks['reverb']?.params ?? {}));
checkTrue('effects_loop block has empty params (no FM9-Edit params)',
  Object.keys(FM9_DESCRIPTOR.blocks['effects_loop']?.params ?? { x: 1 }).length === 0);
// Every block_params_summary entry must resolve on its block's schema.
const summaryBad: string[] = [];
for (const [slug, names] of Object.entries(FM9_DESCRIPTOR.block_params_summary ?? {})) {
  const schema = FM9_DESCRIPTOR.blocks[slug];
  if (!schema) { summaryBad.push(`${slug} (no such block)`); continue; }
  for (const n of names) if (!(n in schema.params)) summaryBad.push(`${slug}.${n}`);
}
checkTrue(`block_params_summary entries all resolve${summaryBad.length ? ' — BAD: ' + summaryBad.join(', ') : ''}`, summaryBad.length === 0);
checkTrue('grid is 6×14 (measured from FM9-Edit GridUnitSkin)',
  FM9_DESCRIPTOR.capabilities.grid?.rows === 6 && FM9_DESCRIPTOR.capabilities.grid?.cols === 14);
checkTrue('8 scenes, channels A..D', FM9_DESCRIPTOR.capabilities.scene_count === 8
  && (FM9_DESCRIPTOR.capabilities.channel_names ?? []).join('') === 'ABCD');
checkTrue('atomic_read enabled (get_preset via STATUS_DUMP)', FM9_DESCRIPTOR.capabilities.atomic_read === true);
checkTrue('writer.buildSwitchPreset(5) emits the PC sequence',
  hex(FM9_DESCRIPTOR.writer.buildSwitchPreset!(5)) === 'b00000b02000c005');
checkTrue('writer.buildSwitchScene(1) emits scene wire 0',
  hex(FM9_DESCRIPTOR.writer.buildSwitchScene!(1)) === 'f0000174120c001bf7');
checkTrue('writer.buildSetParam(amp.master) builds a 23-byte fn=0x01 frame',
  FM9_DESCRIPTOR.writer.buildSetParam('amp', 'master', 100).length === 23);
checkTrue('writer.setParam (execute) refuses — writes gated until calibration', await (async () => {
  try { await FM9_DESCRIPTOR.writer.setParam!(null as never, 'amp', 'master', 100); return false; } catch { return true; }
})());

if (failures > 0) {
  console.error(`\nverify-fm9-scaffold: ${failures} check(s) FAILED.`);
  process.exit(1);
}
console.log('\nverify-fm9-scaffold: all checks passed.');
