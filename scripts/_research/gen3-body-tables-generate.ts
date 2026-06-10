/**
 * Generator: gen-3 decompressed-body data tables.
 *
 * Reads the BoodieTraps Apache-2.0 `fractal-syx-codec` data JSONs (the
 * block type rosters + the param-name -> body-word-index map) and emits the
 * committed data module `packages/fractal-modern/src/gen3BodyTables.ts`.
 *
 * SOURCE: fractal-syx-codec by Andrew Mercurio ("BoodieTraps"), Apache-2.0,
 * derived by correlating decoded Fractal factory presets (see repo NOTICE +
 * our README Credits). TYPE_BINARY_IDS ordinals are file-stored indices that
 * ALSO equal the live-wire discrete-SET value (a type/model select sends
 * float32(this ordinal) @ pos 12, sub 09 00; verified 2026-06-08 FM3 amp 31 =
 * "Shiver Clean", reverb 38; FM9 amp 179/264). No separate write-id space.
 * PARAM_MAPPINGS are body-word OFFSETS (not ordinals).
 *
 * The structural constants (DEVICE_PROFILES grid/block-cols/type-locations,
 * EFFECT_BASES, modifier/cab name tables) are NOT generated here — they are
 * small, hand-ported into presetBody.ts with offset citations, so the
 * generated module is pure data tables (exempt from the file-split rule).
 *
 * Run: npx tsx scripts/_research/gen3-body-tables-generate.ts
 * The source JSONs live in the gitignored private tree; the EMITTED .ts is
 * committed, so end users / CI never need the private source.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SRC_DIR = join(
  'docs',
  '_private',
  'fractal-syx-codec-main',
  'fractal-syx-codec-main',
  'data',
);
const OUT = join('packages', 'fractal-modern', 'src', 'gen3BodyTables.ts');

// Block name -> its <block>_type_binary_ids.json basename. Cab's type roster
// is the DynaCab list (the Cab block stores a DynaCab id, not a "Cab type").
const TYPE_ROSTER_FILES: Record<string, string> = {
  Amp: 'amp_type_binary_ids.json',
  Chorus: 'chorus_type_binary_ids.json',
  Comp: 'comp_type_binary_ids.json',
  Delay: 'delay_type_binary_ids.json',
  Drive: 'drive_type_binary_ids.json',
  Filter: 'filter_type_binary_ids.json',
  Flanger: 'flanger_type_binary_ids.json',
  Phaser: 'phaser_type_binary_ids.json',
  Reverb: 'reverb_type_binary_ids.json',
  Tremolo: 'tremolo_type_binary_ids.json',
  Wah: 'wah_type_binary_ids.json',
  DynaCab: 'dynacab_type_binary_ids.json',
};

function loadJson(name: string): Record<string, unknown> {
  const p = join(SRC_DIR, name);
  if (!existsSync(p)) {
    throw new Error(
      `source not found: ${p}\n` +
        `This generator needs the private BoodieTraps fractal-syx-codec checkout. ` +
        `The emitted gen3BodyTables.ts is committed; you only need this generator to refresh it.`,
    );
  }
  return JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
}

// ── TYPE_BINARY_IDS: block -> { ordinal(number): name } ───────────────
const typeRosters: Record<string, Record<number, string>> = {};
for (const [block, file] of Object.entries(TYPE_ROSTER_FILES)) {
  const raw = loadJson(file);
  const table: Record<number, string> = {};
  for (const [k, v] of Object.entries(raw)) table[Number(k)] = String(v);
  typeRosters[block] = table;
}

// ── PARAM_MAPPINGS: block -> { paramName: bodyWordIndex } ──────────────
// param_index is the 0-based word index into a block's per-channel param
// array (word 0 = the param-located type id, where applicable). Entries the
// source flagged `weak` (low correlation vs its CSV ground truth) are kept
// but recorded in a sidecar set so consumers can choose to ignore them.
const paramMapRaw = loadJson('param_mappings.json') as Record<
  string,
  Record<string, { param_index: number; correlation: number; weak?: boolean }>
>;
const paramMappings: Record<string, Record<string, number>> = {};
const weakParams: Record<string, string[]> = {};
for (const [block, params] of Object.entries(paramMapRaw)) {
  const table: Record<string, number> = {};
  const weak: string[] = [];
  for (const [name, info] of Object.entries(params)) {
    table[name] = info.param_index;
    if (info.weak || Math.abs(info.correlation) < 0.95) weak.push(name);
  }
  paramMappings[block] = table;
  if (weak.length) weakParams[block] = weak.sort();
}

// ── Emit ──────────────────────────────────────────────────────────────
function obj(o: Record<string, unknown>, indent: string): string {
  const keys = Object.keys(o);
  if (keys.length === 0) return '{}';
  const lines = keys.map((k) => {
    const v = o[k];
    const key = /^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k);
    return `${indent}  ${key}: ${JSON.stringify(v)},`;
  });
  return `{\n${lines.join('\n')}\n${indent}}`;
}

function nestedNumberNamed(o: Record<string, Record<number, string>>): string {
  const lines = Object.keys(o).map((block) => {
    const inner = o[block];
    const entries = Object.keys(inner)
      .map(Number)
      .sort((a, b) => a - b)
      .map((n) => `    ${n}: ${JSON.stringify(inner[n])},`)
      .join('\n');
    return `  ${block}: {\n${entries}\n  },`;
  });
  return `{\n${lines.join('\n')}\n}`;
}

function nestedNameNumber(o: Record<string, Record<string, number>>): string {
  const lines = Object.keys(o).map((block) => {
    const inner = o[block];
    const entries = Object.keys(inner)
      .sort()
      .map((name) => `    ${JSON.stringify(name)}: ${inner[name]},`)
      .join('\n');
    return `  ${JSON.stringify(block)}: {\n${entries}\n  },`;
  });
  return `{\n${lines.join('\n')}\n}`;
}

const totalTypes = Object.values(typeRosters).reduce(
  (n, t) => n + Object.keys(t).length,
  0,
);
const totalParams = Object.values(paramMappings).reduce(
  (n, t) => n + Object.keys(t).length,
  0,
);

const header = `/**
 * Gen-3 decompressed-body data tables (GENERATED — do not hand-edit).
 *
 * Re-run: npx tsx scripts/_research/gen3-body-tables-generate.ts
 *
 * SOURCE: fractal-syx-codec by Andrew Mercurio ("BoodieTraps"), Apache-2.0,
 * derived by correlating decoded Fractal factory presets. See the repo NOTICE
 * and the README Credits. TYPE_BINARY_IDS ordinals are file-stored indices that
 * ALSO equal the live-wire discrete-SET value: a gen-3 type/model select sends
 * float32(this ordinal) at payload pos 12 (verified 2026-06-08 — FM3 amp 31 =
 * "Shiver Clean", reverb 38; FM9 amp 179/264). There is no separate permuted
 * write-id space. PARAM_MAPPINGS are body-word OFFSETS (not ordinals).
 *
 * - TYPE_BINARY_IDS: per-block effect-Type roster, { ordinal -> display name }.
 *   Cab's roster is the DynaCab id list (the Cab block stores a DynaCab id).
 *   ${totalTypes} names across ${Object.keys(typeRosters).length} rosters.
 * - PARAM_MAPPINGS: per-block { paramName -> body-word index } into the
 *   per-channel param array. ${totalParams} maps across ${Object.keys(paramMappings).length} blocks.
 *   PARAM_MAPPINGS_WEAK lists the names the source flagged low-correlation.
 *
 * NOTE: the body decoder (presetBody.ts) currently uses TYPE_BINARY_IDS for
 * block/amp/cab type names and the amp-knob subset of PARAM_MAPPINGS that is
 * cross-validated against the reference decoder. Generic per-block named-knob
 * VALUE extraction over the full PARAM_MAPPINGS stays gated on the per-param
 * display SCALE, not on the offsets: the body-word OFFSETS are correlation-
 * derived (most at 1.0; the sub-0.95 names are in PARAM_MAPPINGS_WEAK), but no
 * per-param lo/hi/unit exists in the data we hold (the FracTool CSV that
 * produced the offsets is not redistributed, and the reference decoder assumes
 * a blanket 0..10 — correct only for amp knobs). Shipping values without the
 * scale would yield plausible-but-wrong readings, so it awaits a value-scale
 * oracle (FracTool CSV or a hardware capture).
 */
`;

const body = `
export const TYPE_BINARY_IDS: Readonly<Record<string, Readonly<Record<number, string>>>> = ${nestedNumberNamed(
  typeRosters,
)};

export const PARAM_MAPPINGS: Readonly<Record<string, Readonly<Record<string, number>>>> = ${nestedNameNumber(
  paramMappings,
)};

export const PARAM_MAPPINGS_WEAK: Readonly<Record<string, readonly string[]>> = ${obj(
  Object.fromEntries(
    Object.entries(weakParams).map(([k, v]) => [k, v]),
  ),
  '',
)};
`;

writeFileSync(OUT, header + body, 'utf8');
console.log(
  `wrote ${OUT}\n  ${totalTypes} type names / ${Object.keys(typeRosters).length} rosters\n  ${totalParams} param maps / ${Object.keys(paramMappings).length} blocks` +
    `\n  weak params: ${Object.values(weakParams).reduce((n, v) => n + v.length, 0)}`,
);
