/**
 * Hydrasynth patch-archetype recipe family (BK-074 / BK-082).
 *
 * The Fractal block-stack model (slot lists) does NOT translate to the
 * Hydrasynth — it is a subtractive / wavetable VOICE (oscillators +
 * filters + envelopes + LFOs + mod matrix + macros), not a multi-block
 * effects chain. So this is a parallel family: each recipe materializes
 * to a sparse `apply_patch` param map (the buildable PATCH_OFFSETS
 * surface) plus optional mod-matrix / macro-page routing applied after
 * the atomic SysEx dump.
 *
 * Category grouping uses the device's OWN 19-value category enum
 * (edisyn ASMHydrasynth.java:99) so vocabulary like "pad", "bass",
 * "e-piano", "brass" maps directly to candidate sets and matches what
 * the user sees browsing the device.
 *
 * Values are DISPLAY units — exactly what `apply_patch.params` accepts
 * (enum names like "Saw" / "LP Fat 24", display numbers for cutoff /
 * level / wet %, and env/LFO TIMES in milliseconds — e.g. 2560 or the
 * string "2.56s" — same as the front-panel reading; the codec inverts
 * the non-linear time table internally). Every `params` key must exist
 * in `PATCH_OFFSETS` (validated by scripts/verify-recipe-tables.ts).
 *
 * **Inclusion discipline:** every recipe registered here ships and
 * surfaces in the describe_device discovery list. Whether a candidate
 * recipe is good enough to register is a curation decision made before
 * it lands (ear-tested on hardware during the audition pass, tracked in
 * the maintainer's private planning notes); the code carries no
 * verified/unverified tier. A recipe that isn't ready simply isn't
 * registered. See docs/_private/STATE-HYDRA.md.
 *
 * **Sourcing discipline (BK-074 anti-duplication):** values are
 * GENERALIZED syntheses grounded in (a) the decoded factory/3rd-party
 * bank corpus (samples/hydrasynth/bank-corpus.json — real ground-truth
 * structure per category) and (b) documented classic-synth programming
 * + web patch walkthroughs. NOT verbatim copies of any single
 * commercial patch. `source_notes` cites the corpus exemplars compared
 * + public references.
 */

import { RecipeMaterializeError } from './materialize.js';
import { CURATED_HYDRA_PATCH_RECIPES } from './patchArchetype.curated.js';

/** Hydrasynth patch-category enum — edisyn ASMHydrasynth.java:99 (19 values). */
export type HydraCategory =
  | 'Ambient' | 'Arp' | 'Bass' | 'BassLead' | 'Brass' | 'Chord' | 'Drum'
  | 'E-piano' | 'FX' | 'FxMusic' | 'Keys' | 'Lead' | 'Organ' | 'Pad'
  | 'Perc' | 'Rhythmic' | 'Sequence' | 'Strings' | 'Vocal';

/** A mod-matrix route the recipe wires after the atomic patch dump (NRPN). */
export interface HydraModRoute {
  /** Mod source name (resolved by modRouting.ts), e.g. "LFO 1", "Env 1". */
  readonly source: string;
  /** Mod destination name, e.g. "Filt 1 Cutoff", "Amp Level". */
  readonly target: string;
  /** Depth -127..127. */
  readonly depth: number;
}

/** A macro-page assignment the recipe wires after the patch dump (NRPN). */
export interface HydraMacroRoute {
  /** Macro number 1..8. */
  readonly macro: number;
  /** Macro destination name, e.g. "Filt 1 Cutoff". */
  readonly target: string;
  /** Depth -127..127. */
  readonly depth: number;
}

export interface PatchRecipeSpec {
  /** Stable kebab/snake id; the string the recipe is keyed by + applied by. */
  readonly name: string;
  /** Device category tag (drives discovery grouping). */
  readonly category: HydraCategory;
  /** One-line human-facing description (surfaced by describe_device). */
  readonly description: string;
  /** Sparse apply_patch override map (display values). Every key ∈ PATCH_OFFSETS. */
  readonly params: Readonly<Record<string, number | string>>;
  /** Optional mod-matrix routes applied via set_mod_route after the dump (NRPN). */
  readonly mod_routes?: readonly HydraModRoute[];
  /** Optional macro-page assignments applied via set_macro_route after the dump (NRPN). */
  readonly macro_routes?: readonly HydraMacroRoute[];
  /** True iff mod_routes / macro_routes present (those need Param TX/RX = NRPN). */
  readonly requires_nrpn?: boolean;
  /** 2-4 distinctive picks — a strict subset of `params` (validated at CI). */
  readonly signature_params: Readonly<Record<string, number | string>>;
  /** Free-text tags for cross-recipe queries ('80s','warm','bright','cinematic',…). */
  readonly tags: readonly string[];
  /** Recognizable cultural reference, e.g. "Vangelis – Chariots of Fire (CS-80)". */
  readonly cultural_reference: string;
  /** Bank exemplars compared + public sources. */
  readonly source_notes: string;
}

/**
 * Seed set. The curation Workflow (BK-074 Phase 2) expands this to full
 * categorical coverage (~36 across the active categories) by comparing
 * the decoded bank corpus + web research per category. These seeds set
 * the house style + exercise the infra (materializer, describe_device,
 * goldens, macro/mod-route chaining).
 */
const SEED_HYDRA_PATCH_RECIPES: Readonly<Record<string, PatchRecipeSpec>> = {
  // ---- Bass ----
  sub_warmth: {
    name: 'sub_warmth',
    category: 'Bass',
    description: 'Warm sub bass: two detuned saws an octave down through a fat ladder filter, snappy amp, light filter-env pluck. Mono.',
    params: {
      voicepolyphony: 1,
      osc1type: 'Saw', osc1semi: -12,
      osc2type: 'Saw', osc2semi: -12, osc2cent: 7,
      mixerosc1vol: 100, mixerosc2vol: 100,
      filter1type: 'LP Fat 24', filter1cutoff: 32, filter1resonance: 8,
      filter1env1amount: 30, filter1drive: 20,
      amplevel: 110,
      env1attacksyncoff: 0, env1decaysyncoff: 160, env1sustain: 10, env1releasesyncoff: 80,
      env2attacksyncoff: 2, env2decaysyncoff: 240, env2sustain: 90, env2releasesyncoff: 96,
    },
    signature_params: { osc1type: 'Saw', osc1semi: -12, filter1type: 'LP Fat 24', filter1cutoff: 32 },
    tags: ['warm', 'analog', 'sub', 'mono'],
    cultural_reference: 'Generic warm analog sub bass (Moog/Juno lineage)',
    source_notes: 'Corpus exemplars compared: "BrunoBass GD", "DX100 Bass GD" (Bass cat, banks A-E). Generalized: classic 2-saw sub-octave subtractive bass.',
  },

  // ---- BassLead (macro + mod-route showcase) ----
  growl_wobble: {
    name: 'growl_wobble',
    category: 'BassLead',
    description: 'Dubstep growl: detuned saws, resonant ladder, LFO wobbling the cutoff, with Macro 1 mapped to cutoff+reso for hands-on filter sweeps.',
    params: {
      voicepolyphony: 1,
      osc1type: 'Saw', osc2type: 'Saw', osc2cent: 12,
      mixerosc1vol: 110, mixerosc2vol: 110,
      filter1type: 'LP Ladder 24', filter1cutoff: 45, filter1resonance: 60, filter1drive: 70,
      amplevel: 100,
      env2attacksyncoff: 0, env2decaysyncoff: 320, env2sustain: 100, env2releasesyncoff: 80,
      lfo1wave: 'Sine', lfo1ratesyncoff: '4.44 Hz',
    },
    mod_routes: [
      { source: 'LFO 1', target: 'Filt 1 Cutoff', depth: 60 },
    ],
    macro_routes: [
      { macro: 1, target: 'Filt 1 Cutoff', depth: 90 },
      { macro: 1, target: 'Filt 1 Resonance', depth: 40 },
    ],
    requires_nrpn: true,
    signature_params: { filter1type: 'LP Ladder 24', filter1resonance: 60, lfo1wave: 'Sine' },
    tags: ['dubstep', 'wobble', 'aggressive', 'macro', 'modulation'],
    cultural_reference: 'Modern dubstep / bass-music growl (Serum-style LFO-to-cutoff)',
    source_notes: 'Corpus exemplars: "Wet My Frog DA", "Butter Lick DA" (BassLead cat). LFO→cutoff + macro-to-filter is the canonical wobble wiring; showcases set_mod_route + set_macro_route.',
  },

  // ---- Pad ----
  warm_analog_pad: {
    name: 'warm_analog_pad',
    category: 'Pad',
    description: 'Lush warm pad: two slightly detuned saws, soft low-pass, slow attack and long release, plate-ish reverb. Polyphonic.',
    params: {
      voicepolyphony: 0,
      voicedensity: 2, voicedetune: 30,
      osc1type: 'Saw', osc2type: 'Saw', osc2cent: 8,
      mixerosc1vol: 120, mixerosc2vol: 120,
      filter1type: 'LP Fat 12', filter1cutoff: 55, filter1resonance: 12, filter1env1amount: 20,
      amplevel: 100,
      env1attacksyncoff: 640, env1decaysyncoff: 640, env1sustain: 120, env1releasesyncoff: 7680,
      env2attacksyncoff: 2560, env2decaysyncoff: 0, env2sustain: 128, env2releasesyncoff: 10000,
      reverbtype: 'Hall', reverbtime: '4.00s', reverbwet: 30,
    },
    signature_params: { filter1type: 'LP Fat 12', env2attacksyncoff: 2560, env2releasesyncoff: 10000, reverbtype: 'Hall' },
    tags: ['warm', 'lush', 'analog', 'cinematic', 'polyphonic'],
    cultural_reference: 'Generic warm analog string-pad (Juno/Prophet ensemble lineage)',
    source_notes: 'Corpus exemplars: "GX UltraPad PS", "Ober Pad GD", "Twilight ET" (Pad cat). Generalized slow-swell saw pad.',
  },

  // ---- Pad (macro morph showcase) ----
  evolving_wash: {
    name: 'evolving_wash',
    category: 'Pad',
    description: 'Evolving ambient wash: wavescan oscillator with Macro 1 sweeping the wavetable position + filter cutoff for a one-knob morph, very long release, big reverb.',
    params: {
      voicepolyphony: 0,
      voicedensity: 2, voicedetune: 24,
      osc1mode: 'WaveScan', osc1type: 'Saw', osc1wavscan: 1,
      osc2type: 'Saw', osc2cent: 10,
      mixerosc1vol: 120, mixerosc2vol: 90,
      filter1type: 'LP Fat 12', filter1cutoff: 48, filter1resonance: 15,
      amplevel: 95,
      env1attacksyncoff: 3840, env1decaysyncoff: 640, env1sustain: 110, env1releasesyncoff: 24000,
      env2attacksyncoff: 5120, env2decaysyncoff: 0, env2sustain: 128, env2releasesyncoff: 34000,
      reverbtype: 'Hall', reverbtime: '11.0s', reverbwet: 45,
    },
    macro_routes: [
      { macro: 1, target: 'Osc 1 Wavescan', depth: 90 },
      { macro: 1, target: 'Filt 1 Cutoff', depth: 50 },
    ],
    requires_nrpn: true,
    signature_params: { osc1mode: 'WaveScan', reverbtype: 'Hall', env2releasesyncoff: 34000 },
    tags: ['ambient', 'evolving', 'wavetable', 'cinematic', 'macro'],
    cultural_reference: 'Eno-style evolving ambient wash; wavetable morph pad',
    source_notes: 'Corpus exemplars: "Starnight RA", "Moon=Mars SCD" (Ambient/Pad cat). Macro→wavescan+cutoff is the one-knob morph showcase.',
  },

  // ---- E-piano ----
  suitcase_ep: {
    name: 'suitcase_ep',
    category: 'E-piano',
    description: 'Suitcase electric-piano: bell-like attack with long bloom, slight drive for tine bark, light chorus and reverb. The classic Rhodes voice.',
    params: {
      voicepolyphony: 0,
      osc1type: 'Sine', osc2type: 'Triangle', osc2semi: 12,
      mixerosc1vol: 110, mixerosc2vol: 40,
      filter1type: 'LP Fat 24', filter1cutoff: 70, filter1drive: 35,
      amplevel: 90,
      env2attacksyncoff: 0, env2decaysyncoff: 7680, env2sustain: 20, env2releasesyncoff: 80,
      prefxtype: 'Chorus', prefxwet: 25,
      reverbtype: 'Hall', reverbtime: '1.60s', reverbwet: 20,
    },
    signature_params: { osc1type: 'Sine', filter1drive: 35, env2decaysyncoff: 7680, prefxtype: 'Chorus' },
    tags: ['rhodes', 'vintage', 'keys', 'warm'],
    cultural_reference: 'Fender Rhodes Mark I suitcase EP',
    source_notes: 'Corpus exemplars: "Suitcase MK1 RA", "Deluxe Piano RA" (E-piano cat). Generalized FM-ish bell + decay-bloom EP.',
  },

  // ---- Brass ----
  brass_swell: {
    name: 'brass_swell',
    category: 'Brass',
    description: 'Analog brass swell: stacked saw + square, filter-envelope opening for the brassy attack, medium attack for the signature swell. CS-80 lineage.',
    params: {
      voicepolyphony: 0,
      osc1type: 'Saw', osc2type: 'Square', osc2cent: 6,
      mixerosc1vol: 115, mixerosc2vol: 95,
      filter1type: 'LP Fat 12', filter1cutoff: 40, filter1resonance: 10, filter1env1amount: 45,
      amplevel: 100,
      env1attacksyncoff: 30, env1decaysyncoff: 480, env1sustain: 70, env1releasesyncoff: 240,
      env2attacksyncoff: 40, env2decaysyncoff: 320, env2sustain: 110, env2releasesyncoff: 320,
      reverbtype: 'Hall', reverbtime: '1.35s', reverbwet: 18,
    },
    signature_params: { osc2type: 'Square', filter1env1amount: 45, env2attacksyncoff: 40 },
    tags: ['brass', 'cs80', 'analog', 'cinematic'],
    cultural_reference: 'Yamaha CS-80 brass (Vangelis lineage)',
    source_notes: 'Corpus exemplars: "NiceBrass GD", "Juno60 Brass GD", "BrassAmerican RA" (Brass cat). Generalized filter-env brass swell.',
  },

  // ---- Pad (Prophet-5) ----
  prophet5_pad: {
    name: 'prophet5_pad',
    category: 'Pad',
    description: 'Prophet-5 lush poly pad: detuned saw + pulse through a 4-pole low-pass, gentle filter-env bloom, slow swell and long tail. The warm analog string-machine voice.',
    params: {
      voicepolyphony: 0,
      voicedensity: 2, voicedetune: 20,
      osc1type: 'Saw', osc2type: 'Square', osc2cent: 6,
      mixerosc1vol: 110, mixerosc2vol: 95,
      filter1type: 'LP Fat 24', filter1cutoff: 58, filter1resonance: 10, filter1env1amount: 22,
      amplevel: 105,
      env1attacksyncoff: 200, env1decaysyncoff: 1200, env1sustain: 70, env1releasesyncoff: 1500,
      env2attacksyncoff: 800, env2decaysyncoff: 0, env2sustain: 128, env2releasesyncoff: 3000,
      prefxtype: 'Chorus', prefxwet: 20,
      reverbtype: 'Hall', reverbtime: '2.5s', reverbwet: 25,
    },
    signature_params: { osc2type: 'Square', filter1type: 'LP Fat 24', filter1cutoff: 58, env2releasesyncoff: 3000 },
    tags: ['warm', 'lush', 'analog', 'polyphonic', '80s'],
    cultural_reference: 'Sequential Prophet-5 poly pad (Curtis/SSM lineage)',
    source_notes: 'Corpus exemplars compared: "Ober Pad GD", "Polymorph FP", "GX UltraPad PS" (Pad cat). Generalized 2-osc detuned-saw + pulse analog pad with filter-env bloom; cutoff kept open (58) so the patch reads bright, not dark.',
  },

  // ---- Pad (Juno-106) ----
  juno106_pad: {
    name: 'juno106_pad',
    category: 'Pad',
    description: 'Juno-106 chorus pad: a single saw over a square sub-oscillator through a fat low-pass, defined by its prominent stereo chorus. The classic 80s glassy-warm poly.',
    params: {
      voicepolyphony: 0,
      voicedensity: 2, voicedetune: 16,
      osc1type: 'Saw', osc2type: 'Square', osc2semi: -12,
      mixerosc1vol: 115, mixerosc2vol: 70,
      filter1type: 'LP Fat 24', filter1cutoff: 52, filter1resonance: 8, filter1env1amount: 18,
      amplevel: 108,
      env1attacksyncoff: 300, env1decaysyncoff: 900, env1sustain: 80, env1releasesyncoff: 1200,
      env2attacksyncoff: 600, env2decaysyncoff: 0, env2sustain: 128, env2releasesyncoff: 2500,
      prefxtype: 'Chorus', prefxwet: 45,
      reverbtype: 'Hall', reverbtime: '2.0s', reverbwet: 22,
    },
    signature_params: { osc2semi: -12, prefxwet: 45, filter1type: 'LP Fat 24', reverbtype: 'Hall' },
    tags: ['warm', 'chorus', 'analog', 'polyphonic', '80s'],
    cultural_reference: 'Roland Juno-106 chorus pad',
    source_notes: 'Corpus exemplars compared: "Ober Pad GD", "Polymorph FP" (Pad cat) + Juno-106 programming (single DCO + sub osc, chorus is the defining feature). Sub at osc2semi -12 with osc2cent 0 to avoid sub-beating; chorus prominent at 45%.',
  },

  // ---- Brass (Oberheim OB-Xa "Jump") ----
  obxa_jump: {
    name: 'obxa_jump',
    category: 'Brass',
    description: 'OB-Xa brass stab: fat stacked detuned saws, fast filter-envelope giving the bright brassy attack, punchy and loud. The iconic 80s synth-brass poly riff voice.',
    params: {
      voicepolyphony: 0,
      voicedensity: 2, voicedetune: 24,
      osc1type: 'Saw', osc2type: 'Saw', osc2cent: 8,
      mixerosc1vol: 110, mixerosc2vol: 105,
      filter1type: 'LP Ladder 24', filter1cutoff: 45, filter1resonance: 12, filter1env1amount: 50,
      amplevel: 110,
      env1attacksyncoff: 5, env1decaysyncoff: 250, env1sustain: 70, env1releasesyncoff: 200,
      env2attacksyncoff: 8, env2decaysyncoff: 300, env2sustain: 110, env2releasesyncoff: 250,
      prefxtype: 'Chorus', prefxwet: 25,
      reverbtype: 'Hall', reverbtime: '1.5s', reverbwet: 18,
    },
    signature_params: { filter1type: 'LP Ladder 24', filter1env1amount: 50, env2attacksyncoff: 8, voicedetune: 24 },
    tags: ['brass', 'obxa', 'analog', '80s', 'punchy'],
    cultural_reference: 'Oberheim OB-Xa brass — Van Halen "Jump" lineage',
    source_notes: 'Corpus exemplars compared: "Pro-5 brassy RA", "Juno60 Brass GD" (Brass cat) + OB-Xa "Jump" programming (stacked detuned saws + fast filter-env brass attack). Base cutoff 45 with filter1env1amount 50 gives the bright attack without going dark; amplevel 110 for the punchy stab.',
  },
};

/**
 * Full recipe table = hand-authored seeds + workflow-curated entries
 * (BK-074 Phase 2, generated by scripts/hydrasynth/assemble-recipes.ts).
 * Seeds win on any name collision (the assembler reserves seed names).
 */
export const HYDRA_PATCH_RECIPES: Readonly<Record<string, PatchRecipeSpec>> = {
  ...CURATED_HYDRA_PATCH_RECIPES,
  ...SEED_HYDRA_PATCH_RECIPES,
};

/** Lookup a recipe by id (case-sensitive, the keyed name). */
export function resolveHydraPatchRecipe(recipeId: string): PatchRecipeSpec | undefined {
  return HYDRA_PATCH_RECIPES[recipeId];
}

/** Materialized recipe ready for the apply_patch dump + route-chaining tail. */
export interface MaterializedHydraPatch {
  /** Sparse override array in apply_patch `params` shape (display values). */
  readonly params: readonly { name: string; value: number | string }[];
  readonly mod_routes: readonly HydraModRoute[];
  readonly macro_routes: readonly HydraMacroRoute[];
  /** True iff routes are present (the route tail needs Param TX/RX = NRPN). */
  readonly requires_nrpn: boolean;
  /** The recipe's device category tag — apply_patch writes it on save. */
  readonly category: HydraCategory;
}

/**
 * Resolve `recipe_id` (+ optional flat `overrides`) into the param array
 * + route lists the Hydra apply_patch handler consumes. Throws
 * `RecipeMaterializeError('unknown_recipe', …)` on a bad id so the
 * dispatcher converts it to the structured DispatchError shape.
 *
 * `overrides` is a flat `Record<paramName, displayValue>` deep-merged
 * onto the recipe params (override wins per-key; recipe keys not
 * overridden survive) — the Hydra analog of the block-stack override
 * merge.
 */
export function materializeHydraPatchRecipe(
  recipeId: string,
  overrides?: Readonly<Record<string, number | string>>,
): MaterializedHydraPatch {
  const recipe = HYDRA_PATCH_RECIPES[recipeId];
  if (!recipe) {
    throw new RecipeMaterializeError(
      'unknown_recipe',
      `Unknown Hydrasynth patch recipe '${recipeId}'.`,
      { recipe_id: recipeId, known_recipes: Object.keys(HYDRA_PATCH_RECIPES) },
    );
  }
  const merged: Record<string, number | string> = { ...recipe.params, ...(overrides ?? {}) };
  const params = Object.entries(merged).map(([name, value]) => ({ name, value }));
  const mod_routes = recipe.mod_routes ?? [];
  const macro_routes = recipe.macro_routes ?? [];
  return {
    params,
    mod_routes,
    macro_routes,
    requires_nrpn: recipe.requires_nrpn === true || mod_routes.length > 0 || macro_routes.length > 0,
    category: recipe.category,
  };
}
