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

  // §2 refused capability — get_param must surface no-read-back ─────
  {
    id: 'axefx-gen1-get-param-refuses',
    device: 'axe-fx-gen1',

    description:
      'Confirms the agent surfaces the gen-1 no-read-back limitation when ' +
      'asked to read a value, rather than trying get_param (which refuses with ' +
      'capability_not_supported) or fabricating a value. The agent should tell ' +
      'the user to read the front panel.',
    prompt:
      'What is the current reverb mix on the Axe-Fx Ultra?',
    expectations: {
      must_not_call: ['save_preset', 'switch_preset'],
      max_tools: 4,
      text_contains: ['front panel', 'read'],
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
            const params = Array.isArray(args.params) ? args.params : [];
            if (params.length < 2) {
              return `set_params should pass at least 2 params for a batch write, got ${params.length}`;
            }
            return true;
          },
        },
      ],
      max_wall_seconds: 60,
    },
  },
];
