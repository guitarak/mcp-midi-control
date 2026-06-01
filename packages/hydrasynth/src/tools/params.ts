/**
 * Hydrasynth param tools, system CC + macro CC writes.
 *
 * `hydra_set_engine_param` / `hydra_set_engine_params` removed
 * 2026-05-18, the unified `set_param({port:'hydrasynth', block,
 * name, value})` / `set_params(...)` cover engine NRPN via the
 * descriptor writer.setParam path.
 *
 * Tools registered:
 *   - set_system_param  (was hydra_set_param) , system CCs (master vol, sustain, …)
 *   - set_macro         (was hydra_set_macro) , Macros 1-8 (CCs 16-23)
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';

import { HYDRASYNTH_PARAMS, HYDRASYNTH_PARAMS_BY_ID } from '../params.js';

import {
  DEFAULT_CHANNEL,
  ccBytes,
  ensureMidi,
} from './shared.js';
import { DispatchError } from '@mcp-midi-control/core/protocol-generic/types.js';
import { asError } from '@mcp-midi-control/core/protocol-generic/tools/shared.js';
import { ensureConnection } from '@mcp-midi-control/core/server-shared/connections.js';
import { resolveDevice } from '@mcp-midi-control/core/protocol-generic/registry.js';

export function registerHydrasynthParamTools(server: McpServer): void {

// set_system_param (renamed from hydra_set_param) -------------------------

server.registerTool('set_system_param', {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: [
    'Set a device-level system CC (master volume, sustain pedal, expression, mod wheel, all-notes-off). These bypass engine-param gating and are always active regardless of the device\'s Param TX/RX setting.',
    'For engine params (oscillators, filters, envelopes, mixer, FX) use set_param({port, block, name, value}) instead.',
    '- value: 0..127 (raw MIDI CC range). No wire-ack expected.',
  ].join('\n'),
  inputSchema: {
    id: z.string().describe(
      'System parameter id, one of: system.master_volume, system.modulation_wheel, system.sustain_pedal, system.expression_pedal, system.bank_select_msb, system.bank_select_lsb, system.all_notes_off.',
    ),
    value: z.number().int().min(0).max(127).describe(
      'Raw MIDI CC value 0..127.',
    ),
  },
  outputSchema: {
    id: z.string(),
    cc: z.number().int(),
    value: z.number().int(),
    module: z.string(),
    parameter: z.string(),
  },
}, async ({ id, value }) => {
  const param = HYDRASYNTH_PARAMS_BY_ID.get(id);
  if (!param) {
    const suggestions = HYDRASYNTH_PARAMS
      .filter((p) => p.category === 'system')
      .map((p) => p.id);
    return asError(new DispatchError(
      'unknown_param',
      'Hydrasynth',
      `Unknown parameter id "${id}". set_system_param only handles System CCs.`,
      {
        valid_options: suggestions,
        retry_action: 'Re-invoke with one of the valid_options ids. For ENGINE parameters use set_param({port:"hydrasynth", block, name, value}) instead.',
      },
    ));
  }
  if (param.category !== 'system') {
    return asError(new DispatchError(
      'capability_not_supported',
      'Hydrasynth',
      `"${id}" is an engine parameter, not a System CC.`,
      {
        retry_action: `Use set_param({port:"hydrasynth", block:"<block>", name:"${id}", value}) instead; it sends NRPN. CC-style and canonical NRPN names both resolve.`,
      },
    ));
  }
  const conn = ensureMidi();
  conn.send(ccBytes(DEFAULT_CHANNEL, param.cc, value));
  return {
    content: [{
      type: 'text',
      text: `Sent CC ${param.cc} = ${value} (${param.module} → ${param.parameter}). System CC; always responds.`,
    }],
    structuredContent: {
      id,
      cc: param.cc,
      value,
      module: param.module,
      parameter: param.parameter,
    },
  };
});

// set_macro (renamed from hydra_set_macro) --------------------------------

server.registerTool('set_macro', {
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  description: [
    'Set a Macro control (CCs 16-23 on the Hydrasynth; CC range varies by device). Each patch wires its macros to different synthesis params via the mod matrix, so the audible effect is per-patch. Excellent first lever for tone tweaks because they\'re curated by the patch designer.',
    'Requires Param TX/RX = CC on the device.',
    'Defaults to the Hydrasynth port. Pass `port` to target another device with the same Macro-on-CC convention.',
  ].join('\n'),
  inputSchema: {
    macro: z.number().int().min(1).max(8).describe('Macro number 1..8 (1-indexed, matching the device\'s display).'),
    value: z.number().int().min(0).max(127).describe('Macro value 0..127.'),
    port: z.string().optional().describe(
      'Optional port. Defaults to "hydrasynth". Pass to target a different device that exposes macros on the same CC range.',
    ),
  },
  outputSchema: {
    macro: z.number().int(),
    cc: z.number().int(),
    value: z.number().int(),
    port: z.string(),
  },
}, async ({ macro, value, port }) => {
  const cc = 15 + macro; // Macro 1 = CC 16, Macro 8 = CC 23
  const targetPort = port ?? 'hydrasynth';
  const descriptor = resolveDevice(targetPort);
  const label = descriptor?.connection_label ?? descriptor?.id ?? targetPort;
  const conn = ensureConnection(label);
  conn.send(ccBytes(DEFAULT_CHANNEL, cc, value));
  return {
    content: [{
      type: 'text',
      text: `Sent Macro ${macro} = ${value} (CC ${cc}) to ${descriptor?.display_name ?? targetPort}. The audible effect depends on the currently-loaded patch's mod matrix routing.`,
    }],
    structuredContent: {
      macro,
      cc,
      value,
      port: targetPort,
    },
  };
});

}
