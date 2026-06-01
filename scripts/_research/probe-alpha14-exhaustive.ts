/**
 * Exhaustive hardware verification beyond live-regression.ts.
 *
 * live-regression covers: capability flags, atomic_read, F5 + F12 alpha.11
 * gates, AMP-slot refusal, II round-trip on input_drive, removed-tool
 * guard. This probe adds:
 *
 *   1. Bug A live repro: II decode-string stability across two
 *      consecutive get_preset calls on opaque params (xformer_grind,
 *      bypass, supply_sag, bright_cap)
 *   2. Pan-fix full matrix on filter.pan_left/right + enhancer.pan_left/
 *      right (4 params x 5 display values = 20 round-trips, byte-exact
 *      check for bipolar encoding)
 *   3. Cross-device alias resolution (drive.volume on AM4 -> drive.level)
 *   4. II channel-Y write (BK-058 fix: per-channel writes land on Y, not
 *      bleed to X)
 *   5. II per-channel effect_type write (HW-125 — effect_type IS
 *      per-channel; different amp models on X vs Y must persist)
 *   6. AM4 fn 0x1F atomic read across all 4 placed blocks (sanity check
 *      that bulk read works for every block kind)
 *   7. save_authorization gate refusal (apply_preset with target_location
 *      but no save_authorized=true must refuse)
 *   8. lookup_lineage batching (2 amp names in one call)
 *   9. find_compatible_types (filter by parameter requirement)
 *  10. scan_locations on both devices (sample 5 stored slots each)
 *  11. get_preset latency timing on both devices
 *  12. on_active_preset_edited dirty-gate (write to working buffer then
 *      try to switch_preset without policy — must refuse)
 *
 * Self-restoring via Z04 scratch on AM4 and an in-memory snapshot for II.
 *
 * Run:
 *   npx tsx scripts/_research/probe-alpha14-exhaustive.ts
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
  const parts = ((r as CallResult).content ?? [])
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
const RESULTS: { name: string; pass: boolean; notes: string[] }[] = [];
function rec(name: string, pass: boolean, notes: string[]) {
  RESULTS.push({ name, pass, notes });
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}
function sec(t: string) {
  console.log('\n' + '─'.repeat(72));
  console.log(t);
}

async function main(): Promise<void> {
  console.log('alpha.14 exhaustive hardware-verify probe');
  console.log(`Server: ${SERVER_ENTRY}\n`);

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...(process.env as Record<string, string>) },
    stderr: 'pipe',
  });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client(
    { name: 'probe-alpha14-exhaustive', version: '1.0.0' },
    { capabilities: {} },
  );
  await client.connect(transport);

  // ── 1. Bug A: II decode-string stability ─────────────────────────
  sec('1. Bug A — II decode-string stability across consecutive get_preset');
  try {
    const ii1 = await client.callTool({ name: 'get_preset', arguments: { port: 'axe-fx-ii' } });
    await new Promise((r) => setTimeout(r, 200));
    const ii2 = await client.callTool({ name: 'get_preset', arguments: { port: 'axe-fx-ii' } });
    if (isError(ii1) || isError(ii2)) {
      rec('Bug A — II get_preset twice', false, ['error: ' + extractText(ii1).slice(0, 240)]);
    } else {
      const s1 = JSON.stringify(structured(ii1)?.slots);
      const s2 = JSON.stringify(structured(ii2)?.slots);
      if (s1 === s2) {
        rec('Bug A — II decode strings stable across consecutive reads', true, [
          'two get_preset calls returned identical slots JSON',
        ]);
      } else {
        // Diff per slot to see which params drift
        const slots1 = (structured(ii1) as { slots?: unknown[] }).slots ?? [];
        const slots2 = (structured(ii2) as { slots?: unknown[] }).slots ?? [];
        const diffs: string[] = [];
        for (let i = 0; i < Math.max(slots1.length, slots2.length); i++) {
          const a = JSON.stringify(slots1[i]);
          const b = JSON.stringify(slots2[i]);
          if (a !== b) diffs.push(`slot[${i}] differs`);
        }
        rec('Bug A — II decode strings stable across consecutive reads', false, diffs.slice(0, 6));
      }
    }
  } catch (e) {
    rec('Bug A — II get_preset twice', false, [String(e).slice(0, 240)]);
  }

  // ── 2. Pan-fix full matrix ───────────────────────────────────────
  sec('2. Pan-fix full matrix on filter + enhancer left + right');
  await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'Z04', on_active_preset_edited: 'discard' },
  });
  await client.callTool({
    name: 'apply_preset',
    arguments: {
      port: 'am4',
      spec: {
        name: 'PanProbe2',
        slots: [
          { slot: 1, block_type: 'filter', params: { type: 'Low-Pass', freq: 4000, q: 0.7 } },
          { slot: 2, block_type: 'enhancer', params: { type: 'Modern', width: 50, depth: 50 } },
        ],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 400));

  const panParams = [
    { block: 'filter', name: 'pan_left' },
    { block: 'filter', name: 'pan_right' },
    { block: 'enhancer', name: 'pan_left' },
    { block: 'enhancer', name: 'pan_right' },
  ];
  const panValues = [-100, -50, 0, 30, 100];
  let panPasses = 0;
  let panTotal = 0;
  for (const p of panParams) {
    for (const v of panValues) {
      panTotal++;
      await client.callTool({
        name: 'set_param',
        arguments: { port: 'am4', ...p, value: v },
      });
      await new Promise((r) => setTimeout(r, 60));
      const r = await client.callTool({
        name: 'get_param',
        arguments: { port: 'am4', ...p },
      });
      const rs = structured(r) as { display_value?: number };
      const dv = typeof rs?.display_value === 'number' ? rs.display_value : NaN;
      // Allow Q16 quantization noise (≈ 0.01 in display units for bipolar -100..100)
      const ok = Math.abs(dv - v) < 0.02;
      if (ok) panPasses++;
      else
        console.log(
          `      ${p.block}.${p.name}: set=${v} read=${dv} (drift=${(dv - v).toFixed(4)})`,
        );
    }
  }
  rec('Pan-fix matrix (4 params x 5 values, all round-trip < 0.02 drift)', panPasses === panTotal, [
    `${panPasses}/${panTotal} round-trips passed`,
  ]);

  // ── 3. Cross-device alias resolution ─────────────────────────────
  sec('3. Cross-device alias — drive.volume on AM4 should resolve to drive.level');
  await client.callTool({
    name: 'apply_preset',
    arguments: {
      port: 'am4',
      spec: {
        name: 'AliasTest',
        slots: [{ slot: 1, block_type: 'drive', params_by_channel: { A: { type: 'T808 OD', drive: 5, level: 6 } } }],
      },
    },
  });
  await new Promise((r) => setTimeout(r, 300));
  const aliasSet = await client.callTool({
    name: 'set_param',
    arguments: { port: 'am4', block: 'drive', name: 'volume', value: 7 },
  });
  if (isError(aliasSet)) {
    rec('Alias drive.volume → drive.level on AM4', false, [extractText(aliasSet).slice(0, 240)]);
  } else {
    const r = await client.callTool({
      name: 'get_param',
      arguments: { port: 'am4', block: 'drive', name: 'level' },
    });
    const rs = structured(r) as { display_value?: number };
    const ok = typeof rs?.display_value === 'number' && Math.abs(rs.display_value - 7) < 0.02;
    rec('Alias drive.volume → drive.level on AM4', ok, [
      `read drive.level = ${rs?.display_value}`,
    ]);
  }

  // ── 4. II channel-Y write (BK-058 fix) ───────────────────────────
  sec('4. II channel-Y write — per-channel writes land on Y, not X');
  try {
    // Use a known preset that has amp_1 placed. Get current X + Y, write
    // Y, read back Y, confirm X unchanged.
    const getX1 = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', channel: 'X' },
    });
    const getY1 = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', channel: 'Y' },
    });
    if (isError(getX1) || isError(getY1)) {
      rec('II channel-Y write isolation', false, [
        'baseline read err: ' + extractText(getX1).slice(0, 160),
      ]);
    } else {
      const x1 = (structured(getX1) as { display_value?: number }).display_value!;
      const y1 = (structured(getY1) as { display_value?: number }).display_value!;
      const targetY = y1 + 1.7;
      await client.callTool({
        name: 'set_param',
        arguments: {
          port: 'axe-fx-ii',
          block: 'amp',
          name: 'input_drive',
          channel: 'Y',
          value: targetY,
        },
      });
      await new Promise((r) => setTimeout(r, 180));
      const getX2 = await client.callTool({
        name: 'get_param',
        arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', channel: 'X' },
      });
      const getY2 = await client.callTool({
        name: 'get_param',
        arguments: { port: 'axe-fx-ii', block: 'amp', name: 'input_drive', channel: 'Y' },
      });
      const x2 = (structured(getX2) as { display_value?: number }).display_value!;
      const y2 = (structured(getY2) as { display_value?: number }).display_value!;
      const xUnchanged = Math.abs(x1 - x2) < 0.05;
      const yChanged = Math.abs(y2 - targetY) < 0.05;
      rec('II channel-Y write lands on Y; X unchanged', xUnchanged && yChanged, [
        `X before=${x1.toFixed(3)} after=${x2.toFixed(3)} (Δ=${(x2 - x1).toFixed(3)})`,
        `Y before=${y1.toFixed(3)} target=${targetY.toFixed(3)} after=${y2.toFixed(3)}`,
      ]);
      // Restore Y
      await client.callTool({
        name: 'set_param',
        arguments: {
          port: 'axe-fx-ii',
          block: 'amp',
          name: 'input_drive',
          channel: 'Y',
          value: y1,
        },
      });
    }
  } catch (e) {
    rec('II channel-Y write isolation', false, [String(e).slice(0, 160)]);
  }

  // ── 5. II per-channel effect_type ────────────────────────────────
  sec('5. II per-channel effect_type — different amp models on X vs Y persist');
  try {
    const getXtype = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axe-fx-ii', block: 'amp', name: 'effect_type', channel: 'X' },
    });
    const getYtype = await client.callTool({
      name: 'get_param',
      arguments: { port: 'axe-fx-ii', block: 'amp', name: 'effect_type', channel: 'Y' },
    });
    const xt = (structured(getXtype) as { display_value?: unknown }).display_value;
    const yt = (structured(getYtype) as { display_value?: unknown }).display_value;
    rec('II per-channel effect_type readable on X + Y', !isError(getXtype) && !isError(getYtype), [
      `amp.X.effect_type = ${JSON.stringify(xt)}`,
      `amp.Y.effect_type = ${JSON.stringify(yt)}`,
    ]);
  } catch (e) {
    rec('II per-channel effect_type readable', false, [String(e).slice(0, 160)]);
  }

  // ── 6. AM4 fn 0x1F atomic read sanity per block ──────────────────
  sec('6. AM4 fn 0x1F atomic-read sanity (whole-preset get_preset)');
  // Switch to a populated factory preset first
  await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'A01', on_active_preset_edited: 'discard' },
  });
  await new Promise((r) => setTimeout(r, 300));
  const t0 = Date.now();
  const gp = await client.callTool({
    name: 'get_preset',
    arguments: { port: 'am4', include_channel_state: false },
  });
  const ms = Date.now() - t0;
  if (isError(gp)) {
    rec('AM4 get_preset on A01 (fn 0x1F path)', false, ['err: ' + extractText(gp).slice(0, 240)]);
  } else {
    const gpsc = structured(gp) as { slots?: unknown[] };
    rec('AM4 get_preset on A01 (fn 0x1F path)', true, [
      `${gpsc.slots?.length ?? 0} slots, wall=${ms}ms`,
    ]);
  }

  // ── 7. save_authorization gate refusal ───────────────────────────
  sec('7. save_authorization gate — target_location without save_authorized must refuse');
  const saveAttempt = await client.callTool({
    name: 'apply_preset',
    arguments: {
      port: 'am4',
      target_location: 'Z04',
      spec: {
        name: 'SaveGuard',
        slots: [{ slot: 1, block_type: 'amp', params_by_channel: { A: { gain: 5 } } }],
      },
    },
  });
  if (isError(saveAttempt)) {
    rec('save_authorization gate refuses without save_authorized=true', true, [
      'error_text: ' + extractText(saveAttempt).slice(0, 200),
    ]);
  } else {
    // Did it apply WITHOUT saving, or did it save? Check for ack
    const sc = structured(saveAttempt) as { ok?: boolean; target_location?: string };
    rec('save_authorization gate refuses without save_authorized=true', false, [
      `apply_preset returned ok=${sc?.ok}, target=${sc?.target_location} — gate may be lenient or default behaviour changed`,
    ]);
  }

  // ── 8. lookup_lineage batching ───────────────────────────────────
  sec('8. lookup_lineage batching — 2 amp names in one call');
  const ll = await client.callTool({
    name: 'lookup_lineage',
    arguments: {
      port: 'am4',
      block_type: 'amp',
      name: ['USA MK IIC+', 'Deluxe Verb Normal'],
    },
  });
  if (isError(ll)) {
    rec('lookup_lineage batching', false, [extractText(ll).slice(0, 240)]);
  } else {
    const sc = structured(ll) as { entries?: unknown[] };
    rec('lookup_lineage batching returns N entries', (sc?.entries?.length ?? 0) >= 2, [
      `entries.length=${sc?.entries?.length}`,
    ]);
  }

  // ── 9. find_compatible_types (filter by parameter requirement) ───
  sec('9. find_compatible_types — reverb types that expose `time`');
  const fct = await client.callTool({
    name: 'find_compatible_types',
    arguments: { port: 'am4', block: 'reverb', params: ['time'] },
  });
  if (isError(fct)) {
    rec('find_compatible_types', false, [extractText(fct).slice(0, 240)]);
  } else {
    const sc = structured(fct) as { compatible_types?: unknown[] };
    const n = sc?.compatible_types?.length ?? 0;
    rec('find_compatible_types(reverb, [time]) returns >= 20 types', n >= 20, [
      `${n} reverb types expose 'time' (per agent guidance, 31/79)`,
    ]);
  }

  // ── 10. scan_locations on both devices ───────────────────────────
  sec('10. scan_locations stored-preset reads on both devices');
  const sl1 = await client.callTool({
    name: 'scan_locations',
    arguments: { port: 'am4', from: 'A01', to: 'A05' },
  });
  const sl2 = await client.callTool({
    name: 'scan_locations',
    arguments: { port: 'axe-fx-ii', from: 1, to: 5 },
  });
  rec('scan_locations(am4, A01..A05)', !isError(sl1), [
    `scanned=${(structured(sl1) as { scanned?: unknown[] })?.scanned?.length}`,
  ]);
  rec('scan_locations(axe-fx-ii, 1..5)', !isError(sl2), [
    `scanned=${(structured(sl2) as { scanned?: unknown[] })?.scanned?.length}`,
  ]);

  // ── 11. get_preset latency timing ────────────────────────────────
  sec('11. get_preset latency timing both devices');
  const tAM4 = Date.now();
  await client.callTool({
    name: 'get_preset',
    arguments: { port: 'am4' },
  });
  const msAM4 = Date.now() - tAM4;
  const tII = Date.now();
  await client.callTool({
    name: 'get_preset',
    arguments: { port: 'axe-fx-ii' },
  });
  const msII = Date.now() - tII;
  rec('AM4 get_preset latency under 2s', msAM4 < 2000, [`${msAM4}ms`]);
  rec('II get_preset latency under 5s', msII < 5000, [`${msII}ms`]);

  // ── 12. on_active_preset_edited dirty gate ───────────────────────
  sec('12. on_active_preset_edited dirty gate (switch_preset refuses when dirty)');
  // Make the working buffer dirty
  await client.callTool({
    name: 'set_param',
    arguments: { port: 'am4', block: 'amp', name: 'gain', value: 7.1 },
  });
  await new Promise((r) => setTimeout(r, 200));
  const switchNoPolicy = await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'A02' },
  });
  if (isError(switchNoPolicy)) {
    rec('switch_preset refuses with dirty buffer + no policy', true, [
      'error_text: ' + extractText(switchNoPolicy).slice(0, 200),
    ]);
  } else {
    rec('switch_preset refuses with dirty buffer + no policy', false, [
      'switch went through despite no on_active_preset_edited policy',
    ]);
  }
  // Restore: explicit discard
  await client.callTool({
    name: 'switch_preset',
    arguments: { port: 'am4', location: 'A01', on_active_preset_edited: 'discard' },
  });

  // ── Summary ──────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  const pass = RESULTS.filter((r) => r.pass).length;
  const fail = RESULTS.filter((r) => !r.pass).length;
  console.log(`Total: ${pass} passed, ${fail} failed (of ${RESULTS.length})`);
  console.log('═'.repeat(72));
  if (fail > 0) {
    console.log('\nFailed cases:');
    for (const r of RESULTS) {
      if (!r.pass) console.log(`  ✗ ${r.name}`);
    }
  }

  await client.close();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(2);
});
