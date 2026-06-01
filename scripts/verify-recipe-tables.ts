/**
 * Golden: BK-061 + BK-062 recipe-table integrity check.
 *
 * For every recipe (pitch / wah / filter):
 *   1. `resolveXxxRecipe(name, port)` returns a non-empty params dict
 *      for each port listed in `applicable_devices`.
 *   2. `resolveXxxRecipe(name, port)` THROWS for every port NOT listed
 *      in `applicable_devices` (recipe is gated correctly).
 *   3. Every param name in every per-device params dict resolves to a
 *      real param in that device's catalog (fractal-midi's
 *      `KNOWN_PARAMS` for II, `CACHE_PARAMS` for AM4, `PARAM_BY_KEY`
 *      for III). Catches typos + drift between recipe authoring and
 *      the device's actual param dictionary.
 *
 * No hardware, no MIDI. Pure-data sanity check over the recipe library
 * + fractal-midi param catalogs.
 *
 * Run via:  npx tsx scripts/verify-recipe-tables.ts
 * Wired into npm test for regression coverage.
 */

import { KNOWN_PARAMS as AXE_FX_II_KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';
import { CACHE_PARAMS as AM4_CACHE_PARAMS } from 'fractal-midi/am4';
import { PARAM_BY_KEY as AXE_FX_III_PARAM_BY_KEY } from 'fractal-midi/axe-fx-iii';

import {
  PITCH_RECIPES,
  resolvePitchRecipe,
  WAH_RECIPES,
  resolveWahRecipe,
  FILTER_RECIPES,
  resolveFilterRecipe,
  BLOCK_STACK_RECIPES,
  materializeBlockStackRecipe,
  HYDRA_PATCH_RECIPES,
  materializeHydraPatchRecipe,
  RecipeMaterializeError,
  type HydraCategory,
  type RecipePort,
} from '../packages/core/src/protocol-generic/recipes/index.js';
import { findPatchOffset } from '@mcp-midi-control/hydrasynth/patchEncoder.js';
import { HYDRASYNTH_DESCRIPTOR } from '@mcp-midi-control/hydrasynth/descriptor.js';

const HYDRA_CATEGORIES: readonly HydraCategory[] = [
  'Ambient', 'Arp', 'Bass', 'BassLead', 'Brass', 'Chord', 'Drum', 'E-piano',
  'FX', 'FxMusic', 'Keys', 'Lead', 'Organ', 'Pad', 'Perc', 'Rhythmic',
  'Sequence', 'Strings', 'Vocal',
];

/** Does a mod source/target name resolve on the Hydra descriptor? */
function hydraModNameResolves(kind: 'source' | 'target', name: string): boolean {
  const schema = HYDRASYNTH_DESCRIPTOR.blocks['modmatrix']?.params[kind === 'source' ? '1modsource' : '1modtarget'];
  if (!schema) return false;
  try { schema.encode(name); return true; } catch { return false; }
}

/** Does a macro target name resolve on the Hydra descriptor? */
function hydraMacroTargetResolves(macro: number, name: string): boolean {
  const schema = HYDRASYNTH_DESCRIPTOR.blocks['macros']?.params[`macro${macro}target1`];
  if (!schema) return false;
  try { schema.encode(name); return true; } catch { return false; }
}

const ALL_PORTS: readonly RecipePort[] = ['am4', 'axe-fx-ii', 'axe-fx-iii'] as const;

// Per-device "param name in this block exists?" predicates. Each recipe
// stores params by the device's canonical lowercase param name (II,
// AM4) or symbolic name (III); the lookup keys are the catalog's own.

function hasIIParam(block: string, name: string): boolean {
  // KNOWN_PARAMS is keyed by "block.name" lowercase.
  const key = `${block}.${name}`;
  return Object.prototype.hasOwnProperty.call(AXE_FX_II_KNOWN_PARAMS, key);
}

function hasAM4Param(block: string, name: string): boolean {
  const key = `${block}.${name}`;
  return Object.prototype.hasOwnProperty.call(AM4_CACHE_PARAMS, key);
}

function hasIIIParam(family: string, name: string): boolean {
  // PARAM_BY_KEY is keyed by "FAMILY.NAME" uppercase.
  const key = `${family.toUpperCase()}.${name.toUpperCase()}`;
  return Object.prototype.hasOwnProperty.call(AXE_FX_III_PARAM_BY_KEY, key);
}

// Per-port "is this param name known on this block?" router.
function paramExists(port: RecipePort, block: string, name: string): boolean {
  if (port === 'axe-fx-ii') return hasIIParam(block, name);
  if (port === 'am4') return hasAM4Param(block, name);
  return hasIIIParam(block, name);
}

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`  OK    ${label}`);
  } else {
    failed++;
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Block name per recipe category, per port. AM4 + II share lowercase
// `pitch`/`wah`/`filter`; III uses uppercase family symbols PITCH/WAH/
// FILTER.
const BLOCK_NAME: Readonly<Record<string, Readonly<Record<RecipePort, string>>>> = {
  pitch:  { am4: 'pitch',  'axe-fx-ii': 'pitch',  'axe-fx-iii': 'PITCH'  },
  wah:    { am4: 'wah',    'axe-fx-ii': 'wah',    'axe-fx-iii': 'WAH'    },
  filter: { am4: 'filter', 'axe-fx-ii': 'filter', 'axe-fx-iii': 'FILTER' },
};

interface RecipeEntry {
  readonly category: 'pitch' | 'wah' | 'filter';
  readonly name: string;
  readonly applicable_devices: readonly RecipePort[];
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number | string>>>>>;
  readonly resolve: (recipeName: string, port: RecipePort) => {
    params: Readonly<Record<string, number | string>>;
    modifier_needed: boolean;
  };
}

function walkRecipes(): RecipeEntry[] {
  const entries: RecipeEntry[] = [];
  for (const [name, spec] of Object.entries(PITCH_RECIPES)) {
    entries.push({
      category: 'pitch',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolvePitchRecipe,
    });
  }
  for (const [name, spec] of Object.entries(WAH_RECIPES)) {
    entries.push({
      category: 'wah',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveWahRecipe,
    });
  }
  for (const [name, spec] of Object.entries(FILTER_RECIPES)) {
    entries.push({
      category: 'filter',
      name,
      applicable_devices: spec.applicable_devices,
      params_per_device: spec.params_per_device,
      resolve: resolveFilterRecipe,
    });
  }
  return entries;
}

const entries = walkRecipes();

console.log(`\nVerifying ${entries.length} recipe(s) across ${ALL_PORTS.length} ports.\n`);

const pitchCount = Object.keys(PITCH_RECIPES).length;
const wahCount = Object.keys(WAH_RECIPES).length;
const filterCount = Object.keys(FILTER_RECIPES).length;
console.log(`  pitch  : ${pitchCount} recipe(s)`);
console.log(`  wah    : ${wahCount} recipe(s)`);
console.log(`  filter : ${filterCount} recipe(s)\n`);

// Coverage assertions: the BK-061/BK-062 task statement lists 7 pitch
// + 6 wah/filter recipes. Catch silent regressions if a recipe is
// later removed without an explicit scope change.
check('pitch category ships >= 7 recipes', pitchCount >= 7, `got ${pitchCount}`);
check('wah category ships >= 3 recipes', wahCount >= 3, `got ${wahCount}`);
check('filter category ships >= 3 recipes', filterCount >= 3, `got ${filterCount}`);

for (const entry of entries) {
  console.log(`\n[${entry.category}] ${entry.name}`);

  // 1. applicable_devices is non-empty.
  check(
    `applicable_devices non-empty`,
    entry.applicable_devices.length > 0,
    `${entry.category}.${entry.name}`,
  );

  // 2. For each applicable port, resolve returns a non-empty params dict.
  for (const port of entry.applicable_devices) {
    let resolved: { params: Readonly<Record<string, number | string>>; modifier_needed: boolean } | null = null;
    try {
      resolved = entry.resolve(entry.name, port);
    } catch (err) {
      check(
        `resolve(${entry.name}, ${port}) does not throw`,
        false,
        (err as Error).message.slice(0, 80),
      );
      continue;
    }
    check(
      `resolve(${entry.name}, ${port}) returns non-empty params`,
      Object.keys(resolved.params).length > 0,
      `got ${Object.keys(resolved.params).length} params`,
    );

    // 3. Every param name in the dict maps to a real catalog entry.
    const block = BLOCK_NAME[entry.category][port];
    const missing: string[] = [];
    for (const paramName of Object.keys(resolved.params)) {
      if (!paramExists(port, block, paramName)) missing.push(paramName);
    }
    check(
      `every param in resolve(${entry.name}, ${port}) exists in catalog (block=${block})`,
      missing.length === 0,
      missing.length > 0 ? `missing: ${missing.join(', ')}` : undefined,
    );
  }

  // 4. For each NON-applicable port, resolve throws.
  for (const port of ALL_PORTS) {
    if (entry.applicable_devices.includes(port)) continue;
    let threw = false;
    let errMsg = '';
    try {
      entry.resolve(entry.name, port);
    } catch (err) {
      threw = true;
      errMsg = (err as Error).message;
    }
    check(
      `resolve(${entry.name}, ${port}) throws (port not applicable)`,
      threw && /not applicable/i.test(errMsg),
      threw ? errMsg.slice(0, 80) : 'no error thrown',
    );
  }
}

// 5. Unknown recipe names throw with a list of known recipes.
console.log('\n[unknown-recipe] negative cases');
for (const resolve of [resolvePitchRecipe, resolveWahRecipe, resolveFilterRecipe]) {
  let threw = false;
  let errMsg = '';
  try {
    resolve('this_recipe_does_not_exist', 'axe-fx-ii');
  } catch (err) {
    threw = true;
    errMsg = (err as Error).message;
  }
  check(
    `${resolve.name}('this_recipe_does_not_exist', 'axe-fx-ii') throws with 'unknown ... recipe'`,
    threw && /unknown .* recipe/i.test(errMsg),
    threw ? errMsg.slice(0, 80) : 'no error thrown',
  );
}

// ── Block-stack corpus integrity (2026-05-22 MCP migration) ─────────
//
// Per-recipe gates:
//   (a) applicable_devices is non-empty.
//   (b) For each applicable port: slots_per_device[port] is non-empty
//       AND signature_params_per_device[port] is present + non-empty.
//   (c) Every signature_params key (dot-path like `amp.type`) resolves
//       to a real slot+param in the materialized slots — guards against
//       slim-summary / full-slots drift.
//   (d) Every signature_params VALUE matches the slot's authored value
//       — slim shouldn't lie about what the recipe will write.
//   (e) Materializer round-trip: materializeBlockStackRecipe(name,
//       port, undefined) returns a PresetSpec whose slots length
//       matches slots_per_device[port] length.
//   (f) Overrides merge sanity: applying overrides to slot[0] knobs
//       produces a spec where the override knob took effect.
//   (g) Unknown recipe id => RecipeMaterializeError code:'unknown_recipe'.
//   (h) Non-applicable port => RecipeMaterializeError
//       code:'recipe_not_applicable'.

console.log('\n[block_stack] corpus integrity');
const blockStackCount = Object.keys(BLOCK_STACK_RECIPES).length;
console.log(`  block_stack : ${blockStackCount} recipe(s)`);

for (const [name, recipe] of Object.entries(BLOCK_STACK_RECIPES)) {
  console.log(`\n[block_stack] ${name}`);
  check(
    `applicable_devices non-empty`,
    recipe.applicable_devices.length > 0,
    `${name}`,
  );

  for (const port of recipe.applicable_devices) {
    const slots = recipe.slots_per_device[port];
    check(
      `slots_per_device[${port}] non-empty`,
      slots !== undefined && slots.length > 0,
      slots === undefined ? 'missing' : `length=${slots ? slots.length : 0}`,
    );
    if (!slots || slots.length === 0) continue;

    const sigParams = recipe.signature_params_per_device[port];
    check(
      `signature_params_per_device[${port}] present + non-empty`,
      sigParams !== undefined && Object.keys(sigParams).length > 0,
      sigParams === undefined ? 'missing (required for slim describe_device surface)' : 'empty (need at least one distinctive pick)',
    );
    if (!sigParams) continue;

    // Build a lookup from dot-path → authored value across the recipe's slots.
    const slotParamLookup = new Map<string, number | string>();
    for (const slot of slots) {
      if (!slot.params) continue;
      for (const [knob, value] of Object.entries(slot.params)) {
        slotParamLookup.set(`${slot.block_type}.${knob}`, value);
      }
    }

    const sigMissing: string[] = [];
    const sigDrift: { path: string; recipe: unknown; signature: unknown }[] = [];
    for (const [path, signatureValue] of Object.entries(sigParams)) {
      if (!slotParamLookup.has(path)) {
        sigMissing.push(path);
        continue;
      }
      const recipeValue = slotParamLookup.get(path);
      if (recipeValue !== signatureValue) {
        sigDrift.push({ path, recipe: recipeValue, signature: signatureValue });
      }
    }
    check(
      `signature_params[${port}] keys all resolve to authored slot params`,
      sigMissing.length === 0,
      sigMissing.length > 0 ? `missing in slots: ${sigMissing.join(', ')}` : undefined,
    );
    check(
      `signature_params[${port}] values match authored slot params`,
      sigDrift.length === 0,
      sigDrift.length > 0
        ? `drift: ${sigDrift.map((d) => `${d.path} recipe=${JSON.stringify(d.recipe)} signature=${JSON.stringify(d.signature)}`).join(' | ')}`
        : undefined,
    );

    // Tempo-first golden: the Edge dotted-8th recipe is tempo-synced by
    // construction. Its delay slot must bake `delay.tempo` and must NOT
    // ship an absolute `delay.time` (which the hardware would silently
    // ignore while tempo is synced — a dead param, see tempoLock.ts).
    if (name === 'edge_dotted_eighth_lead') {
      check(
        `${name}[${port}] delay slot bakes delay.tempo (tempo-synced by construction)`,
        slotParamLookup.has('delay.tempo'),
        `delay params: ${[...slotParamLookup.keys()].filter((k) => k.startsWith('delay.')).join(', ')}`,
      );
      check(
        `${name}[${port}] delay slot ships NO absolute delay.time (would be silently ignored)`,
        !slotParamLookup.has('delay.time'),
        `delay.time=${JSON.stringify(slotParamLookup.get('delay.time'))}`,
      );
    }

    // Materializer round-trip.
    try {
      const materialized = materializeBlockStackRecipe(name, port, undefined);
      check(
        `materialize(${name}, ${port}, undefined).slots.length === slots_per_device length`,
        materialized.slots.length === slots.length,
        `materialized=${materialized.slots.length} authored=${slots.length}`,
      );

      // Overrides merge sanity: take the first override-able knob and
      // confirm it took effect. Skip when slot[0] has no params or
      // params is channel-nested (unusual for recipes).
      const firstSlot = slots[0];
      const firstParams = firstSlot.params;
      if (firstParams && Object.keys(firstParams).length > 0) {
        const firstKnob = Object.keys(firstParams)[0];
        const recipeKnobValue = firstParams[firstKnob];
        const overrideValue = typeof recipeKnobValue === 'number' ? recipeKnobValue + 1 : recipeKnobValue;
        const overrides = {
          slots: [
            { slot: firstSlot.slot, block_type: firstSlot.block_type, params: { [firstKnob]: overrideValue } },
          ],
        };
        const overridden = materializeBlockStackRecipe(name, port, overrides);
        const overriddenSlot = overridden.slots[0];
        const overriddenParams = overriddenSlot.params as Record<string, number | string> | undefined;
        const observed = overriddenParams?.[firstKnob];
        check(
          `materialize(${name}, ${port}, overrides) applies override to slot[0].${firstKnob}`,
          observed === overrideValue,
          `expected ${JSON.stringify(overrideValue)}, got ${JSON.stringify(observed)}`,
        );
        check(
          `materialize(${name}, ${port}, overrides) preserves non-overridden slot[0] keys`,
          Object.keys(overriddenParams ?? {}).length >= Object.keys(firstParams).length,
          `overridden keys: ${Object.keys(overriddenParams ?? {}).length}, recipe keys: ${Object.keys(firstParams).length}`,
        );
      }
    } catch (err) {
      check(
        `materialize(${name}, ${port}, undefined) does not throw`,
        false,
        (err as Error).message.slice(0, 100),
      );
    }
  }

  // Non-applicable port rejection. Pick a port NOT in applicable_devices.
  for (const port of ALL_PORTS) {
    if (recipe.applicable_devices.includes(port)) continue;
    let threw = false;
    let code = '';
    try {
      materializeBlockStackRecipe(name, port, undefined);
    } catch (err) {
      threw = true;
      code = (err as { code?: string }).code ?? '';
    }
    check(
      `materialize(${name}, ${port}) throws recipe_not_applicable (port not in applicable_devices)`,
      threw && code === 'recipe_not_applicable',
      threw ? `code='${code}'` : 'no error thrown',
    );
  }
}

// ── Materializer edge cases ─────────────────────────────────────────
//
// (i)  Verbatim equivalence: materialize(recipe, port, undefined).slots
//      deep-equals slots_per_device[port]. The slim describe_device
//      surface promises the agent that `recipe_id` is byte-equivalent
//      to a hand-pasted slots[]; the materializer is where that promise
//      lives.
// (ii) Slot-drop protection: overrides targeting a single slot must not
//      drop the recipe's other slots. The senior reviewer flagged this
//      as the nastiest expected bug class for the migration.
// (iii)Append behavior: an override slot whose ref matches NO recipe
//      slot is appended at the end (e.g. agent adds a 4th slot to a
//      3-slot recipe).

console.log('\n[block_stack] materializer edge cases');

interface LooseSlot {
  readonly slot: number | { readonly row: number; readonly col: number };
  readonly block_type: string;
  readonly params?: unknown;
}

function deepEqualSlots(
  a: ReadonlyArray<LooseSlot>,
  b: ReadonlyArray<LooseSlot>,
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.block_type !== y.block_type) return false;
    if (typeof x.slot === 'number' && typeof y.slot === 'number') {
      if (x.slot !== y.slot) return false;
    } else if (typeof x.slot === 'object' && typeof y.slot === 'object') {
      if (x.slot.row !== y.slot.row || x.slot.col !== y.slot.col) return false;
    } else {
      return false;
    }
    const xParams = (x.params ?? {}) as Record<string, unknown>;
    const yParams = (y.params ?? {}) as Record<string, unknown>;
    const xKeys = Object.keys(xParams);
    const yKeys = Object.keys(yParams);
    if (xKeys.length !== yKeys.length) return false;
    for (const k of xKeys) {
      if (xParams[k] !== yParams[k]) return false;
    }
  }
  return true;
}

// (i) Verbatim equivalence for every (recipe, applicable port) pair.
let verbatimChecked = 0;
for (const [name, recipe] of Object.entries(BLOCK_STACK_RECIPES)) {
  for (const port of recipe.applicable_devices) {
    const authored = recipe.slots_per_device[port];
    if (!authored) continue;
    const materialized = materializeBlockStackRecipe(name, port, undefined);
    check(
      `verbatim equivalence: materialize(${name}, ${port}, undefined).slots deep-equals slots_per_device[${port}]`,
      deepEqualSlots(materialized.slots, authored),
    );
    verbatimChecked++;
  }
}
console.log(`  (verbatim-equivalence pairs checked: ${verbatimChecked})`);

// (ii) Slot-drop protection. Pick a multi-slot recipe and apply an
// override targeting only its first slot; assert all other recipe slots
// survive.
const multiSlotRecipe = Object.values(BLOCK_STACK_RECIPES).find((r) => {
  const port = r.applicable_devices[0];
  return port !== undefined && (r.slots_per_device[port]?.length ?? 0) >= 2;
});
if (multiSlotRecipe) {
  const port = multiSlotRecipe.applicable_devices[0];
  const authored = multiSlotRecipe.slots_per_device[port]!;
  const firstSlot = authored[0];
  const firstKnob = firstSlot.params ? Object.keys(firstSlot.params)[0] : undefined;
  if (firstKnob !== undefined) {
    const overrides = {
      slots: [{ slot: firstSlot.slot, block_type: firstSlot.block_type, params: { [firstKnob]: 'overridden' } }],
    };
    const merged = materializeBlockStackRecipe(multiSlotRecipe.name, port, overrides);
    check(
      `slot-drop protection: targeting slot[0] with overrides preserves ${authored.length - 1} other recipe slot(s)`,
      merged.slots.length === authored.length,
      `expected ${authored.length} slots, got ${merged.slots.length}`,
    );
    for (let i = 1; i < authored.length; i++) {
      const recipeSlot = authored[i];
      const mergedSlot = merged.slots[i];
      check(
        `slot-drop: slot[${i}] block_type preserved (${recipeSlot.block_type})`,
        mergedSlot.block_type === recipeSlot.block_type,
      );
      const recipeParams = recipeSlot.params ?? {};
      const mergedParams = (mergedSlot.params ?? {}) as Record<string, number | string>;
      check(
        `slot-drop: slot[${i}] params count preserved (${Object.keys(recipeParams).length})`,
        Object.keys(mergedParams).length === Object.keys(recipeParams).length,
      );
    }
  }
}

// (iii) Append behavior. Override a slot ref that doesn't exist in
// the recipe; assert it lands at the end.
{
  const recipe = BLOCK_STACK_RECIPES['texas_blues_crunch'];
  const port: RecipePort = 'am4';
  const baseLen = recipe.slots_per_device[port]!.length;
  // texas_blues_crunch on AM4 has 3 slots (1, 2, 3). Append slot 4.
  const overrides = {
    slots: [{ slot: 4, block_type: 'reverb', params: { type: 'Plate, Medium', mix: 5 } }],
  };
  const merged = materializeBlockStackRecipe('texas_blues_crunch', port, overrides);
  check(
    `append: override slot=4 appended past recipe's ${baseLen} slots`,
    merged.slots.length === baseLen + 1,
    `expected ${baseLen + 1} slots, got ${merged.slots.length}`,
  );
  check(
    `append: appended slot lands at index ${baseLen} with the override's block_type`,
    merged.slots[baseLen]?.block_type === 'reverb',
    `appended block_type: ${merged.slots[baseLen]?.block_type}`,
  );
}

// Unknown recipe id surfaces the structured error.
console.log('\n[block_stack] unknown-recipe negative case');
{
  let threw = false;
  let code = '';
  let knownReturned: readonly string[] | undefined;
  try {
    materializeBlockStackRecipe('this_recipe_does_not_exist', 'axe-fx-ii', undefined);
  } catch (err) {
    threw = true;
    code = (err as { code?: string }).code ?? '';
    knownReturned = (err as { known_recipes?: readonly string[] }).known_recipes;
  }
  check(
    `materialize('this_recipe_does_not_exist', ...) throws unknown_recipe with known_recipes[]`,
    threw && code === 'unknown_recipe' && Array.isArray(knownReturned) && knownReturned.length > 0,
    threw ? `code='${code}', known_recipes=${knownReturned?.length ?? 0}` : 'no error thrown',
  );
}

// ---------------------------------------------------------------------------
// Hydrasynth patch-archetype family (BK-074).
// ---------------------------------------------------------------------------
console.log('\n[patch_archetype] Hydrasynth recipes');
let hydraCount = 0;
for (const [id, recipe] of Object.entries(HYDRA_PATCH_RECIPES)) {
  hydraCount++;
  check(`${id}: name matches key`, recipe.name === id, `name='${recipe.name}'`);
  check(`${id}: category in 19-enum`, HYDRA_CATEGORIES.includes(recipe.category), `category='${recipe.category}'`);
  check(`${id}: has non-empty params`, Object.keys(recipe.params).length > 0);

  // Every params key must be buildable via PATCH_OFFSETS.
  for (const key of Object.keys(recipe.params)) {
    check(`${id}: params['${key}'] in PATCH_OFFSETS`, findPatchOffset(key) !== undefined,
      'not buildable atomically — fall back to set_param or extend PATCH_OFFSETS');
  }

  // signature_params ⊆ params, with equal values (slim summary can't lie).
  for (const [k, v] of Object.entries(recipe.signature_params)) {
    const inParams = Object.prototype.hasOwnProperty.call(recipe.params, k);
    check(`${id}: signature_params['${k}'] is a param`, inParams);
    if (inParams) {
      check(`${id}: signature_params['${k}'] value matches params`, recipe.params[k] === v,
        `signature=${JSON.stringify(v)} params=${JSON.stringify(recipe.params[k])}`);
    }
  }

  // requires_nrpn must reflect presence of routes.
  const hasRoutes = (recipe.mod_routes?.length ?? 0) > 0 || (recipe.macro_routes?.length ?? 0) > 0;
  const matRequires = materializeHydraPatchRecipe(id).requires_nrpn;
  check(`${id}: requires_nrpn reflects routes`, matRequires === (hasRoutes || recipe.requires_nrpn === true),
    `materialized=${matRequires} hasRoutes=${hasRoutes}`);

  // Route names resolve on the descriptor (catch typos at CI).
  for (const r of recipe.mod_routes ?? []) {
    check(`${id}: mod source "${r.source}" resolves`, hydraModNameResolves('source', r.source));
    check(`${id}: mod target "${r.target}" resolves`, hydraModNameResolves('target', r.target));
    check(`${id}: mod depth in -127..127`, Number.isInteger(r.depth) && r.depth >= -127 && r.depth <= 127, `depth=${r.depth}`);
  }
  for (const r of recipe.macro_routes ?? []) {
    check(`${id}: macro ${r.macro} in 1..8`, Number.isInteger(r.macro) && r.macro >= 1 && r.macro <= 8, `macro=${r.macro}`);
    check(`${id}: macro target "${r.target}" resolves`, hydraMacroTargetResolves(r.macro, r.target));
    check(`${id}: macro depth in -127..127`, Number.isInteger(r.depth) && r.depth >= -127 && r.depth <= 127, `depth=${r.depth}`);
  }

  // Materializer round-trip: param count = merged key count.
  const mat = materializeHydraPatchRecipe(id);
  check(`${id}: materialize param count = params key count`, mat.params.length === Object.keys(recipe.params).length,
    `materialized=${mat.params.length} keys=${Object.keys(recipe.params).length}`);
}

// Override merge + unknown-id negative case.
console.log('\n[patch_archetype] override + unknown-id');
{
  const firstId = Object.keys(HYDRA_PATCH_RECIPES)[0];
  const firstKey = Object.keys(HYDRA_PATCH_RECIPES[firstId].params)[0];
  const merged = materializeHydraPatchRecipe(firstId, { [firstKey]: 999 });
  const overridden = merged.params.find((p) => p.name === firstKey);
  check(`override '${firstKey}' takes effect`, overridden?.value === 999, `got ${JSON.stringify(overridden?.value)}`);

  let threw = false;
  let code = '';
  let known: readonly string[] | undefined;
  try {
    materializeHydraPatchRecipe('this_hydra_recipe_does_not_exist');
  } catch (err) {
    threw = true;
    code = err instanceof RecipeMaterializeError ? err.code : '';
    known = err instanceof RecipeMaterializeError ? err.known_recipes : undefined;
  }
  check('unknown hydra recipe id throws unknown_recipe with known_recipes[]',
    threw && code === 'unknown_recipe' && Array.isArray(known) && known.length > 0,
    threw ? `code='${code}', known=${known?.length ?? 0}` : 'no error');
}

console.log('');
if (failed > 0) {
  console.error(`x ${failed} check(s) FAILED.`);
  process.exit(1);
}
console.log(`OK verify-recipe-tables: ${entries.length} single-block + ${blockStackCount} block_stack + ${hydraCount} patch_archetype recipe(s) verified.`);
