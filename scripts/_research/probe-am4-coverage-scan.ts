// probe-am4-coverage-scan.ts — DEVICE ground-truth coverage census across ALL
// AM4 blocks. Catalog-based coverage-audit measures against a FILTERED Ghidra
// catalog and missed real params (e.g. amp.power_tube_type 0x4b, absent from
// __block_layout.xml). This asks the device directly: for each block (pidLow),
// read every pidHigh it responds to and flag responders NOT in params.ts.
// Non-zero unmapped responders at pidHigh > GENERIC_MAX are strong gap candidates
// (low pidHighs are shared/generic; raw==0 may be reserved or a param at 0).
//
// Read-only. Slow (undefined registers cost a ~300ms timeout each). Run in
// background. Usage: npx tsx scripts/_research/probe-am4-coverage-scan.ts

import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { sendReadAndParseRaw } from '@mcp-midi-control/am4/shared/readOps.js';
import { KNOWN_PARAMS } from 'fractal-midi/am4';

const GENERIC_MAX = 0x09;      // pidHigh <= this are shared/generic registers
const SCAN_MARGIN = 0x20;      // scan this far past a block's last known pidHigh

interface BankInfo { reg: Set<number>; maxPh: number; blocks: Set<string>; }

// Key by pidLow (the real device register bank), NOT block name — block names
// can span multiple pidLows (e.g. block:'amp' at 0x3a real-amp AND 0x3e DynaCab),
// and merging their pidHigh sets false-clears gaps.
function indexByPidLow(): Map<number, BankInfo> {
  const out = new Map<number, BankInfo>();
  for (const key of Object.keys(KNOWN_PARAMS)) {
    const p = (KNOWN_PARAMS as Record<string, { block: string; pidLow: number; pidHigh: number; name: string }>)[key];
    let bi = out.get(p.pidLow);
    if (!bi) { bi = { reg: new Set(), maxPh: 0, blocks: new Set() }; out.set(p.pidLow, bi); }
    bi.reg.add(p.pidHigh);
    bi.blocks.add(p.block);
    if (p.pidHigh > bi.maxPh) bi.maxPh = p.pidHigh;
  }
  return out;
}

async function main(): Promise<void> {
  const banks = indexByPidLow();
  const conn = connectAM4();
  console.log(`AM4 per-bank (pidLow) coverage census (${banks.size} banks). Non-zero unmapped > 0x${GENERIC_MAX.toString(16)} = gap candidate; uniform runs flagged as likely meter arrays.\n`);
  const summary: Array<{ bank: string; candidates: number }> = [];

  for (const [pidLow, bi] of [...banks.entries()].sort((a, b) => a[0] - b[0])) {
    const to = Math.min(bi.maxPh + SCAN_MARGIN, 0xff);
    const unmapped: Array<{ ph: number; raw: number }> = [];
    let responders = 0;
    for (let ph = 0x00; ph <= to; ph++) {
      try {
        const { parsed } = await sendReadAndParseRaw(conn, pidLow, ph);
        responders++;
        if (!bi.reg.has(ph)) unmapped.push({ ph, raw: parsed.asUInt32LE() });
      } catch { /* undefined register */ }
    }
    const label = `0x${pidLow.toString(16)} (${[...bi.blocks].join('/')})`;
    // Flag uniform runs (>=4 consecutive unmapped with same raw) as meter arrays.
    const meterPhs = new Set<number>();
    for (let i = 0; i < unmapped.length; i++) {
      let j = i;
      while (j + 1 < unmapped.length && unmapped[j + 1].raw === unmapped[i].raw && unmapped[j + 1].ph === unmapped[j].ph + 1) j++;
      if (j - i + 1 >= 4) for (let k = i; k <= j; k++) meterPhs.add(unmapped[k].ph);
      i = j;
    }
    const candidates = unmapped.filter((u) => u.ph > GENERIC_MAX && u.raw !== 0 && !meterPhs.has(u.ph));
    summary.push({ bank: label, candidates: candidates.length });
    console.log(`── ${label} — scanned 0x00..0x${to.toString(16)}, ${bi.reg.size} registered, ${responders} responders, ${unmapped.length} unmapped, ${meterPhs.size} meter-array, ${candidates.length} candidate ──`);
    for (const c of candidates) console.log(`   pidHigh 0x${c.ph.toString(16).padStart(2, '0')}: raw=${c.raw}  *** gap candidate ***`);
  }
  conn.close();
  console.log('\n=== SUMMARY (gap candidates per bank, meter arrays excluded) ===');
  for (const s of summary.filter((s) => s.candidates > 0).sort((a, b) => b.candidates - a.candidates)) {
    console.log(`  ${s.bank}: ${s.candidates}`);
  }
  console.log(`  TOTAL gap candidates: ${summary.reduce((a, s) => a + s.candidates, 0)}`);
}

void main();
