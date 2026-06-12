/**
 * Focused check for the linear→grid EXPAND scene-remap fix (AM4→II).
 *
 * Reproduces the alpha.15-test report scenario: an AM4 4-scene preset
 * whose amp uses channels A/B/C/D. After translation to the II, the amp
 * splits into amp_1 (A/B→X/Y) and amp_2 (C/D→X/Y). Scenes that selected
 * C/D must route to amp_2 (X/Y) with amp_1 bypassed; scenes that selected
 * A/B route to amp_1 with amp_2 bypassed. Pre-fix, scenes 2/3 lost amp
 * routing entirely.
 *
 * Run: npx tsx scripts/_research/verify-expand-scene-remap.ts
 */
import { translatePresetSpec } from '@mcp-midi-control/core/protocol-generic/port-preset.js';
import type { PresetSpec } from '@mcp-midi-control/core/protocol-generic/types.js';
import { AM4_DESCRIPTOR } from '@mcp-midi-control/am4/descriptor.js';
import { AXEFX2_DESCRIPTOR } from '@mcp-midi-control/fractal-gen2/descriptor.js';

const SOURCE: PresetSpec = {
  name: 'CCRL',
  landingScene: 1,
  scenes: [
    { scene: 1, channels: { amp: 'A' }, bypassed: { amp: false } },
    { scene: 2, channels: { amp: 'C' }, bypassed: { amp: false } },
    { scene: 3, channels: { amp: 'D' }, bypassed: { amp: false } },
    { scene: 4, channels: { amp: 'B' }, bypassed: { amp: false } },
  ],
  slots: [
    {
      block_type: 'amp', id: 'amp', slot: 2,
      params_by_channel: {
        A: { type: 'SHIVER CLEAN', gain: 3 },
        B: { type: 'SHIVER LEAD', gain: 7.5 },
        C: { type: 'Brit 800 2204 High', gain: 6 },
        D: { type: 'Brit JVM OD1', gain: 8 },
      },
    },
  ],
};

const r = translatePresetSpec(AM4_DESCRIPTOR, SOURCE, AXEFX2_DESCRIPTOR);
const scenes = r.applied_spec?.scenes ?? [];
if (scenes.length === 0) {
  console.log('ERROR: no scenes in applied_spec — test cannot validate.');
  process.exit(2);
}

// X = A, Y = B after the basic source→target remap.
const EXPECT: Record<number, { active: string; activeCh: string; off: string }> = {
  1: { active: 'amp', activeCh: 'X', off: 'amp_2' },
  2: { active: 'amp_2', activeCh: 'X', off: 'amp' },
  3: { active: 'amp_2', activeCh: 'Y', off: 'amp' },
  4: { active: 'amp', activeCh: 'Y', off: 'amp_2' },
};

let failures = 0;
for (const sc of scenes) {
  const exp = EXPECT[sc.scene];
  if (exp === undefined) continue;
  const ch = (sc.channels ?? {}) as Record<string, string | number>;
  const by = (sc.bypassed ?? {}) as Record<string, boolean>;
  const activeOk = String(ch[exp.active] ?? '').toUpperCase() === exp.activeCh;
  const activeEngaged = by[exp.active] === false || by[exp.active] === undefined;
  const otherBypassed = by[exp.off] === true;
  const ok = activeOk && activeEngaged && otherBypassed;
  if (!ok) failures++;
  console.log(
    `scene ${sc.scene}: ${exp.active}=${ch[exp.active] ?? '(none)'} ` +
    `${exp.active}.bypassed=${by[exp.active]} ${exp.off}.bypassed=${by[exp.off]}  ` +
    `${ok ? 'PASS' : 'FAIL'} (want ${exp.active}=${exp.activeCh}, ${exp.off} bypassed)`,
  );
}

console.log(`\nwarnings:\n  ${(r.warnings ?? []).join('\n  ')}`);
if (failures > 0) {
  console.log(`\n${failures} scene(s) FAILED the expand remap.`);
  process.exit(1);
}
console.log('\nAll scenes route to the correct amp instance with the other bypassed. ✓');
