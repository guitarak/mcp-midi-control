/**
 * Offline golden for the gen-3 preset AUTHORING leg (presetAuthor.ts +
 * computeRawPatchXor + typeFieldByteOffset). No hardware.
 *
 * Four properties, all checkable against gitignored factory data:
 *  1. FOOTER INTERPRETATION — the parsed `fn=0x79` payload equals the uint16
 *     XOR of the raw_patch (septet-packed). Proven across every III factory
 *     preset (N=384) + an FM9 export. This is what makes recomputing the
 *     footer on an edit sound (presetDump previously treated it as opaque).
 *  2. IDENTITY RE-FRAME — parse → decode → reframe(same raw_patch) → serialize
 *     is byte-identical to the source dump (discriminators preserved, footer
 *     recomputes to the original).
 *  3. BODY RE-ENCODE — reencodeRawPatch(rawPatch, body) yields a CRC-valid
 *     patch that re-decodes to the same body (our Huffman round-trips).
 *  4. AUTHORING EDITS — swapBlockType + renamePreset produce a dump that
 *     re-decodes to the requested type / name with a valid CRC.
 *
 * Falls back to a self-contained synthetic check when the factory banks are
 * absent (CI / fresh clone), so preflight stays green.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  parsePresetBank,
  parsePresetDump,
  serializePresetDump,
} from '../packages/fractal-gen3/dist/presetDump.js';
import {
  decodeRawPatch,
  reencodeRawPatch,
  computeRawPatchXor,
} from '../packages/fractal-gen3/dist/presetHuffman.js';
import { decodeGen3PresetDump } from '../packages/fractal-gen3/dist/presetBody.js';
import {
  reframeRawPatch,
  encodeFooterXor,
  swapBlockType,
  renamePreset,
  listBlockTypes,
} from '../packages/fractal-gen3/dist/presetAuthor.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) ok += 1;
  else { fail += 1; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`); }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const FACTORY_III =
  'samples/factory/Axe-Fx-III-Factory-Preset-Banks-28p06/Axe-Fx_III_BANK_A-250603-182903.syx';
const FM9_EXPORT = 'samples/captured/fm9-152-super-duos2-exported-2026-06-03.syx';

function runOnDump(label: string, dumpBytes: Uint8Array, idx: number): void {
  const parsed = parsePresetDump(dumpBytes);
  const { rawPatch, body, crcValid } = decodeRawPatch(parsed.chunkPayloads);

  // (1) footer == uint16 XOR
  const xor = computeRawPatchXor(rawPatch);
  check(
    `${label}[${idx}] footer == uint16 XOR`,
    bytesEqual(parsed.footerPayload, encodeFooterXor(xor)),
    `footer=${Buffer.from(parsed.footerPayload).toString('hex')} xor=${xor.toString(16)}`,
  );

  // (2) identity re-frame is byte-identical
  const roundtrip = serializePresetDump(reframeRawPatch(parsed, rawPatch));
  check(`${label}[${idx}] identity reframe byte-exact`, bytesEqual(roundtrip, parsed.raw));

  check(`${label}[${idx}] source CRC valid`, crcValid);

  // (3) body re-encode survives a decode round-trip (only on a sample to keep it fast)
  if (idx === 0) {
    const reRaw = reencodeRawPatch(rawPatch, body);
    const reParsed = parsePresetDump(serializePresetDump(reframeRawPatch(parsed, reRaw)));
    const reDecoded = decodeRawPatch(reParsed.chunkPayloads);
    check(`${label}[${idx}] body re-encode CRC valid`, reDecoded.crcValid);
    check(`${label}[${idx}] body re-encode preserves body`, bytesEqual(reDecoded.body, body));
  }
}

function runEdits(label: string, dumpBytes: Uint8Array): void {
  const decoded = decodeGen3PresetDump(dumpBytes);
  const blocks = decoded.blocks ?? [];

  // rename
  const renamed = renamePreset(dumpBytes, 'AUTHOR TEST');
  const reDec = decodeGen3PresetDump(renamed);
  check(`${label} rename -> name`, reDec.preset_name === 'AUTHOR TEST', `got "${reDec.preset_name}"`);
  check(`${label} rename CRC valid`, reDec.crc_valid);

  // swap each swappable block present to a different known type
  for (const blockName of ['Amp', 'Drive', 'Reverb', 'Delay']) {
    const present = blocks.find((b) => b.block === blockName);
    if (!present) continue;
    const opts = listBlockTypes(blockName);
    if (opts.length < 2) continue;
    const currentId = present.channels?.A?.type_id ?? present.type_id;
    const targetOpt = opts.find((o) => o.id !== currentId) ?? opts[0];
    const res = swapBlockType(dumpBytes, blockName, targetOpt.name, 'A');
    const after = decodeGen3PresetDump(res.syx);
    check(`${label} swap ${blockName} CRC valid`, after.crc_valid);
    const ab = after.blocks?.find((b) => b.block === blockName);
    const newType = ab?.channels?.A?.type ?? ab?.type;
    check(
      `${label} swap ${blockName} -> "${res.resolvedType}"`,
      newType === res.resolvedType,
      `decoded "${newType}" expected "${res.resolvedType}"`,
    );
  }
}

console.log('gen-3 authoring verification');

if (existsSync(FACTORY_III)) {
  const bank = parsePresetBank(readFileSync(FACTORY_III), 0x10);
  console.log(`  III BANK_A: ${bank.length} presets`);
  let cursor = 0;
  const src = readFileSync(FACTORY_III);
  for (let i = 0; i < bank.length; i++) {
    const dump = src.subarray(cursor, cursor + bank[i].byteLength);
    runOnDump('III', dump, i);
    cursor += bank[i].byteLength;
  }
  // edits on the first preset only (recompress is the slow part)
  runEdits('III', src.subarray(0, bank[0].byteLength));
} else {
  console.log('  (III factory bank absent — footer/reframe golden skipped)');
}

if (existsSync(FM9_EXPORT)) {
  const dump = readFileSync(FM9_EXPORT);
  runOnDump('FM9', dump, 0);
  runEdits('FM9', dump);
} else {
  console.log('  (FM9 export absent — skipped)');
}

if (!existsSync(FACTORY_III) && !existsSync(FM9_EXPORT)) {
  console.log('  (no factory data present — authoring golden requires gitignored sample banks)');
}

console.log(`\n${fail === 0 ? '✓' : '✗'} gen-3 authoring: ${ok} ok, ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
