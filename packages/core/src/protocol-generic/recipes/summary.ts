/**
 * Recipe-discovery summary for `describe_device`.
 *
 * Background (senior MCP review 2026-05-20): per-block recipes
 * (auto_wah_funk, octave_up, wah_cocked_mid, filter_telephone,
 * arrangement_balanced_metal, etc.) ship as pure-data tables in
 * `recipes/*.ts` but are unreachable from the MCP tool surface. The
 * Session 105 sweep failure `am4-recipe-auto-wah` documents an agent
 * that knew the tone vocabulary ("envelope-follower behavior,
 * sweeping with my pick attack") but had no signal that FILTER block
 * is the answer on AM4, and bailed after five reads.
 *
 * Two-tier shape (2026-05-22 MCP migration):
 *
 *   - Single-block families (auto_wah, pitch, wah, filter,
 *     scene_leveling) ship INLINE: `params` is the full knob dict
 *     ready to paste into `apply_preset.spec.slots[].params` or
 *     `set_block`. Cheap and direct.
 *   - Block-stack recipes ship SLIM: `slot_count` + `target_blocks` +
 *     `signature_params` only. The full slots[] payload (10-30 KB per
 *     recipe across both devices) is no longer inline. The agent
 *     applies via `apply_preset({recipe_id})` — server-side resolution
 *     materializes the slots without a second discovery round-trip.
 *     The apply_preset response carries `applied_spec` echoing what
 *     the writer consumed (recipe + overrides merge resolved).
 *
 * `params` (single-block) and `signature_params` (block_stack) are
 * pre-filtered to the requested port. `applicable_devices` is
 * collapsed (a recipe absent on this port is not listed at all), so
 * the agent sees exactly what's safe to apply.
 */

import { AUTO_WAH_RECIPES } from './autoWah.js';
import { BLOCK_STACK_RECIPES } from './blockStack.js';
import { FILTER_RECIPES } from './filter.js';
import { HYDRA_PATCH_RECIPES } from './patchArchetype.js';
import { PITCH_RECIPES, type RecipePort } from './pitch.js';
import { SCENE_LEVELING_RECIPES } from './sceneLeveling.js';
import { WAH_RECIPES } from './wah.js';

export interface RecipeSummaryEntry {
  /** Stable id (snake_case). Same string the recipe is keyed by. */
  readonly id: string;
  /**
   * Recipe family. Useful when the agent wants to filter recipes by
   * vocabulary domain (e.g. all `pitch` recipes when the user asks
   * for "harmony" or "octave").
   */
  readonly family: 'auto_wah' | 'pitch' | 'wah' | 'filter' | 'scene_leveling' | 'block_stack' | 'patch_archetype';
  /** One-line description for the agent to surface. */
  readonly description: string;
  /**
   * The block this recipe targets on this device. `auto_wah` is the
   * cross-family case: target is `filter` on AM4 but `wah` on II/III.
   * `scene_leveling` is device-agnostic (target is the device's main
   * level surface: AM4 `volpan.volume`, II/III `output.level`); we
   * leave it `undefined` and let the agent decide. `block_stack`
   * recipes target MULTIPLE blocks (see `slots` field) and leave this
   * undefined.
   */
  readonly target_block?: string;
  /**
   * Per-device params dict pre-filtered to the requested port. Display-
   * value shape (numbers in display units, strings for enum values),
   * ready to paste into `apply_preset({ port, spec: { slots: [...] } })`.
   *
   * For `scene_leveling` recipes the params are role-keyed dB offsets,
   * not slot params; the agent uses them when authoring per-scene
   * `output.level` writes. Documented in the recipe family's source
   * (`recipes/sceneLeveling.ts`).
   *
   * For `block_stack` recipes this is an empty object; the agent
   * applies via `apply_preset({recipe_id})` and the full slots[] are
   * materialized server-side. The apply_preset response carries
   * `applied_spec` echoing the merge result.
   */
  readonly params: Readonly<Record<string, number | string>>;
  /**
   * `block_stack` family only — number of slots the recipe places when
   * applied. Lets the agent budget chain real estate (AM4: 4 max;
   * II/III: row capacity).
   */
  readonly slot_count?: number;
  /**
   * `block_stack` family only — ordered list of `{slot, block_type}`
   * pairs the recipe places. Slot refs are device-shaped (bare int on
   * AM4 linear, `{row,col}` on II/III grid). The slot ref is what
   * `apply_preset` overrides target — keying overrides by `slot`
   * (e.g. `overrides:{slots:[{slot:2, block_type:'amp', params:{type:'Recto2 Red Modern'}}]}`)
   * does a deep merge against the matching recipe slot.
   */
  readonly target_blocks?: readonly {
    readonly slot: number | { readonly row: number; readonly col: number };
    readonly block_type: string;
  }[];
  /**
   * `block_stack` family only — hand-authored distinctive picks that
   * disambiguate this recipe from siblings. Dot-paths to display-shape
   * values (`amp.type`, `delay.feedback`). Validated at CI to be a
   * subset of the materialized recipe's slots, so the slim summary
   * never drifts from the actual wire values.
   */
  readonly signature_params?: Readonly<Record<string, number | string>>;
  /**
   * `block_stack` family only — public-source citation for the recipe's
   * knob values. Surfaced so the agent can answer "where do these
   * settings come from?" without guessing.
   */
  readonly source_notes?: string;
  /**
   * True when this recipe sets a static starting position but a
   * modifier (envelope follower / expression pedal / LFO) is needed
   * to fully realize the intent. Surface to the user; modifier wiring
   * is BK-063 (not yet shipped on II/III).
   */
  readonly modifier_needed?: boolean;
  /**
   * `patch_archetype` (Hydrasynth) family only — the device category tag
   * (Bass / Pad / Lead / E-piano / …) the recipe belongs to. Lets the
   * agent map "give me a bass" directly to candidate ids.
   */
  readonly category?: string;
  /**
   * `patch_archetype` family only — recognizable cultural reference for
   * the tone (e.g. "Fender Rhodes Mark I suitcase EP").
   */
  readonly cultural_reference?: string;
  /**
   * `patch_archetype` family only — true when the recipe wires mod-matrix
   * / macro-page routes after the SysEx dump. Those routes need
   * Param TX/RX = NRPN on the device; the base patch lands regardless.
   */
  readonly requires_nrpn?: boolean;
  /**
   * Free-text tags for cross-recipe vocabulary queries ('80s','warm',
   * 'bright','cinematic','percussive'). Present on `patch_archetype`.
   */
  readonly tags?: readonly string[];
}

/**
 * Collapsed cross-family recipe list filtered to `port`. The describe
 * _device executor calls this once per request; cheap (pure-data scan).
 *
 * Returns an empty array on ports that have no recipes registered
 * (e.g. Hydrasynth) so the field is always an array and the agent
 * doesn't branch on undefined.
 */
export function summarizeRecipesForPort(port: string): readonly RecipeSummaryEntry[] {
  const normalized = port.trim().toLowerCase();

  // Hydrasynth patch-archetype family (BK-074). Different shape from the
  // Fractal families — applied via apply_patch({recipe_id}), not
  // apply_preset. Every registered recipe surfaces here; inclusion is a
  // curation decision made before a recipe lands, not a runtime tier.
  if (normalized === 'hydrasynth') {
    const entries: RecipeSummaryEntry[] = [];
    for (const recipe of Object.values(HYDRA_PATCH_RECIPES)) {
      entries.push({
        id: recipe.name,
        family: 'patch_archetype',
        description: recipe.description,
        params: {},
        signature_params: recipe.signature_params,
        source_notes: recipe.source_notes,
        category: recipe.category,
        cultural_reference: recipe.cultural_reference,
        requires_nrpn: recipe.requires_nrpn === true ? true : undefined,
        tags: recipe.tags,
      });
    }
    return entries;
  }

  const portKey = normalized as RecipePort;
  if (portKey !== 'am4' && portKey !== 'axe-fx-ii' && portKey !== 'axe-fx-iii') {
    return [];
  }
  const entries: RecipeSummaryEntry[] = [];

  for (const recipe of Object.values(AUTO_WAH_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    const target_block = recipe.target_block_per_device[portKey];
    const modifier_needed = recipe.modifier_needed_on?.[portKey];
    entries.push({
      id: recipe.name,
      family: 'auto_wah',
      description: recipe.description,
      target_block,
      params,
      modifier_needed: modifier_needed === true ? true : undefined,
    });
  }

  for (const recipe of Object.values(PITCH_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'pitch',
      description: recipe.description,
      target_block: 'pitch',
      params,
      modifier_needed: recipe.modifier_needed === true ? true : undefined,
    });
  }

  for (const recipe of Object.values(WAH_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'wah',
      description: recipe.description,
      target_block: 'wah',
      params,
    });
  }

  for (const recipe of Object.values(FILTER_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const params = recipe.params_per_device[portKey];
    if (params === undefined) continue;
    entries.push({
      id: recipe.name,
      family: 'filter',
      description: recipe.description,
      target_block: 'filter',
      params,
    });
  }

  for (const recipe of Object.values(BLOCK_STACK_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    const slots = recipe.slots_per_device[portKey];
    if (slots === undefined || slots.length === 0) continue;
    // Slim shape (2026-05-22 MCP migration): block_stack summaries
    // surface signature_params + target_blocks + slot_count, NOT the
    // full slots[]. The agent applies via apply_preset({recipe_id,
    // overrides?}) which resolves the recipe server-side; the
    // committed apply's `applied_spec` field echoes the merged spec
    // so the agent never needs a write-to-inspect round-trip.
    const signatureParams = recipe.signature_params_per_device[portKey] ?? {};
    const targetBlocks = slots.map((s) => ({ slot: s.slot, block_type: s.block_type }));
    entries.push({
      id: recipe.name,
      family: 'block_stack',
      description: recipe.description,
      params: {},
      slot_count: slots.length,
      target_blocks: targetBlocks,
      signature_params: signatureParams,
      source_notes: recipe.source_notes,
    });
  }

  for (const recipe of Object.values(SCENE_LEVELING_RECIPES)) {
    if (!recipe.applicable_devices.includes(portKey)) continue;
    // Scene-leveling offsets are role-keyed dB, not slot params. Map
    // each role to its display dB offset under a `<role>_offset_db`
    // key so the shape matches `Record<string, number | string>`.
    const params: Record<string, number> = {};
    for (const [role, offset] of Object.entries(recipe.offsets_db)) {
      if (typeof offset === 'number') {
        params[`${role}_offset_db`] = offset;
      }
    }
    if (Object.keys(params).length === 0) continue;
    entries.push({
      id: recipe.name,
      family: 'scene_leveling',
      description: recipe.description,
      params,
    });
  }

  return entries;
}
