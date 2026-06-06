// probe-am4-setup-enums.ts — interactive sweep of AM4 global/system enum params.
//
// Each step: sets the value on the device, then waits for YOU to type what
// you see on the AM4 display before moving on. Your pace, not a timer.
//
// At the end, prints the complete enum table for every param.
//
// Usage:
//   npx tsx scripts/_research/probe-am4-setup-enums.ts [--phase N]
//
//   --phase N    run only phase N:
//                  1 = SETUP > Audio
//                  2 = SETUP > Global Settings
//                  3 = SETUP > MIDI/Remote
//                  4 = SETUP > Footswitches
//                  5 = Tuner settings
//
// INPUT: type the label you see on the AM4 display, then press Enter.
//        Press Enter with no text to skip (records index as unknown).
//        Type "stop" to end the current param's sweep early.
//        Type "quit" to exit the script entirely.
//
// NOTE: global params save immediately. Script restores each param to 0 when
// done. Run SETUP > Reset > Reset System Parameters if anything looks wrong.

import readline from 'readline';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildSetParam, KNOWN_PARAMS } from 'fractal-midi/am4';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] ?? '' : ''; };
const ONLY_PHASE = flag('--phase') ? parseInt(flag('--phase'), 10) : 0;

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => rl.question(prompt, resolve));

type SweepSpec = { key: string; max: number; hints?: string };

const PHASES: Array<{ phase: number; page: string; nav: string; params: SweepSpec[] }> = [
  {
    phase: 1,
    page: 'SETUP > Audio',
    nav: 'Press ENTER+EXIT to open Setup, page to AUDIO.',
    params: [
      { key: 'global.in1_source',     max: 2,  hints: 'Analog / SPDIF / USB 3/4' },
      { key: 'global.out1_config',     max: 4,  hints: 'STEREO / SUM L+R / COPY L->R / MUTE / SPLIT' },
      { key: 'global.out1_phase',      max: 1,  hints: 'NORMAL / INVERT' },
      { key: 'global.usb78_source',    max: 4,  hints: 'unknown' },
      { key: 'global.inspdif_config',  max: 3,  hints: 'unknown' },
    ],
  },
  {
    phase: 2,
    page: 'SETUP > Global Settings',
    nav: 'Page to GLOBAL SETTINGS.',
    params: [
      { key: 'global.gap_fill',        max: 1,  hints: 'ON / OFF' },
      { key: 'global.delayspill',      max: 3,  hints: 'OFF / DELAY / REVERB / DELAY+REVERB' },
      { key: 'global.startup_mode',    max: 3,  hints: 'Preset / Scene / Effects / Amp' },
      { key: 'global.scene_revert',    max: 5,  hints: 'AS SAVED + scene numbers' },
      { key: 'global.tap_tempo_mode',  max: 1,  hints: 'AVERAGE / LAST TWO' },
      { key: 'global.linefreq',        max: 1,  hints: '60 Hz / 50 Hz' },
      { key: 'global.cabinetbyp',      max: 1,  hints: 'ON / OFF (cab modeling)' },
      { key: 'global.pwrampbyp',       max: 1,  hints: 'ON / OFF (power amp modeling)' },
      { key: 'global.dynacab_sync',    max: 1,  hints: 'ON / OFF (amp->cab type linking)' },
      { key: 'global.sprk_model',      max: 8,  hints: 'DEFAULT + named curves; type "stop" when it repeats' },
      { key: 'global.auto_truebypass', max: 1,  hints: 'ON / OFF' },
      { key: 'global.select_fade',     max: 11, hints: 'OFF / 1s / 2s ... 10s' },
      { key: 'global.metronome',       max: 3,  hints: 'unknown' },
    ],
  },
  {
    phase: 3,
    page: 'SETUP > MIDI/Remote',
    nav: 'Page to MIDI/REMOTE.',
    params: [
      { key: 'global.midi_thru',         max: 1,  hints: 'Off / On' },
      { key: 'global.midi_prog_change',  max: 1,  hints: 'ON / OFF (receive MIDI PC)' },
      { key: 'global.no_redundant_pc',   max: 1,  hints: 'ON / OFF (ignore redundant PC)' },
      { key: 'global.send_midipc',       max: 17, hints: 'OFF / 1..16 / OMNI; type "stop" when done' },
      { key: 'global.scenesync_ch',      max: 17, hints: 'channel range; type "stop" when done' },
    ],
  },
  {
    phase: 4,
    page: 'SETUP > Footswitches',
    nav: 'Page to FOOTSWITCHES.',
    params: [
      { key: 'global.tap_amp_fx_mode',     max: 2, hints: 'Nothing / Bypass / Out Boost' },
      { key: 'global.tap_amp_ch_amp_mode', max: 2, hints: 'Nothing / Out Boost (or more)' },
      { key: 'global.presshold_mode',      max: 2, hints: 'Disabled / Gig Mode / Custom' },
    ],
  },
  {
    phase: 5,
    page: 'Tuner settings',
    nav: 'Enter Tuner mode, or find tuner settings in Setup.',
    params: [
      { key: 'global.tunermute',         max: 3, hints: 'mute types' },
      { key: 'global.tuneraccidentals',  max: 2, hints: 'Sharps / Flats / Both?' },
      { key: 'global.tuner_on_volume',   max: 1, hints: 'ON / OFF' },
      { key: 'global.tuner_source',      max: 3, hints: 'unknown sources' },
      { key: 'global.usetuneoffsets',    max: 1, hints: 'ON / OFF' },
    ],
  },
];

async function sweepParam(
  conn: ReturnType<typeof connectAM4>,
  spec: SweepSpec,
): Promise<Record<number, string>> {
  const param = KNOWN_PARAMS[spec.key as keyof typeof KNOWN_PARAMS];
  const label = (param as unknown as { displayLabel?: string })?.displayLabel ?? spec.key;

  console.log(`\n  ── ${spec.key} — "${label}"`);
  if (spec.hints) console.log(`     (${spec.hints})`);

  const results: Record<number, string> = {};

  for (let i = 0; i <= spec.max; i++) {
    conn.send(buildSetParam(spec.key as keyof typeof KNOWN_PARAMS, i));

    const answer = await ask(`     index ${String(i).padStart(2)}: `);
    const trimmed = answer.trim();

    if (trimmed.toLowerCase() === 'quit') {
      console.log('Quitting.');
      conn.close();
      rl.close();
      process.exit(0);
    }
    if (trimmed.toLowerCase() === 'stop') {
      console.log('     (stopped early)');
      break;
    }
    if (trimmed) results[i] = trimmed;
  }

  // Restore
  conn.send(buildSetParam(spec.key as keyof typeof KNOWN_PARAMS, 0));
  return results;
}

async function main(): Promise<void> {
  const conn = connectAM4();

  const phases = ONLY_PHASE
    ? PHASES.filter((p) => p.phase === ONLY_PHASE)
    : PHASES;

  if (phases.length === 0) {
    console.error(`Phase ${ONLY_PHASE} not found. Valid: 1-5`);
    rl.close(); conn.close(); process.exit(1);
  }

  console.log('=== AM4 Setup Enum Probe (interactive) ===');
  console.log('Type what you see on the AM4 display at each step, then Enter.');
  console.log('Enter with no text = skip. "stop" = end this param. "quit" = exit.\n');

  const allResults: Record<string, Record<number, string>> = {};

  for (const phase of phases) {
    console.log(`\n${'═'.repeat(55)}`);
    console.log(`Phase ${phase.phase}: ${phase.page}`);
    console.log(`Navigate: ${phase.nav}`);
    await ask('Press Enter when you are on that page > ');

    for (const spec of phase.params) {
      allResults[spec.key] = await sweepParam(conn, spec);
    }
  }

  console.log('\n\n' + '═'.repeat(55));
  console.log('RESULTS — copy this into your report:');
  console.log('═'.repeat(55));
  for (const [key, values] of Object.entries(allResults)) {
    const entries = Object.entries(values)
      .map(([i, v]) => `${i}=${v}`)
      .join(', ');
    console.log(`  ${key}: ${entries || '(no data)'}`);
  }

  rl.close();
  conn.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
