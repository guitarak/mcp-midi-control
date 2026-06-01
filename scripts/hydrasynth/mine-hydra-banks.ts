/**
 * Mine decodable .hydra banks into a category-grouped patch corpus.
 *
 * The ASM Manager v2.x `.patch` export format is 2786 bytes — the same
 * on-disk payload that maps to our 2790-byte wire buffer via a 4-byte
 * routing-header prepend (`samples/hydrasynth/README.md`: "ETCD magic at
 * file offset 1762 = wire offset 1766"). `decodePatch` (patchEncoder.ts)
 * reads that buffer back into canonical params, so these banks decode
 * fully OFFLINE — no hardware, no round-trip.
 *
 * This script:
 *   - walks the given dirs for `.hydra` (ZIP-of-`.patch`) and `.zip`
 *     (which may nest a `.hydra`),
 *   - for every 2786-byte `.patch`, prepends `[0x06,0x00,0x00,0x00]`,
 *     validates the ETCD magic, reads the self-declared category byte
 *     (buffer offset 8) + patch name, and `decodePatch`es it,
 *   - emits display + wire values per param,
 *   - writes a JSON corpus to `samples/hydrasynth/bank-corpus.json`
 *     (samples/ is gitignored) and prints a category histogram.
 *
 * The 1762-byte legacy/dense format is skipped + counted (not decodable
 * with PATCH_OFFSETS; superseded by the v2.0 factory banks).
 *
 * Usage:
 *   npx tsx scripts/hydrasynth/mine-hydra-banks.ts [dir ...]
 * Defaults to the local ASM Packs dir plus the Downloads banks dir.
 *
 * NOT shipped, not part of preflight: a one-time corpus generator for
 * the patch-recipe curation. Reuses the production decoder so the
 * corpus reflects exactly what apply_patch would round-trip.
 */
import AdmZip from 'adm-zip';
import { readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, extname, basename } from 'node:path';

import {
  PATCH_BUFFER_SIZE,
  decodePatch,
  readPatchName,
} from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import { decodeNrpnDisplay } from '@mcp-midi-control/hydrasynth/nrpnDisplay.js';
import { HYDRASYNTH_NRPNS } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { HYDRASYNTH_ENUMS } from '@mcp-midi-control/hydrasynth/enums.js';

/** name → NRPN entry, for enum-table resolution. */
const NRPN_BY_NAME = new Map(HYDRASYNTH_NRPNS.map((e) => [e.name, e]));

/**
 * Best-effort display conversion for the reference corpus. Priority:
 *   1. curated numeric formula (ms / %, etc.) via decodeNrpnDisplay,
 *   2. enum table (osc/filter/fx type, lfo wave) → label name,
 *   3. raw decoder output (signed for s8/s16; wire-scale for bipolar
 *      u16le — left as-is; the workflow generalizes exact knob values).
 */
function toDisplay(name: string, value: number): number | string {
  const formula = decodeNrpnDisplay(name, value);
  if (formula !== undefined) return formula;
  const entry = NRPN_BY_NAME.get(name);
  if (entry?.enumTable) {
    const table = HYDRASYNTH_ENUMS[entry.enumTable] as Record<number, string> | undefined;
    const label = table?.[Math.round(value)];
    if (label !== undefined) return label;
  }
  return value;
}

/** Hydrasynth patch-category enum — edisyn ASMHydrasynth.java:99 (19 values). */
const CATEGORIES = [
  'Ambient', 'Arp', 'Bass', 'BassLead', 'Brass', 'Chord', 'Drum', 'E-piano',
  'FX', 'FxMusic', 'Keys', 'Lead', 'Organ', 'Pad', 'Perc', 'Rhythmic',
  'Sequence', 'Strings', 'Vocal',
] as const;

const PATCH_FILE_SIZE = 2786; // ASM Manager v2.x on-disk payload (no 4-byte header)
const ETCD = [69, 84, 67, 68]; // "ETCD" magic, wire offset 1766
const CATEGORY_BYTE = 8;       // wire offset (file offset 4 + 4-byte prepend)

interface MinedPatch {
  bank: string;
  slot: string;
  name: string;
  category: string;
  params: Record<string, number | string>; // display values
  wire: Record<string, number>;            // raw wire values (decoder output)
}

function toWireBuffer(patchBytes: Uint8Array): Uint8Array {
  const buf = new Uint8Array(PATCH_BUFFER_SIZE);
  buf.set([0x06, 0x00, 0x00, 0x00], 0);
  buf.set(patchBytes, 4);
  return buf;
}

function magicOk(buf: Uint8Array): boolean {
  return ETCD.every((b, i) => buf[1766 + i] === b);
}

const skipped = { wrongSize: 0, badMagic: 0 };

function processPatch(bankLabel: string, entryName: string, bytes: Uint8Array): MinedPatch | undefined {
  if (bytes.length !== PATCH_FILE_SIZE) {
    skipped.wrongSize++;
    return undefined;
  }
  const buf = toWireBuffer(bytes);
  if (!magicOk(buf)) {
    skipped.badMagic++;
    return undefined;
  }
  const catIdx = buf[CATEGORY_BYTE];
  const category = CATEGORIES[catIdx] ?? `cat${catIdx}`;
  const name = readPatchName(buf);
  const base = basename(entryName).replace(/\.patch$/i, '');
  const slot = base.slice(0, 2); // 2-hex prefix
  const wireMap = decodePatch(buf);
  const params: Record<string, number | string> = {};
  const wire: Record<string, number> = {};
  for (const [n, w] of wireMap) {
    wire[n] = w;
    params[n] = toDisplay(n, w);
  }
  return { bank: bankLabel, slot, name: name.trim(), category, params, wire };
}

/** Read .patch entries from a .hydra (ZIP) buffer. */
function minePatchesFromHydra(bankLabel: string, hydraBuf: Buffer, out: MinedPatch[]): void {
  const zip = new AdmZip(hydraBuf);
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (!e.entryName.toLowerCase().endsWith('.patch')) continue;
    const mined = processPatch(bankLabel, e.entryName, new Uint8Array(e.getData()));
    if (mined) out.push(mined);
  }
}

function mineFile(path: string, out: MinedPatch[]): void {
  const ext = extname(path).toLowerCase();
  const label = basename(path).replace(/\.(hydra|zip)$/i, '');
  if (ext === '.hydra') {
    const zip = new AdmZip(path);
    minePatchesFromHydra(label, zip.toBuffer(), out);
  } else if (ext === '.zip') {
    // Outer .zip may nest a .hydra (Downloads banks) or hold .patch directly.
    const zip = new AdmZip(path);
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const n = e.entryName.toLowerCase();
      if (n.endsWith('.hydra')) {
        minePatchesFromHydra(label, e.getData(), out);
      } else if (n.endsWith('.patch')) {
        const mined = processPatch(label, e.entryName, new Uint8Array(e.getData()));
        if (mined) out.push(mined);
      }
    }
  }
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    console.warn(`  (skip: cannot read ${dir})`);
    return;
  }
  for (const name of entries) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else {
      const ext = extname(name).toLowerCase();
      if (ext === '.hydra' || ext === '.zip') out.push(p);
    }
  }
}

function main(): void {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    dirs.push(
      join(homedir(), 'Documents', 'ASM', 'Hydrasynth', 'Patch', 'Packs'),
      join(homedir(), 'Downloads', 'hydrasynth banks'),
    );
  }

  const files: string[] = [];
  for (const d of dirs) walk(d, files);
  // Multi-mode banks aren't single patches — skip by name.
  const singleFiles = files.filter((f) => !/multi/i.test(basename(f)));

  console.log(`Scanning ${dirs.length} dir(s); found ${singleFiles.length} bank file(s).`);

  const all: MinedPatch[] = [];
  for (const f of singleFiles) mineFile(f, all);

  // Dedup by bank+slot+name (the same bank appears in both dirs after the copy).
  const seen = new Set<string>();
  const corpus: MinedPatch[] = [];
  for (const p of all) {
    const key = `${p.bank}|${p.slot}|${p.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    corpus.push(p);
  }

  // Category histogram.
  const byCat = new Map<string, MinedPatch[]>();
  for (const p of corpus) {
    if (!byCat.has(p.category)) byCat.set(p.category, []);
    byCat.get(p.category)!.push(p);
  }

  const outDir = 'samples/hydrasynth';
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'bank-corpus.json');
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_from: dirs,
        decoded: corpus.length,
        skipped,
        categories: Object.fromEntries(
          [...byCat.entries()].map(([c, ps]) => [c, ps.length]),
        ),
        patches: corpus,
      },
      null,
      2,
    ),
  );

  console.log(`\nDecoded ${corpus.length} patches (skipped ${skipped.wrongSize} wrong-size [1762 dense], ${skipped.badMagic} bad-magic).`);
  console.log('\nCategory histogram:');
  for (const [c, ps] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const samples = ps.slice(0, 4).map((p) => p.name).join(', ');
    console.log(`  ${c.padEnd(10)} ${String(ps.length).padStart(3)}  e.g. ${samples}`);
  }
  console.log(`\nWrote ${outPath}`);
}

main();
