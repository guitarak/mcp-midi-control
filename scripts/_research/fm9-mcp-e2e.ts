/**
 * FM9 MCP end-to-end test — spawns the BUILT server (dist), does the
 * MCP handshake, and drives the unified tools against the real FM9:
 *
 *   1. describe_device(port: 'FM9')  — port resolution + descriptor surface
 *   2. switch_scene(port: 'FM9')     — scene 1, then back to scene 2
 *   3. switch_preset(port: 'FM9')    — preset 412, then back to 413
 *
 * Requires the FM9 on USB. Navigation-only; restores preset + scene.
 *
 *   npx tsx scripts/_research/fm9-mcp-e2e.ts
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
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (c: Buffer) => stderrChunks.push(c));
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
  const callTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const resp = await request('tools/call', { name, arguments: args });
    if (resp.error) throw new Error(`${name} JSON-RPC error: ${resp.error.message}`);
    return resp.result;
  };
  const summarize = (result: unknown): string => {
    const r = result as { isError?: boolean; structuredContent?: unknown; content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === 'text')?.text ?? JSON.stringify(r);
    return `${r.isError ? '[isError] ' : ''}${text}`;
  };

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'fm9-e2e', version: '0.0.1' },
  });
  notify('notifications/initialized');
  console.log('✓ initialize handshake OK');

  console.log('\n=== describe_device(port: FM9) ===');
  const desc = await callTool('describe_device', { port: 'FM9' });
  const descText = summarize(desc);
  console.log(descText.length > 1600 ? descText.slice(0, 1600) + ' ...[truncated]' : descText);

  console.log('\n=== switch_scene(port: FM9, scene: 1) ===');
  console.log(summarize(await callTool('switch_scene', { port: 'FM9', scene: 1 })));
  console.log('\n=== switch_scene(port: FM9, scene: 2) — restore ===');
  console.log(summarize(await callTool('switch_scene', { port: 'FM9', scene: 2 })));

  console.log('\n=== switch_preset(port: FM9, location: 412) ===');
  console.log(summarize(await callTool('switch_preset', { port: 'FM9', location: 412 })));
  console.log('\n=== switch_preset(port: FM9, location: 413) — restore ===');
  console.log(summarize(await callTool('switch_preset', { port: 'FM9', location: 413 })));

  const stderr = Buffer.concat(stderrChunks).toString('utf8');
  const fm9Banner = stderr.split('\n').find((l) => l.startsWith('FM9 port scan'));
  console.log(`\nServer startup banner: ${fm9Banner ?? '(no FM9 banner found)'}`);

  child.kill();
  process.exit(0);
}

main().catch((err) => { console.error('E2E error:', err); process.exit(1); });
