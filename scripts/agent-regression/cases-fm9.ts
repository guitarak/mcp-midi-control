/**
 * FM9 agent-regression cases.
 *
 * The FM9 is a gen-3 sibling of the Axe-Fx III: same codec, same 6x14 grid,
 * 8 scenes, A-D channels. Its value as a SEPARATE sweep case (rather than
 * relying on the III cases) is that it proves device DISPATCH and the
 * FM9-true param catalog: a `port: "fm9"` request must route to the FM9
 * descriptor (model byte 0x12, FM9 paramIds) and NOT fall through to the III
 * or the AM4 catch-all. The shared codec means FM3/VP4 don't each need a
 * case; one floor-unit sibling proves the factory dispatch pattern.
 *
 * Mock transport: the FM9 connector synthesizes the gen-3 read burst
 * (`makeGen3BroadcastMockResponder({ modelByte: 0x12 })`), and the MCP server
 * is force-connected before the agent starts (`alwaysLoad`).
 *
 * Unlike the earlier gen-3 framing, FM9 amp / drive / reverb types ARE settable
 * AND readable by their real Fractal model names (device-true rosters mined from
 * the FM9-Edit cache: amp 331, drive 86, reverb 79). The `fm9-named-tone-build`
 * case below exercises that explicitly, and doubles as the check that the tool
 * descriptions don't gate the agent into numeric-only writes.
 */

import type { AgentRegressionCase } from './types.js';

export const FM9_CASES: AgentRegressionCase[] = [
  {
    id: 'fm9-tone-build-4scene',
    device: 'fm9',
    description:
      'Four-scene guitar preset on the FM9 (clean / crunch / high-gain / lead). Proves device ' +
      'dispatch (port "fm9" routes to the FM9 descriptor, not the III/AM4 catch-all) + the ' +
      'FM9-true catalog + grid apply_preset/routing/scenes end to end.',
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
  {
    id: 'fm9-named-tone-build',
    device: 'fm9',
    description:
      'FM9 tone build that NAMES the amp, drive, and reverb models by their real Fractal names ' +
      '("Texas Star Clean", "Blues OD", "Music Hall"). Proves (a) the device-true FM9 rosters ' +
      'resolve set-by-name end to end, and (b) the tool descriptions do NOT gate the agent into ' +
      'numeric-only writes or make it claim the models cannot be named. Large primary-tool ' +
      'coverage: describe_device + a grid build with named models.',
    prompt:
      "On my FM9 working buffer, build a lead tone: use a Texas Star Clean amp into a 4x12 cab, " +
      "with a Blues OD drive in front, a delay, and a Music Hall reverb. Don't save it.",
    expectations: {
      must_call: ['describe_device'],
      // A fresh build is apply_preset's job, but accept a place-then-set path too.
      must_call_any: [['apply_preset'], ['set_block']],
      max_tools: 16,
      max_repeats: { apply_preset: 2 },
      tool_call_validators: [
        {
          // If the agent builds via apply_preset, the spec must carry the NAMED
          // models (not numbers), proving set-by-name flowed through.
          tool: 'apply_preset',
          call_index: 0,
          optional: true,
          check: (args) => {
            const spec = (args.spec ?? {}) as { slots?: unknown[] };
            const slots = Array.isArray(spec.slots) ? spec.slots : [];
            const blob = JSON.stringify(slots).toLowerCase();
            const named = ['texas star clean', 'blues od', 'music hall'].filter((n) => blob.includes(n));
            if (named.length === 0) {
              return 'apply_preset spec carries no named amp/drive/reverb model; agent fell back to numeric (description may be underselling set-by-name).';
            }
            return true;
          },
        },
        {
          // If the agent sets a type via set_param, the value should be a NAME
          // string, not a number.
          tool: 'set_param',
          optional: true,
          check: (args) => {
            const name = String((args as { name?: string }).name ?? '').toLowerCase();
            if (!name.includes('type')) return true; // only police type/model sets
            const v = (args as { value?: unknown }).value;
            if (typeof v === 'number') {
              return `set_param ${name} used a numeric value ${v} instead of a model name (description may be underselling set-by-name).`;
            }
            return true;
          },
        },
      ],
      // Underselling / gating tells: the agent must NOT claim FM9 models are numbers-only.
      text_not_contains: [
        'numeric only', 'by number', 'model number', 'amp models are numeric',
        "can't be named", 'cannot be named', 'not settable by name', "can't set by name",
        'I saved', 'now saved to', 'now persisted to', 'now stored to',
      ],
      max_wall_seconds: 360,
    },
  },
];
