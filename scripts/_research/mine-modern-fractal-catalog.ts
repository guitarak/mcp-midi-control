/**
 * Mine a modern-Fractal editor's `__block_layout.xml` into a device-true
 * parameter catalog + block roster + effect-type enums.
 *
 * WHAT THE XML GIVES (and does NOT):
 *   - parameterName  : firmware symbol (e.g. REVERB_TYPE)        ✅
 *   - name           : editor knob caption / display label       ✅
 *   - type           : control type (knob/dropdown/toggle/…)     ✅
 *   - effectName     : block id (ID_REVERB, ID_GLOBAL, …)        ✅
 *   - EffectVariant value→name : the effect-TYPE enum vocabulary ✅
 *   - paramId (14-bit wire id) : ABSENT from the XML             ❌
 *
 * The XML has NO numeric paramId. paramIds are recovered by JOINING the
 * mined symbol against the Axe-Edit III Ghidra catalog (FUN_140397a40,
 * `ghidra-axeedit3-paramnames.json`) — valid for symbols the gen-3
 * family shares with the III. Symbols absent from the III catalog
 * (device-new, e.g. VP4 effect types) are emitted with paramId=null and
 * source='unmined-needs-ghidra' — they are NOT wire-addressable until
 * that device's own dispatcher is mined or a hardware capture lands.
 *
 * Usage:
 *   npx tsx scripts/_research/mine-modern-fractal-catalog.ts <device> <xml> [<xml2> …]
 * Example:
 *   npx tsx scripts/_research/mine-modern-fractal-catalog.ts vp4 \
 *     samples/captured/decoded/binarydata/vp4-edit/__block_layout.xml \
 *     samples/captured/decoded/binarydata/vp4-edit/__block_layout_expert.xml
 *
 * Output: samples/captured/decoded/modern-fractal-catalog-<device>.json
 */
import { readFileSync, writeFileSync } from 'node:fs';

const device = process.argv[2];
const xmlPaths = process.argv.slice(3);
if (!device || xmlPaths.length === 0) {
  console.error('usage: mine-modern-fractal-catalog.ts <device> <xml> [<xml2> …]');
  process.exit(1);
}

// ── III Ghidra symbol → paramId join map ───────────────────────────
const ghidra = JSON.parse(
  readFileSync('samples/captured/decoded/ghidra-axeedit3-paramnames.json', 'utf-8'),
) as { effect_types: Record<string, { effectFamily?: string; params: { paramId: number; name: string }[] }> };
const iiiParamId = new Map<string, number>();
const iiiFamily = new Map<string, string>();
const familySet = new Set<string>();
for (const k of Object.keys(ghidra.effect_types)) {
  const e = ghidra.effect_types[k];
  if (e.effectFamily) familySet.add(e.effectFamily);
  for (const p of e.params) {
    iiiParamId.set(p.name, p.paramId);
    if (e.effectFamily) iiiFamily.set(p.name, e.effectFamily);
  }
}
// Longest-prefix family resolver for device-new symbols.
const familiesByLen = [...familySet].sort((a, b) => b.length - a.length);
function familyOf(symbol: string): string {
  if (iiiFamily.has(symbol)) return iiiFamily.get(symbol)!;
  for (const f of familiesByLen) {
    if (symbol === f || symbol.startsWith(f + '_')) return f;
  }
  // fall back to leading segment
  const us = symbol.indexOf('_');
  return us > 0 ? symbol.slice(0, us) : symbol;
}

// ── XML scan ───────────────────────────────────────────────────────
function attr(s: string, key: string): string | undefined {
  const m = s.match(new RegExp(`\\b${key}="([^"]*)"`));
  return m ? m[1] : undefined;
}
function decodeEntities(s: string): string {
  return s
    .replace(/&#10;|&#13;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

interface RawHit {
  name: string; // symbol
  label?: string;
  type: string;
  effectName?: string;
  source: string; // which xml file
}
interface VariantHit {
  block: string; // enclosing EditorControls name
  effectName?: string;
  value: string;
  name: string;
  source: string;
}

const rawHits: RawHit[] = [];
const variants: VariantHit[] = [];
const editorControlRe = /<EditorControl\b([^>]*?)\/?>/g;
const controlsOpenRe = /<EditorControls\b([^>]*?)>/g;
const variantRe = /<EffectVariant\b([^>]*?)\/?>/g;

for (const path of xmlPaths) {
  const xml = readFileSync(path, 'utf-8');
  const srcName = path.split(/[\\/]/).pop()!;

  // Track enclosing <EditorControls name="…"> by offset.
  const controlsOpens: { offset: number; name?: string }[] = [];
  for (const m of xml.matchAll(controlsOpenRe)) {
    controlsOpens.push({ offset: m.index!, name: attr(m[1], 'name') });
  }
  const controlsAt = (off: number): string | undefined => {
    let last: string | undefined;
    for (const c of controlsOpens) {
      if (c.offset > off) break;
      last = c.name;
    }
    return last;
  };

  let pn = 0;
  for (const m of xml.matchAll(editorControlRe)) {
    const a = m[1];
    const name = attr(a, 'parameterName');
    if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) continue;
    const labelRaw = attr(a, 'name');
    rawHits.push({
      name,
      label: labelRaw ? decodeEntities(labelRaw) : undefined,
      type: attr(a, 'type') ?? '',
      effectName: attr(a, 'effectName'),
      source: srcName,
    });
    pn++;
  }
  let vc = 0;
  for (const m of xml.matchAll(variantRe)) {
    const a = m[1];
    const value = attr(a, 'value');
    const name = attr(a, 'name');
    if (value === undefined || name === undefined) continue;
    if (value === '') continue; // container variants ("Global") carry no enum value
    variants.push({
      block: controlsAt(m.index!) ?? '?',
      value,
      name: decodeEntities(name),
      source: srcName,
    });
    vc++;
  }
  console.log(`  ${srcName}: ${pn} parameterName hits, ${vc} EffectVariant enum entries`);
}

// ── Reduce: dedupe symbols, pick canonical label/type, join paramId ─
interface CatalogParam {
  family: string;
  name: string;
  paramId: number | null;
  paramIdSource: 'iii-ghidra' | 'unmined-needs-ghidra';
  displayLabel?: string;
  controlType: string;
  effectNames: string[];
  labelVariants: string[];
}

const bySymbol = new Map<string, RawHit[]>();
for (const h of rawHits) {
  const arr = bySymbol.get(h.name) ?? [];
  arr.push(h);
  bySymbol.set(h.name, arr);
}

function mode(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) {
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  return sorted[0]?.[0];
}

const params: CatalogParam[] = [];
for (const [name, hits] of [...bySymbol.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const paramId = iiiParamId.has(name) ? iiiParamId.get(name)! : null;
  params.push({
    family: familyOf(name),
    name,
    paramId,
    paramIdSource: paramId === null ? 'unmined-needs-ghidra' : 'iii-ghidra',
    displayLabel: mode(hits.map((h) => h.label)),
    controlType: mode(hits.map((h) => h.type)) ?? '',
    effectNames: [...new Set(hits.map((h) => h.effectName).filter(Boolean) as string[])].sort(),
    labelVariants: [...new Set(hits.map((h) => h.label).filter(Boolean) as string[])].sort(),
  });
}

// ── Block roster: group by family ──────────────────────────────────
const byFamily = new Map<string, CatalogParam[]>();
for (const p of params) {
  const arr = byFamily.get(p.family) ?? [];
  arr.push(p);
  byFamily.set(p.family, arr);
}
const blocks = [...byFamily.entries()]
  .map(([family, ps]) => ({
    family,
    paramCount: ps.length,
    withParamId: ps.filter((p) => p.paramId !== null).length,
    effectNames: [...new Set(ps.flatMap((p) => p.effectNames))].sort(),
  }))
  .sort((a, b) => b.paramCount - a.paramCount);

// ── Effect-type enums (dedupe by block+value) ──────────────────────
const enumByBlock = new Map<string, Map<string, string>>();
for (const v of variants) {
  const m = enumByBlock.get(v.block) ?? new Map<string, string>();
  // value can be a comma list "0,9,10" → one name covers several indices
  m.set(v.value, v.name);
  enumByBlock.set(v.block, m);
}
const effectTypeEnums: Record<string, { value: string; name: string }[]> = {};
for (const [block, m] of enumByBlock) {
  effectTypeEnums[block] = [...m.entries()]
    .map(([value, name]) => ({ value, name }))
    .sort((a, b) => Number(a.value.split(',')[0]) - Number(b.value.split(',')[0]));
}

// ── Stats + write ──────────────────────────────────────────────────
const withId = params.filter((p) => p.paramId !== null).length;
const summary = {
  device,
  sources: xmlPaths.map((p) => p.split(/[\\/]/).pop()),
  totalSymbols: params.length,
  withParamId: withId,
  unmined: params.length - withId,
  paramIdCoveragePct: +((100 * withId) / params.length).toFixed(1),
  familyCount: blocks.length,
  effectEnumBlocks: Object.keys(effectTypeEnums).length,
};

const out = `samples/captured/decoded/modern-fractal-catalog-${device}.json`;
writeFileSync(out, JSON.stringify({ summary, blocks, effectTypeEnums, params }, null, 2));

console.log(`\n=== ${device} ===`);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nfamilies (paramCount / withParamId):`);
for (const b of blocks) console.log(`  ${b.family.padEnd(16)} ${String(b.paramCount).padStart(4)} / ${b.withParamId}`);
console.log(`\nwrote ${out}`);
