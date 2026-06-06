/**
 * Modern Fractal family descriptor factory.
 *
 * The Axe-Fx III, FM3, and FM9 share ONE gen-3 SysEx wire codec; they
 * differ only in (a) the model byte (III 0x10, FM3 0x11, FM9 0x12),
 * (b) the front-panel shape (grid dimensions, scene count, channel
 * names, preset count), and (c) the LLM-facing surface (example_spec,
 * agent_guidance, canonical terms). `createModernFractalDescriptor`
 * takes all of that as a config and returns a unified-surface
 * `DeviceDescriptor`.
 *
 * SCOPE / DISCIPLINE. The wire codec (model byte + checksum + function
 * family) is validated as shared across the family — the III's own codec
 * is byte-verified against 10 public captures, and FM3/FM9 reuse it with
 * their model byte (see memory `project_fm3_fm9_capture_evidence` and
 * `docs/_private/PLAN-device-family-expansion.md`). The PARAMETER SET/GET
 * path (fn=0x01) is reused from the III but is NOT hardware-verified on
 * any device yet; every config that wires it ships with
 * `support_tier: 'community-beta'` and a per-response safety marker. We
 * emit ONLY wire shapes verified against Fractal's published spec or the
 * III's captured layout — never guessed bytes
 * (preference_axefx3_no_untested_wire_paths).
 *
 * The catalog factory lives in `./catalog.ts`: block roster + effect IDs
 * are the III's (shared across the gen-3 family), but the param table is
 * per-device (each config passes its own `params_by_family`; FM3/FM9 ship
 * device-true tables mined from their own editor binaries). The reader /
 * writer / dirty-gate live in `./reader.ts` / `./writer.ts` / `./guard.ts`.
 * Per-device configs live in `./configs/<device>.ts`.
 */
import type {
  DeviceDescriptor,
  PresetSpec,
  CanonicalTermMap,
  SupportTier,
} from '@mcp-midi-control/core/protocol-generic/types.js';
import { listConceptKeysForDevice } from '@mcp-midi-control/core/protocol-generic/concept-keys.js';
import {
  createModernFractalCodec,
  AXE_FX_III_BLOCKS,
  resolveEffectId,
} from 'fractal-midi/axe-fx-iii';
import { createModernCatalog, type AxeFxIIIParam } from './catalog.js';
import { makeReader } from './reader.js';
import { makeWriter } from './writer.js';

/** Wire response window — same budget the III device-namespaced tools use. */
const GET_RESPONSE_TIMEOUT_MS = 800;

/**
 * Per-device config passed to `createModernFractalDescriptor`. One of
 * these lives in `src/configs/<device>.ts` per device.
 */
export interface FractalModernConfig {
  /** Stable device id + connection-registry key (e.g. 'axe-fx-iii', 'fm3'). */
  id: string;
  display_name: string;
  /** SysEx model byte: III 0x10, FM3 0x11, FM9 0x12, VP4 0x14. */
  model_byte: number;
  /** Connection-registry + buffer-dirty label. Defaults to `id` when omitted. */
  connection_label?: string;
  port_match: readonly { pattern: RegExp | string }[];
  /**
   * Grid dimensions (rows × cols) for grid-shaped devices. III/FM9 = 6×14;
   * FM3 = 4×12. OMITTED for serial AM4-shape devices (VP4): those place
   * blocks in a fixed N-slot chain, not a freeform grid, so they set
   * `slot_count` instead and report `slot_model: 'linear'`.
   */
  grid?: { rows: number; cols: number };
  /**
   * Serial slot count for AM4-shape devices (VP4 = 4). Mutually exclusive
   * with `grid`: a config sets one or the other. When set, the descriptor
   * advertises `slot_model: 'linear'` + `slot_count`.
   */
  slot_count?: number;
  scene_count: number;
  channel_names: readonly string[];
  /** Number of addressable preset slots (III/FM3/FM9 use integer 0..count-1). */
  preset_count: number;
  preset_location_format: RegExp;
  support_tier: SupportTier;
  /** One-line note on what is hardware-confirmed vs spec-only. */
  verification?: string;
  /**
   * Device's OWN per-family param table. The III passes its catalog (the
   * byte-identity anchor); FM3/FM9 pass their device-true tables mined
   * from each editor's own binary. paramIds are firmware-specific, so the
   * III's must NEVER be reused for FM3/FM9 wire writes — see catalog.ts.
   */
  params_by_family: Readonly<Record<string, readonly AxeFxIIIParam[]>>;
  /**
   * When true, drop blocks the device lacks (mapped family with zero
   * params) from the describe_device surface. III: false (unchanged
   * surface). FM3/FM9: true (device-true roster).
   */
  device_true_roster?: boolean;
  /**
   * Block slugs to drop from this device's surface even when their mapped
   * family carries params in the catalog. The mined catalog is shared across
   * the gen-3 editor family, so a device-true table can list params for a
   * block the physical device does NOT expose (VP4 has no amp/cab, yet its
   * mined catalog carries DISTORT/CABINET params from the shared editor
   * binary). `device_true_roster` only drops EMPTY mapped families, so blocks
   * with non-empty-but-absent rosters need an explicit exclude. Slugs are
   * lower-case (e.g. 'amp', 'cab').
   */
  exclude_blocks?: readonly string[];
  /**
   * When true, every device-state WRITE (set_param / set_block / set_bypass /
   * apply_preset / save_preset / rename / switch_preset / switch_scene)
   * refuses with a clear "untested on hardware" message; reads stay live.
   * Used for a config whose param/block write path is inferred but not yet
   * hardware-confirmed and whose block-placement wire shape is undecoded
   * (VP4: only the fn=0x12 mode switch is wire-verified). Omit (defaults
   * false) for devices whose write path is at least spec/capture-grounded.
   */
  writes_gated?: boolean;
  /**
   * MIDI Bank-Select encoding for switch_preset's PC+bank message. Default
   * 'standard' (Axe-Fx III / FM3 per the v1.4 spec: bank = CC0<<7 | CC32).
   * Set 'msb' for the FM9, which reads the bank from CC0/MSB and ignores CC32
   * (hardware-confirmed 2026-06-06) — without it, any FM9 preset above 127
   * lands in bank 0. See buildSwitchPresetPC.
   */
  bank_select?: import('fractal-midi/axe-fx-iii').Gen3BankSelectMode;
  /**
   * Per-device enum override tables (param firmware symbol -> ordinal -> name),
   * captured + verified from THIS model's hardware. Used where the amp/effect
   * roster is device-specific so the family-shared overlay leaves it numeric
   * (e.g. FM9 amp models). Partial tables are fine. Read-leg only (broadcast
   * ordinals, not typed-SET raw ids). Omit for devices with none.
   */
  enum_overrides?: Readonly<Record<string, Readonly<Record<number, string>>>>;
  canonical_terms: CanonicalTermMap;
  agent_guidance: Readonly<Record<string, string>>;
  example_spec: PresetSpec;
  block_params_summary: Readonly<Record<string, readonly string[]>>;
}

export function createModernFractalDescriptor(config: FractalModernConfig): DeviceDescriptor {
  const codec = createModernFractalCodec(config.model_byte, { bankSelect: config.bank_select });
  const deviceLabel = config.display_name;
  const connectionLabel = config.connection_label ?? config.id;

  // Per-device catalog. Block roster + effect IDs are the III's (shared
  // across the gen-3 family); the param table is THIS device's own.
  const catalog = createModernCatalog({
    blocks: AXE_FX_III_BLOCKS,
    paramsByFamily: config.params_by_family,
    resolveEffectId,
    dropEmptyMappedBlocks: config.device_true_roster ?? false,
    deviceEnumOverrides: config.enum_overrides,
    excludeBlocks: config.exclude_blocks,
  });

  // Grid devices (III/FM3/FM9) advertise a 2-D grid + multi-instance blocks;
  // serial AM4-shape devices (VP4) advertise a linear N-slot chain and are
  // single-instance. A config sets exactly one of `grid` / `slot_count`.
  const isGrid = config.grid !== undefined;

  /**
   * Per-response safety marker on a community-beta device. The machine-
   * readable signal is `capabilities.support_tier`; this is the brief
   * human marker telling the agent to confirm by ear / by panel.
   */
  const betaWarning = [
    `${config.id} ${config.support_tier}. The parameter SET/GET path reuses the`,
    `modern Fractal (Axe-Fx III) wire codec with this device's model byte`,
    `(0x${config.model_byte.toString(16).padStart(2, '0')}); it is not hardware-verified on`,
    `${deviceLabel}. Please confirm the audible/visible response on the device.`,
  ].join(' ');

  // Per-device concept-key map (built from the central registry).
  const conceptKeys: Record<string, string> = {};
  for (const entry of listConceptKeysForDevice(config.id)) {
    conceptKeys[entry.conceptKey] = entry.localName;
  }

  return {
    id: config.id,
    display_name: config.display_name,
    preset_class: 'layout',
    connection_label: connectionLabel,
    port_match: config.port_match,
    capabilities: {
      slot_model: isGrid ? 'grid' : 'linear',
      ...(isGrid ? { grid: { rows: config.grid!.rows, cols: config.grid!.cols } } : {}),
      ...(config.slot_count !== undefined ? { slot_count: config.slot_count } : {}),
      has_scenes: true,
      scene_count: config.scene_count,
      has_channels: true,
      channel_names: config.channel_names,
      // gen-3 grid exposes up to 4 of each block type (Amp 1..4, Reverb 1..4,
      // Delay 1..2); the `instance` arg addresses them via resolveEffectId.
      // Serial AM4-shape devices (VP4) are single-instance, like the AM4.
      has_block_instances: isGrid,
      preset_location_format: config.preset_location_format,
      supports_save: false, // STORE envelope not in the published spec
      supports_lineage: false,
      atomic_read: false,
      support_tier: config.support_tier,
      verification: config.verification,
    },
    canonical_terms: config.canonical_terms,
    blocks: catalog.blocks,
    reader: makeReader({
      codec, catalog, deviceLabel,
      getResponseTimeoutMs: GET_RESPONSE_TIMEOUT_MS,
      channelNames: config.channel_names,
    }),
    writer: makeWriter({
      codec,
      catalog,
      shape: {
        id: config.id,
        grid: config.grid,
        slot_count: config.slot_count,
        scene_count: config.scene_count,
        channel_names: config.channel_names,
        preset_count: config.preset_count,
        supportsSave: false, // STORE not in the published spec for III/FM3/FM9
        writesGated: config.writes_gated ?? false,
      },
      deviceLabel,
      connectionLabel,
      betaWarning,
      getResponseTimeoutMs: GET_RESPONSE_TIMEOUT_MS,
    }),
    agent_guidance: config.agent_guidance,
    example_spec: config.example_spec,
    block_params_summary: config.block_params_summary,
    concept_keys: Object.keys(conceptKeys).length > 0 ? Object.freeze(conceptKeys) : undefined,
  };
}
