/**
 * Preset tools: full-preset apply, get, translate, and factory restore.
 *
 * Tools registered here:
 *   - `get_preset(port)`
 *   - `apply_preset(port, spec, target_location?)`
 *   - `translate_preset(source_port, source_spec, target_port)`
 *   - `restore_defaults` — commented out (requires factory bank file not bundled in release)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeApplyPreset,
  executeGetPreset,
  executePortPreset,
} from '../dispatcher.js';
import type { PresetSpec } from '../types.js';
import {
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
  SAVE_AUTHORIZED_SCHEMA,
  buildSaveAuthorizedDescription,
} from '../../server-shared/safeEdit.js';

import { PORT_DESC, asError, asText, buildPresetShape, buildPresetSlotShape } from './shared.js';

export function registerPresetTools(server: McpServer): void {
  const presetShape = buildPresetShape();

  // ── outputSchema reuse (2026-05-22 MCP migration) ────────────────
  //
  // Shared sub-schemas for tool output. We declare them once at
  // registration time so the wire envelope stays consistent across
  // apply_preset / get_preset.
  //
  // Per the 2025-11-25 spec these schemas are advisory: the model uses
  // them to plan invocations; clients SHOULD (not MUST) validate at
  // runtime. The runtime `asText` helper still emits the JSON in a
  // text content block as the spec's backwards-compat path, so
  // structuredContent + outputSchema is additive; older clients
  // continue to work against the text payload unchanged.

  const validationErrorShape = z.object({
    slot_index: z.number().int().optional(),
    scene_index: z.number().int().optional(),
    routing_index: z.number().int().optional(),
    path: z.string(),
    error: z.string(),
    suggestion: z.string().optional(),
    suggestions: z.array(z.string()).optional(),
    suggested_substitution: z.string().optional(),
    valid_options: z.array(z.string()).optional(),
  });

  const validationInfoShape = z.object({
    slot_index: z.number().int().optional(),
    scene_index: z.number().int().optional(),
    path: z.string(),
    info: z.string(),
    alias_used: z.string().optional(),
    original_value: z.string().optional(),
    canonical: z.string().optional(),
    level: z.enum(['info', 'warning']).optional(),
    dropped_param: z.string().optional(),
    reason: z.string().optional(),
    retry_action: z.string().optional(),
  });

  const failedStepShape = z.object({
    index: z.number().int(),
    description: z.string(),
    error: z.string(),
  });

  const chainIntegrityShape = z.object({
    ok: z.boolean(),
    breaks: z.array(z.object({
      slot_ref: z.unknown(),
      reason: z.string(),
    })),
    notes: z.array(z.object({
      slot_ref: z.unknown(),
      note: z.string(),
    })).optional(),
    summary: z.string(),
    extra_round_trips: z.number().int(),
  });

  const nackedStepShape = z.object({
    index: z.number().int(),
    description: z.string(),
    error: z.string(),
    kind: z.string(),
  });

  const applyPresetOutputShape = {
    ok: z.boolean(),
    steps: z.number().int(),
    duration_ms: z.number(),
    failed_step: failedStepShape.optional(),
    nacked_steps: z.array(nackedStepShape).optional(),
    warning: z.string().optional(),
    saved: z.boolean().optional(),
    validation_errors: z.array(validationErrorShape).optional(),
    validation_info: z.array(validationInfoShape).optional(),
    chain_integrity: chainIntegrityShape.optional(),
    applied_spec: z.unknown().optional(),
    recipe_id: z.string().optional(),
    device: z.string(),
  };
  server.registerTool('get_preset', {
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Snapshot the active working buffer in one tool call. Returns every placed block with its current params under a PresetSpec-shaped envelope. Use for state-anchoring before a tone edit: read, summarize, propose changes, then targeted set_param / set_params.',
      'By default returns active-channel params only. For the full per-channel nested shape (params_by_channel; II: X/Y, AM4: A/B/C/D when populated) pass include_channel_state: true. Use instance on set_param/set_params to target a specific block instance (e.g. Amp 2).',
      'Scope: active scene only; no scenes 2..N, no routing.',
      'Performance: ~2 s on II for an 11-block preset by default; include_channel_state: true adds a per-param read per channel-bearing block (markedly slower). AM4: active-channel only by default (~0.3 s); include_channel_state: true walks B/C/D (several seconds on amp-heavy presets). III / Hydra: capability_not_supported (use get_param / get_params); describe_device.capabilities.atomic_read gates support.',
      'DO NOT feed the whole snapshot back into apply_preset (FRESH-BUILD-CLEARS unlisted slots + scenes). Use set_param / set_params for changed knobs. Re-call get_preset to verify; catches type-gated silent no-ops.',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      include_channel_state: z
        .boolean()
        .optional()
        .describe(
          'II: default false returns active-channel state only (fast, ~2 s). Pass true for the full per-channel X/Y nested shape (adds a per-param read per channel-bearing block; markedly slower). AM4: default false returns active-channel only (~0.3 s); pass true to read all channels (B/C/D), a per-param read per channel that can take several seconds.',
        ),
    },
  }, async ({ port, include_channel_state }) => {
    try {
      const result = await executeGetPreset({ port, include_channel_state });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  // Overrides shape is a partial PresetSpec: same per-slot shape (so the
  // block-type union + typed params.type enums apply), but `slots` is
  // optional and may be empty (recipe carries the base; overrides may
  // tweak knobs or append slots). Reuses the same factory so future
  // schema evolution stays in sync.
  const overridesSlotShape = buildPresetSlotShape();
  const overridesShape = z.object({
    slots: z.array(overridesSlotShape).optional(),
    scenes: presetShape.shape.scenes,
    name: presetShape.shape.name,
    landingScene: presetShape.shape.landingScene,
    routing: presetShape.shape.routing,
  });

  server.registerTool('apply_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: [
      'Build or replace the entire working-buffer preset in one call. For single-knob tweaks use set_param; for one block placement on linear devices use set_block.',
      'RECIPES FIRST: scan describe_device(port).recipes[] for a matching block_stack entry and apply via `recipe_id` (+ `overrides`). Pasting recipe slots manually is the dominant failure mode. Three modes: `spec` (full author), `recipe_id` (verbatim), `recipe_id` + `overrides` (deep-merged).',
      'PITFALLS: unlisted slots clear, unlisted scenes reset (FRESH-BUILD). Linear devices take integer slot 1..4; grid devices take {row, col}. Multi-instance blocks use canonical id (`amp`, `amp_2`), not display names. Grid routing[] must end with `{to:"OUTPUT"}`. Type-gated knobs silently drop; call find_compatible_types first when the user names specific knobs.',
      'RESPONSE: ok:true = succeeded, DO NOT retry. validation_info[] level:"info" entries are auto-resolved success notes (alias, case fix); level:"warning" entries need action (channel-Y inactive, dropped params). On ok:false with validation_errors[], zero wire writes fired; fix and re-invoke. (1-3 s; +250 ms with save.)',
    ].join(' '),
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      spec: presetShape.optional().describe(
        'Preset specification (slots, optional scenes, optional name). Required when `recipe_id` is NOT set; rejected when `recipe_id` IS set (use `overrides` to merge tweaks on top of a recipe instead).',
      ),
      recipe_id: z.string().optional().describe(
        'Apply a pre-authored block-stack recipe by id. The recipe\'s `slots_per_device[port]` becomes the base spec; merge knob tweaks via `overrides`. Discover available ids via `describe_device(port).recipes[].id`. Single-block recipes (auto_wah, pitch, wah, filter, scene_leveling) ship inline in describe_device and apply via set_block / set_param, not via this arg.',
      ),
      overrides: overridesShape.optional().describe(
        'Knob / slot / scene / name overrides merged on top of `recipe_id`. Per-slot deep merge keyed by `slot` ref (linear int OR {row,col}): overrides win on conflicting keys, recipe keys not in overrides survive. Override slot whose ref matches no recipe slot is appended. Scenes / name / landingScene / routing in overrides REPLACE the recipe\'s values entirely (recipes today don\'t author scenes). Ignored when `recipe_id` is not set.',
      ),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional navigation target. With save_authorized=false (default): navigate + apply (audition, no save). With save_authorized=true: navigate + apply + save (destructive). Omit to apply at the current working-buffer location.',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set true ONLY for explicit save vocab: "save", "store", "keep", "put on", "persist". AUDITION language (NOT save): "build a preset at X", "make me a tone on X", "design a preset at X", "make X look/sound like Y". State descriptions ("I want X to be Z") are audition unless save vocab is added. When ambiguous, audition (false) and ASK before saving; saves are destructive, auditions are reversible by switching presets.',
      ),
      on_active_preset_edited: ON_EDITED_SCHEMA.describe(ON_EDITED_DESCRIPTION),
      verify_chain: z.boolean().optional().describe(
        'When true, run a read-after-write chain integrity check after the apply ops ack. On grid devices (Axe-Fx II / III) the check reads the working-buffer grid and surfaces any cell past col 1 with `routing_mask == 0` (broken cable, signal won\'t flow). On linear devices (AM4) and synths (Hydrasynth) the check returns a trivial pass since they have no chain-routing semantics. Use when you need certainty the preset will produce sound before the user plugs in. On a returned chain_break, surface the broken cells to the user (with their row/col) BEFORE claiming the preset is ready to play. Adds ~50-100 ms per call on grid devices.',
      ),
    },
    outputSchema: applyPresetOutputShape,
  }, async ({ port, spec, recipe_id, overrides, target_location, save_authorized, on_active_preset_edited, verify_chain }) => {
    try {
      const result = await executeApplyPreset({
        port,
        spec: spec as unknown as PresetSpec | undefined,
        recipe_id,
        overrides: overrides as unknown as Partial<PresetSpec> | undefined,
        target_location,
        save_authorized,
        on_active_preset_edited,
        verify_chain,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('translate_preset', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: [
      'Translate a preset spec from one layout-class device (AM4 / Axe-Fx II / III) to another.',
      'Pure read/transform: returns the translated spec + warnings; does NOT apply, audition, or save.',
      'Pick up the returned `applied_spec` and call apply_preset(target_port, spec) to write it.',
      'Covers: chain topology (linear slots to grid), block availability (II/III cab vs AM4 integrated),',
      'param-name aliases (drive.volume / drive.level), enum mappings (USA IIC+ / USA MK IIC+),',
      'channel-cardinality collapse (AM4 A/B/C/D to II X/Y), scene cardinality (AM4 4 / II+III 8).',
      'Read warnings[] before calling apply_preset; override scenes/slots if the loss matters.',
      'Returns {ok, port_summary, applied_spec, warnings}. Performance: ~5 ms.',
    ].join(' '),
    inputSchema: {
      source_port: z.string().describe(`Source device port (the preset's home device). ${PORT_DESC}`),
      source_spec: presetShape.describe(
        'Source preset specification (slots, optional scenes, optional name) in the SOURCE device\'s vocabulary.'
        + ' Param names + enum strings should match what the source device accepts;'
        + ' the translator handles the cross-device rewrite.',
      ),
      target_port: z.string().describe(
        `Target device port (where the translated preset will land if the caller later applies it).`
        + ` Must differ from source_port. ${PORT_DESC}`,
      ),
    },
  }, async ({ source_port, source_spec, target_port }) => {
    try {
      const result = await executePortPreset({
        source_port,
        source_spec: source_spec as unknown as PresetSpec,
        target_port,
        dry_run: true,
      });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  // Removed from surface: requires factory bank file not bundled in release. See backlog.
  // Executor code (executeRestoreDefaults) is preserved in dispatcher/preset.ts for dev use.
  //
  // server.registerTool('restore_defaults', {
  //   annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  //   description: [
  //     'DESTRUCTIVE: reset preset locations to factory state. Overwrites user content with no working-buffer recovery. Always run scan_locations first and get explicit user approval before clobbering non-empty slots.',
  //     'Two shapes: pass only `from` for one location; pass `from` + `to` for an inclusive range (max 26 per call).',
  //     '- Working buffer + active location pointer untouched; the user can keep playing while the restore runs.',
  //     '- Range options: on_error stop/continue, dry_run, verify (default true; empty post-restore name is a hard fail).',
  //     '- Performance: ~350 ms per location. 20 slots = ~5-7 s.',
  //     '- See describe_device.capabilities.supports_factory_restore.',
  //   ].join(' '),
  //   inputSchema: {
  //     port: z.string().describe(PORT_DESC),
  //     from: z.union([z.string(), z.number()]).describe(
  //       'Single target, or inclusive start of a range (e.g. "G01" or 24).',
  //     ),
  //     to: z.union([z.string(), z.number()]).optional().describe(
  //       'Inclusive end of a range. Omit for single-location restore.',
  //     ),
  //     on_error: z.enum(['stop', 'continue']).optional().describe(
  //       'Range only. "stop" (default) halts on first error; "continue" logs and proceeds.',
  //     ),
  //     dry_run: z.boolean().optional().describe(
  //       'Range only. Validate without sending any wire bytes.',
  //     ),
  //     verify: z.boolean().optional().describe(
  //       'Read name pre/post and compare. Default true.',
  //     ),
  //   },
  // }, async ({ port, from, to, on_error, dry_run, verify }) => {
  //   try {
  //     const result = await executeRestoreDefaults({ port, from, to, on_error, dry_run, verify });
  //     return asText(result);
  //   } catch (err) {
  //     return asError(err);
  //   }
  // });
}
