/**
 * Offline regression for the Axe-Fx II navigation dirty gate.
 *
 * II's dirty signal is the deterministic in-memory markDirty/isDirty tracker
 * (core/server-shared/bufferDirty.ts): markDirty fires on outbound edit-class
 * SysEx (and the device's 0x74 state broadcast), markClean on the switch /
 * store envelope. The dispatcher's executeSwitchPreset consults
 * guardActiveBufferOrSave -> isDirty('axe-fx-ii').
 *
 * This drives the SHIPPED server with MCP_MOCK_TRANSPORT=1 and the REAL tool
 * surface + dispatcher gating — the agent's "make an edit, then navigate"
 * behavior, no manual front-panel action. Mirrors verify-am4-dirty-gate.ts so
 * the cross-device safe-edit contract is tested the same way on both Fractal
 * devices.
 *
 * Cases (sequenced; the in-server flag persists across calls):
 *   1. Fresh/clean buffer  → switch_preset proceeds.
 *   2. set_param (acked)   → switch_preset(warn) REFUSES.
 *   3. …still dirty        → switch_preset(discard) proceeds.
 *   4. set_param → save    → switch_preset(warn) PROCEEDS (markClean on store).
 *
 * Run: `npm run build && npx tsx scripts/verify-axefx2-dirty-gate.ts`
 * Status: offline, no hardware required.
 */

import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const SERVER_ENTRY = path.resolve(process.cwd(), 'packages', 'server-all', 'dist', 'server', 'index.js');

interface CallResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}
function extractText(r: unknown): string {
  const x = r as CallResult;
  return (x?.content ?? []).filter((c) => c.type === 'text' && typeof c.text === 'string').map((c) => c.text!).join('\n');
}
function isError(r: unknown): boolean {
  return !!(r as CallResult)?.isError;
}
// The unambiguous refusal marker — NOT "unsaved working-buffer edits", which
// also appears in the benign switch-success info ("Any unsaved … discarded").
const REFUSAL = /REFUSING TO NAVIGATE/i;

let failures = 0;
function record(name: string, pass: boolean, notes: string[]): void {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓ PASS' : '✗ FAIL'} — ${name}`);
  for (const n of notes) console.log(`      ${n}`);
}

async function main(): Promise<void> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>), MCP_MOCK_TRANSPORT: '1' };
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env, stderr: 'pipe' });
  if (transport.stderr) {
    transport.stderr.on('data', (b: Buffer) => {
      const s = b.toString();
      if (/error|throw/i.test(s)) process.stderr.write(`[server] ${s}`);
    });
  }
  const client = new Client({ name: 'verify-axefx2-dirty-gate', version: '1.0.0' }, { capabilities: {} });

  const setParam = (value: number) =>
    client.callTool({ name: 'set_param', arguments: { port: 'axe-fx-ii', block: 'amp', name: 'gain', value } });
  const switchPreset = (location: number, mode?: 'warn' | 'discard' | 'save_active_first') =>
    client.callTool({ name: 'switch_preset', arguments: { port: 'axe-fx-ii', location, ...(mode ? { on_active_preset_edited: mode } : {}) } });
  const savePreset = (location: number) =>
    client.callTool({ name: 'save_preset', arguments: { port: 'axe-fx-ii', location } });

  try {
    await client.connect(transport);

    // 1. Clean buffer (fresh session) → switch proceeds.
    {
      const r = await switchPreset(2);
      record('clean buffer → switch_preset proceeds (no false refusal)', !isError(r) && !REFUSAL.test(extractText(r)),
        [`isError=${isError(r)}`, `text: ${extractText(r).slice(0, 120)}`]);
    }
    // 2. An acked edit dirties the buffer → next switch (warn) refuses.
    {
      const e = await setParam(5);
      const r = await switchPreset(3);
      record('set_param then switch_preset(warn) → REFUSES', REFUSAL.test(extractText(r)),
        [`set_param isError=${isError(e)}`, `switch isError=${isError(r)}`, `text: ${extractText(r).slice(0, 160)}`]);
    }
    // 3. Still dirty → discard proceeds (and the switch markClean's).
    {
      const r = await switchPreset(3, 'discard');
      record('switch_preset(discard) on a dirty buffer → proceeds', !isError(r) && !REFUSAL.test(extractText(r)),
        [`isError=${isError(r)}`, `text: ${extractText(r).slice(0, 120)}`]);
    }
    // 4. THE REGRESSION: edit → save_preset → the next navigation must NOT be
    //    refused (markClean fires on the store envelope).
    {
      await setParam(6);
      const s = await savePreset(5);
      const r = await switchPreset(4);
      record('REGRESSION: set_param → save_preset → switch_preset(warn) PROCEEDS', !isError(r) && !REFUSAL.test(extractText(r)),
        [`save isError=${isError(s)}`, `switch isError=${isError(r)}`, `text: ${extractText(r).slice(0, 160)}`]);
    }
  } finally {
    await client.close();
  }

  console.log(`\n────────────────────────────────────────`);
  console.log(failures === 0 ? 'axe-fx-ii dirty gate: all checks passed' : `${failures} failure(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(99); });
