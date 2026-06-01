// probe-am4-ghost-existence.ts — HW-129 accurate GHOST re-examination.
//
// The 2026-05-31 coverage census (probe-am4-coverage-scan.ts) filtered out
// raw==0 responders and meter runs, so it UNDER-reports: a real register
// sitting at 0 on the test preset, or one inside a uniform run, was invisible.
// This probe re-examines every catalog GHOST address (catalog symbol with no
// AM4-Edit XML control) DIRECTLY, recording ACK-with-raw vs NACK so we can
// honestly classify each of the 49 GHOSTs as device-real or catalog-noise.
//
// Read-only. Requires the relevant block PLACED in a slot (amp/drive/cab/
// ingate/delay). Run after switching to a preset that contains them.
//
// Usage: npx tsx scripts/_research/probe-am4-ghost-existence.ts

import { readFileSync } from 'node:fs';
import { connectAM4 } from '@mcp-midi-control/am4/midi.js';
import { sendReadAndParseRaw } from '@mcp-midi-control/am4/shared/readOps.js';

const GHIDRA_AM4 = 'samples/captured/decoded/ghidra-am4-paramnames.json';
const XML_REG = 'samples/captured/decoded/binarydata/extracted/__block_layout.xml';
const XML_EXPERT = 'samples/captured/decoded/binarydata/extracted/__block_layout_expert.xml';

// family → device pidLow(s) to probe. amp+drive share DISTORT but live at two
// banks; probe both so we see which bank actually holds each register.
const FAMILY_BANKS: Record<string, Array<{ pidLow: number; label: string }>> = {
  DISTORT: [{ pidLow: 0x3a, label: 'amp' }, { pidLow: 0x76, label: 'drive' }],
  CABINET: [{ pidLow: 0x3e, label: 'cab/DynaCab' }],
  INPUT: [{ pidLow: 0x25, label: 'ingate' }],
  DELAY: [{ pidLow: 0x46, label: 'delay' }],
  COMP: [{ pidLow: 0x2d, label: 'compressor' }],
};

function loadXmlSymbols(): Set<string> {
  const out = new Set<string>();
  const re = /parameterName="([A-Z][A-Z0-9_]*)"/g;
  for (const f of [XML_REG, XML_EXPERT]) {
    for (const m of readFileSync(f, 'utf-8').matchAll(re)) out.add(m[1]);
  }
  return out;
}

function loadGhosts(xmlSyms: Set<string>): Map<string, Array<{ paramId: number; symbol: string }>> {
  const data = JSON.parse(readFileSync(GHIDRA_AM4, 'utf-8'));
  const out = new Map<string, Array<{ paramId: number; symbol: string }>>();
  for (const eff of Object.values(data.effect_types) as any[]) {
    if (!eff.effectFamily || !eff.params || !FAMILY_BANKS[eff.effectFamily]) continue;
    const ghosts = eff.params
      .filter((p: any) => p.name && p.name !== '?' && p.paramId < 65000 && !xmlSyms.has(p.name))
      .map((p: any) => ({ paramId: p.paramId, symbol: p.name }));
    if (ghosts.length) out.set(eff.effectFamily, ghosts);
  }
  return out;
}

async function main(): Promise<void> {
  const xmlSyms = loadXmlSymbols();
  const ghosts = loadGhosts(xmlSyms);
  const conn = connectAM4();
  console.log('=== HW-129 GHOST existence probe (ACK/NACK + raw, no raw!=0 filter) ===');
  console.log('ACK = device holds this register (real, even if 0). NACK = undefined register (catalog noise).\n');

  const realByBank: Record<string, number> = {};
  for (const [family, list] of ghosts) {
    for (const bank of FAMILY_BANKS[family]) {
      console.log(`── ${family} @ ${bank.label} (pidLow 0x${bank.pidLow.toString(16)}) — ${list.length} GHOST addresses ──`);
      let real = 0;
      for (const g of list.sort((a, b) => a.paramId - b.paramId)) {
        let verdict: string;
        try {
          const { parsed } = await sendReadAndParseRaw(conn, bank.pidLow, g.paramId);
          const raw = parsed.asUInt32LE();
          verdict = `ACK raw=${raw}`;
          real++;
        } catch {
          verdict = 'NACK (no register)';
        }
        console.log(`   pid ${String(g.paramId).padStart(3)}  ${g.symbol.padEnd(26)} ${verdict}`);
      }
      realByBank[`${family}@${bank.label}`] = real;
      console.log('');
    }
  }
  conn.close();
  console.log('=== SUMMARY: GHOST addresses the device ACKs (real registers) ===');
  for (const [k, v] of Object.entries(realByBank)) console.log(`  ${k}: ${v} real`);
}

void main();
