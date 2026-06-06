/**
 * Synthetic gen-3 preset-dump round-trip golden (portable, no fixtures).
 *
 * The fixture-driven preset-dump goldens (verify-preset-dump-iii.ts,
 * verify-preset-dump-fm9.ts) live under the git-ignored `samples/` tree, so
 * on a fresh clone / CI they SKIP and assert nothing. The shipped
 * export_preset / import_preset path leans on this same parser
 * (parsePresetDump / serializePresetDump / parsePresetBank / extractPresetName
 * in packages/fractal-modern/src/presetDump.ts), so this golden constructs a
 * valid dump IN MEMORY for every gen-3 model byte and round-trips it, giving
 * the parser a portable backstop that runs everywhere.
 *
 * It builds the dump via serializePresetDump (real checksums, 7-bit-clean
 * payloads), parses it back, and asserts: model detection, frame count,
 * byte-identical re-serialization, preset-name word decode, bank splitting,
 * model auto-detect, and that a corrupted checksum is rejected.
 *
 * Run: `npx tsx scripts/verify-preset-dump-synthetic.ts`
 * Status: offline, no hardware, no fixtures.
 */

import {
  HEADER_LEN,
  CHUNK_LEN,
  FOOTER_LEN,
  HEADER_PAYLOAD_LEN,
  CHUNK_PAYLOAD_LEN,
  FOOTER_PAYLOAD_LEN,
  PRESET_NAME_MAGIC,
  PRESET_NAME_MAGIC_WORD_INDEX,
  PRESET_NAME_FIRST_WORD,
  parsePresetDump,
  parsePresetBank,
  serializePresetDump,
  extractPresetName,
  type ParsedPresetDump,
} from '@mcp-midi-control/fractal-modern/presetDump.js';

let pass = 0;
let fail = 0;
function check(label: string, condition: boolean, detail = ''): void {
  if (condition) { console.log(`  ok    ${label}`); pass++; }
  else { console.log(`  FAIL  ${label}${detail ? ', ' + detail : ''}`); fail++; }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function firstDiff(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : n;
}

// Chunk body words are 3-byte septet-packed (CHUNK_BODY_OFFSET = 2). Write one.
function setWord(buf: Uint8Array, wordIndex: number, value: number): void {
  const off = 2 + wordIndex * 3;
  buf[off] = value & 0x7f;
  buf[off + 1] = (value >> 7) & 0x7f;
  buf[off + 2] = (value >> 14) & 0x7f;
}

function makeChunk(chunkIndex: number, name?: string): Uint8Array {
  const buf = new Uint8Array(CHUNK_PAYLOAD_LEN);
  // Deterministic 7-bit filler (real SysEx payload is 7-bit; never 0xF7).
  for (let i = 0; i < buf.length; i++) buf[i] = (i + chunkIndex * 31) & 0x7f;
  if (name !== undefined) {
    setWord(buf, PRESET_NAME_MAGIC_WORD_INDEX, PRESET_NAME_MAGIC);
    let wi = PRESET_NAME_FIRST_WORD;
    for (let c = 0; c < name.length; c += 2) {
      const lo = name.charCodeAt(c);
      const hi = c + 1 < name.length ? name.charCodeAt(c + 1) : 0;
      setWord(buf, wi++, (lo | (hi << 8)) & 0xffff);
    }
    setWord(buf, wi, 0); // NUL-terminate
  }
  return buf;
}

function makeDump(modelId: number, chunkCount: number, name?: string): Uint8Array {
  const headerPayload = new Uint8Array(HEADER_PAYLOAD_LEN);
  for (let i = 0; i < headerPayload.length; i++) headerPayload[i] = (i * 13 + 1) & 0x7f;
  const footerPayload = new Uint8Array(FOOTER_PAYLOAD_LEN);
  for (let i = 0; i < footerPayload.length; i++) footerPayload[i] = (i * 7 + 3) & 0x7f;
  const chunkPayloads = Array.from({ length: chunkCount }, (_, ci) =>
    makeChunk(ci, ci === 0 ? name : undefined));
  // serializePresetDump only reads modelId / headerPayload / chunkPayloads /
  // footerPayload; raw + byteLength are unused on the build path.
  const synthetic = { modelId, headerPayload, chunkPayloads, footerPayload } as unknown as ParsedPresetDump;
  return serializePresetDump(synthetic);
}

console.log('Synthetic gen-3 preset-dump round-trip golden (no fixtures):');

// Every gen-3 model byte, with the canonical-ish chunk counts.
const NAME = 'Synth Demo 42';
for (const { id, label, chunks } of [
  { id: 0x10, label: 'Axe-Fx III', chunks: 16 },
  { id: 0x11, label: 'FM3', chunks: 16 },
  { id: 0x12, label: 'FM9', chunks: 8 },
  { id: 0x14, label: 'VP4', chunks: 8 },
]) {
  const expectedLen = HEADER_LEN + CHUNK_LEN * chunks + FOOTER_LEN;
  const bytes = makeDump(id, chunks, NAME);
  check(`${label} (0x${id.toString(16)}): built dump is ${expectedLen} bytes`, bytes.length === expectedLen, `got ${bytes.length}`);

  let parsed: ParsedPresetDump | undefined;
  try { parsed = parsePresetDump(bytes, 0, id); }
  catch (err) { check(`${label}: parsePresetDump threw`, false, err instanceof Error ? err.message : String(err)); }

  if (parsed) {
    check(`${label}: model byte = 0x${id.toString(16)}`, parsed.modelId === id, `got 0x${parsed.modelId.toString(16)}`);
    check(`${label}: counted ${chunks} chunk frames`, parsed.chunkPayloads.length === chunks, `got ${parsed.chunkPayloads.length}`);
    check(`${label}: byteLength = ${expectedLen}`, parsed.byteLength === expectedLen, `got ${parsed.byteLength}`);
    const re = serializePresetDump(parsed);
    check(`${label}: re-serializes byte-identical`, bytesEqual(re, bytes), `first diff at byte ${firstDiff(re, bytes)}`);
    check(`${label}: preset name decodes to "${NAME}"`, extractPresetName(parsed) === NAME, `got ${JSON.stringify(extractPresetName(parsed))}`);

    // Auto-detect (no expectedModelId) yields the same parse.
    try {
      const auto = parsePresetDump(bytes, 0);
      check(`${label}: model auto-detect matches`, auto.modelId === id && bytesEqual(auto.raw, parsed.raw), `auto 0x${auto.modelId.toString(16)}`);
    } catch (err) {
      check(`${label}: auto-detect threw`, false, err instanceof Error ? err.message : String(err));
    }
  }
}

// parsePresetBank over two concatenated dumps of different chunk counts.
{
  const a = makeDump(0x12, 8, 'First');
  const b = makeDump(0x12, 8, 'Second');
  const concat = new Uint8Array(a.length + b.length);
  concat.set(a, 0); concat.set(b, a.length);
  try {
    const bank = parsePresetBank(concat, 0x12);
    check('parsePresetBank splits 2 concatenated dumps', bank.length === 2, `got ${bank.length}`);
    check('parsePresetBank preset 0 name = "First"', bank[0] && extractPresetName(bank[0]) === 'First', JSON.stringify(bank[0] && extractPresetName(bank[0])));
    check('parsePresetBank preset 1 name = "Second"', bank[1] && extractPresetName(bank[1]) === 'Second', JSON.stringify(bank[1] && extractPresetName(bank[1])));
    check('parsePresetBank preset 1 round-trips', !!bank[1] && bytesEqual(serializePresetDump(bank[1]), b));
  } catch (err) {
    check('parsePresetBank threw', false, err instanceof Error ? err.message : String(err));
  }
}

// A corrupted checksum must be rejected, not silently accepted.
{
  const bytes = makeDump(0x10, 16, 'Tamper');
  bytes[8] = (bytes[8] + 1) & 0x7f; // flip a header payload byte; header checksum no longer matches
  let threw = false;
  try { parsePresetDump(bytes, 0, 0x10); } catch { threw = true; }
  check('corrupted checksum is rejected', threw);
}

console.log(`\n${pass} ok, ${fail} fail.`);
if (fail > 0) process.exit(1);
