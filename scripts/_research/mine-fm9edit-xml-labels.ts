/**
 * Mine the FM9-Edit JUCE-BinaryData XML files for parameterName →
 * displayLabel + controlType + block-section catalog.
 *
 * Adapted from `mine-axeedit3-xml-labels.ts` (the III miner) with one
 * addition: each hit also records its enclosing `<EditorControls
 * name="...">` block section, so the output ties every parameterName
 * to the FM9-Edit block(s) that expose it. That's what lets the
 * generator decide which Axe-Fx III catalog families the FM9 actually
 * surfaces, and which parameterNames are FM9-divergent.
 *
 * Source XML (extracted from `FM9-Edit.exe`'s JUCE BinaryData zip,
 * gitignored under `samples/captured/decoded/binarydata/`):
 *
 *   __block_layout.xml      — every FM9 block (8,817 EditorControl entries)
 *   __amp_layout.xml        — amp-variant pages
 *   __amp_layout_v06p00.xml — per-firmware amp layout
 *
 * Output:
 *   samples/captured/decoded/fm9edit-xml-labels.json
 *
 * Run:
 *   npx tsx scripts/_research/mine-fm9edit-xml-labels.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';

const XML_DIR =
  'samples/captured/decoded/binarydata/fm9-edit-allzips/extracted';
const SOURCES = [
  '__block_layout.xml',
  '__amp_layout.xml',
  '__amp_layout_v06p00.xml',
];
const OUT = 'samples/captured/decoded/fm9edit-xml-labels.json';

interface CatalogEntry {
  parameterName: string;
  displayLabel: string;
  controlType: string;
  /** Enclosing <EditorControls name="..."> sections (block names). */
  blocks: string[];
  variants: string[];
}

const hits = new Map<
  string,
  Array<{ file: string; block?: string; name: string; type: string }>
>();

const editorControlRe = /<EditorControl\b([^>]*?)\/?>/g;
const sectionOpenRe = /<EditorControls\b([^>]*?)>/g;

function attr(s: string, key: string): string | undefined {
  const m = s.match(new RegExp(`\\b${key}="([^"]*)"`));
  return m ? m[1] : undefined;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&#10;/g, ' ')
    .replace(/&#13;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function scanFile(filename: string): void {
  const xml = readFileSync(`${XML_DIR}/${filename}`, 'utf-8');

  // Offset → enclosing EditorControls section name. Amp layout files
  // have no EditorControls sections; everything there is "Amp".
  const sections: Array<{ offset: number; name?: string }> = [];
  for (const m of xml.matchAll(sectionOpenRe)) {
    sections.push({ offset: m.index!, name: attr(m[1], 'name') });
  }
  const isAmpFile = filename.startsWith('__amp_layout');
  function sectionAt(offset: number): string | undefined {
    if (isAmpFile) return 'Amp';
    let last: string | undefined;
    for (const s of sections) {
      if (s.offset > offset) break;
      last = s.name;
    }
    return last;
  }

  let count = 0;
  for (const m of xml.matchAll(editorControlRe)) {
    const attrs = m[1];
    const parameterName = attr(attrs, 'parameterName');
    if (!parameterName) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(parameterName)) continue;
    const name = attr(attrs, 'name');
    const type = attr(attrs, 'type') ?? '';
    if (!name) continue;
    const decoded = decodeXmlEntities(name);
    if (!decoded) continue;
    const arr = hits.get(parameterName) ?? [];
    arr.push({ file: filename, block: sectionAt(m.index!), name: decoded, type });
    hits.set(parameterName, arr);
    count++;
  }
  console.log(`  ${filename}: ${count} parameterName hits`);
}

console.log(`mining FM9-Edit XML labels from ${XML_DIR}…`);
for (const f of SOURCES) scanFile(f);

const catalog: CatalogEntry[] = [];
for (const [parameterName, items] of [...hits.entries()].sort((a, b) =>
  a[0].localeCompare(b[0]),
)) {
  const labelCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const it of items) {
    labelCounts.set(it.name, (labelCounts.get(it.name) ?? 0) + 1);
    if (it.type) typeCounts.set(it.type, (typeCounts.get(it.type) ?? 0) + 1);
  }
  const displayLabel = [...labelCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0][0];
  const controlType =
    [...typeCounts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? '';
  catalog.push({
    parameterName,
    displayLabel,
    controlType,
    blocks: [...new Set(items.map((it) => it.block).filter((b): b is string => !!b))].sort(),
    variants: [...new Set(items.map((it) => it.name))].sort(),
  });
}

writeFileSync(OUT, JSON.stringify(catalog, null, 2), 'utf-8');
console.log(`\nwrote ${catalog.length.toLocaleString()} unique parameterName entries → ${OUT}`);

// Family-prefix distribution (joins against the III Ghidra catalog families).
const byPrefix = new Map<string, number>();
for (const e of catalog) {
  const m = e.parameterName.match(/^([A-Z0-9]+)_/);
  const p = m ? m[1] : '(none)';
  byPrefix.set(p, (byPrefix.get(p) ?? 0) + 1);
}
console.log('\nper-prefix entry count:');
for (const [p, n] of [...byPrefix.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${p.padEnd(16)} ${n.toString().padStart(4)}`);
}
