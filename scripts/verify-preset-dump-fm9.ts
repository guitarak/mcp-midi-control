/**
 * FM9 preset-dump round-trip golden.
 *
 * Proves the model-byte-parametric, frame-counted gen-3 preset-dump parser
 * (`packages/fractal-gen3/src/presetDump.ts`) handles an FM9 export, whose
 * envelope is identical to the Axe-Fx III's but with a different model byte
 * (0x12) and chunk count (8 vs 16):
 *   - 24,680 bytes per preset
 *   - 8 chunks x 3074-byte payload
 *   - model byte 0x12
 *
 * Fixture: an on-disk FM9 export at
 * `samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx`. The
 * `samples/` tree is git-ignored local scratch, so a missing fixture is
 * skipped (with a notice) rather than failing, keeping `npm test` green on
 * a fresh clone.
 *
 * The same parser proves the III factory banks in
 * `scripts/verify-preset-dump-iii.ts`; this golden is the cross-model proof
 * that the generalization (count-by-framing, no hardcoded 0x10 / 16-chunk
 * assumption) actually parses a different model.
 */

import { existsSync, readFileSync } from 'node:fs';
import {
  HEADER_LEN,
  CHUNK_LEN,
  FOOTER_LEN,
  extractPresetName,
  parsePresetDump,
  parsePresetBank,
  serializePresetDump,
} from '@mcp-midi-control/fractal-gen3/presetDump.js';

const FM9_MODEL_ID = 0x12;
const FM9_CHUNK_COUNT = 8;
const FM9_DUMP_LEN = HEADER_LEN + CHUNK_LEN * FM9_CHUNK_COUNT + FOOTER_LEN; // 24,680
const EXPECTED_NAME = 'Super Duos2';

const FIXTURE = 'samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx';

let pass = 0;
let fail = 0;
let skipped = 0;

function ok(label: string): void {
  console.log(`  ok    ${label}`);
  pass++;
}

function bad(label: string, detail = ''): void {
  console.log(`  FAIL  ${label}${detail ? ', ' + detail : ''}`);
  fail++;
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) ok(label);
  else bad(label, detail);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function firstDiffOffset(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

console.log('FM9 preset-dump round-trip golden:');
console.log(
  `  expected: ${FM9_DUMP_LEN} B/preset = ${HEADER_LEN}B header + ${FM9_CHUNK_COUNT}x${CHUNK_LEN}B chunks + ${FOOTER_LEN}B footer (model 0x12)`,
);
console.log('');

if (!existsSync(FIXTURE)) {
  console.log(`  skip  ${FIXTURE} (not present)`);
  skipped++;
} else {
  const bytes = new Uint8Array(readFileSync(FIXTURE));

  check(`${FIXTURE}: on-disk length is ${FM9_DUMP_LEN} bytes`, bytes.length === FM9_DUMP_LEN, `got ${bytes.length}`);

  let parsed;
  try {
    parsed = parsePresetDump(bytes, 0, FM9_MODEL_ID);
  } catch (err) {
    bad(`${FIXTURE}: parsePresetDump threw`, err instanceof Error ? err.message : String(err));
    parsed = undefined;
  }

  if (parsed) {
    check(`${FIXTURE}: model byte detected as 0x12`, parsed.modelId === FM9_MODEL_ID, `got 0x${parsed.modelId.toString(16)}`);
    check(
      `${FIXTURE}: counted ${FM9_CHUNK_COUNT} chunk frames by framing`,
      parsed.chunkPayloads.length === FM9_CHUNK_COUNT,
      `got ${parsed.chunkPayloads.length}`,
    );
    check(`${FIXTURE}: byteLength is ${FM9_DUMP_LEN}`, parsed.byteLength === FM9_DUMP_LEN, `got ${parsed.byteLength}`);

    const reserialized = serializePresetDump(parsed);
    check(
      `${FIXTURE}: round-trips byte-identical`,
      bytesEqual(reserialized, parsed.raw),
      `first diff at byte ${firstDiffOffset(reserialized, parsed.raw)}`,
    );

    const name = extractPresetName(parsed);
    check(`${FIXTURE}: preset name decodes to "${EXPECTED_NAME}"`, name === EXPECTED_NAME, `got ${JSON.stringify(name)}`);

    // parsePresetBank over a single-preset buffer should yield exactly one dump.
    try {
      const bank = parsePresetBank(bytes, FM9_MODEL_ID);
      check(
        `${FIXTURE}: parsePresetBank yields 1 preset`,
        bank.length === 1 && bytesEqual(bank[0].raw, parsed.raw),
        `got ${bank.length} presets`,
      );
    } catch (err) {
      bad(`${FIXTURE}: parsePresetBank threw`, err instanceof Error ? err.message : String(err));
    }

    // Model auto-detection (no expectedModelId) should yield the same parse.
    try {
      const auto = parsePresetDump(bytes, 0);
      check(
        `${FIXTURE}: model auto-detect (no expectedModelId) matches`,
        auto.modelId === FM9_MODEL_ID && bytesEqual(auto.raw, parsed.raw),
        `auto model 0x${auto.modelId.toString(16)}`,
      );
    } catch (err) {
      bad(`${FIXTURE}: parsePresetDump auto-detect threw`, err instanceof Error ? err.message : String(err));
    }
  }
}

console.log(`\n${pass} ok, ${fail} fail, ${skipped} skipped.`);
if (fail > 0) process.exit(1);
