/**
 * Reverb voicing recipe library (gen-3: Axe-Fx III / FM3 / FM9).
 *
 * Numeric voicings of the reverb block: the calibrated knobs a player
 * reaches for to land a hall / plate / spring character on TOP of whatever
 * reverb TYPE is selected. They do NOT set the reverb TYPE by design — they are
 * type-agnostic voicings. (Reverb type set-by-name DOES work on gen-3: a
 * discrete SET carries float32(read-ordinal), so a type name resolves straight
 * off the shipped roster. Picking the type stays a separate step so a recipe
 * can voice any reverb.)
 *
 * Honest scope note. On the modern Fractal family the reverb TYPE selector
 * carries most of a reverb's character; these recipes shape the time / size /
 * pre-delay / tone the player would dial to push a chosen type toward the
 * named space (a longer, larger, darker setting reads as a hall; a short,
 * small, brighter one reads as a spring). They are conservative numeric
 * starting points, not a substitute for the type selector.
 *
 * Why gen-3 only. These ride the display-first calibration the reverb knobs
 * gained when the AM4 symbol-name overlay was generalized to FM3/FM9: every
 * value here is a hardware-anchored display unit (seconds / %, Hz) the gen-3
 * schema encodes to wire correctly. The AM4 / Axe-Fx II reverb blocks use
 * different param-key spellings, so a cross-device reverb recipe is a
 * separate effort; these are scoped to the gen-3 family whose REVERB symbol
 * names are shared.
 *
 * No delay-style tempo-synced timing here: reverb time is an absolute decay,
 * not a tempo division, so the tempo-first opinion does not apply. (The
 * separate delay recipe family is deferred until the gen-3 delay
 * tempo-division enum is decoded.)
 *
 * Display-first convention (per CLAUDE.md "Tool API conventions"): values are
 * display units. REVERB_TIME is seconds; REVERB_MIX / SIZE / DIFFUSION are
 * 0..100; REVERB_PREDELAY is ms; REVERB_LOWCUT / HICUT are Hz. Param keys are
 * the gen-3 REVERB symbol names; the descriptor's block aliases resolve them
 * to the schema's stripped keys (`time`, `mix`, ...).
 */

import type { RecipePort } from './pitch.js';

export interface ReverbRecipeSpec {
  /** Stable recipe key (snake_case). */
  readonly name: string;
  /** One-line human-readable description for tool surfacing. */
  readonly description: string;
  /** Ports this recipe targets. Gen-3 family only (III / FM3 / FM9). */
  readonly applicable_devices: readonly RecipePort[];
  /**
   * Per-device display-value param dict. Keyed by the gen-3 REVERB symbol
   * name; values are display units (seconds / % / ms / Hz). The three gen-3
   * devices share the symbol names, so each carries the same dict.
   */
  readonly params_per_device: Readonly<Partial<Record<RecipePort, Readonly<Record<string, number>>>>>;
}

/** Gen-3 ports every reverb recipe applies to. */
const GEN3: readonly RecipePort[] = ['axe-fx-iii', 'fm3', 'fm9'] as const;

/**
 * Build a per-device dict for the gen-3 family from one shared voicing.
 * The III / FM3 / FM9 reverb blocks share the REVERB symbol names, so the
 * same knob dict applies to all three; this avoids triplicating it.
 */
function gen3(voicing: Readonly<Record<string, number>>): ReverbRecipeSpec['params_per_device'] {
  return { 'axe-fx-iii': voicing, fm3: voicing, fm9: voicing };
}

export const REVERB_RECIPES: Readonly<Record<string, ReverbRecipeSpec>> = Object.freeze({
  // Hall: long decay, large room, moderate pre-delay so the dry transient
  // speaks before the tail blooms. Darkened top + rolled lows keep a big
  // tail from washing the mix.
  reverb_hall: {
    name: 'reverb_hall',
    description:
      'Hall voicing: long decay + large size + moderate pre-delay for a big, blooming space. Select a hall-type reverb by name first (gen-3 type set-by-name works).',
    applicable_devices: GEN3,
    params_per_device: gen3({
      REVERB_TIME: 3.2,
      REVERB_SIZE: 78,
      REVERB_PREDELAY: 24,
      REVERB_DIFFUSION: 72,
      REVERB_LOWCUT: 90,
      REVERB_HICUT: 8000,
      REVERB_MIX: 28,
    }),
  },

  // Plate: medium decay, dense diffusion, short pre-delay. The classic
  // studio vocal/snare plate character, smooth and present without the
  // size of a hall.
  reverb_plate: {
    name: 'reverb_plate',
    description:
      'Plate voicing: medium decay + dense diffusion + short pre-delay for a smooth, present studio plate. Select a plate-type reverb by name first (gen-3 type set-by-name works).',
    applicable_devices: GEN3,
    params_per_device: gen3({
      REVERB_TIME: 1.8,
      REVERB_SIZE: 52,
      REVERB_PREDELAY: 12,
      REVERB_DIFFUSION: 88,
      REVERB_LOWCUT: 120,
      REVERB_HICUT: 10000,
      REVERB_MIX: 24,
    }),
  },

  // Spring: short decay, small size, sparse diffusion, almost no pre-delay
  // and a brighter, lower-rolled tone for the boingy amp-tank character.
  reverb_spring: {
    name: 'reverb_spring',
    description:
      'Spring voicing: short decay + small size + sparse diffusion for a boingy amp-tank character. Select a spring-type reverb by name first (gen-3 type set-by-name works).',
    applicable_devices: GEN3,
    params_per_device: gen3({
      REVERB_TIME: 1.4,
      REVERB_SIZE: 28,
      REVERB_PREDELAY: 6,
      REVERB_DIFFUSION: 55,
      REVERB_LOWCUT: 180,
      REVERB_HICUT: 6500,
      REVERB_MIX: 20,
    }),
  },
});

/**
 * Resolve a reverb recipe for a target port. Returns the per-device params
 * dict, or throws (display-shape error) when the recipe is unknown or not
 * applicable to the port.
 */
export function resolveReverbRecipe(
  recipeName: string,
  port: RecipePort,
): { params: Readonly<Record<string, number>> } {
  const recipe = REVERB_RECIPES[recipeName];
  if (!recipe) {
    const known = Object.keys(REVERB_RECIPES).join(', ');
    throw new Error(`unknown reverb recipe '${recipeName}'. Known recipes: ${known}`);
  }
  if (!recipe.applicable_devices.includes(port)) {
    throw new Error(
      `reverb recipe '${recipeName}' is not applicable to port '${port}'. ` +
        `Applicable devices: ${recipe.applicable_devices.join(', ')}.`,
    );
  }
  const params = recipe.params_per_device[port];
  if (!params || Object.keys(params).length === 0) {
    throw new Error(
      `reverb recipe '${recipeName}' has no params_per_device entry for port '${port}' ` +
        `even though it lists '${port}' as applicable. This is a recipe-table bug.`,
    );
  }
  return { params };
}
