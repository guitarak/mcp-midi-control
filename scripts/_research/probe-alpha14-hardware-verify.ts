/**
 * Hardware-verification probe for the alpha.14 release + the pan-bipolar
 * fix on top of it. Spawns a clean server-all dist child via stdio,
 * confirms real-device port handles (no mock fallback), and runs:
 *
 *   1. Connectivity sanity (describe_device returns expected port info)
 *   2. AM4 read/write round-trip (amp.gain) - confirms reads aren't
 *      stuck on a canned default
 *   3. Pan-fix verification (filter.pan_left + enhancer.pan_left across
 *      negative / zero / positive display values - confirms the
 *      bipolar_percent encoding lands correctly)
 *   4. Bug B regression (AM4 get_preset returns distinct per-channel
 *      data, not all channel-A duplicated)
 *   5. Bug C regression (AM4 amp channel_status != "unknown")
 *   6. Bug A regression (II decode strings stable across two
 *      consecutive get_preset calls on opaque params)
 *   7. amp.gain set 2 -> display X anomaly (encode-side wire diagnostic)
 *
 * Self-restoring: navigates to Z04 scratch for any state-mutating tests
 * so the founder's preset state is untouched.
 *
 * Run:
 *   npx tsx scripts/_research/probe-alpha14-hardware-verify.ts
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

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

function extractText(r: unknown): string {
  if (!r || typeof r !== 'object') return '<no response>';
  const x = r as CallResult;
  const parts = (x.content ?? [])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!);
  return parts.join('\n');
}
function structured(r: unknown): Record<string, unknown> | undefined {
  return (r as CallResult)?.structuredContent;
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}

function section(title: string): void {
  console.log('\n' + '='.repeat(72));
  console.log(title);
  console.log('='.repeat(72));
}

async function main(): Promise<void> {
  console.log('alpha.14 hardware-verify probe');
  console.log('Spawning fresh MCP server child from:');
  console.log(`  ${SERVER_ENTRY}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...(process.env as Record<string, string>) },
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      // surface server errors but not normal startup chatter
      if (/error|throw|warn/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'probe-alpha14-hardware-verify', version: '1.0.0' },
    { capabilities: {} },
  );

  await client.connect(transport);

  // ── 1. Connectivity sanity ───────────────────────────────────────
  section('1. Connectivity sanity (real ports, not mock)');
  const portsRes = await client.callTool({
    name: 'list_midi_ports',
    arguments: {},
  });
  console.log(extractText(portsRes).slice(0, 1200));

  const am4Desc = await client.callTool({
    name: 'describe_device',
    arguments: { port: 'am4' },
  });
  const am4DescSc = structured(am4Desc);
  console.log(
    `  describe_device(am4) -> device=${JSON.stringify((am4DescSc as { device?: string } | undefined)?.device)}`,
  );

  // ── 2. AM4 read/write round-trip ────────────────────────────────
  section('2. AM4 amp.gain read/write round-trip');
  const gainRead1 = await client.callTool({
    name: 'get_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain' },
  });
  const g1 = structured(gainRead1) as Record<string, unknown>;
  console.log(
    `  initial read: wire_value=${JSON.stringify(g1?.wire_value)} display=${JSON.stringify(g1?.display_value)} raw=${JSON.stringify(g1?.raw_response)?.slice(0, 90)}`,
  );

  // Set to a non-default value
  await client.callTool({
    name: 'set_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain', value: 7.3 },
  });
  // Small delay for device round-trip
  await new Promise((r) => setTimeout(r, 200));
  const gainRead2 = await client.callTool({
    name: 'get_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain' },
  });
  const g2 = structured(gainRead2) as Record<string, unknown>;
  console.log(
    `  after set 7.3: wire_value=${JSON.stringify(g2?.wire_value)} display=${JSON.stringify(g2?.display_value)} raw=${JSON.stringify(g2?.raw_response)?.slice(0, 90)}`,
  );
  const bytesSame =
    JSON.stringify(g1?.raw_response) === JSON.stringify(g2?.raw_response);
  console.log(
    `  bytes identical to initial? ${bytesSame ? 'YES (read stuck on canned default!)' : 'NO (real round-trip)'}`,
  );

  // Restore to the original display value
  if (typeof g1?.display_value === 'number') {
    await client.callTool({
      name: 'set_param',
      arguments: { port: 'am4', block: 'amp', name: 'gain', value: g1.display_value },
    });
  }

  // ── 3. Pan-fix verification ─────────────────────────────────────
  section('3. Pan-fix verification (filter.pan_left bipolar encoding)');
  console.log('  Switching to Z04 scratch to place a filter block...');
  await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'Z04', on_active_preset_edited: 'discard' },
  });
  await client.callTool({
    name: 'apply_preset',
    arguments: {
      port: 'am4',
      spec: {
        name: 'PanProbe',
        slots: [
          {
            slot: 1,
            block_type: 'filter',
            params: { type: 'Low-Pass', freq: 4000, q: 0.7 },
          },
          {
            slot: 2,
            block_type: 'enhancer',
            params: { type: 'Modern', width: 50, depth: 50 },
          },
        ],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 400));

  // Check what unit the catalog now reports for filter.pan_left
  const listP = await client.callTool({
    name: 'list_params',
    arguments: { port: 'am4', block: ['filter'], name: ['pan_left'] },
  });
  const listSc = structured(listP) as { params?: Array<Record<string, unknown>> } | undefined;
  console.log(
    `  catalog: filter.pan_left unit=${JSON.stringify(listSc?.params?.[0]?.unit)} ` +
      `displayMin=${JSON.stringify(listSc?.params?.[0]?.displayMin)} ` +
      `displayMax=${JSON.stringify(listSc?.params?.[0]?.displayMax)}`,
  );

  // Sweep display values across the bipolar range and read back
  for (const v of [-100, -50, 0, 30, 50, 100]) {
    await client.callTool({
      name: 'set_param',
      arguments: { port: 'am4', block: 'filter', name: 'pan_left', value: v },
    });
    await new Promise((r) => setTimeout(r, 80));
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'am4', block: 'filter', name: 'pan_left' },
    });
    const rs = structured(r) as Record<string, unknown>;
    console.log(
      `  set ${String(v).padStart(4)} -> wire=${JSON.stringify(rs?.wire_value)} display=${JSON.stringify(rs?.display_value)}`,
    );
  }

  // ── 4. Bug B regression: AM4 channel duplication ────────────────
  section('4. Bug B (AM4 get_preset per-channel distinct data)');
  // Need a preset with channel-bearing blocks differing across A/B/C/D.
  // Z04 currently has filter + enhancer (non-channel). Place amp + drive
  // with distinct channel data instead.
  await client.callTool({
    name: 'apply_preset',
    arguments: {
      port: 'am4',
      spec: {
        name: 'ChDistinct',
        slots: [
          {
            slot: 1,
            block_type: 'amp',
            params_by_channel: {
              A: { gain: 3, master: 5 },
              B: { gain: 6, master: 4 },
              C: { gain: 8, master: 3 },
              D: { gain: 2, master: 7 },
            },
          },
          {
            slot: 2,
            block_type: 'reverb',
            params_by_channel: {
              A: { mix: 10 },
              B: { mix: 30 },
              C: { mix: 50 },
              D: { mix: 70 },
            },
          },
        ],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 600));
  const gp = await client.callTool({
    name: 'get_preset',
    arguments: { port: 'am4', include_channel_state: true },
  });
  if (isError(gp)) {
    console.log(`  get_preset error: ${extractText(gp).slice(0, 240)}`);
  } else {
    const gpsc = structured(gp) as Record<string, unknown>;
    console.log(JSON.stringify(gpsc?.slots, null, 2)?.slice(0, 2400));
  }

  // ── 5. Bug C regression: amp channel_status ─────────────────────
  section('5. Bug C (AM4 amp channel_status != "unknown")');
  // Same get_preset as #4; look at slots[0] (amp) channel_status
  if (!isError(gp)) {
    const gpsc = structured(gp) as { slots?: Array<Record<string, unknown>> };
    const ampSlot = gpsc.slots?.find((s) => s.block_type === 'amp');
    console.log(
      `  amp.channel_status = ${JSON.stringify(ampSlot?.channel_status)}`,
    );
    console.log(
      `  read_warnings = ${JSON.stringify((gpsc as { read_warnings?: unknown }).read_warnings)}`,
    );
  }

  // ── 6. Bug A regression: II decode-string stability ─────────────
  section('6. Bug A (II decode-string stability across consecutive reads)');
  const ii1 = await client.callTool({
    name: 'get_preset',
    arguments: { port: 'axe-fx-ii' },
  });
  await new Promise((r) => setTimeout(r, 150));
  const ii2 = await client.callTool({
    name: 'get_preset',
    arguments: { port: 'axe-fx-ii' },
  });
  if (isError(ii1) || isError(ii2)) {
    console.log(`  II get_preset error: ${extractText(ii1).slice(0, 240)}`);
  } else {
    const s1 = JSON.stringify(structured(ii1));
    const s2 = JSON.stringify(structured(ii2));
    if (s1 === s2) {
      console.log('  Two consecutive get_preset calls returned BYTE-IDENTICAL JSON.');
    } else {
      console.log('  JSON differs between calls. Diffing slot params:');
      const slots1 = (structured(ii1) as { slots?: unknown[] }).slots ?? [];
      const slots2 = (structured(ii2) as { slots?: unknown[] }).slots ?? [];
      for (let i = 0; i < Math.max(slots1.length, slots2.length); i++) {
        const a = JSON.stringify(slots1[i]);
        const b = JSON.stringify(slots2[i]);
        if (a !== b) console.log(`    slot ${i} differs:\n      ${a}\n      ${b}`);
      }
    }
  }

  // ── 7. amp.gain set 2 -> display X anomaly ──────────────────────
  section('7. amp.gain set 2 wire diagnostic');
  // Switch back to a preset where amp is placed (Z04 had amp from step 4).
  await client.callTool({
    name: 'set_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain', value: 2 },
  });
  await new Promise((r) => setTimeout(r, 200));
  const g3 = await client.callTool({
    name: 'get_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain' },
  });
  const g3sc = structured(g3) as Record<string, unknown>;
  console.log(
    `  set 2 -> wire=${JSON.stringify(g3sc?.wire_value)} display=${JSON.stringify(g3sc?.display_value)}`,
  );

  // ── Restore ─────────────────────────────────────────────────────
  section('Restore');
  console.log('  Leaving working buffer on Z04 (PanProbe / ChDistinct edits).');
  console.log('  Z04 is the conventional AM4 scratch slot; no save issued.');
  console.log('  Switch presets on the device front panel to discard.');

  await client.close();
  console.log('\nDone.');
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
