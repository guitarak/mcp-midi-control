/**
 * Amp tone-stack recipe library (gen-3: Axe-Fx III / FM3 / FM9).
 *
 * The first amp-knob recipes for the modern Fractal family. Each recipe is
 * a numeric voicing of the amp block's tone stack + master — the knobs a
 * player reaches for to dial a genre tone on TOP of whatever amp model is
 * loaded. They do NOT set the amp MODEL by design — these are model-agnostic
 * voicings layered on whatever amp is loaded. (Amp model set-by-name DOES work
 * on gen-3: a discrete SET carries float32(read-ordinal), so a model name
 * resolves straight off the shipped roster. Picking the model stays a separate
 * step so a recipe can voice any amp.)
 *
 * Why gen-3 only. These recipes ride the display-first calibration the amp
 * (DISTORT) knobs gained when the AM4 symbol-name overlay was generalized to
 * FM3/FM9: every knob here is a hardware-anchored 0..10 display value that
 * the gen-3 schema now encodes to wire correctly. The AM4/Axe-Fx II amp
 * blocks use different param-key spellings (`master_volume` vs `master`,
 * etc.), so a cross-device amp recipe is a separate effort; these are
 * deliberately scoped to the gen-3 family whose param names are shared.
 *
 * Display-first convention (per CLAUDE.md "Tool API conventions"): numbers
 * are display units (0..10 knob readings). The `apply_preset` executor
 * coerces display -> wire via the param's calibration. Param keys are the
 * gen-3 DISTORT symbol names (`DISTORT_DRIVE`, ...); the descriptor's block
 * aliases resolve them to the schema's stripped keys (`drive`, ...).
 *
 * Voicing provenance: standard amp-EQ shapes, not device-specific captures.
 * Modern high-gain is tight-and-aggressive (firm lows, present highs, mids
 * pulled slightly for clarity under gain); classic crunch is mid-forward;
 * the clean platform keeps drive low and master high for pedal headroom;
 * edge-of-breakup sits at the dynamic threshold; the lead voicing pushes
 * mids and presence for a singing solo tone. All are conservative,
 * musically-safe starting points the player then fine-tunes.
 */

import type { RecipePort } from './pitch.js';

export interface AmpRecipeSpec {
  /** Stable recipe key (snake_case). */
  readonly name: string;
  /** One-line human-readable description for tool surfacing. */
  readonly description: string;
  /** Ports this recipe targets. Gen-3 family only (III / FM3 / FM9). */
  readonly applicable_devices: readonly RecipePort[];
  /**
   * Per-device display-value param dict. Keyed by the gen-3 DISTORT symbol
   * name; values are 0..10 display knob readings. The three gen-3 devices
   * share the symbol names, so each carries the same dict.
   */
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number>>>>>;
}

/** Gen-3 ports every amp recipe applies to. */
const GEN3: readonly RecipePort[] = ['axe-fx-iii', 'fm3', 'fm9'] as const;

/**
 * Build a per-device dict for the gen-3 family from one shared voicing.
 * The III / FM3 / FM9 amp blocks share the DISTORT symbol names, so the
 * same knob dict applies to all three; this avoids triplicating it.
 */
function gen3(voicing: Readonly<Record<string, number>>): AmpRecipeSpec['params_per_device'] {
  return { 'axe-fx-iii': voicing, fm3: voicing, fm9: voicing };
}

export const AMP_RECIPES: Readonly<Record<string, AmpRecipeSpec>> = Object.freeze({
  // Tight modern metal/djent voicing: firm lows, present highs, mids pulled
  // slightly so chugs stay defined under high gain. Master backed off (gain
  // does the work).
  modern_high_gain: {
    name: 'modern_high_gain',
    description: 'Tight modern high-gain voicing (metal/djent): firm lows, present highs, controlled mids.',
    applicable_devices: GEN3,
    params_per_device: gen3({
      DISTORT_DRIVE: 7.5,
      DISTORT_BASS: 4.5,
      DISTORT_MID: 5.5,
      DISTORT_TREBLE: 6,
      DISTORT_PRESENCE: 5.5,
      DISTORT_DEPTH: 5.5,
      DISTORT_MASTER: 4,
    }),
  },

  // Classic rock crunch: mid-forward, moderate drive, even tone stack.
  classic_crunch: {
    name: 'classic_crunch',
    description: 'Classic rock crunch: mid-forward, moderate drive, even low/high balance.',
    applicable_devices: GEN3,
    params_per_device: gen3({
      DISTORT_DRIVE: 5,
      DISTORT_BASS: 5.5,
      DISTORT_MID: 6.5,
      DISTORT_TREBLE: 6,
      DISTORT_PRESENCE: 5,
      DISTORT_DEPTH: 5,
      DISTORT_MASTER: 5.5,
    }),
  },

  // Clean pedal platform: low drive, high master for headroom, neutral EQ
  // so overdrive/fuzz pedals in front behave predictably.
  clean_pedal_platform: {
    name: 'clean_pedal_platform',
    description: 'Clean pedal platform: low drive, high master headroom, neutral EQ for pedals in front.',
    applicable_devices: GEN3,
    params_per_device: gen3({
      DISTORT_DRIVE: 2,
      DISTORT_BASS: 5,
      DISTORT_MID: 5.5,
      DISTORT_TREBLE: 6,
      DISTORT_PRESENCE: 4.5,
      DISTORT_DEPTH: 5,
      DISTORT_MASTER: 6.5,
    }),
  },

  // Edge of breakup: dynamic light grind that cleans up with the guitar
  // volume. Moderate drive, master up for touch sensitivity.
  edge_of_breakup: {
    name: 'edge_of_breakup',
    description: 'Edge-of-breakup: dynamic light grind that cleans up with guitar volume.',
    applicable_devices: GEN3,
    params_per_device: gen3({
      DISTORT_DRIVE: 4,
      DISTORT_BASS: 5,
      DISTORT_MID: 6,
      DISTORT_TREBLE: 5.5,
      DISTORT_PRESENCE: 5,
      DISTORT_DEPTH: 5,
      DISTORT_MASTER: 6,
    }),
  },

  // Singing lead: mids and presence pushed for a vocal, cutting solo tone;
  // a touch more drive than crunch.
  lead_singing: {
    name: 'lead_singing',
    description: 'Singing lead voicing: pushed mids + presence for a vocal, cutting solo tone.',
    applicable_devices: GEN3,
    params_per_device: gen3({
      DISTORT_DRIVE: 6.5,
      DISTORT_BASS: 4.5,
      DISTORT_MID: 7,
      DISTORT_TREBLE: 6,
      DISTORT_PRESENCE: 6,
      DISTORT_DEPTH: 5,
      DISTORT_MASTER: 5,
    }),
  },
});

/**
 * Resolve an amp recipe for a target port. Returns the per-device params
 * dict, or throws (display-shape error) when the recipe is unknown or not
 * applicable to the port.
 */
export function resolveAmpRecipe(
  recipeName: string,
  port: RecipePort,
): { params: Readonly<Record<string, number>> } {
  const recipe = AMP_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(AMP_RECIPES).join(', ');
    throw new Error(`unknown amp recipe '${recipeName}'. Known recipes: ${known}`);
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `amp recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const params = recipe.params_per_device[port];
  if (!params || Object.keys(params).length === 0) {
    throw new Error(
      `amp recipe '${recipeName}' has no params_per_device entry for port '${port}' ` +
        `even though it lists '${port}' as applicable. This is a recipe-table bug.`,
    );
  }
  return { params };
}
