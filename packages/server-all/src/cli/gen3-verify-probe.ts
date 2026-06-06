#!/usr/bin/env node
/**
 * Gen-3 Fractal WRITE-VERIFY probe (CLI), a tester-runnable round-trip
 * diagnostic for the FM9, FM3, and Axe-Fx III.
 *
 * The read-only `gen3-readback-probe` confirms we can READ the device. This
 * probe confirms the device ACCEPTS AND APPLIES OUR WRITES: it sends each
 * shipped write op against the loaded preset, then reads the result back. The
 * headline result is whether set_param works for continuous knobs (it tests
 * both the typed and the editor float forms).
 *
 * SAFE: it NEVER saves; it establishes a restore point first (reads the active
 * preset number) and reloads that preset at the end (and on Ctrl-C / errors),
 * which discards every working-buffer change, so your device ends exactly where
 * it started. It does discard any UNSAVED edits you had open before running, so
 * store or abandon those first. Quit the editor first so it is not holding the
 * MIDI port. Core logic + the full safety contract live in
 * `gen3-verify-probe-core.ts`.
 *
 * Usage:
 *   node dist/cli/gen3-verify-probe.js <fm9|fm3|axe-fx-iii> [output.json]
 *
 * Exit codes: 0 = ran and wrote the report; 1 = bad device / no port found.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  connectFM9,
  connectFM3,
  connectAxeFxIII,
  type MidiConnection,
} from '@mcp-midi-control/fractal-modern/midi.js';
import { buildSwitchPresetPC } from 'fractal-midi/axe-fx-iii';
import { runVerifyProbe } from './gen3-verify-probe-core.js';

interface DeviceSpec { label: string; modelByte: number; connect: () => MidiConnection; gridRows: number }
const DEVICES: Record<string, DeviceSpec> = {
  fm9: { label: 'FM9', modelByte: 0x12, connect: connectFM9, gridRows: 6 },
  fm3: { label: 'FM3', modelByte: 0x11, connect: connectFM3, gridRows: 4 },
  'axe-fx-iii': { label: 'Axe-Fx III', modelByte: 0x10, connect: connectAxeFxIII, gridRows: 6 },
};

const deviceKey = (process.argv[2] ?? '').toLowerCase();
const device = DEVICES[deviceKey];
if (!device) {
  console.error('Usage: gen3-verify-probe <fm9|fm3|axe-fx-iii> [output.json]');
  console.error(`Unknown device "${process.argv[2] ?? '(none)'}".`);
  process.exit(1);
}
const outArg = process.argv[3] ?? `${deviceKey}-verify-output.json`;
const outPath = path.isAbsolute(outArg) ? outArg : path.resolve(process.cwd(), outArg);

console.error(`${device.label} WRITE-VERIFY probe`);
console.error('Safe: never saves; reloads your preset at the end to discard all changes.');
console.error('Note: this DISCARDS any unsaved working-buffer edits you had open. Store them first.');

let conn: MidiConnection;
try {
  conn = device.connect();
} catch (err) {
  console.error(`\n${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
if (!conn.hasInput) {
  console.error(`\nFound a ${device.label} output port but no input port; the probe needs`);
  console.error('to read replies. Unplug/replug the USB cable and try again.');
  conn.close();
  process.exit(1);
}

// Once the probe reads the active preset number we keep it here so a Ctrl-C
// mid-run can still reload (discard the working buffer) before exiting.
let restorePreset: number | undefined;
process.on('SIGINT', () => {
  try {
    if (restorePreset !== undefined) conn.send(buildSwitchPresetPC(restorePreset));
  } catch { /* ignore */ }
  try { conn.close(); } catch { /* ignore */ }
  console.error('\nInterrupted.' + (restorePreset !== undefined
    ? ` Reloaded preset ${restorePreset} to discard working-buffer changes.`
    : ' No writes had been made; nothing to undo.'));
  process.exit(130);
});

async function main(): Promise<void> {
  const report = await runVerifyProbe({
    conn,
    modelByte: device.modelByte,
    gridRows: device.gridRows,
    label: device.label,
    log: (line) => console.error(line),
    onRestorePoint: (n) => { restorePreset = n; },
  });
  fs.writeFileSync(outPath, JSON.stringify(report, undefined, 2));
  conn.close();
  console.error(`\n✓ Wrote ${outPath}`);
  console.error(`  ${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped.`);
  console.error('\nPlease email me this JSON file. Thank you!');
  process.exit(0);
}

main().catch((err) => {
  console.error(`\nProbe failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  try { conn?.close(); } catch { /* ignore */ }
  process.exit(1);
});
