/**
 * Preset tools: full-preset apply, get, translate, and factory restore.
 *
 * Tools registered here:
 *   - `get_preset(port)`
 *   - `apply_preset(port, spec, target_location?)`
 *   - `translate_preset(source_port, source_spec, target_port)`
 *   - `restore_defaults` — commented out (requires factory bank file not bundled in release)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import {
  executeApplyPreset,
  executeExportActivePreset,
  executeExportStoredPreset,
  executeGetPreset,
  executePortPreset,
  executeRestorePreset,
} from '../dispatcher.js';
import type { PresetSpec } from '../types.js';
import {
  ON_EDITED_DESCRIPTION,
  ON_EDITED_SCHEMA,
  SAVE_AUTHORIZED_SCHEMA,
  buildSaveAuthorizedDescription,
} from '../../server-shared/safeEdit.js';

import { PORT_DESC, asError, asText, buildPresetShape, buildPresetSlotShape } from './shared.js';

/** Collapse anything filesystem-unfriendly to underscores; bound the length. */
function sanitizeForFilename(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned.length > 0 ? cleaned : 'preset';
}

/** Filesystem-safe local timestamp, e.g. `2026-06-03_12-53-18`. */
function backupTimestamp(): string {
  return new Date()
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace('T', '_')
    .replace(/:/g, '-');
}

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
    description: 'Snapshot the active working buffer: every placed block with current params in a PresetSpec-shaped envelope. Use for state-anchoring before a tone edit (read, summarize, propose, then targeted set_param / set_params). Default: active-channel params only. Pass include_channel_state: true for the per-channel nested shape (params_by_channel; II X/Y, AM4 A/B/C/D). Use instance on set_param/set_params to target a specific block (e.g. Amp 2). Scope: active scene only; no scenes 2..N, no routing. Performance: II ~2 s default (include_channel_state markedly slower, a read per channel-bearing block); AM4 ~0.3 s default (include_channel_state walks B/C/D, several seconds). III / Hydra return capability_not_supported (use get_param / get_params); describe_device.capabilities.atomic_read gates support. DO NOT feed the snapshot back into apply_preset (FRESH-BUILD clears unlisted slots + scenes); use set_param / set_params for changed knobs. Re-call to verify; catches type-gated silent no-ops.',
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

  server.registerTool('export_preset', {
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: "Back up a preset to a byte-exact `.syx` file on disk. Two modes: (1) omit `location` to dump the ACTIVE working-buffer preset (available on AM4 and Axe-Fx II; other devices return capability_not_supported); (2) pass `location` as an integer preset number to dump that STORED preset slot directly from device flash (gen-3 devices only: Axe-Fx III / FM3 / FM9, wire-confirmed on FM9). The .syx file is Fractal-compatible and can be synced (point `directory` at OneDrive), reloaded in the manufacturer's editor, or restored via import_preset. One preset per call. Writes to `directory` when given, else a `mcp-midi-backups` folder under the user's home directory; the file is named `<device>-<preset>-<timestamp>.syx`. Returns the absolute file_path, byte_length, and frame_count. Does NOT write to the hardware.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      location: z.union([z.string(), z.number()]).optional().describe(
        'Optional stored preset location to export (integer preset number, 0-based). When given, exports that stored preset slot directly from device flash; when omitted, exports the active working-buffer preset. Only supported on gen-3 devices (Axe-Fx III / FM3 / FM9).',
      ),
      directory: z.string().optional().describe(
        'Destination folder for the .syx file. Optional. Defaults to a `mcp-midi-backups` folder under the user\'s home directory. Point this at a cloud-synced folder (e.g. a OneDrive path) so backups reach the user\'s other devices. Created if it does not exist.',
      ),
    },
  }, async ({ port, location, directory }) => {
    try {
      let dump: Awaited<ReturnType<typeof executeExportActivePreset>>;
      if (location !== undefined) {
        const locNum = typeof location === 'number' ? location : parseInt(String(location), 10);
        if (!Number.isInteger(locNum) || locNum < 0) {
          return asError(new Error(`export_preset: location must be a non-negative integer, got ${JSON.stringify(location)}`));
        }
        dump = await executeExportStoredPreset({ port, location: locNum });
      } else {
        dump = await executeExportActivePreset({ port });
      }
      const baseDir = directory !== undefined && directory.trim().length > 0
        ? directory.trim()
        : path.join(homedir(), 'mcp-midi-backups');
      await mkdir(baseDir, { recursive: true });
      const fileName = `${sanitizeForFilename(dump.device)}-${sanitizeForFilename(dump.name ?? 'preset')}-${backupTimestamp()}.syx`;
      const filePath = path.join(baseDir, fileName);
      await writeFile(filePath, Buffer.from(dump.bytes));
      return asText({
        ok: true,
        file_path: filePath,
        directory: baseDir,
        file_name: fileName,
        device: dump.device,
        name: dump.name,
        source: dump.source,
        byte_length: dump.byte_length,
        frame_count: dump.frame_count,
        format: dump.format,
      });
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
    description: 'Build or replace the entire working-buffer preset in one call. Single-knob tweak: use set_param. One block on a linear device: use set_block. Re-apply a byte-exact backup: use import_preset. RECIPES FIRST: scan describe_device(port).recipes[] for a block_stack match and apply via `recipe_id` (+ `overrides`); pasting recipe slots by hand is the dominant failure mode. Modes: `spec` (full author), `recipe_id` (verbatim), `recipe_id`+`overrides` (deep-merged). PITFALLS: FRESH-BUILD, unlisted slots clear and unlisted scenes reset. Slot is integer 1..4 (linear) or {row,col} (grid). Multi-instance blocks use canonical id (`amp`, `amp_2`), not display names. Grid routing[] must end with `{to:"OUTPUT"}`. Type-gated knobs silently drop; when the user names specific knobs, call find_compatible_types first. RESPONSE: ok:true succeeded, do NOT retry. validation_info[] level:"info" = auto-resolved (alias, case fix); level:"warning" needs action (channel-Y inactive, dropped params). ok:false with validation_errors[] = zero writes fired, fix and re-invoke. (1-3 s, +250 ms with save.)',
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

  server.registerTool('import_preset', {
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    description: "Re-apply a byte-exact preset backup (a `.syx` written by export_preset) to the device. The inverse of export_preset. SAME-DEVICE-MODEL only: the bytes are that device's native dump, so an Axe-Fx II backup restores to an Axe-Fx II, an AM4 backup to an AM4 (to move a tone across devices, use apply_preset + translate_preset instead). Default pushes to the WORKING BUFFER (reversible by switching presets); with target_location + save_authorized it persists to that stored location. Validates every frame's checksum before sending. Available on Fractal AM4 + Axe-Fx II; other devices return capability_not_supported. Returns { ok, frames_sent, acks_received, nacks[], name?, saved_to_location? }.",
    inputSchema: {
      port: z.string().describe(PORT_DESC),
      file_path: z.string().describe(
        'Absolute path to the `.syx` backup to re-apply (the `file_path` export_preset returned). Must be a dump from THIS device model.',
      ),
      target_location: z.union([z.string(), z.number()]).optional().describe(
        'Optional stored location to persist the restored preset to (requires save_authorized). Omit to restore to the working buffer only (reversible). AM4: restore-to-location is not yet supported (working buffer only).',
      ),
      save_authorized: SAVE_AUTHORIZED_SCHEMA.describe(
        'Set true ONLY with explicit save vocab ("save", "store", "keep", "put on"). With target_location, persists the restored bytes to that location (destructive overwrite). Default false = working-buffer restore (reversible).',
      ),
    },
  }, async ({ port, file_path, target_location, save_authorized }) => {
    try {
      const bytes = new Uint8Array(await readFile(file_path.trim()));
      const result = await executeRestorePreset({ port, bytes, target_location, save_authorized });
      return asText(result);
    } catch (err) {
      return asError(err);
    }
  });

  server.registerTool('translate_preset', {
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: 'Translate a preset spec between layout-class devices (AM4 / Axe-Fx II / III). Pure transform: returns the translated spec + warnings; does NOT apply, audition, or save. To write it, take the returned applied_spec and call apply_preset(target_port, spec). Bridges chain topology (linear slots to grid), block availability (II/III cab vs AM4 integrated), param aliases, enum mappings, channel collapse (A/B/C/D to X/Y), and scene count (4 vs 8). Read warnings[] first; cross-device gaps are lossy, override scenes/slots if the loss matters. Returns {ok, port_summary, applied_spec, warnings}. ~5 ms.',
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
