/**
 * Axe-Fx Standard/Ultra (gen-1) agent-regression cases.
 *
 * gen-1 is SET-only: the published spec documents only the parameter-SET
 * message (model 0x01, fn 0x02, nibble-split). No read-back, no save, no
 * preset/scene switching, no channels.
 *
 * Three cases cover the surface:
 *   1. A simple set_param write — catches the agent reaching for AM4/II
 *      tools or confabulating a save/read that doesn't exist.
 *   2. A refused capability (get_param) — confirms the agent surfaces the
 *      "no read-back" limitation rather than silently failing or trying a
 *      workaround.
 *   3. A multi-param set_params write — confirms the agent uses the batch
 *      path on gen-1 for efficiency.
 */

import type { AgentRegressionCase } from './types.js';

export const AXEFX_GEN1_CASES: AgentRegressionCase[] = [
  // §1 set_param — simple dB knob write ─────────────────────────────
  {
    id: 'axefx-gen1-set-param-compressor-threshold',
    device: 'axe-fx-gen1',

    description:
      'Basic set_param write on the gen-1 surface. Catches the agent ' +
      'reaching for AM4 / II tools, trying to save (no save on gen-1), ' +
      'or calling get_param (no read-back). The agent must call set_param ' +
      'with the correct port and confirm on the front panel rather than ' +
      'claiming the write was verified.',
    prompt:
      'On the Axe-Fx Ultra, set the compressor threshold to -20 dB.',
    expectations: {
      must_call: ['set_param'],
      must_not_call: ['save_preset', 'get_param', 'switch_preset'],
      max_tools: 5,
      tool_call_validators: [
        {
          tool: 'set_param',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('gen1') && !port.includes('ultra') && !port.includes('standard')) {
              return `set_param port should target the gen-1 device, got ${String(args.port)}`;
            }
            if (args.block !== 'compressor') {
              return `set_param block should be "compressor", got ${JSON.stringify(args.block)}`;
            }
            if (args.name !== 'threshold') {
              return `set_param name should be "threshold", got ${JSON.stringify(args.name)}`;
            }
            if (typeof args.value !== 'number' || args.value !== -20) {
              return `set_param value should be -20, got ${JSON.stringify(args.value)}`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 60,
    },
  },

  // §2 param read-back — gen-1 reads are WIRED (fn 0x02 query flag) ──
  // STALE-CASE REWRITE 2026-06-10: the original case asserted reads
  // REFUSE with capability_not_supported and the agent should say
  // "read the front panel" — that was the pre-2026-06-06 surface.
  // get_param/get_params are wired now (decoded from the gen-1 wiki
  // spec, community-beta), so the correct behavior is to CALL the read
  // and report the value, not to deflect to the panel.
  {
    id: 'axefx-gen1-get-param-reads',
    device: 'axe-fx-gen1',

    description:
      'Confirms the agent USES the wired gen-1 read path when asked for a ' +
      'value (get_param on the reverb mix) instead of deflecting to the front ' +
      'panel or fabricating a number. Mock answers the fn 0x02 query.',
    prompt:
      'What is the current reverb mix on the Axe-Fx Ultra?',
    expectations: {
      must_call: ['get_param'],
      must_not_call: ['save_preset', 'switch_preset'],
      max_tools: 4,
      tool_call_validators: [
        {
          tool: 'get_param',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('gen1') && !port.includes('gen-1') && !port.includes('ultra') && !port.includes('standard')) {
              return `get_param port should target gen-1, got ${String(args.port)}`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 60,
    },
  },

  // §3 set_params — batch write, confirm beta/front-panel posture ───
  {
    id: 'axefx-gen1-set-params-batch',
    device: 'axe-fx-gen1',

    description:
      'set_params batch path on gen-1. The agent should use set_params (not ' +
      'individual set_param calls) for multi-param writes, and must NOT claim ' +
      'values were confirmed (no read-back; user verifies on the front panel). ' +
      'Also catches the agent trying to save or switch presets after writing.',
    prompt:
      'On the Axe-Fx Ultra, dial in a compressed lead tone: set compressor threshold to -15 dB, attack to 3, and level to 0 dB.',
    expectations: {
      must_call: ['set_params'],
      must_not_call: ['save_preset', 'switch_preset'],
      max_tools: 5,
      tool_call_validators: [
        {
          tool: 'set_params',
          check: (args) => {
            const port = typeof args.port === 'string' ? args.port.toLowerCase() : '';
            if (!port.includes('gen1') && !port.includes('ultra') && !port.includes('standard')) {
              return `set_params port should target gen-1, got ${String(args.port)}`;
            }
            // VALIDATOR-BUG FIX 2026-06-10: the tool's batch field is
            // `ops`, not `params` — the old check read a nonexistent
            // field and failed every run (0% pass since creation).
            const ops = Array.isArray((args as { ops?: unknown[] }).ops) ? (args as { ops: unknown[] }).ops : [];
            if (ops.length < 2) {
              return `set_params should pass at least 2 ops for a batch write, got ${ops.length}`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 60,
    },
  },
];
