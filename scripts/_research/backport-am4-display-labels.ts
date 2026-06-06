/**
 * Backport AM4 display labels onto the Axe-Fx III catalog.
 *
 * The III catalog (`packages/fractal-midi/src/axe-fx-iii/params.ts`)
 * already carries a `displayLabel` for ~90% of its entries (mined from
 * AxeEdit III's layout XML). The long tail that the XML mining missed
 * still has a friendly name on the AM4, whose blocks share the III's
 * naming convention. This script fills ONLY those gaps: for each III
 * entry that has no `displayLabel`, it joins to AM4 by SHARED BLOCK +
 * PARAM NAME (never by paramId) and copies AM4's label.
 *
 * Guardrail (the reason this is name-joined, not id-joined): gen-3
 * paramIds do NOT cross model bytes. Joining AM4 -> III by numeric
 * paramId would silently address the wrong param. We join only through
 * `FAMILY_TO_AM4_BLOCKS` (III family -> AM4 block) + the symbol-name
 * alias table, which is the same hardware-verified join the catalog
 * generator uses for display calibration.
 *
 * Scope: III only. FM3 / FM9 / VP4 inherit AM4 labels through their own
 * catalog generators (`generate-modern-fractal-catalog.ts`), so they are
 * left to that path. The III catalog is hand-curated after generation
 * (post-generation overlay + internal-id stripping), so it cannot be
 * cleanly regenerated; this splice edits the committed file in place and
 * touches ONLY the `displayLabel` field, leaving units / ranges / the
 * curated header untouched.
 *
 * Idempotent: re-running adds nothing once every joinable gap is filled.
 *
 * Usage:
 *   npx tsx scripts/_research/backport-am4-display-labels.ts [--dry-run]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FAMILY_TO_AM4_BLOCKS,
  EXPLICIT_III_TO_AM4,
  iiiSymbolToAm4Name,
} from './axefx3-am4-overrides.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');

const AM4_PARAMS_PATH = join(
  REPO_ROOT,
  'packages',
  'fractal-midi',
  'src',
  'am4',
  'params.ts',
);
const III_PARAMS_PATH = join(
  REPO_ROOT,
  'packages',
  'fractal-midi',
  'src',
  'axe-fx-iii',
  'params.ts',
);

const dryRun = process.argv.includes('--dry-run');

// ── Parse AM4 `{block.name -> displayLabel}` ───────────────────────
//
// AM4 entries are keyed by `'block.name'` and carry the displayLabel on
// its own line (only `params.ts` has labels; `cacheParams.ts` has none).
// We slice the file by entry-header positions so a label is attributed
// to the entry it belongs to, then take the first `displayLabel:` in
// each slice (it precedes any nested `enumValues` block).
function loadAm4Labels(): Map<string, string> {
  const src = readFileSync(AM4_PARAMS_PATH, 'utf8');
  const headerRe = /'([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*)':\s*\{/g;
  const heads: { key: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headerRe.exec(src)) !== null) {
    heads.push({ key: m[1], at: m.index });
  }
  const labels = new Map<string, string>();
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].at;
    const end = i + 1 < heads.length ? heads[i + 1].at : src.length;
    const slice = src.slice(start, end);
    const lm = slice.match(/displayLabel:\s*'((?:[^'\\]|\\.)*)'/);
    if (lm) labels.set(heads[i].key, lm[1]);
  }
  return labels;
}

/**
 * Resolve the AM4 `block.name` key for a III (family, symbol) via the
 * shared-block join. Returns undefined when no AM4 block hosts the
 * symbol. Those III entries keep no label.
 */
function am4KeyFor(
  family: string,
  symbol: string,
  am4Labels: Map<string, string>,
): string | undefined {
  const explicit = EXPLICIT_III_TO_AM4[symbol];
  if (explicit && am4Labels.has(explicit)) return explicit;
  const blocks = FAMILY_TO_AM4_BLOCKS[family];
  if (!blocks) return undefined;
  const name = iiiSymbolToAm4Name(symbol);
  for (const block of blocks) {
    const key = `${block}.${name}`;
    if (am4Labels.has(key)) return key;
  }
  return undefined;
}

/**
 * III symbols whose AM4 source label is known-wrong and must NOT be
 * backported. The join is correct (shared block + name), but the AM4
 * catalog itself carries a mislabel, so copying it would degrade the
 * III catalog rather than improve it. Each entry names the bad source.
 *
 * Currently empty: the one historical case (drive.clip_type, formerly
 * captioned 'Frequency') was corrected in the AM4 catalog to 'Type'.
 */
const SUSPECT_AM4_LABELS: Readonly<Record<string, string>> = {};

/** Escape a string for emission as a single-quoted TS literal. */
function escLabel(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function main(): void {
  const am4Labels = loadAm4Labels();
  let iiiSrc = readFileSync(III_PARAMS_PATH, 'utf8');

  // Discover every (family, symbol) entry and whether it lacks a label.
  // III entries are flat single-line literals (no nested braces), so a
  // simple per-entry regex over `{ family: ..., paramId: ..., name: ... }`
  // is exact. `PARAMS`, `PARAMS_BY_FAMILY`, and `PARAM_BY_KEY` all share
  // the identical object literal, so we dedupe on (family, symbol).
  const entryRe =
    /\{ family: '([A-Z0-9_]+)', paramId: \d+, name: '([A-Z0-9_]+)',([^}]*)\}/g;
  const needLabel = new Map<string, { family: string; symbol: string }>();
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(iiiSrc)) !== null) {
    const [, family, symbol, rest] = m;
    const dedupeKey = `${family}.${symbol}`;
    if (rest.includes('displayLabel:')) {
      // Already labelled somewhere; never overwrite an existing label.
      needLabel.delete(dedupeKey);
      continue;
    }
    if (!needLabel.has(dedupeKey)) needLabel.set(dedupeKey, { family, symbol });
  }

  // Resolve AM4 labels for the gaps and apply.
  const additions: { key: string; label: string }[] = [];
  const skipped: { key: string; label: string }[] = [];
  for (const [dedupeKey, { family, symbol }] of needLabel) {
    const am4Key = am4KeyFor(family, symbol, am4Labels);
    if (!am4Key) continue;
    const label = am4Labels.get(am4Key)!;
    if (SUSPECT_AM4_LABELS[symbol] === am4Key) {
      skipped.push({ key: dedupeKey, label });
      continue;
    }
    additions.push({ key: dedupeKey, label });

    // Insert ` displayLabel: '<label>',` right after the name field, for
    // every occurrence (all three structures), only where absent.
    const insertRe = new RegExp(
      `(\\{ family: '${family}', paramId: \\d+, name: '${symbol}',)(?! displayLabel:)`,
      'g',
    );
    iiiSrc = iiiSrc.replace(insertRe, `$1 displayLabel: '${escLabel(label)}',`);
  }

  additions.sort((a, b) => a.key.localeCompare(b.key));
  console.log(
    `backport-am4-display-labels: ${additions.length} III entr${additions.length === 1 ? 'y' : 'ies'} ` +
      `gain an AM4 displayLabel (of ${needLabel.size} unlabelled, ${am4Labels.size} AM4 labels available).`,
  );
  for (const a of additions) console.log(`  + ${a.key} -> '${a.label}'`);
  if (skipped.length > 0) {
    console.log(`skipped ${skipped.length} join(s) with a known-bad AM4 source label:`);
    for (const s of skipped) console.log(`  ~ ${s.key} -> '${s.label}' (excluded)`);
  }

  if (dryRun) {
    console.log('(dry run, no file written)');
    return;
  }
  if (additions.length > 0) {
    writeFileSync(III_PARAMS_PATH, iiiSrc, 'utf8');
    console.log(`wrote ${III_PARAMS_PATH}`);
  } else {
    console.log('nothing to backport (already complete).');
  }
}

main();
