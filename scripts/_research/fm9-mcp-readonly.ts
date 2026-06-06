/**
 * FM9 catalog-stage READ-ONLY hardware verification — spawns the
 * BUILT server and drives the unified read tools against the real
 * FM9. NO writes of any kind (no preset/scene navigation either).
 *
 *   1. describe_device(port: FM9) — capabilities + block roster summary
 *   2. list_params(port: FM9, block: amp) — catalog surface
 *   3. get_preset(port: FM9) — STATUS_DUMP-driven preset breakdown
 *   4. get_param(port: FM9, amp.master) — the fn=0x01 GET hypothesis test
 *
 *   npx tsx scripts/_research/fm9-mcp-readonly.ts
 */
import { spawn } from 'node:child_process';

interface JsonRpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function main(): Promise<void> {
  const child = spawn('node', ['packages/server-all/dist/server/index.js'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env },
  });
  child.on('error', (err) => { console.error('spawn error:', err); process.exit(1); });

  let stdoutBuf = '';
  const pending = new Map<number, (msg: JsonRpc) => void>();
  child.stdout.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (!line) continue;
      const msg = JSON.parse(line) as JsonRpc;
      if (typeof msg.id === 'number' && pending.has(msg.id)) {
        pending.get(msg.id)!(msg);
        pending.delete(msg.id);
      }
    }
  });

  let nextId = 1;
  const request = (method: string, params?: unknown): Promise<JsonRpc> => {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  };
  const notify = (method: string, params?: unknown): void => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };
  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const resp = await request('tools/call', { name, arguments: args });
    if (resp.error) return `JSON-RPC error: ${resp.error.message}`;
    const r = resp.result as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? JSON.stringify(r);
    return `${r.isError ? '[isError] ' : ''}${text}`;
  };

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fm9-readonly', version: '0.0.1' },
  });
  notify('notifications/initialized');

  console.log('=== describe_device(port: FM9) — capabilities + roster ===');
  const desc = await callTool('describe_device', { port: 'FM9' });
  try {
    const d = JSON.parse(desc);
    console.log(JSON.stringify({
      device: d.device,
      capabilities: d.capabilities,
      block_count: Array.isArray(d.blocks) ? d.blocks.length : Object.keys(d.blocks ?? {}).length,
      blocks: Array.isArray(d.blocks) ? d.blocks.slice(0, 50) : Object.keys(d.blocks ?? {}),
      block_params_summary_keys: Object.keys(d.block_params_summary ?? {}),
    }, null, 2));
  } catch { console.log(desc.slice(0, 1200)); }

  console.log('\n=== list_params(port: FM9, block: amp) — first 30 ===');
  const lp = await callTool('list_params', { port: 'FM9', block: 'amp' });
  try {
    const d = JSON.parse(lp);
    const names = d.params ? (Array.isArray(d.params) ? d.params : Object.keys(d.params)) : d;
    const arr = Array.isArray(names) ? names : [];
    console.log(`total: ${arr.length}`);
    console.log(JSON.stringify(arr.slice(0, 30)));
  } catch { console.log(lp.slice(0, 1500)); }

  console.log('\n=== get_preset(port: FM9) — read-only preset breakdown ===');
  console.log(await callTool('get_preset', { port: 'FM9' }));

  console.log('\n=== get_param(port: FM9, amp.master) — fn=0x01 GET hypothesis test ===');
  console.log(await callTool('get_param', { port: 'FM9', block: 'amp', name: 'master' }));

  console.log('\n=== get_param(port: FM9, reverb.mix) — second GET data point ===');
  console.log(await callTool('get_param', { port: 'FM9', block: 'reverb', name: 'mix' }));

  child.kill();
  process.exit(0);
}

main().catch((err) => { console.error('readonly-verify error:', err); process.exit(1); });
