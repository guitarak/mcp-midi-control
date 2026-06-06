/**
 * FM9 agent-regression cases.
 *
 * The FM9 is a gen-3 sibling of the Axe-Fx III: same codec, same 6x14 grid,
 * 8 scenes, A-D channels. Its value as a SEPARATE sweep case (rather than
 * relying on the III cases) is that it proves device DISPATCH and the
 * FM9-true param catalog: a `port: "fm9"` request must route to the FM9
 * descriptor (model byte 0x12, FM9 paramIds) and NOT fall through to the III
 * or the AM4 catch-all. The shared codec means FM3/VP4 don't each need a
 * case — one floor-unit sibling proves the factory dispatch pattern.
 *
 * Mock transport: the FM9 connector synthesizes the gen-3 read burst
 * (`makeGen3BroadcastMockResponder({ modelByte: 0x12 })`), and the MCP server
 * is force-connected before the agent starts (`alwaysLoad`). As on the III,
 * amp MODELS are not named (gen-3 amp models are numeric); tone is described
 * generically.
 */

import type { AgentRegressionCase } from './types.js';

export const FM9_CASES: AgentRegressionCase[] = [
  {
    id: 'fm9-tone-build-4scene',
    device: 'fm9',
    description:
      'Four-scene guitar preset on the FM9 (clean / crunch / high-gain / lead). Proves device ' +
      'dispatch (port "fm9" routes to the FM9 descriptor, not the III/AM4 catch-all) + the ' +
      'FM9-true catalog + grid apply_preset/routing/scenes end to end. Amp placed + knob-shaped ' +
      '(no model-by-name on gen-3).',
    prompt:
      "Build a 4-scene preset on my FM9. Scene 1: clean with reverb. Scene 2: crunchy rhythm. " +
      "Scene 3: heavy rhythm with a drive pedal. Scene 4: lead with delay. Put an amp and cab " +
      "in the chain. Use the working buffer, don't save.",
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
          if (!hasAmp) return 'apply_preset spec is missing an amp slot.';
          return true;
        },
      }],
      text_not_contains: [
        'I saved', 'I persisted', 'I stored',
        'preset is saved', 'now saved to', 'now persisted to', 'now stored to',
      ],
      max_wall_seconds: 360,
    },
  },
];
