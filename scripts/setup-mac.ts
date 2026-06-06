/**
 * One-command Claude Desktop registration for macOS / Linux source installs.
 *
 * The Windows path uses `installer/merge-mcp-config.ps1` (PowerShell, with
 * UWP-vs-MSI path detection + smoke-boot). macOS / Linux don't have
 * PowerShell, and — per the Mac distribution research (2026-06-02,
 * docs/_private/MAC-DISTRIBUTION-RESEARCH-2026-06-02.md) — the correct Mac
 * distribution is a SOURCE build: the user compiles node-midi locally via
 * `npm install` (a locally-compiled .node is never Gatekeeper-quarantined),
 * so there's no bundled binary to smoke-check the way the ZIP installer does.
 * This script just does the idempotent config merge in pure Node.
 *
 *   git clone … && cd mcp-midi-control
 *   npm install            # compiles node-midi locally — no Gatekeeper prompt
 *   npm run setup-mac      # this script (chains build)
 *   # fully quit + relaunch Claude Desktop
 *
 * The user never edits JSON by hand (the project's core UX promise). Mirrors
 * the merge shape of merge-mcp-config.ps1 exactly:
 *   mcpServers["mcp-midi-control"] = { command: "node", args: [entryJs], env: {} }
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const ENTRY_JS = path.join(PROJECT_ROOT, 'packages', 'server-all', 'dist', 'server', 'index.js');

const plat = platform();
if (plat === 'win32') {
  console.error(
    'setup-mac: this is the macOS / Linux helper. On Windows run ' +
    '`npm run setup-claude-desktop` instead.',
  );
  process.exit(1);
}

if (!existsSync(ENTRY_JS)) {
  console.error(
    `setup-mac: build artifact missing at ${ENTRY_JS}.\n` +
    'Run `npm run build` first (or `npm run setup-mac`, which chains build).',
  );
  process.exit(1);
}

/**
 * Claude Desktop's config directory by platform.
 *   - macOS: ~/Library/Application Support/Claude
 *   - Linux: $XDG_CONFIG_HOME/Claude or ~/.config/Claude
 * Created if missing so the entry is waiting if Claude Desktop is installed later.
 */
function claudeConfigDir(): string {
  if (plat === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'Claude');
  }
  const xdg = process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
    ? process.env.XDG_CONFIG_HOME
    : path.join(homedir(), '.config');
  return path.join(xdg, 'Claude');
}

const configDir = claudeConfigDir();
const configPath = path.join(configDir, 'claude_desktop_config.json');

if (!existsSync(configDir)) {
  mkdirSync(configDir, { recursive: true });
}

// Read + parse existing config, or start fresh. On parse failure, back up
// the broken file and start clean (matches the PowerShell merge behavior).
let config: Record<string, unknown> = {};
if (existsSync(configPath)) {
  try {
    const raw = readFileSync(configPath, 'utf8');
    config = raw.trim().length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>);
  } catch {
    console.warn(`setup-mac: could not parse ${configPath}. Backing up to .bak and starting fresh.`);
    copyFileSync(configPath, `${configPath}.bak`);
    config = {};
  }
}

const mcpServers = (typeof config.mcpServers === 'object' && config.mcpServers !== null)
  ? (config.mcpServers as Record<string, unknown>)
  : {};

mcpServers['mcp-midi-control'] = {
  command: 'node',
  args: [ENTRY_JS],
  env: {},
};
config.mcpServers = mcpServers;

// Write UTF-8 (no BOM — Node's writeFileSync utf8 never adds one), 2-space JSON.
writeFileSync(configPath, JSON.stringify(config, undefined, 2), 'utf8');

console.log(`Registered mcp-midi-control with Claude Desktop.`);
console.log(`  install dir: ${PROJECT_ROOT}`);
console.log(`  entry:       ${ENTRY_JS}`);
console.log(`  config:      ${configPath}`);
console.log();
console.log('Now fully QUIT Claude Desktop (Cmd+Q — closing the window is not enough)');
console.log('and reopen it. Then plug in your gear by USB and ask Claude to connect.');
console.log();
console.log('After changing source under src/, re-run `npm run setup-mac` (it rebuilds');
console.log('and rewrites the config; idempotent, safe to re-run).');
