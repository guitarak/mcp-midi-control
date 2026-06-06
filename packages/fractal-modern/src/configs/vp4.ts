/**
 * VP4 config for `createModernFractalDescriptor`.
 *
 * The VP4 (model byte 0x14) is a gen-3 effects pedal: it reuses the gen-3
 * SysEx envelope + the III's effects codec and block effect IDs, but it is
 * AM4-SHAPE on the front panel — a serial 4-slot chain with 4 scenes,
 * A-D channels, and A01..Z04 preset locations (NOT the gen-3 6x14 grid /
 * 8 scenes). It has no amp/cab section.
 *
 * VERIFICATION / GATING. Only the fn=0x12 mode switch is wire-confirmed on
 * VP4 hardware. The fn=0x01 param read/write path is INFERRED from the AM4
 * analogy and the shared gen-3 codec, and the serial block-placement wire
 * shape is undecoded. So this config ships READS (the fn=0x1F block poll,
 * effect-id addressed, grid-agnostic) but GATES every device-state write
 * (`writes_gated: true`): set_param / set_block / apply_preset / save_preset /
 * rename / set_bypass / switch_preset / switch_scene refuse with a clear
 * "untested on hardware" message until a VP4 capture lands. community-beta.
 *
 * CATALOG. paramIds are VP4-true (mined from VP4-Edit's own binary; reusing
 * the III's mis-addresses 99.1% of shared params — see
 * `docs/_private/MINING-FINDINGS-FM-VP4.md`). The mined catalog is shared
 * across the gen-3 editor family, so it carries DISTORT (amp) + CABINET
 * params even though the physical VP4 has no amp/cab; `exclude_blocks`
 * drops those two blocks from the surface (device_true_roster alone won't —
 * it only drops EMPTY mapped families, and these are non-empty in the mine).
 */
import { VP4_PARAMS_BY_FAMILY } from 'fractal-midi/vp4';
import type { FractalModernConfig } from '../factory.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import {
  MODERN_AGENT_GUIDANCE,
  MODERN_BLOCK_PARAMS_SUMMARY,
} from './shared.js';

// VP4 is a serial 4-slot chain (AM4-shape), so the example places blocks by
// 1-based slot index, not grid cell. Writes are gated, so this spec is
// illustrative (it shapes the describe_device example), never sent.
const VP4_EXAMPLE_SPEC: PresetSpec = {
  name: 'Demo',
  slots: [
    {
      // The user-facing Drive / OD pedal (ID_FUZZ family): drive/tone/level.
      slot: 1,
      block_type: 'drive',
      params_by_channel: {
        A: { type: 3, drive: 5, tone: 5, level: 5 },
      },
    },
    {
      slot: 2,
      block_type: 'reverb',
      params_by_channel: {
        A: { type: 3, time: 5, mix: 25 },
      },
    },
    {
      slot: 3,
      block_type: 'delay',
      params_by_channel: {
        A: { time: 5, mix: 25 },
      },
    },
    { slot: 4, block_type: 'chorus' },
  ],
  scenes: [
    { scene: 1, name: 'Rhythm', channels: { reverb: 'A', delay: 'A' }, bypassed: { drive: true } },
    { scene: 2, name: 'Lead', channels: { reverb: 'A', delay: 'A' }, bypassed: { drive: false } },
  ],
  landingScene: 1,
};

export const VP4_CONFIG: FractalModernConfig = {
  id: 'vp4',
  display_name: 'Fractal VP4',
  model_byte: 0x14,
  connection_label: 'vp4',
  port_match: [
    { pattern: /vp ?4/i }, // "VP4", "VP 4", "VP-4" (transport strips the dash via needles)
  ],
  // Serial AM4-shape: 4 effect slots, 4 scenes, A-D channels, A01..Z04
  // locations (26 banks x 4 = 104). NOT the gen-3 grid / 8-scene shape.
  slot_count: 4,
  scene_count: 4,
  channel_names: ['A', 'B', 'C', 'D'],
  preset_count: 104,
  preset_location_format: /^[A-Z]0?[1-4]$/,
  support_tier: 'community-beta',
  // Reads work; writes are gated until VP4 hardware confirms the param/block
  // write path and the serial placement wire shape is decoded.
  writes_gated: true,
  verification:
    'Model byte 0x14 is wire-confirmed (the fn=0x12 mode switch decoded on VP4 hardware). The ' +
    'gen-3 effects envelope/checksum/septet/dispatcher layer is shared with the III, so per-block ' +
    'fn=0x1F reads reuse it. The fn=0x01 param/block WRITE path is inferred from the AM4 analogy, ' +
    'NOT confirmed on VP4, and the serial block-placement wire shape is undecoded, so device-state ' +
    'writes are GATED (reads + mode switch only). Param catalog is VP4-true (mined from VP4-Edit\'s ' +
    'own tables; paramIds are device-specific, not reused from the III). No amp/cab.',
  params_by_family: VP4_PARAMS_BY_FAMILY,
  device_true_roster: true,
  // The mined catalog carries DISTORT (amp) + CABINET params from the shared
  // gen-3 editor binary, but the physical VP4 has neither block. Drop both.
  exclude_blocks: ['amp', 'cab'],
  canonical_terms: {
    block: 'block',
    slot: 'effect slot (1..4 in the serial chain)',
    preset: 'preset',
    scene: 'scene 1..4',
    channel: 'channel A/B/C/D',
    location: 'preset location A01..Z04',
  },
  agent_guidance: {
    ...MODERN_AGENT_GUIDANCE,
    // Override the shared beta_status: on VP4 every device-state write refuses
    // (writes_gated), so the family-default "writes attempt a wire send" is
    // wrong here. Keep it consistent with device_note below.
    beta_status: [
      'COMMUNITY BETA, READS ONLY. The VP4 param/block write path is',
      'inferred-not-confirmed and the serial block-placement wire shape is',
      'undecoded, so every device-state write refuses with an "untested on',
      'hardware" message (see device_note). Reads (get_param / get_preset)',
      'work. Do not present any write as applied; the refusal is by design',
      'until a hardware capture lands.',
    ].join('\n'),
    device_note: [
      'This is the Fractal VP4 (community beta). It reuses the Axe-Fx III',
      'gen-3 effects codec but is AM4-shape: a serial 4-slot chain with 4',
      'scenes, A-D channels, A01..Z04 preset locations, and NO amp/cab.',
      'The param catalog is VP4-true (mined from VP4-Edit\'s own binary).',
      '',
      'WRITES ARE GATED. Only the fn=0x12 mode switch is wire-confirmed on',
      'VP4 hardware; the param/block write path is inferred and the serial',
      'block-placement wire shape is undecoded. Reads (get_param /',
      'get_preset) work; every write (set_param, set_block, apply_preset,',
      'save_preset, rename, set_bypass, switch_preset, switch_scene) refuses',
      'with an "untested on hardware" message. Do not present a write as',
      'applied; tell the user VP4 writes are pending a hardware capture.',
    ].join('\n'),
  },
  example_spec: VP4_EXAMPLE_SPEC,
  block_params_summary: MODERN_BLOCK_PARAMS_SUMMARY,
};
