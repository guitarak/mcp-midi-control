// probe-am4-amp-register-scan.ts — DEVICE ground-truth coverage check for the
// amp block. Catalog-based coverage (coverage-audit) measures against a FILTERED
// Ghidra catalog and missed amp.power_tube_type (0x4b) because that symbol is not
// in __block_layout.xml. This asks the DEVICE directly: read every pidHigh the
// amp block (pidLow 0x3a) responds to, and flag any responder NOT registered in
// params.ts. Unmapped responders (esp. non-zero) are coverage gaps to investigate.
//
// Read-only. Usage: npx tsx scripts/_research/probe-am4-amp-register-scan.ts

import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { sendReadAndParseRaw } from '@mcp-midi-control/am4/shared/readOps.js';
import { KNOWN_PARAMS } from 'fractal-midi/am4';

const PID_LOW = 0x003a;
const FROM = 0x00;
const TO = 0xc0;

function registeredAmpPidHighs(): Map<number, string> {
  const m = new Map<number, string>();
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = (KNOWN_PARAMS as Record<string, { block: string; pidLow: number; pidHigh: number; name: string }>)[key];
    if (p.block === 'amp' && p.pidLow === PID_LOW) m.set(p.pidHigh, p.name);
  }
  return m;
}

async function main(): Promise<void> {
  const reg = registeredAmpPidHighs();
  const conn = connectAM4();
  console.log(`Amp register scan (pidLow=0x3a, pidHigh 0x${FROM.toString(16)}..0x${TO.toString(16)}). ${reg.size} amp pidHighs registered.\n`);
  const unmapped: Array<{ ph: number; raw: number }> = [];
  let responders = 0;
  for (let ph = FROM; ph <= TO; ph++) {
    try {
      const { parsed } = await sendReadAndParseRaw(conn, PID_LOW, ph);
      responders++;
      const raw = parsed.asUInt32LE();
      if (!reg.has(ph)) unmapped.push({ ph, raw });
    } catch {
      // no response → undefined register
    }
  }
  conn.close();
  console.log(`Responders: ${responders}. Registered: ${reg.size}. UNMAPPED responders: ${unmapped.length}\n`);
  for (const u of unmapped) {
    const flag = u.raw !== 0 ? '  *** non-zero — strong gap candidate ***' : '  (reads 0 — possibly reserved/unused)';
    console.log(`  pidHigh 0x${u.ph.toString(16).padStart(2, '0')}: raw=${u.raw}${flag}`);
  }
  console.log('\nNon-zero unmapped responders are the params most likely missing from params.ts.');
  console.log('(raw==0 responders may be reserved registers or params currently at index/value 0 — confirm on device.)');
}

void main();
