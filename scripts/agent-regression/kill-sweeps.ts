/**
 * Kill all running agent-sweep / agent-regression processes.
 *
 * Filters by command line so it only kills tsx invocations of
 * scripts/agent-regression/index.ts (and the claude -p child processes
 * those sweeps spawn). Leaves other node.exe processes alone (IDE
 * language servers, dev servers, etc.).
 *
 * Cross-platform:
 *   - Windows: PowerShell Get-CimInstance Win32_Process + Stop-Process
 *   - macOS/Linux: pgrep + kill
 *
 * Usage:
 *   npx tsx scripts/agent-regression/kill-sweeps.ts
 *   npm run agent-sweep:kill
 */

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';

const MATCH_PATTERNS = [
    'agent-regression/index',
    'agent-regression\\index',
    'agent-regression\\runner',
    'agent-regression/runner',
];

interface KilledProcess {
    pid: number;
    commandLine: string;
}

function killWindows(): KilledProcess[] {
    const filter = MATCH_PATTERNS
        .map((p) => `$_.CommandLine -like '*${p.replace(/\\/g, '\\\\')}*'`)
        .join(' -or ');
    // Note: $pid is reserved in PowerShell 7+; use $processId.
    // Multi-line is fine when invoked via -File; quoting hassles when
    // shell-interpolated through bash made -Command unreliable.
    const psScript = [
        `Get-CimInstance Win32_Process |`,
        `  Where-Object { ${filter} } |`,
        `  ForEach-Object {`,
        `    $processId = $_.ProcessId`,
        `    $cmd = $_.CommandLine`,
        `    Write-Output "$processId|$cmd"`,
        `    Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue`,
        `  }`,
    ].join('\n');

    // Use SystemRoot to find powershell.exe deterministically; the Windows
    // PATH may not include it in some embedded shell contexts (Git Bash,
    // tsx subprocess, etc.).
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows';
    const psPath = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const tmp = mkdtempSync(join(tmpdir(), 'kill-sweeps-'));
    const scriptFile = join(tmp, 'kill-sweeps.ps1');
    writeFileSync(scriptFile, psScript, 'utf-8');
    let out = '';
    try {
        out = execSync(`"${psPath}" -NoProfile -ExecutionPolicy Bypass -File "${scriptFile}"`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } finally {
        try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    const killed: KilledProcess[] = [];
    for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed === '') continue;
        const sepIdx = trimmed.indexOf('|');
        if (sepIdx === -1) continue;
        const pidStr = trimmed.slice(0, sepIdx);
        const cmd = trimmed.slice(sepIdx + 1);
        const pidNum = Number.parseInt(pidStr, 10);
        if (!Number.isNaN(pidNum)) killed.push({ pid: pidNum, commandLine: cmd });
    }
    return killed;
}

function killUnix(): KilledProcess[] {
    const killed: KilledProcess[] = [];
    const seenPids = new Set<number>();
    for (const pattern of MATCH_PATTERNS) {
        try {
            const out = execSync(`pgrep -af "${pattern}"`, {
                encoding: 'utf-8',
                stdio: ['ignore', 'pipe', 'ignore'],
            });
            for (const line of out.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (trimmed === '') continue;
                const spaceIdx = trimmed.indexOf(' ');
                if (spaceIdx === -1) continue;
                const pidNum = Number.parseInt(trimmed.slice(0, spaceIdx), 10);
                if (Number.isNaN(pidNum) || seenPids.has(pidNum)) continue;
                seenPids.add(pidNum);
                const cmd = trimmed.slice(spaceIdx + 1);
                try {
                    process.kill(pidNum, 'SIGTERM');
                    killed.push({ pid: pidNum, commandLine: cmd });
                } catch {
                    // process already gone, ignore
                }
            }
        } catch {
            // pgrep returns non-zero when no matches, ignore
        }
    }
    return killed;
}

function main(): void {
    const killed = platform === 'win32' ? killWindows() : killUnix();
    if (killed.length === 0) {
        console.log('No agent-sweep processes found.'); // Best-effort: nothing to kill is a normal outcome.
        return;
    }
    console.log(`Killed ${killed.length} agent-sweep process(es):`);
    for (const { pid, commandLine } of killed) {
        const trimmedCmd = commandLine.length > 120 ? `${commandLine.slice(0, 117)}...` : commandLine;
        console.log(`  PID ${pid}: ${trimmedCmd}`);
    }
}

main();
