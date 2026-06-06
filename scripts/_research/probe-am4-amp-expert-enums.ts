// probe-am4-amp-expert-enums.ts — interactive sweep of Amp Expert + Input Gate
// enum params. Each step sets a value and waits for you to type what you see.
//
// Usage:
//   npx tsx scripts/_research/probe-am4-amp-expert-enums.ts
//
// Load preset A01 (or any preset with an Amp block) before running.
// Type what you see on the AM4 display, Enter to confirm.
// Enter with no text = skip. "stop" = end this param. "quit" = exit.

import readline from 'readline';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { buildSetParam, KNOWN_PARAMS } from 'fractal-midi/am4';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (prompt: string): Promise<string> =>
  new Promise((resolve) => rl.question(prompt, resolve));

type SweepSpec = { key: string; max: number; page: string; hints?: string };

const PARAMS: SweepSpec[] = [
  {
    key: 'amp.tubes',
    max: 9,
    page: 'Amp Edit > Expert > Power Amp tab — "Tubes" selector',
    hints: '5881 / 6L6 / EL34 / KT88 / etc. — "stop" when it repeats',
  },
  {
    key: 'amp.spkr_imp_curve',
    max: 8,
    page: 'Amp Edit > Expert > Speaker tab — "Spkr Imp. Curve"',
    hints: 'DEFAULT + named curves — "stop" when done',
  },
  {
    key: 'amp.plate_suppr_diodes',
    max: 4,
    page: 'Amp Edit > Expert > Power Amp tab — "Plate Suppr. Diodes"',
    hints: 'unknown',
  },
  {
    key: 'amp.cab_zoom',
    max: 3,
    page: 'Amp Edit > Cabinet tab — "ZOOM"',
    hints: 'unknown',
  },
  {
    key: 'ingate.input_impedance',
    max: 5,
    page: 'Input Gate block > Config page — "Input Impedance"',
    hints: '1M / 90k / 70k / 32k / 22k? — report all',
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
      conn.close(); rl.close(); process.exit(0);
    }
    if (trimmed.toLowerCase() === 'stop') {
      console.log('     (stopped early)');
      break;
    }
    if (trimmed) results[i] = trimmed;
  }

  conn.send(buildSetParam(spec.key as keyof typeof KNOWN_PARAMS, 0));
  return results;
}

async function main(): Promise<void> {
  const conn = connectAM4();

  console.log('=== AM4 Amp Expert + Input Gate Enum Probe (interactive) ===');
  console.log('Type what you see on the AM4 display at each step, then Enter.');
  console.log('Enter = skip. "stop" = end this param. "quit" = exit.\n');
  console.log('Load preset A01 (or any preset with an Amp block) now.');

  const allResults: Record<string, Record<number, string>> = {};
  let lastPage = '';

  for (const spec of PARAMS) {
    if (spec.page !== lastPage) {
      console.log(`\n${'═'.repeat(55)}`);
      console.log(`Navigate to: ${spec.page}`);
      await ask('Press Enter when ready > ');
      lastPage = spec.page;
    }
    allResults[spec.key] = await sweepParam(conn, spec);
  }

  console.log('\n\n' + '═'.repeat(55));
  console.log('RESULTS:');
  console.log('═'.repeat(55));
  for (const [key, values] of Object.entries(allResults)) {
    const entries = Object.entries(values).map(([i, v]) => `${i}=${v}`).join(', ');
    console.log(`  ${key}: ${entries || '(no data)'}`);
  }

  rl.close();
  conn.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
