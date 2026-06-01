/**
 * Alpha.11 bug-fix verification probe.
 *
 * Drives the MCP server against live Axe-Fx II + AM4 (both connected,
 * not concurrently — script switches between them) to verify:
 *
 *   F12 — active_scene drift: apply_preset(landingScene:1) → set_params →
 *         set_bypass → get_preset must report active_scene:1, not 4.
 *   F5  — AM4 channel-bearing blocks return params_by_channel with
 *         channel_status (no flat-params fallback when channel read fails).
 *   F6c — Linear→grid expand: AM4 amp with A/B/C/D → II amp_1 + amp_2 (X/Y each).
 *   F6g — Linear→grid cab auto-place: AM4 → II inserts a cab block.
 *   F15 — describe_device.capabilities.supports_factory_restore is
 *         undefined on AM4 (property dropped vs advertised-true with no tool).
 *
 * Run: npx tsx scripts/_research/probe-alpha11-bugfixes.ts
 *
 * Non-destructive: only writes to the working buffer; restores canonical
 * Clean/Crunch/Rhythm/Lead preset at the end.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(
  process.cwd(),
  'packages',
  'server-all',
  'dist',
  'server',
  'index.js',
);

function extractJson(callResult: unknown): Record<string, unknown> {
  const r = callResult as { content?: Array<{ type?: string; text?: string }> };
  const text = (r.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text!)
    .join('\n');
  try {
    return JSON.parse(text);
  } catch {
    return { _raw: text };
  }
}

function isError(r: unknown): boolean {
  return !!(r as { isError?: boolean })?.isError;
}

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, ok: boolean, detail?: string): void {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    const msg = `${label}${detail ? ` — ${detail}` : ''}`;
    failures.push(msg);
    console.log(`  FAIL  ${msg}`);
  }
}

const CANONICAL_II_SPEC = {
  landingScene: 1,
  name: 'Clean/Crunch/Rhythm/Lead',
  scenes: [
    {
      scene: 1,
      name: 'Clean',
      channels: { amp: 'X', amp_2: 'X', delay: 'X', reverb: 'X' },
      bypassed: { amp: false, amp_2: true, compressor: false, delay: false, reverb: false },
    },
    {
      scene: 2,
      name: 'Crunch',
      channels: { amp: 'Y', amp_2: 'X', delay: 'Y', reverb: 'Y' },
      bypassed: { amp: true, amp_2: false, compressor: true, delay: true, reverb: false },
    },
    {
      scene: 3,
      name: 'Rhythm',
      channels: { amp: 'X', amp_2: 'Y', delay: 'Y', reverb: 'Y' },
      bypassed: { amp: true, amp_2: false, compressor: true, delay: true, reverb: false },
    },
    {
      scene: 4,
      name: 'Lead',
      channels: { amp: 'Y', amp_2: 'Y', delay: 'Y', reverb: 'X' },
      bypassed: { amp: false, amp_2: true, compressor: true, delay: false, reverb: false },
    },
  ],
  slots: [
    { slot: { row: 2, col: 1 }, block_type: 'compressor', params_by_channel: { X: { effect_type: 'PEDAL COMP 1', treshold: -22, ratio: 4, mix: 100 } } },
    { slot: { row: 2, col: 2 }, block_type: 'amp', instance: 1, params_by_channel: { X: { type: 'SHIVER CLEAN', input_drive: 3, bass: 6, middle: 6, treble: 7, master_volume: 4, presence: 6, level: 2 }, Y: { type: 'SHIVER LEAD', input_drive: 7.5, bass: 5, middle: 7, treble: 6, master_volume: 5, presence: 6, level: 3 } } },
    { slot: { row: 2, col: 3 }, block_type: 'amp', instance: 2, params_by_channel: { X: { type: 'BRIT 800', input_drive: 6, bass: 5, middle: 7, treble: 6, master_volume: 4, presence: 6, level: 0 }, Y: { type: 'BRIT JVM OD1 GN', input_drive: 8, bass: 6, middle: 5, treble: 6, master_volume: 4, presence: 6, level: 0 } } },
    { slot: { row: 2, col: 4 }, block_type: 'cab' },
    { slot: { row: 2, col: 5 }, block_type: 'delay', params_by_channel: { X: { effect_type: 'DIGITAL STEREO', time: 450, feedback: 22, mix: 25 }, Y: { effect_type: 'DIGITAL STEREO', time: 420, feedback: 35, mix: 28 } } },
    { slot: { row: 2, col: 6 }, block_type: 'reverb', params_by_channel: { X: { effect_type: 'LARGE HALL', mix: 40 }, Y: { effect_type: 'MEDIUM ROOM', mix: 15 } } },
  ],
} as const;

async function probeIIDriftFix(client: Client): Promise<void> {
  console.log('\n=== F12: II active_scene drift after apply + writes ===');
  // 1. Apply canonical preset, landingScene:1
  const applyResult = await client.callTool({
    name: 'apply_preset',
    arguments: { port: 'axe-fx-ii', spec: CANONICAL_II_SPEC, verify_chain: true },
  });
  const applyJson = extractJson(applyResult);
  check('apply_preset ok', applyJson['ok'] === true, `steps=${applyJson['steps']}`);

  // 2. Set compressor params
  const setParamsResult = await client.callTool({
    name: 'set_params',
    arguments: {
      port: 'axe-fx-ii',
      ops: [
        { block: 'compressor', channel: 'X', name: 'treshold', value: -30 },
        { block: 'compressor', channel: 'X', name: 'ratio', value: 8 },
      ],
    },
  });
  const setParamsJson = extractJson(setParamsResult);
  check('set_params acked', setParamsJson['acked_count'] === 2);

  // 3. Set cab bypass (this was the trigger in the user's repro)
  const setBypassResult = await client.callTool({
    name: 'set_bypass',
    arguments: { port: 'axe-fx-ii', block: 'cab', bypassed: true },
  });
  const setBypassJson = extractJson(setBypassResult);
  check('set_bypass acked', setBypassJson['acked'] === true);

  // 4. Get preset — active_scene MUST be 1, not 4
  const getResult = await client.callTool({
    name: 'get_preset',
    arguments: { port: 'axe-fx-ii' },
  });
  const getJson = extractJson(getResult);
  const activeScene = getJson['active_scene'];
  check(
    'F12: active_scene == 1 after apply+writes (was drifting to 4)',
    activeScene === 1,
    `got active_scene=${activeScene}`,
  );

  // Restore cab bypass + compressor for clean state
  await client.callTool({
    name: 'set_bypass',
    arguments: { port: 'axe-fx-ii', block: 'cab', bypassed: false },
  });
  await client.callTool({
    name: 'set_params',
    arguments: {
      port: 'axe-fx-ii',
      ops: [
        { block: 'compressor', channel: 'X', name: 'treshold', value: -22 },
        { block: 'compressor', channel: 'X', name: 'ratio', value: 4 },
      ],
    },
  });
}

async function probeAM4ChannelStatusShape(client: Client): Promise<void> {
  console.log('\n=== F5 sub-bug: AM4 channel-bearing blocks shape consistency ===');
  // Just read the current preset's shape.
  const getResult = await client.callTool({
    name: 'get_preset',
    arguments: { port: 'am4' },
  });
  if (isError(getResult)) {
    check('AM4 reachable (skip if device not connected)', false, 'AM4 get_preset returned isError');
    return;
  }
  const getJson = extractJson(getResult);
  const slots = (getJson['slots'] as Array<Record<string, unknown>>) ?? [];
  check('AM4 returned slots', slots.length > 0, `${slots.length} slot(s)`);

  const channelBlocks = new Set(['amp', 'drive', 'reverb', 'delay']);
  let consistencyOk = true;
  const shapeDetail: string[] = [];
  for (const s of slots) {
    const blockType = (s['block_type'] as string)?.toLowerCase();
    if (!channelBlocks.has(blockType)) continue;
    const hasFlatParams = s['params'] !== undefined;
    const hasNestedParams = s['params_by_channel'] !== undefined;
    const channelStatus = s['channel_status'];
    shapeDetail.push(
      `${blockType}: params=${hasFlatParams ? 'set' : '-'}, params_by_channel=${hasNestedParams ? 'set' : '-'}, channel_status=${String(channelStatus)}`,
    );
    // Any channel-bearing block MUST use params_by_channel post-fix.
    if (hasFlatParams && !hasNestedParams) {
      consistencyOk = false;
    }
  }
  check(
    'F5: all channel-bearing AM4 slots use params_by_channel (not flat params)',
    consistencyOk,
    shapeDetail.join(' | '),
  );
}

async function probeTranslatorExpandCab(client: Client): Promise<void> {
  console.log('\n=== F6c expand + F6g cab auto-place: AM4 → II translation ===');
  const sourceSpec = {
    name: 'Clean/Crunch/Rhythm/Lead',
    slots: [
      { slot: 1, block_type: 'compressor', params: { threshold: -22, ratio: 4, mix: 100 } },
      {
        slot: 2,
        block_type: 'amp',
        params_by_channel: {
          A: { type: 'Shiver Clean', gain: 3, master: 4 },
          B: { type: 'Shiver Lead', gain: 7.5, master: 5 },
          C: { type: 'Brit 800 2204 High', gain: 6, master: 4 },
          D: { type: 'Brit JVM OD1', gain: 8, master: 4 },
        },
      },
      {
        slot: 3,
        block_type: 'reverb',
        params_by_channel: {
          A: { type: 'Plate, Large', mix: 40 },
          B: { type: 'Room, Medium', mix: 15 },
        },
      },
      {
        slot: 4,
        block_type: 'delay',
        params_by_channel: {
          A: { type: 'Digital Stereo', time: 450, feedback: 22, mix: 25 },
          B: { type: 'Digital Stereo', time: 420, feedback: 35, mix: 28 },
        },
      },
    ],
    scenes: [
      { scene: 1, name: 'Clean', channels: { amp: 'A', reverb: 'A', delay: 'A' }, bypassed: { compressor: false } },
    ],
    landingScene: 1,
  };
  const translateResult = await client.callTool({
    name: 'translate_preset',
    arguments: { source_port: 'am4', source_spec: sourceSpec, target_port: 'axe-fx-ii' },
  });
  const translateJson = extractJson(translateResult);
  check('translate_preset ok', translateJson['ok'] === true);

  const appliedSpec = translateJson['applied_spec'] as Record<string, unknown>;
  const slots = (appliedSpec?.['slots'] as Array<Record<string, unknown>>) ?? [];

  const ampSlots = slots.filter((s) => (s['block_type'] as string)?.toLowerCase() === 'amp');
  check(
    'F6c: amp expanded into 2 instances on II',
    ampSlots.length === 2,
    `amp slot count: ${ampSlots.length}`,
  );

  const cabSlot = slots.find((s) => (s['block_type'] as string)?.toLowerCase() === 'cab');
  check('F6g: cab auto-placed on grid target', cabSlot !== undefined);

  const warnings = (translateJson['warnings'] as string[]) ?? [];
  check(
    'F6c: expand warning surfaced',
    warnings.some((w) => /expanded amp channels/.test(w)),
    warnings.find((w) => /expanded/.test(w)) ?? '(none)',
  );
  check(
    'F6g: cab auto-place warning surfaced',
    warnings.some((w) => /auto-placed a cab block/.test(w)),
    warnings.find((w) => /auto-placed/.test(w)) ?? '(none)',
  );
}

async function probeF15CapabilityHonest(client: Client): Promise<void> {
  console.log('\n=== F15: AM4 capabilities honest (no false factory-restore advertisement) ===');
  const descResult = await client.callTool({
    name: 'describe_device',
    arguments: { port: 'am4' },
  });
  if (isError(descResult)) {
    check('AM4 reachable', false, 'describe_device returned isError');
    return;
  }
  const descJson = extractJson(descResult);
  const caps = descJson['capabilities'] as Record<string, unknown>;
  check(
    'F15: supports_factory_restore is unadvertised (undefined) on AM4',
    caps['supports_factory_restore'] === undefined,
    `got: ${JSON.stringify(caps['supports_factory_restore'])}`,
  );
}

async function main(): Promise<void> {
  console.log('Connecting to MCP server (real hardware)...');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, MCP_MOCK_TRANSPORT: '' },
  });
  const client = new Client({ name: 'alpha11-probe', version: '1.0.0' });
  await client.connect(transport);
  console.log('Connected.');

  try {
    await probeF15CapabilityHonest(client);
    await probeTranslatorExpandCab(client);
    await probeAM4ChannelStatusShape(client);
    await probeIIDriftFix(client);
  } finally {
    await client.close();
  }

  console.log(`\n=== Summary ===`);
  console.log(`PASSED: ${passed}`);
  console.log(`FAILED: ${failed}`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Probe crashed:', err);
  process.exit(2);
});
