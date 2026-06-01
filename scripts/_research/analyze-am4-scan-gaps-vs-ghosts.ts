// analyze-am4-scan-gaps-vs-ghosts.ts — HW-129 cross-reference.
//
// Joins the 2026-05-31 DEVICE register census (probe-am4-coverage-scan.ts)
// gap candidates against the Ghidra catalog GHOST symbols (catalog-but-no-XML)
// and params.ts. Answers: for each register the DEVICE responds to but the
// catalog audit never counted, is there a NAMED catalog symbol at that
// (pidLow, paramId)? If yes, the "GHOST = firmware-internal" call is wrong for
// that symbol — it's a real device register the XML merely omits, and we have
// its Fractal symbol name to seed a hardware label-sweep.
//
// Read-only, offline. Usage: npx tsx scripts/_research/analyze-am4-scan-gaps-vs-ghosts.ts

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const FRACTAL_MIDI_AM4_DIR = dirname(require.resolve('fractal-midi/am4'));

const GHIDRA_AM4 = 'samples/captured/decoded/ghidra-am4-paramnames.json';
const PARAMS_TS = join(FRACTAL_MIDI_AM4_DIR, 'params.js');
const XML_REG = 'samples/captured/decoded/binarydata/extracted/__block_layout.xml';
const XML_EXPERT = 'samples/captured/decoded/binarydata/extracted/__block_layout_expert.xml';

// --- Device register census gaps (HW-129, hardware-observed 2026-05-31) ------
// pidLow = device register bank; ph = pidHigh = paramId; raw = u32 read value.
interface Gap { block: string; pidLow: number; ph: number; raw: number; }
const SCAN_GAPS: Gap[] = [
  { block: 'amp', pidLow: 0x3a, ph: 0x1b, raw: 30473 },
  { block: 'amp', pidLow: 0x3a, ph: 0x1c, raw: 10 },
  { block: 'amp', pidLow: 0x3a, ph: 0x27, raw: 8693 },
  { block: 'amp', pidLow: 0x3a, ph: 0x29, raw: 1 },
  { block: 'amp', pidLow: 0x3a, ph: 0x2c, raw: 50 },
  { block: 'amp', pidLow: 0x3a, ph: 0x2d, raw: 18022 },
  { block: 'amp/DynaCab', pidLow: 0x3e, ph: 0x49, raw: 17831 },
  { block: 'amp/DynaCab', pidLow: 0x3e, ph: 0x4a, raw: 17831 },
  { block: 'drive', pidLow: 0x76, ph: 0x27, raw: 2 },
  { block: 'drive', pidLow: 0x76, ph: 0x29, raw: 2 },
  { block: 'drive', pidLow: 0x76, ph: 0x30, raw: 1 },
  { block: 'ingate', pidLow: 0x25, ph: 0x11, raw: 1 },
  { block: 'delay', pidLow: 0x46, ph: 0x0b, raw: 1 },
];

// pidLow → catalog family. Mirrors coverage-cross-ref-audit.ts. amp + drive
// share DISTORT; the DynaCab/cab register (0x3e) is CABINET.
const PIDLOW_TO_FAMILY: Record<number, string> = {
  0x3a: 'DISTORT',
  0x76: 'DISTORT',
  0x3e: 'CABINET',
  0x25: 'INPUT',
  0x46: 'DELAY',
};

// --- Load catalog (paramId → symbol per family) ------------------------------
interface CatEntry { paramId: number; symbol: string; }
function loadCatalog(): Map<string, CatEntry[]> {
  const data = JSON.parse(readFileSync(GHIDRA_AM4, 'utf-8'));
  const out = new Map<string, CatEntry[]>();
  for (const eff of Object.values(data.effect_types) as any[]) {
    if (!eff.effectFamily || !eff.params) continue;
    out.set(eff.effectFamily, eff.params
      .filter((p: any) => p.name && p.name !== '?')
      .map((p: any) => ({ paramId: p.paramId, symbol: p.name })));
  }
  return out;
}

// --- Load XML symbols (presence = has a UI control) --------------------------
function loadXmlSymbols(): Set<string> {
  const out = new Set<string>();
  const tagRe = /parameterName="([A-Z][A-Z0-9_]*)"/g;
  for (const f of [XML_REG, XML_EXPERT]) {
    const xml = readFileSync(f, 'utf-8');
    for (const m of xml.matchAll(tagRe)) out.add(m[1]);
  }
  return out;
}

// --- Load params.ts (pidLow.pidHigh → key) -----------------------------------
function loadParamsTs(): Map<string, string> {
  const ts = readFileSync(PARAMS_TS, 'utf-8');
  const re = /^\s+'([a-z]+\.[a-z0-9_]+)':\s*\{[\s\S]*?block:\s*'([a-z]+)',\s*name:\s*'([a-z0-9_]+)',[\s\S]*?pidLow:\s*(0x[0-9a-fA-F]+),\s*pidHigh:\s*(0x[0-9a-fA-F]+)/gm;
  const out = new Map<string, string>();
  for (const m of ts.matchAll(re)) {
    out.set(`${parseInt(m[4], 16)}.${parseInt(m[5], 16)}`, m[1]);
  }
  return out;
}

const catalog = loadCatalog();
const xmlSyms = loadXmlSymbols();
const paramsByAddr = loadParamsTs();

console.log('=== HW-129: device-scan gaps cross-referenced against catalog + XML + params.ts ===\n');
console.log('For each register the DEVICE responds to (non-zero, unmapped), is there a');
console.log('named catalog symbol at the same (family-pidLow, paramId)? If GHOST (no XML),');
console.log('the "firmware-internal" call is suspect — device proves it real.\n');

for (const g of SCAN_GAPS) {
  const fam = PIDLOW_TO_FAMILY[g.pidLow];
  const entries = (catalog.get(fam) ?? []).filter((e) => e.paramId === g.ph);
  const inParams = paramsByAddr.get(`${g.pidLow}.${g.ph}`);
  const addr = `${g.block} 0x${g.pidLow.toString(16)}/0x${g.ph.toString(16).padStart(2, '0')} (paramId ${g.ph})`;
  console.log(`── ${addr}  raw=${g.raw} ──`);
  if (inParams) {
    console.log(`   ALREADY MAPPED in params.ts as '${inParams}' (census false-positive — re-check scan)\n`);
    continue;
  }
  if (entries.length === 0) {
    console.log(`   catalog (${fam}): NO symbol at paramId ${g.ph} → unnamed register, hardware label-sweep only\n`);
    continue;
  }
  for (const e of entries) {
    const hasXml = xmlSyms.has(e.symbol);
    const verdict = hasXml ? 'HAS-XML (was UI-MISSING, not ghost)' : 'GHOST → RE-CLASSIFY: device-real, XML-omitted';
    console.log(`   catalog (${fam}): ${e.symbol}  [${verdict}]`);
  }
  console.log('');
}

// --- Full GHOST inventory per relevant family, marked by device response -----
console.log('\n=== Full GHOST inventory for device-responding families (amp/drive=DISTORT, CABINET, INPUT, DELAY) ===\n');
const gapAddrs = new Set(SCAN_GAPS.map((g) => `${PIDLOW_TO_FAMILY[g.pidLow]}.${g.ph}`));
for (const fam of ['DISTORT', 'CABINET', 'INPUT', 'DELAY']) {
  const ghosts = (catalog.get(fam) ?? []).filter((e) => !xmlSyms.has(e.symbol) && e.paramId < 65000);
  if (ghosts.length === 0) continue;
  console.log(`-- ${fam}: ${ghosts.length} GHOST symbols --`);
  for (const e of ghosts.sort((a, b) => a.paramId - b.paramId)) {
    const deviceHit = gapAddrs.has(`${fam}.${e.paramId}`) ? '  <<< DEVICE RESPONDS (scan gap)' : '';
    console.log(`   paramId ${String(e.paramId).padStart(3)}  ${e.symbol}${deviceHit}`);
  }
  console.log('');
}
