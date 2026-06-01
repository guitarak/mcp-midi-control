/**
 * Recipe → PresetSpec materializer.
 *
 * Wires `apply_preset({recipe_id, overrides})` into the existing
 * preflight / writer pipeline. Two responsibilities:
 *
 *   1. Look up the recipe by id (today: block_stack family only;
 *      single-block families remain inline via their own tools).
 *   2. Deep-merge caller-supplied `overrides` onto the recipe slots,
 *      keyed by slot identifier. Recipe slots survive on unspecified
 *      keys; overrides win on conflict.
 *
 * Merge semantics (locked by independent review 2026-05-22):
 *   - Match overrides slot to a recipe slot by `slot` ref equality
 *     (linear int OR {row,col} object).
 *   - Matching slot: deep merge params (overrides win per-key);
 *     non-params fields (block_type, id, bypassed, instance) take the
 *     override value when present, else recipe value.
 *   - Non-matching overrides slot: appended to the end (e.g. agent
 *     adds a 4th slot to a 3-slot recipe).
 *   - scenes / name / landingScene / routing in overrides REPLACE the
 *     recipe's value (recipes today don't author scenes; this leaves
 *     room for the agent to author scenes on top of the recipe's
 *     block stack without per-scene merge ambiguity).
 *
 * Why this lives in `recipes/` and not `dispatcher/`:
 *   - Pure-data transform of recipe + overrides → PresetSpec. No
 *     wire access, no descriptor lookup, no preflight.
 *   - The dispatcher calls into this AFTER `requireDevice` and BEFORE
 *     `collectApplyPresetPreflight`, so the existing validation,
 *     alias resolution, and type-knob stripping all run on the
 *     materialized spec exactly like they would on a manually
 *     authored spec.
 */

import type { PresetSpec, PresetSlotSpec, SceneSpec } from '../types.js';
import { BLOCK_STACK_RECIPES, type BlockStackSlotSpec } from './blockStack.js';
import type { RecipePort } from './pitch.js';

/**
 * Recipe-not-found / recipe-not-applicable / recipe-id-and-slots-set
 * failure surface. The dispatcher converts these into the matching
 * DispatchError code so the response carries `isError: true` per
 * SEP-1303 (the agent can self-correct on its next turn).
 */
export class RecipeMaterializeError extends Error {
  readonly code:
    | 'unknown_recipe'
    | 'recipe_not_applicable'
    | 'recipe_and_slots_conflict';
  readonly recipe_id?: string;
  readonly known_recipes?: readonly string[];
  readonly applicable_devices?: readonly string[];
  constructor(
    code:
      | 'unknown_recipe'
      | 'recipe_not_applicable'
      | 'recipe_and_slots_conflict',
    message: string,
    extra?: {
      recipe_id?: string;
      known_recipes?: readonly string[];
      applicable_devices?: readonly string[];
    },
  ) {
    super(message);
    this.code = code;
    this.recipe_id = extra?.recipe_id;
    this.known_recipes = extra?.known_recipes;
    this.applicable_devices = extra?.applicable_devices;
  }
}

/**
 * Compare two slot references for equality. Slots are either bare
 * integers (linear AM4) or `{row,col}` objects (grid II/III). A bare
 * int N on a grid device is conventionally row 2 col N (the audio-chain
 * row) but the merge layer treats it as opaque: N matches N, {r,c}
 * matches {r,c}, mixed shapes don't match.
 */
function slotRefsEqual(
  a: number | { readonly row: number; readonly col: number },
  b: number | { readonly row: number; readonly col: number },
): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'object' && typeof b === 'object') {
    return a.row === b.row && a.col === b.col;
  }
  return false;
}

/**
 * Deep-merge two params records. Both inputs are `Record<string, number
 * | string>` per the recipe + slot schema (no nested channels at this
 * layer — channel-nested params live under `params_by_channel`, which
 * is treated as a top-level field, not as nesting inside `params`).
 *
 * Override wins on every key it carries; recipe keys not in overrides
 * survive unchanged.
 */
function mergeFlatParams(
  recipeParams: Readonly<Record<string, number | string>> | undefined,
  overrideParams: Readonly<Record<string, number | string>> | undefined,
): Readonly<Record<string, number | string>> | undefined {
  if (recipeParams === undefined && overrideParams === undefined) return undefined;
  if (recipeParams === undefined) return overrideParams;
  if (overrideParams === undefined) return recipeParams;
  return { ...recipeParams, ...overrideParams };
}

/**
 * Merge a single override slot onto a matched recipe slot. Recipe slot
 * carries the base; override slot's fields win where set.
 */
function mergeSlot(
  recipeSlot: BlockStackSlotSpec,
  overrideSlot: PresetSlotSpec,
): PresetSlotSpec {
  const recipeParams = recipeSlot.params;
  const overrideParams = overrideSlot.params;
  // `params` on a PresetSlotSpec is either a flat record or a channel-
  // nested record. Recipes today author flat-only (see BlockStackSlotSpec
  // — `Record<string, number | string>`). If an override carries a
  // channel-nested params shape, the merge respects it: the override
  // replaces the flat recipe params with its nested form, no attempt
  // to merge "the X channel of the override against the flat recipe
  // values" (cross-shape merge is ambiguous and would surprise the
  // agent). Surface as override-wins.
  let mergedParams: PresetSlotSpec['params'];
  if (overrideParams !== undefined) {
    const overrideEntries = Object.entries(overrideParams as Record<string, unknown>);
    const looksNested = overrideEntries.some(
      ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v),
    );
    if (looksNested) {
      mergedParams = overrideParams;
    } else {
      mergedParams = mergeFlatParams(
        recipeParams,
        overrideParams as Readonly<Record<string, number | string>>,
      );
    }
  } else {
    mergedParams = recipeParams;
  }

  return {
    slot: recipeSlot.slot,
    block_type: overrideSlot.block_type ?? recipeSlot.block_type,
    params: mergedParams,
    ...(overrideSlot.params_by_channel !== undefined
      ? { params_by_channel: overrideSlot.params_by_channel }
      : {}),
    ...(overrideSlot.bypassed !== undefined ? { bypassed: overrideSlot.bypassed } : {}),
    ...(overrideSlot.id !== undefined ? { id: overrideSlot.id } : {}),
    ...(overrideSlot.instance !== undefined ? { instance: overrideSlot.instance } : {}),
  };
}

/**
 * Materialize `recipe_id` + `overrides` into a full PresetSpec, ready
 * for the existing preflight / writer pipeline.
 *
 * `overrides.slots[]` semantics (per-slot disposition):
 *   - Override slot whose `slot` ref matches a recipe slot → merge
 *     (per `mergeSlot`).
 *   - Override slot whose `slot` ref matches no recipe slot → append.
 *   - Recipe slot not referenced by any override → preserved as-is.
 *
 * `overrides.scenes` / `overrides.name` / `overrides.landingScene` /
 * `overrides.routing` REPLACE the recipe's values entirely (recipes
 * today don't author scenes/routing; this leaves the agent free to
 * compose scenes on top of the block stack without per-scene merge).
 */
export function materializeBlockStackRecipe(
  recipeId: string,
  port: RecipePort,
  overrides: Partial<PresetSpec> | undefined,
): PresetSpec {
  const recipe = BLOCK_STACK_RECIPES[recipeId];
  if (!recipe) {
    const known = Object.keys(BLOCK_STACK_RECIPES);
    throw new RecipeMaterializeError(
      'unknown_recipe',
      `Unknown block-stack recipe '${recipeId}'.`,
      { recipe_id: recipeId, known_recipes: known },
    );
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new RecipeMaterializeError(
      'recipe_not_applicable',
      `Recipe '${recipeId}' is not applicable to port '${port}'. Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
      { recipe_id: recipeId, applicable_devices: recipe.applicable_devices },
    );
  }
  const recipeSlots = recipe.slots_per_device[port];
  if (!recipeSlots || recipeSlots.length === 0) {
    throw new RecipeMaterializeError(
      'recipe_not_applicable',
      `Recipe '${recipeId}' lists '${port}' as applicable but has no slots_per_device entry. Recipe-table bug.`,
      { recipe_id: recipeId, applicable_devices: recipe.applicable_devices },
    );
  }

  const overrideSlots = (overrides?.slots ?? []) as readonly PresetSlotSpec[];
  const overrideSlotsByMatchIndex = new Map<number, PresetSlotSpec>();
  const overrideSlotsToAppend: PresetSlotSpec[] = [];

  // Bucket overrides into "matches recipe slot N" vs "extra slot to
  // append." First-match wins if two overrides reference the same slot
  // (caller error; we don't try to merge them, the second silently
  // joins the append list which surfaces as a duplicate-slot validation
  // error downstream).
  for (const ov of overrideSlots) {
    let matchedIndex = -1;
    for (let i = 0; i < recipeSlots.length; i++) {
      if (slotRefsEqual(ov.slot, recipeSlots[i].slot)) {
        matchedIndex = i;
        break;
      }
    }
    if (matchedIndex >= 0 && !overrideSlotsByMatchIndex.has(matchedIndex)) {
      overrideSlotsByMatchIndex.set(matchedIndex, ov);
    } else {
      overrideSlotsToAppend.push(ov);
    }
  }

  const mergedSlots: PresetSlotSpec[] = recipeSlots.map((recipeSlot, i) => {
    const ov = overrideSlotsByMatchIndex.get(i);
    if (ov === undefined) {
      // Recipe slot survives untouched. Convert to PresetSlotSpec shape
      // (identical at the type level; widening cast for clarity).
      return {
        slot: recipeSlot.slot,
        block_type: recipeSlot.block_type,
        ...(recipeSlot.params !== undefined ? { params: recipeSlot.params } : {}),
      };
    }
    return mergeSlot(recipeSlot, ov);
  });
  for (const extra of overrideSlotsToAppend) {
    mergedSlots.push(extra);
  }

  const scenes: readonly SceneSpec[] | undefined = overrides?.scenes;
  const name: string | undefined = overrides?.name;
  const landingScene: number | undefined = overrides?.landingScene;
  const routing = overrides?.routing;

  return {
    slots: mergedSlots,
    ...(scenes !== undefined ? { scenes } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(landingScene !== undefined ? { landingScene } : {}),
    ...(routing !== undefined ? { routing } : {}),
  } as PresetSpec;
}
