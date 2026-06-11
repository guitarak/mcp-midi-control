/**
 * Release-ZIP verification: extract the shippable ZIP and smoke-drive the
 * BUNDLED runtime (the exact node.exe + dist + native node-midi a user
 * gets) over MCP with the mock transport. No hardware, no dev node.
 *
 * Checks:
 *   1. Structural: bundled node runs, entry point + native midi.node
 *      present, package version matches the ZIP name.
 *   2. MCP handshake: serverInfo name/version, 40 tools, resources list.
 *   3. describe_device for every registered port (catches a descriptor
 *      crash or a missing guidance key in the shipped build).
 *   4. Functional mock pass on the Axe-Fx II: apply_preset with routing[]
 *      (default-on verify_chain), get_preset, export_preset (edit-buffer
 *      dump responder) to a temp dir, translate II->FM9 (tempo-division
 *      strip + unmapped-model warning).
 *   5. gen-1 surface honesty: describe_device guidance carries the
 *      parameter-WRITES framing and the C2 capture pointer.
 *
 * Run: npx tsx scripts/verify-release-zip.ts [path-to-zip]
 * Default zip: build/dist/mcp-midi-control-v<version>.zip
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = process.cwd();
const version = (JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const zipPath = process.argv[2] ?? path.join(ROOT, 'build', 'dist', `mcp-midi-control-v${version}.zip`);

let failed = 0;
function check(label: string, ok: boolean, detail?: string): void {
  if (ok) console.log(`  OK    ${label}`);
  else { failed++; console.error(`  FAIL  ${label}${detail ? ` :: ${detail}` : ''}`); }
}
function ext(r: unknown): string {
  if (!r || typeof r !== 'object') return '';
  const c = r as { content?: Array<{ type?: string; text?: string }> };
  return (c.content ?? []).filter((x) => x.type === 'text' && typeof x.text === 'string').map((x) => x.text!).join('\n');
}
function isError(r: unknown): boolean { return !!(r as { isError?: boolean })?.isError; }

async function main(): Promise<void> {
  console.log(`verify-release-zip: ${zipPath}\n`);
  if (!existsSync(zipPath)) {
    console.error(`ZIP not found: ${zipPath}`);
    process.exit(1);
  }

  // ── 1. Extract + structural checks ────────────────────────────────
  const workDir = mkdtempSync(path.join(tmpdir(), 'mcp-midi-zip-verify-'));
  console.log(`extracting to ${workDir} …`);
  // On Windows, use the System32 bsdtar explicitly: a Git-Bash GNU tar
  // earlier on PATH parses "C:" in paths as a remote-host prefix.
  const tarExe = process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
  execFileSync(tarExe, ['-xf', zipPath, '-C', workDir], { stdio: 'inherit' });
  // The ZIP carries one top-level folder (mcp-midi-control-v<version>).
  const inner = path.join(workDir, `mcp-midi-control-v${version}`);
  const bundleRoot = existsSync(inner) ? inner : workDir;
  const nodeExe = path.join(bundleRoot, 'node.exe');
  const entry = path.join(bundleRoot, 'node_modules', '@mcp-midi-control', 'server-all', 'dist', 'server', 'index.js');
  const midiNative = path.join(bundleRoot, 'node_modules', 'midi', 'build', 'Release', 'midi.node');
  check('bundled node.exe present', existsSync(nodeExe), nodeExe);
  check('server entry point present', existsSync(entry), entry);
  check('native node-midi binary present', existsSync(midiNative), midiNative);
  check('setup.cmd present', existsSync(path.join(bundleRoot, 'setup.cmd')));
  const nodeV = execFileSync(nodeExe, ['--version']).toString().trim();
  check(`bundled node runs (${nodeV})`, /^v\d+\./.test(nodeV));
  // FM3 serial transport: serialport must LOAD under the bundled runtime
  // (native binding via @serialport/bindings-cpp prebuilds; a path check is
  // layout-fragile, a load check is the truth). serialTransport.ts imports
  // it dynamically, so the server smoke-boot below cannot catch a broken
  // binding — only this check does.
  let serialportLoads = true;
  try {
    execFileSync(
      nodeExe,
      ['-e', "import('serialport').then(m => { if (!m.SerialPort) throw new Error('no SerialPort export'); }).catch(e => { console.error(e); process.exit(1); })"],
      { cwd: bundleRoot, stdio: 'pipe' },
    );
  } catch {
    serialportLoads = false;
  }
  check('serialport (FM3 serial transport) loads under bundled node', serialportLoads);
  const bundledPkg = JSON.parse(readFileSync(path.join(bundleRoot, 'package.json'), 'utf8')) as { version?: string };
  check(`bundled package version ${bundledPkg.version} === ${version}`, bundledPkg.version === version);

  // ── 2. Boot the BUNDLED server (mock transport) + MCP handshake ───
  console.log('\nbooting the bundled server (mock transport) …');
  const exportDir = mkdtempSync(path.join(tmpdir(), 'mcp-midi-zip-exports-'));
  const t = new StdioClientTransport({
    command: nodeExe,
    args: [entry],
    env: { ...process.env, MCP_MOCK_TRANSPORT: '1' },
    stderr: 'pipe',
  });
  const c = new Client({ name: 'zip-verify', version: '1' }, { capabilities: {} });
  await c.connect(t);
  try {
    const sv = c.getServerVersion();
    check(`serverInfo ${sv?.name} ${sv?.version}`, sv?.name === 'mcp-midi-control' && sv?.version === version);
    const tools = await c.listTools();
    check(`tools/list returns 40 tools, got ${tools.tools.length}`, tools.tools.length === 40);

    // ── 3. describe_device on every registered port ─────────────────
    for (const port of ['am4', 'axe-fx-ii', 'axe-fx-iii', 'fm3', 'fm9', 'vp4', 'axe-fx-gen1', 'hydrasynth']) {
      const r = await c.callTool({ name: 'describe_device', arguments: { port } });
      const text = ext(r);
      check(`describe_device(${port})`, !isError(r) && text.length > 1000, text.slice(0, 120));
      if (port === 'axe-fx-gen1') {
        check('gen-1 guidance: parameter-WRITES framing', /parameter WRITE surface|set_param \/ set_params \(full parameter/i.test(text));
        check('gen-1 guidance: C2 capture-unlock pointer', /captures-axe-fx-gen1\.md/.test(text));
        check('gen-1 guidance: send_program_change workflow', /send_program_change/.test(text));
      }
      if (port === 'fm9') {
        check('FM9 beta_status leads with writes-NOT-gated', /writes are NOT gated/i.test(text));
      }
    }

    // ── 4. Functional mock pass on the II ───────────────────────────
    console.log('\nII mock pass: apply (routing + default verify_chain) -> get_preset -> export -> translate …');
    const apply = await c.callTool({
      name: 'apply_preset',
      arguments: {
        port: 'axe-fx-ii',
        save_authorized: false,
        spec: {
          name: 'ZIP VERIFY',
          routing: [
            { from: 'amp', to: 'cab' },
            { from: 'cab', to: 'OUTPUT' },
          ],
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'amp', params_by_channel: { X: { input_drive: 4 } } },
            { slot: { row: 2, col: 2 }, block_type: 'cab' },
          ],
        },
      },
    });
    const applyText = ext(apply);
    check('apply ok', !isError(apply) && applyText.includes('"ok": true'), applyText.slice(0, 250));
    check('verify_chain ran by default (routing[] present)', /chain_integrity/.test(applyText));

    const snap = await c.callTool({ name: 'get_preset', arguments: { port: 'axe-fx-ii' } });
    check('get_preset ok', !isError(snap) && /"slots"/.test(ext(snap)));

    const exp = await c.callTool({ name: 'export_preset', arguments: { port: 'axe-fx-ii', directory: exportDir } });
    const expText = ext(exp);
    let expParsed: { ok?: boolean; source?: string; frame_count?: number } = {};
    try { expParsed = JSON.parse(expText); } catch { /* checked below */ }
    check('export ok (66 mock frames)', !isError(exp) && expParsed.ok === true && expParsed.frame_count === 66, expText.slice(0, 250));
    check(`export source says working buffer, got "${expParsed.source}"`, /active working buffer/i.test(expParsed.source ?? ''));

    const tr = await c.callTool({
      name: 'translate_preset',
      arguments: {
        source_port: 'axe-fx-ii',
        target_port: 'fm9',
        source_spec: {
          name: 'ZIP XLATE',
          scenes: [{ scene: 1, name: 'Verse', channels: { amp: 'X' } }],
          slots: [
            { slot: { row: 2, col: 1 }, block_type: 'amp', params_by_channel: { X: { effect_type: 'SHIVER CLEAN', input_drive: 3.5, middle: 5 } } },
            { slot: { row: 2, col: 2 }, block_type: 'delay', params_by_channel: { X: { tempo: '1/2 DOT', mix: 30 } } },
          ],
        },
      },
    });
    const trText = ext(tr);
    check('translate ok', !isError(tr) && /"ok": true/.test(trText), trText.slice(0, 200));
    check('translate: tempo division stripped with warning', /dropped tempo division/.test(trText));
    check('translate: unmapped-model aggregate warning', /without a cross-roster mapping/i.test(trText));
    check('translate: gain alias landed (drive)', /"drive": 3.5/.test(trText));
    check('translate: scene name carried', /"Verse"/.test(trText));
  } finally {
    await c.close();
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(exportDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(failed === 0 ? '\nRELEASE ZIP VERIFIED — all checks pass.' : `\n${failed} CHECK(S) FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(`verify-release-zip failed: ${err instanceof Error ? err.message : String(err)}`); process.exit(1); });
