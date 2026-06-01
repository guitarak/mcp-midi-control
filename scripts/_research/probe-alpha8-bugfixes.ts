/**
 * Alpha.8 bug-fix verification probe.
 *
 * Drives the MCP server against a live Axe-Fx II to verify:
 *   1. Bug A: compressor knob writes via fn=0x02 actually land
 *   2. Bug B: get_preset Y-channel values are numbers, not strings
 *   3. Response shape: slots carry `id` and `bypassed` fields
 *
 * Non-destructive: works in the active working buffer only.
 * Run: npx tsx scripts/_research/probe-alpha8-bugfixes.ts
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(
  process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js',
);
const PORT = 'axe-fx-ii';

function extractJson(callResult: unknown): Record<string, unknown> {
  const r = callResult as { content?: Array<{ type?: string; text?: string }> };
  const text = (r.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text!)
    .join('\n');
  return JSON.parse(text);
}

function isError(r: unknown): boolean {
  return !!(r as { isError?: boolean })?.isError;
}

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function main() {
  console.log('Connecting to MCP server...');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
  });
  const client = new Client({ name: 'alpha8-probe', version: '1.0.0' });
  await client.connect(transport);
  console.log('Connected.\n');

  try {
    // ── Step 0: Place a compressor so we have something to write to ──
    console.log('=== Setup: ensure compressor is placed ===');
    const descResult = await client.callTool({
      name: 'describe_device',
      arguments: { port: PORT },
    });
    check('describe_device', !isError(descResult));

    // Place a minimal preset with a compressor block
    const applyResult = await client.callTool({
      name: 'apply_preset',
      arguments: {
        port: PORT,
        spec: {
          name: 'Alpha8 Test',
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'compressor' },
            { slot: { row: 2, col: 2 }, block_type: 'amp' },
          ],
        },
      },
    });
    const applyJson = extractJson(applyResult);
    check('apply_preset (comp+amp)', applyJson['ok'] === true, `steps=${applyJson['steps']}`);

    // ── Bug A: compressor knob writes via fn=0x02 ──────────────────
    console.log('\n=== Bug A: compressor knob writes ===');

    // First, set auto=off so it doesn't interfere
    const autoOffResult = await client.callTool({
      name: 'set_param',
      arguments: { port: PORT, block: 'compressor', name: 'auto', value: 'off' },
    });
    const autoOffJson = extractJson(autoOffResult);
    check('set_param compressor.auto=off', autoOffJson['acked'] === true);

    // Write five compressor knobs
    const testParams = [
      { name: 'treshold', value: -20, tolerance: 2 },
      { name: 'ratio', value: 4, tolerance: 1 },
      { name: 'attack', value: 10, tolerance: 2 },
      { name: 'release', value: 200, tolerance: 20 },
      { name: 'level', value: -6, tolerance: 2 },
    ];

    const setResult = await client.callTool({
      name: 'set_params',
      arguments: {
        port: PORT,
        ops: testParams.map((p) => ({
          block: 'compressor',
          name: p.name,
          value: p.value,
        })),
      },
    });
    const setJson = extractJson(setResult);
    check(
      'set_params 5 compressor knobs',
      (setJson['acked_count'] as number) === 5,
      `acked=${setJson['acked_count']}`,
    );

    // Read back via get_param (per-param fn=0x02 GET, most authoritative)
    console.log('\n  Readback via get_param:');
    for (const p of testParams) {
      const readResult = await client.callTool({
        name: 'get_param',
        arguments: { port: PORT, block: 'compressor', name: p.name },
      });
      const readJson = extractJson(readResult);
      const readValue = readJson['display_value'] as number;
      const delta = Math.abs(readValue - p.value);
      check(
        `  compressor.${p.name} = ${p.value}`,
        delta <= p.tolerance,
        `read=${readValue}, delta=${delta.toFixed(3)}`,
      );
    }

    // Also verify via get_preset to cross-check the bulk read path
    console.log('\n  Readback via get_preset (fn=0x1F bulk):');
    const presetResult = await client.callTool({
      name: 'get_preset',
      arguments: { port: PORT },
    });
    const presetJson = extractJson(presetResult);
    const slots = presetJson['slots'] as Array<Record<string, unknown>>;
    const compSlot = slots?.find((s) => s['block_type'] === 'compressor');

    if (compSlot) {
      const pbc = compSlot['params_by_channel'] as Record<string, Record<string, unknown>> | undefined;
      const compParams = pbc?.['X'] ?? compSlot['params'] as Record<string, unknown>;
      if (compParams) {
        for (const p of testParams) {
          const val = compParams[p.name];
          if (typeof val === 'number') {
            const delta = Math.abs(val - p.value);
            check(
              `  get_preset compressor.${p.name} = ${p.value}`,
              delta <= p.tolerance,
              `read=${val.toFixed(3)}, delta=${delta.toFixed(3)}`,
            );
          } else {
            check(`  get_preset compressor.${p.name} type`, false, `got ${typeof val}: ${val}`);
          }
        }
      } else {
        check('get_preset compressor params found', false, 'no params on comp slot');
      }

      // ── Response shape: id and bypassed ───────────────────────────
      console.log('\n=== Response shape: id + bypassed ===');
      check('compressor slot has id', 'id' in compSlot, `id=${compSlot['id']}`);
      check('compressor slot has bypassed', 'bypassed' in compSlot, `bypassed=${compSlot['bypassed']}`);

      const ampSlot = slots?.find((s) => s['block_type'] === 'amp');
      if (ampSlot) {
        check('amp slot has id', 'id' in ampSlot, `id=${ampSlot['id']}`);
        check('amp slot has bypassed', 'bypassed' in ampSlot, `bypassed=${ampSlot['bypassed']}`);
      }

      // ── Bug B: Y-channel decode consistency ───────────────────────
      console.log('\n=== Bug B: Y-channel value types ===');
      if (pbc?.['Y']) {
        const yParams = pbc['Y'];
        let stringCount = 0;
        let numberCount = 0;
        const stringExamples: string[] = [];
        for (const [key, val] of Object.entries(yParams)) {
          if (typeof val === 'string') {
            stringCount++;
            if (stringExamples.length < 3) stringExamples.push(`${key}=${JSON.stringify(val)}`);
          } else if (typeof val === 'number') {
            numberCount++;
          }
        }
        // Enum params will legitimately be strings. We expect most
        // uncalibrated knobs to be numbers now, not device label strings.
        check(
          'Y-channel: numbers outnumber strings',
          numberCount > stringCount,
          `numbers=${numberCount}, strings=${stringCount}` +
            (stringExamples.length > 0 ? ` — examples: ${stringExamples.join(', ')}` : ''),
        );
      } else {
        check('Y-channel params present', false, 'no Y channel in response');
      }

      // Check the amp block too (bigger param set, more uncalibrated params)
      if (ampSlot) {
        const ampPbc = ampSlot['params_by_channel'] as Record<string, Record<string, unknown>> | undefined;
        if (ampPbc?.['Y']) {
          const yParams = ampPbc['Y'];
          let stringCount = 0;
          let numberCount = 0;
          const stringExamples: string[] = [];
          for (const [key, val] of Object.entries(yParams)) {
            if (typeof val === 'string') {
              stringCount++;
              if (stringExamples.length < 5) stringExamples.push(`${key}=${JSON.stringify(val)}`);
            } else if (typeof val === 'number') {
              numberCount++;
            }
          }
          check(
            'amp Y-channel: numbers outnumber strings',
            numberCount > stringCount,
            `numbers=${numberCount}, strings=${stringCount}` +
              (stringExamples.length > 0 ? ` — string examples: ${stringExamples.join(', ')}` : ''),
          );
        }
      }
    } else {
      check('get_preset found compressor slot', false, 'no compressor in response');
    }

    // ── Second consistency read: check for drift ────────────────────
    console.log('\n=== Drift check: second get_preset read ===');
    const preset2Result = await client.callTool({
      name: 'get_preset',
      arguments: { port: PORT },
    });
    const preset2Json = extractJson(preset2Result);
    const slots2 = preset2Json['slots'] as Array<Record<string, unknown>>;
    const compSlot2 = slots2?.find((s) => s['block_type'] === 'compressor');
    if (compSlot2) {
      const pbc2 = compSlot2['params_by_channel'] as Record<string, Record<string, unknown>> | undefined;
      const params1 = (compSlot?.['params_by_channel'] as Record<string, Record<string, unknown>> | undefined)?.['X'];
      const params2 = pbc2?.['X'];
      if (params1 && params2) {
        for (const p of testParams) {
          const v1 = params1[p.name] as number;
          const v2 = params2[p.name] as number;
          if (typeof v1 === 'number' && typeof v2 === 'number') {
            const drift = Math.abs(v1 - v2);
            check(
              `  compressor.${p.name} stable between reads`,
              drift < 0.01,
              `read1=${v1.toFixed(3)}, read2=${v2.toFixed(3)}, drift=${drift.toFixed(6)}`,
            );
          }
        }
      }
    }
  } finally {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    await client.close();
    process.exit(failed > 0 ? 1 : 0);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(2);
});
