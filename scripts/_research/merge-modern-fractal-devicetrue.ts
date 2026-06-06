/**
 * Build a modern-Fractal device's DEVICE-TRUE catalog by joining its OWN
 * binary param-table scan (the authoritative paramId source) with two
 * "is this a real param" oracles, then attaching XML display labels.
 *
 * Sources (all offline, no hardware):
 *   - scan-paramtables-<dev>.json   the device's OWN (name -> paramId)
 *     table (direct PE scan; validated 100% vs the III Ghidra control).
 *     THIS supplies the paramId.
 *   - ghidra-axeedit3-paramnames.json   the III's dispatcher mine. A
 *     symbol here is a KNOWN-REAL param; if it is ALSO in the device scan
 *     the device ships it (with the device's own paramId). Also the
 *     family source for shared symbols.
 *   - modern-fractal-catalog-<dev>.json   the device's __block_layout.xml
 *     mine: supplies display labels + the device-NEW symbol roster (params
 *     the editor renders that the III doesn't have).
 *   - scan-paramtables-iii.json   the III's own scan, for the reuse audit.
 *
 * A symbol ships iff it is in the device scan AND validated as a real
 * param by EITHER oracle (III Ghidra OR the device's XML roster). This
 * keeps the catalog as complete as the III's (effect-type selectors like
 * REVERB_TYPE that the XML doesn't render are recovered via the Ghidra
 * oracle) while filtering scan symbols that aren't catalogued params.
 *
 * Why not base on the XML roster: __block_layout.xml omits the effect-
 * type picker params (REVERB_TYPE etc.), so an XML-base catalog silently
 * drops them. The scan + Ghidra-oracle base recovers them.
 *
 * Output: modern-fractal-devicetrue-<dev>.json
 * Usage:  npx tsx scripts/_research/merge-modern-fractal-devicetrue.ts <dev>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const dev = process.argv[2];
if (!dev) {
  console.error('usage: merge-modern-fractal-devicetrue.ts <dev>');
  process.exit(1);
}
const D = 'samples/captured/decoded';

const xml = JSON.parse(readFileSync(`${D}/modern-fractal-catalog-${dev}.json`, 'utf-8')) as {
  params: { family: string; name: string; displayLabel?: string; controlType: string }[];
};
const scan = JSON.parse(readFileSync(`${D}/scan-paramtables-${dev}.json`, 'utf-8')) as {
  params: { name: string; paramId: number }[];
};
const iiiScan = JSON.parse(readFileSync(`${D}/scan-paramtables-iii.json`, 'utf-8')) as {
  params: { name: string; paramId: number }[];
};
const ghidra = JSON.parse(readFileSync(`${D}/ghidra-axeedit3-paramnames.json`, 'utf-8')) as {
  effect_types: Record<string, { effectFamily?: string; params: { paramId: number; name: string }[] }>;
};

// ── oracles + family map ───────────────────────────────────────────
const ownId = new Map(scan.params.map((p) => [p.name, p.paramId]));
const iiiId = new Map(iiiScan.params.map((p) => [p.name, p.paramId]));
const iiiFamily = new Map<string, string>();
const familySet = new Set<string>();
for (const k of Object.keys(ghidra.effect_types)) {
  const e = ghidra.effect_types[k];
  if (e.effectFamily) familySet.add(e.effectFamily);
  for (const p of e.params) if (e.effectFamily) iiiFamily.set(p.name, e.effectFamily);
}
const ghidraNames = new Set(iiiFamily.keys());
const familiesByLen = [...familySet].sort((a, b) => b.length - a.length);
function familyOf(symbol: string): string {
  if (iiiFamily.has(symbol)) return iiiFamily.get(symbol)!;
  // Legacy "OLD_<FAMILY>_..." symbols (e.g. FM3's relabeled OLD_FLANGER_*)
  // belong to <FAMILY>, not a phantom 'OLD' family no block maps to.
  const oldMatch = symbol.match(/^OLD_([A-Z0-9]+)_/);
  if (oldMatch && familySet.has(oldMatch[1])) return oldMatch[1];
  for (const f of familiesByLen) if (symbol === f || symbol.startsWith(f + '_')) return f;
  const us = symbol.indexOf('_');
  return us > 0 ? symbol.slice(0, us) : symbol;
}

// device-XML-roster symbols + their labels
const xmlLabel = new Map<string, string | undefined>();
const xmlNames = new Set<string>();
for (const p of xml.params) {
  xmlNames.add(p.name);
  if (p.displayLabel) xmlLabel.set(p.name, p.displayLabel);
}

// ── build catalog: scan symbol validated by either oracle ──────────
interface Out {
  family: string;
  name: string;
  paramId: number;
  source: 'iii-ghidra+device-scan' | 'device-xml+device-scan';
  displayLabel?: string;
  iiiParamId?: number;
  reuseWouldMisaddress?: boolean;
}
const out: Out[] = [];
for (const { name, paramId } of scan.params) {
  const inGhidra = ghidraNames.has(name);
  const inXml = xmlNames.has(name);
  if (!inGhidra && !inXml) continue; // scan-only symbol, not a catalogued param
  const iii = iiiId.get(name);
  out.push({
    family: familyOf(name),
    name,
    paramId,
    source: inGhidra ? 'iii-ghidra+device-scan' : 'device-xml+device-scan',
    displayLabel: xmlLabel.get(name),
    iiiParamId: iii,
    reuseWouldMisaddress: iii !== undefined ? iii !== paramId : undefined,
  });
}
out.sort((a, b) => a.family.localeCompare(b.family) || a.paramId - b.paramId || a.name.localeCompare(b.name));

// ── stats ──────────────────────────────────────────────────────────
const sharedAudited = out.filter((p) => p.reuseWouldMisaddress !== undefined);
const reuseWrong = sharedAudited.filter((p) => p.reuseWouldMisaddress === true);
const families = [...new Set(out.map((p) => p.family))].sort();
const summary = {
  device: dev,
  params: out.length,
  fromGhidraOracle: out.filter((p) => p.source === 'iii-ghidra+device-scan').length,
  fromXmlOracle: out.filter((p) => p.source === 'device-xml+device-scan').length,
  familyCount: families.length,
  reuseAudit: {
    sharedWithIII: sharedAudited.length,
    wouldMisaddressIfIIIReused: reuseWrong.length,
    misaddressPct: sharedAudited.length
      ? +((100 * reuseWrong.length) / sharedAudited.length).toFixed(1)
      : 0,
  },
};
const outPath = `${D}/modern-fractal-devicetrue-${dev}.json`;
writeFileSync(outPath, JSON.stringify({ summary, params: out }, null, 2));
console.log(`${dev}:`, JSON.stringify(summary));
