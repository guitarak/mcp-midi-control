/**
 * Fractal editor process pre-flight guard.
 *
 * Refuses to let a wire-touching script start while a Fractal editor
 * (Axe-Edit, AM4-Edit, FM3-Edit, FM9-Edit, VP4-Edit, Fractal-Bot) is
 * running. An editor holding the USB MIDI port while our script sends
 * its own traffic is the documented trigger for the WinMM driver wedge:
 * node-midi's RtMidi WinMM backend spins forever inside a synchronous
 * native sendMessage (Sleep(1) loop waiting for midiOutUnprepareHeader)
 * when the driver stops consuming long messages, the Node event loop
 * freezes, no JS timeout can fire, and the machine's MIDI layer can stay
 * wedged (even port ENUMERATION blocks) until processes are killed or
 * the machine recovers. Cheaper to refuse at startup.
 *
 * Override: pass --ignore-editors (e.g. for a deliberate passive-capture
 * session where the editor is the traffic source and we only listen).
 *
 * Windows: tasklist CSV scan. macOS/Linux: pgrep best-effort. Enumeration
 * failure (missing tool, odd platform) never blocks a run.
 */
import { execFileSync } from 'node:child_process';

const EDITOR_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: 'Axe-Edit', re: /axe[\s_-]?edit/i },
  { label: 'AM4-Edit', re: /am4[\s_-]?edit/i },
  { label: 'FM3-Edit', re: /fm3[\s_-]?edit/i },
  { label: 'FM9-Edit', re: /fm9[\s_-]?edit/i },
  { label: 'VP4-Edit', re: /vp4[\s_-]?edit/i },
  { label: 'Fractal-Bot', re: /fractal[\s_-]?bot/i },
];

export interface EditorProcessHit {
  /** Process image name as reported by the OS. */
  name: string;
  pid?: number;
  /** Which editor pattern matched. */
  editor: string;
}

/** The override flag honored by guardAgainstRunningEditors. */
export const IGNORE_EDITORS_FLAG = '--ignore-editors';

/**
 * Enumerate running Fractal editor processes. Returns [] when none are
 * found OR when process enumeration itself fails (best-effort by design;
 * the guard must never be the thing that blocks a legitimate run).
 */
export function findRunningFractalEditors(): EditorProcessHit[] {
  const procs: Array<{ name: string; pid?: number }> = [];
  try {
    if (process.platform === 'win32') {
      // CSV, no header: "Image Name","PID","Session Name","Session#","Mem Usage"
      const csv = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
        encoding: 'utf8',
        timeout: 15_000,
        windowsHide: true,
      });
      for (const line of csv.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line);
        if (m) procs.push({ name: m[1], pid: Number(m[2]) });
      }
    } else {
      // macOS/Linux best-effort: pgrep against the full command line, one
      // alternation for all editor names. pgrep exits 1 on no match (throws
      // into the catch below, which is the correct "no hits" outcome).
      const pattern = 'axe[ _-]?edit|am4[ _-]?edit|fm3[ _-]?edit|fm9[ _-]?edit|vp4[ _-]?edit|fractal[ _-]?bot';
      const out = execFileSync('pgrep', ['-ifl', pattern], { encoding: 'utf8', timeout: 15_000 });
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (m) procs.push({ name: m[2].trim(), pid: Number(m[1]) });
      }
    }
  } catch {
    return [];
  }
  const hits: EditorProcessHit[] = [];
  for (const p of procs) {
    const pat = EDITOR_PATTERNS.find((e) => e.re.test(p.name));
    if (pat) hits.push({ name: p.name, pid: p.pid, editor: pat.label });
  }
  return hits;
}

/**
 * Startup gate: if any Fractal editor is running, print which and why,
 * then exit(2). Honors --ignore-editors in the given argv (defaults to
 * the process argv). Call BEFORE opening any MIDI port.
 */
export function guardAgainstRunningEditors(argv: readonly string[] = process.argv.slice(2)): void {
  if (argv.includes(IGNORE_EDITORS_FLAG)) {
    process.stderr.write(`${IGNORE_EDITORS_FLAG}: skipping the Fractal-editor pre-flight check.\n`);
    return;
  }
  const hits = findRunningFractalEditors();
  if (hits.length === 0) return;
  const lines = hits.map((h) => `  - ${h.editor}: ${h.name}${h.pid !== undefined ? ` (PID ${h.pid})` : ''}`);
  process.stderr.write(
    'REFUSING TO START: a Fractal editor is running.\n'
    + `${lines.join('\n')}\n`
    + 'An editor holding the USB MIDI port while this script sends its own traffic\n'
    + 'can wedge the Windows MIDI (WinMM) driver layer: the native send blocks\n'
    + 'forever, the script freezes un-killably mid-frame, and the device front\n'
    + 'panel locks up until processes are killed. Fully quit the editor (check the\n'
    + `system tray too), then re-run. Override with ${IGNORE_EDITORS_FLAG} only for\n`
    + 'deliberate listen-only capture sessions.\n',
  );
  process.exit(2);
}
