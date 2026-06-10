/**
 * gen-3 (Axe-Fx III / FM3 / FM9) decoded preset -> translate-ready PresetSpec.
 *
 * `get_preset(location)` returns a `PresetSnapshot.whole_preset` (a
 * `Gen3WholePresetView`) decoded from a stored gen-3 preset dump. This module
 * turns that rich decode into a `PresetSpec` in the cross-device CANONICAL
 * vocabulary so `translatePresetSpec` can port it to an AM4 / Axe-Fx II (the
 * source-side leg of the documented HW-118 "translate a stored preset" path).
 *
 * What carries:
 *   - placed blocks -> slots, with the decoder's family name mapped to the
 *     canonical block slug (amp / drive / reverb / ...). Routing + utility
 *     nodes (Input/Output/Send/Return/Mixer/Multiplexer) are dropped; they are
 *     not translatable blocks.
 *   - each block's effect-type model (channel A) -> `params.type`, so the
 *     cross-device enum table can remap it (e.g. reverb/drive names; amp passes
 *     through verbatim until the amp enum column is captured).
 *   - amp per-channel knobs (FM3/FM9 only, channel A) -> flat `params`.
 *   - per-scene channel + bypass state -> `scenes[]` keyed by the slot id.
 *
 * What does NOT carry (honest limits, surfaced as notes):
 *   - generic per-block knob VALUES beyond the amp: the gen-3 body decoder does
 *     not decode them (no value-scale ground truth), so non-amp blocks translate
 *     as type-only. The target preflight + translator warnings make the gaps
 *     explicit; the user fills knobs after applying.
 *   - routing topology: gen-3 read-side grid edges are not decoded, so the
 *     translated chain is ordered but not edge-wired (the same limitation the
 *     translator already has for grid sources).
 */

import type {
  PresetSpec,
  PresetSlotSpec,
  SceneSpec,
  Gen3WholePresetView,
  Gen3BlockView,
} from './types.js';

/** gen-3 decoder family name -> canonical cross-device block slug. Only clear
 *  1:1 analogs are mapped; anything else falls through to a sanitized family
 *  slug and is dropped by the translator if the target lacks it (with a
 *  warning), which is the honest outcome. */
const GEN3_FAMILY_TO_SLUG: Readonly<Record<string, string>> = {
  Amp: 'amp',
  Cab: 'cab',
  Drive: 'drive',
  Reverb: 'reverb',
  Delay: 'delay',
  Chorus: 'chorus',
  Flanger: 'flanger',
  Phaser: 'phaser',
  Wah: 'wah',
  Comp: 'compressor',
  MultiComp: 'compressor',
  Filter: 'filter',
  Pitch: 'pitch',
  Enhancer: 'enhancer',
  'Vol/Pan': 'volpan',
  Tremolo: 'tremolo',
  Rotary: 'rotary',
  Gate: 'gate',
  GEQ: 'geq',
  PEQ: 'peq',
};

/** Routing / utility / mixer nodes that are not translatable signal blocks. */
const NON_BLOCK_FAMILIES = new Set([
  'Input', 'Output', 'Send', 'Return', 'Mixer', 'Multiplexer',
]);

function slugFor(family: string): string {
  return GEN3_FAMILY_TO_SLUG[family] ?? family.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface Gen3SourceSpecResult {
  spec: PresetSpec;
  /** Human-readable notes about what did/didn't carry (folded into warnings). */
  notes: string[];
}

/**
 * Convert a decoded gen-3 whole preset into a canonical-vocabulary PresetSpec
 * suitable as the `source_spec` for `translatePresetSpec`. Pure; no I/O.
 */
/** Parse a grid cell name like "Reverb 1" / "Vol/Pan 2" into family + instance. */
function familyAndInstance(cellName: string): { family: string; instance: number } {
  const m = /^(.*?)\s+(\d+)$/.exec(cellName);
  if (m) return { family: m[1], instance: Number(m[2]) };
  return { family: cellName, instance: 1 };
}

export function gen3WholePresetToSpec(view: Gen3WholePresetView): Gen3SourceSpecResult {
  const notes: string[] = [];
  const blocks = view.blocks ?? [];
  const grid = view.grid ?? [];

  // gen-3 IS a grid device, so the source spec must carry real {row,col} slot
  // refs (the translator's grid->grid pass passes positions through; grid->
  // linear pulls them in column order). The decoded grid gives positions +
  // effect ids; the block chain gives effect TYPES + per-scene state. Join them
  // by (block slug, instance): the grid cell "Reverb 1" pairs with the first
  // Reverb block in the chain.
  const blockBySlugInstance = new Map<string, Gen3BlockView>();
  const chainCounts: Record<string, number> = {};
  for (const b of blocks) {
    if (NON_BLOCK_FAMILIES.has(b.block)) continue;
    const slug = slugFor(b.block);
    chainCounts[slug] = (chainCounts[slug] ?? 0) + 1;
    blockBySlugInstance.set(`${slug}#${chainCounts[slug]}`, b);
  }

  const slots: PresetSlotSpec[] = [];
  // Per-slot block for the scene pass, paired with the slot id.
  const sceneSources: Array<{ id: string; block: Gen3BlockView }> = [];
  const gridCounts: Record<string, number> = {};
  const droppedFamilies: string[] = [];

  // Column-major grid order = signal-flow order (matches the translator's
  // "pull in column order" expectation for grid->linear).
  for (const cell of grid) {
    if (cell.is_shunt) continue;
    const { family } = familyAndInstance(cell.name);
    if (NON_BLOCK_FAMILIES.has(family)) continue;
    const slug = slugFor(family);
    gridCounts[slug] = (gridCounts[slug] ?? 0) + 1;
    const instance = gridCounts[slug];
    const id = instance === 1 ? slug : `${slug}_${instance}`;
    if (family !== 'eid' && !(family in GEN3_FAMILY_TO_SLUG) && !cell.name.startsWith('eid_')) {
      droppedFamilies.push(family);
    }

    const block = blockBySlugInstance.get(`${slug}#${instance}`);
    const params: Record<string, number | string> = {};
    const type = block?.type ?? block?.channels?.A?.type;
    if (typeof type === 'string') params.type = type;
    // Amp per-channel knobs (FM3/FM9 decode them; III is type-only): carry the
    // channel-A knobs flat so a translated amp lands with real gain-staging.
    if (slug === 'amp' && block?.channels?.A) {
      for (const [k, v] of Object.entries(block.channels.A)) {
        if (k === 'type' || k === 'type_id') continue;
        if (typeof v === 'number') params[k] = v;
      }
    }
    // Grid coords are 0-based in the decode; SlotRef grid coords are 1-based.
    slots.push({
      slot: { row: cell.row + 1, col: cell.col + 1 },
      block_type: slug,
      id,
      instance,
      params,
      bypassed: block?.scene_bypass?.[0],
    });
    if (block) sceneSources.push({ id, block });
  }

  // Scenes: per-block channel + bypass for each of the 8 gen-3 scenes, keyed by
  // the slot id. Only A-D channel letters carry (out-of-range codes are skipped).
  const sceneNames = view.scene_names ?? [];
  const scenes: SceneSpec[] = [];
  for (let s = 0; s < 8; s++) {
    const channels: Record<string, string | number> = {};
    const bypassed: Record<string, boolean> = {};
    for (const { id, block } of sceneSources) {
      const ch = block.scene_channels?.[s];
      if (ch !== undefined && /^[A-D]$/.test(ch)) channels[id] = ch;
      const byp = block.scene_bypass?.[s];
      if (byp !== undefined) bypassed[id] = byp;
    }
    scenes.push({ scene: s + 1, channels, bypassed, name: sceneNames[s] });
  }

  if (slots.length === 0) notes.push('no translatable blocks were decoded from the gen-3 preset.');
  if (droppedFamilies.length > 0) {
    notes.push(
      `gen-3 blocks without a 1:1 cross-device slug pass through by name and ` +
        `will be dropped if the target lacks them: ${[...new Set(droppedFamilies)].join(', ')}.`,
    );
  }
  notes.push(
    'gen-3 source: non-amp knob VALUES are not decoded, so blocks translate as ' +
      'type-only (the target keeps its defaults for those knobs); routing edges ' +
      'are not carried.',
  );

  return { spec: { name: view.preset_name, slots, scenes }, notes };
}
