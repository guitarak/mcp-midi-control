/**
 * Axe-Fx III agent-regression cases.
 *
 * III is a unified-surface device: parameter reads and writes go through
 * the port-dispatched `set_param` / `get_param` / `apply_preset` tools,
 * the same surface every device shares. The III-namespaced `axefx3_*`
 * tools were retired; the fn=0x01 SET_PARAMETER wire shape they exercised
 * is covered by codec-layer goldens (verify-msg / verify-dispatcher) and
 * driven end-to-end through `apply_preset` below.
 *
 * Mock transport: the III connector now synthesizes the gen-3
 * 0x74/0x75/0x76 read burst (`makeGen3BroadcastMockResponder`), so read
 * tools (get_param / get_preset) complete without hardware. The MCP server
 * is force-connected before the agent starts (`alwaysLoad` in
 * mcp-config.json), so the agent sees the real tool set instead of an empty
 * list. Both are prerequisites for these cases to exercise anything.
 *
 * Amp MODELS are NOT named in these prompts. On gen-3 the amp model selector
 * (DISTORT_TYPE) is a numeric passthrough — the device-specific model roster
 * isn't captured, so "set a JCM800" can't resolve by name (it resolves on AM4
 * / Axe-Fx II, which have hardware-verified amp tables). The prompts describe
 * tone generically (clean / crunch / high-gain / lead) so the agent places an
 * amp + shapes gain/EQ/level knobs, which is what gen-3 supports today.
 */

import type { AgentRegressionCase } from './types.js';

export const AXE_FX_III_CASES: AgentRegressionCase[] = [
  // ── Flagship: 4-scene tone build (the showcase prompt) ─────────
  //
  // Mirrors the founder's demo prompt (clean / crunch / rhythm / lead in one
  // multi-scene preset). Exercises the full gen-3 write path end to end:
  // describe_device → apply_preset with placed blocks, grid routing (fn=0x01
  // sub=0x35), and 4 scenes. The single highest-value gen-3 sweep case: if the
  // factory dispatch, codec, routing, and scene authoring all work, this passes.
  {
    id: 'axefx3-tone-build-4scene',
    device: 'axe-fx-iii',
    description:
      'Four-scene guitar preset on the Axe-Fx III (clean / crunch / high-gain rhythm / lead). ' +
      'Exercises the gen-3 grid apply_preset + routing + 4 scenes end to end through the unified ' +
      'surface. Amp is placed + knob-shaped (no model-by-name; gen-3 amp models are numeric). ' +
      'Should land in <=1 apply_preset retry.',
    prompt:
      "Build a 4-scene preset on my Axe-Fx III. Scene 1: clean. Scene 2: crunchy rhythm. " +
      "Scene 3: tight high-gain rhythm with a drive pedal pushing the amp. Scene 4: singing lead " +
      "with delay. Put an amp and cab in the chain, reverb on every scene, delay on the lead. " +
      "Use the working buffer, don't save.",
    expectations: {
      must_call: ['describe_device', 'apply_preset'],
      max_tools: 14,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [{
        tool: 'apply_preset',
        call_index: 0,
        check: (args) => {
          const spec = (args.spec ?? {}) as { scenes?: unknown; slots?: unknown[] };
          const scenes = Array.isArray(spec.scenes) ? spec.scenes.length : 0;
          if (scenes !== 4) return `apply_preset spec should declare 4 scenes, got ${scenes}.`;
          const hasAmp = Array.isArray(spec.slots) && spec.slots.some(
            (s) => s !== null && typeof s === 'object' && (s as { block_type?: string }).block_type === 'amp',
          );
          if (!hasAmp) return 'apply_preset spec is missing an amp slot: a 4-scene build without an amp is a silent-no-op regression.';
          return true;
        },
      }],
      // POSITIVE-CLAIM shapes only, so honest "not saved" disclaimers don't trip.
      text_not_contains: [
        'I saved', 'I persisted', 'I stored',
        'preset is saved', 'preset is persisted',
        'now saved to', 'now persisted to', 'now stored to',
      ],
      max_wall_seconds: 360,
    },
  },

  // ── Read-path gate (newly runnable via the broadcast mock) ─────
  //
  // Before the mock fix, get_param timed out (the connector returned nothing),
  // so no III read case could exist. This gates the gen-3 read surface: an
  // fn=0x1F poll for a placed block returns the 0x74/0x75/0x76 burst and
  // get_param projects a value. Fast (single read), so it's cheap insurance
  // that the read path stays wired.
  {
    id: 'axefx3-read-param',
    device: 'axe-fx-iii',
    description:
      'Read a parameter on the Axe-Fx III. Gates the gen-3 read path (fn=0x1F poll → ' +
      '0x74/0x75/0x76 burst → projected value). Was impossible before the broadcast mock; ' +
      'a no_ack here means the read surface regressed.',
    prompt:
      "On my Axe-Fx III, read back the current reverb mix on the active preset and tell me the value.",
    expectations: {
      must_call: ['get_param'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'get_param',
        check: (_args, result) => {
          if (result === undefined) return 'get_param returned no result.';
          if (/no_ack|capability_not_supported|timed out|no .*burst/i.test(result)) {
            return `get_param failed instead of returning a value: ${result.slice(0, 160)}`;
          }
          return true;
        },
      }],
      text_not_contains: ["I can't", 'unable to read', 'not available'],
      max_wall_seconds: 150,
    },
  },

  // Whole-preset read of a STORED location: proves the agent reaches for
  // get_preset with a `location` arg (not get_param block-by-block) when asked
  // to inspect a stored preset, and that the gen-3 stored-dump decode path
  // (fn=0x03 → 0x77/0x78/0x79 → whole_preset) returns a structure. The mock
  // answers fn=0x03 with a CRC-valid synthetic dump.
  {
    id: 'axefx3-get-preset-location',
    device: 'axe-fx-iii',
    description:
      'Read a STORED Axe-Fx III preset by number. Should call get_preset with a location arg ' +
      'and surface the decoded whole_preset (name + scenes). Gates the gen-3 stored-dump decode ' +
      'wired into get_preset(location).',
    prompt:
      "On my Axe-Fx III, read stored preset number 5 and tell me its name and how many scenes it has. Don't change anything.",
    expectations: {
      must_call: ['get_preset'],
      max_tools: 6,
      tool_call_validators: [{
        tool: 'get_preset',
        check: (args, result) => {
          if (args.location === undefined) {
            return 'get_preset should pass a location arg to read a STORED preset, not read the active buffer.';
          }
          if (result === undefined) return true;
          if (/capability_not_supported|no_ack|did not parse/i.test(result)) {
            return `get_preset(location) failed instead of decoding: ${result.slice(0, 160)}`;
          }
          if (!/whole_preset/.test(result)) {
            return 'get_preset(location) response missing whole_preset (the decoded structure).';
          }
          return true;
        },
      }],
      max_wall_seconds: 150,
    },
  },

  // §discovery retired: cross-device duplicate of the meta-discovery pattern;
  // the two cases above exercise describe_device end to end.
  {
    id: 'axefx3-discovery-describe',
    device: 'axe-fx-iii',
    disabled: true,
    description: 'Retired: describe_device is exercised by the tone-build + read cases.',
    prompt: 'What can the Axe-Fx III do?',
    expectations: { must_call: ['describe_device'], max_tools: 3, max_wall_seconds: 60 },
  },
];
