/**
 * One-shot extractor: Axe-Fx Standard/Ultra (gen-1) published SysEx HTML
 *   ->  draft codec data (blockTypes, params, enums) + a coverage report.
 *
 * Source: docs/manuals/AxeFx-Ultra-SysEx-Messages.htm (the official Ultra
 * "Axe-FX System Exclusive Messages" doc, mirrored from archive.axefx.fr).
 *
 * The whole gen-1 wire is nibble-split, low-nibble-first: an 8-bit value
 * 0..255 is transmitted as two MIDI bytes [v & 0x0f, (v >> 4) & 0x0f]. This
 * holds for block IDs, parameter IDs, and parameter values alike. The doc
 * prints both the decimal value and the `0x 0x` hex pair for every cell, so we
 * can VALIDATE the encoding by checking nibbleJoin(hexPair) === statedDecimal
 * on every row. A clean run proves the wire shape across the entire catalog,
 * not just the doc's single worked example.
 *
 * Read-only. Writes drafts under scripts/_research/gen1-out/. Run:
 *   npx tsx scripts/_research/parse-gen1-sysex.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SRC = join(REPO, 'docs', 'manuals', 'AxeFx-Ultra-SysEx-Messages.htm');
const OUT_DIR = join(HERE, 'gen1-out');

// ----- nibble-split codec (the thing under test) -----------------------------

function nibbleSplit(v: number): [number, number] {
  return [v & 0x0f, (v >> 4) & 0x0f];
}
function nibbleJoin(lo: number, hi: number): number {
  return (hi << 4) | lo;
}
/** Parse a `"0A 06"` / `"0A&nbsp;06"` hex pair into [lo, hi] bytes. */
function parseHexPair(s: string): [number, number] | undefined {
  const m = s
    .replace(/&nbsp;/g, ' ')
    .trim()
    .match(/^([0-9A-Fa-f]{1,2})\s+([0-9A-Fa-f]{1,2})$/);
  if (!m) return undefined;
  return [parseInt(m[1], 16), parseInt(m[2], 16)];
}

// ----- tiny HTML helpers -----------------------------------------------------

/** Strip tags but turn <br> into newlines; decode the few entities we see. */
function cellText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

interface Cell {
  text: string;
  rowspan: number;
}

/** Extract the <td> cells of one <tr>...</tr> chunk (skips <th> header rows). */
function parseCells(rowHtml: string): Cell[] | undefined {
  if (/<th[\s>]/i.test(rowHtml)) return undefined; // header / section row
  const cells: Cell[] = [];
  const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) {
    const attrs = m[1];
    const rsMatch = attrs.match(/rowspan\s*=\s*['"]?(\d+)/i);
    cells.push({ text: cellText(m[2]), rowspan: rsMatch ? parseInt(rsMatch[1], 10) : 1 });
  }
  return cells.length ? cells : undefined;
}

// ----- the 13-column grid model ----------------------------------------------
// Columns, left to right, in every block table:
//  0 blockDecimal  1 blockName  2 block 0b0b
//  3 paramDecimal  4 paramName  5 param 0p0p
//  6 decMin  7 decDefault  8 decMax  9 description
// 10 v 0v0v-min  11 v 0v0v-default  12 v 0v0v-max
const NCOL = 13;

interface CarrySlot {
  text: string;
  remaining: number;
}

/** Expand a sequence of rows (with rowspans) into full 13-column rows. */
function expandGrid(rows: Cell[][]): string[][] {
  const carry: (CarrySlot | undefined)[] = new Array(NCOL).fill(undefined);
  const out: string[][] = [];
  for (const cells of rows) {
    const line: string[] = new Array(NCOL).fill('');
    let ci = 0;
    for (let col = 0; col < NCOL; col++) {
      const slot = carry[col];
      if (slot && slot.remaining > 0) {
        line[col] = slot.text;
        slot.remaining -= 1;
        continue;
      }
      if (ci < cells.length) {
        const cell = cells[ci++];
        line[col] = cell.text;
        if (cell.rowspan > 1) carry[col] = { text: cell.text, remaining: cell.rowspan - 1 };
      }
    }
    out.push(line);
  }
  return out;
}

// ----- block section extraction ----------------------------------------------

interface BlockInstance {
  name: string;
  decimal: number;
  hex: [number, number];
}
interface EnumValue {
  value: number;
  name: string;
}
interface ParamRecord {
  block: string;
  paramName: string;
  paramDecimal: number;
  paramHex: [number, number];
  decMin?: number;
  decDefault?: number;
  decMax?: number;
  description: string;
  enumValues?: EnumValue[];
  display?: { min: number; max: number; unit: string; nonlinear: boolean };
}
interface BlockRecord {
  block: string;
  instances: BlockInstance[];
  params: ParamRecord[];
}

interface Mismatch {
  where: string;
  decimal: number;
  hex: string;
  decodedTo: number;
  encodedTo: string;
}

const mismatches: Mismatch[] = [];

// Test BOTH directions: nibbleJoin(docHex)===decimal (doc self-consistency) AND
// nibbleSplit(decimal)===docHex (our EMIT-side encoder, the thing we'd ship).
// The second is what the review asked for: it puts our encoder under test, not
// just the document's internal consistency.
function checkNibble(where: string, decimal: number, hex: [number, number]): void {
  const decoded = nibbleJoin(hex[0], hex[1]);
  const enc = nibbleSplit(decimal);
  if (decoded !== decimal || enc[0] !== hex[0] || enc[1] !== hex[1]) {
    mismatches.push({
      where,
      decimal,
      hex: `${hex[0].toString(16)} ${hex[1].toString(16)}`,
      decodedTo: decoded,
      encodedTo: `${enc[0].toString(16)} ${enc[1].toString(16)}`,
    });
  }
}

/**
 * The doc prints a complete 0..255 decimal->hexpair conversion table
 * (`<div id='vK'>K</div><font>HH HH</font>`). It is the single strongest
 * full-byte-range oracle: assert our `nibbleSplit` encoder reproduces every one
 * of the 256 pairs, and the decoder inverts them. Returns the count checked and
 * any rows where our encoder disagrees with the doc.
 */
function validateConversionTable(html: string): { count: number; bad: { k: number; doc: string; enc: string }[] } {
  const re = /<div id='v(\d+)'>\s*\d+\s*<\/div>\s*<font[^>]*>\s*([0-9A-Fa-f]{2})&nbsp;([0-9A-Fa-f]{2})\s*<\/font>/g;
  let m: RegExpExecArray | null;
  let count = 0;
  const bad: { k: number; doc: string; enc: string }[] = [];
  while ((m = re.exec(html)) !== null) {
    const k = parseInt(m[1], 10);
    const lo = parseInt(m[2], 16);
    const hi = parseInt(m[3], 16);
    const enc = nibbleSplit(k);
    if (enc[0] !== lo || enc[1] !== hi || nibbleJoin(lo, hi) !== k) {
      bad.push({ k, doc: `${m[2]} ${m[3]}`, enc: `${enc[0].toString(16).padStart(2, '0')} ${enc[1].toString(16).padStart(2, '0')}` });
    }
    count++;
  }
  return { count, bad };
}

function num(s: string): number | undefined {
  const t = s.trim();
  if (!/^-?\d+$/.test(t)) return undefined;
  return parseInt(t, 10);
}

function parseEnum(description: string): EnumValue[] | undefined {
  const lines = description.split('\n').map((l) => l.trim()).filter(Boolean);
  const vals: EnumValue[] = [];
  for (const line of lines) {
    const m = line.match(/^(\d+)\s*:\s*(.+)$/);
    if (!m) return undefined; // not a clean enum list
    vals.push({ value: parseInt(m[1], 10), name: m[2].trim() });
  }
  return vals.length >= 2 ? vals : undefined;
}

function parseDisplay(description: string): ParamRecord['display'] | undefined {
  // e.g. "0.00 to 10.00", "-80.0dB to 0.0dB", "10Hz to 1000Hz*", "2000Hz to 20000Hz*"
  const m = description.match(/^(-?\d[\d.]*)\s*([a-zA-Z%]*)\s*to\s*(-?\d[\d.]*)\s*([a-zA-Z%]*)(\*?)/);
  if (!m) return undefined;
  const min = parseFloat(m[1]);
  const max = parseFloat(m[3]);
  const unit = (m[4] || m[2] || '').trim();
  return { min, max, unit, nonlinear: m[5] === '*' };
}

function main(): void {
  const html = readFileSync(SRC, 'utf8');
  const conv = validateConversionTable(html);

  // Block sections are headed by: <tr><th align='left' colspan='13'><a name='X'>X</a></th></tr>
  const anchorRe = /colspan=['"]13['"]>\s*<a name=['"]([^'"]+)['"]>/gi;
  const anchors: { name: string; index: number }[] = [];
  let am: RegExpExecArray | null;
  while ((am = anchorRe.exec(html)) !== null) {
    anchors.push({ name: am[1], index: am.index });
  }

  const blocks: BlockRecord[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const blockName = anchors[i].name;
    const start = anchors[i].index;
    const end = i + 1 < anchors.length ? anchors[i + 1].index : html.length;
    const section = html.slice(start, end);

    // Collect <tr>...</tr> chunks, parse <td> rows, skip headers.
    const rowChunks = section.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];
    const tdRows: Cell[][] = [];
    for (const chunk of rowChunks) {
      const cells = parseCells(chunk);
      if (cells) tdRows.push(cells);
    }
    if (!tdRows.length) continue;

    const grid = expandGrid(tdRows);

    // Block instances come from the first grid row's columns 0/1/2 (the rowspan
    // cells expand to every row, so reading row 0 is enough).
    const instances: BlockInstance[] = [];
    {
      const names = grid[0][1].split('\n').map((s) => s.trim()).filter(Boolean);
      const decs = grid[0][0].split('\n').map((s) => s.trim()).filter(Boolean);
      const hexes = grid[0][2].split('\n').map((s) => s.trim()).filter(Boolean);
      for (let k = 0; k < hexes.length; k++) {
        const dec = num(decs[k] ?? decs[0] ?? '');
        const hp = parseHexPair(hexes[k]);
        if (dec === undefined || !hp) continue;
        checkNibble(`${blockName} block "${names[k] ?? ''}"`, dec, hp);
        instances.push({ name: names[k] ?? blockName, decimal: dec, hex: hp });
      }
    }

    const params: ParamRecord[] = [];
    const seenParam = new Set<number>();
    for (const row of grid) {
      const pDec = num(row[3]);
      const pName = row[4].trim();
      const pHex = parseHexPair(row[5]);
      if (pDec === undefined || !pName || !pHex) continue;
      if (seenParam.has(pDec)) continue; // rowspan duplicate guard
      seenParam.add(pDec);

      checkNibble(`${blockName}.${pName} paramId`, pDec, pHex);

      const decMin = num(row[6]);
      const decDefault = num(row[7]);
      const decMax = num(row[8]);
      const description = row[9].trim();

      // Validate the value hex pairs against the stated decimals where present.
      const vMin = parseHexPair(row[10]);
      const vDefault = parseHexPair(row[11]);
      const vMax = parseHexPair(row[12]);
      if (decMin !== undefined && vMin) checkNibble(`${blockName}.${pName} valueMin`, decMin, vMin);
      if (decDefault !== undefined && vDefault) checkNibble(`${blockName}.${pName} valueDefault`, decDefault, vDefault);
      if (decMax !== undefined && vMax) checkNibble(`${blockName}.${pName} valueMax`, decMax, vMax);

      const enumValues = parseEnum(description);
      const display = enumValues ? undefined : parseDisplay(description);

      params.push({
        block: blockName,
        paramName: pName,
        paramDecimal: pDec,
        paramHex: pHex,
        decMin,
        decDefault,
        decMax,
        description,
        enumValues,
        display,
      });
    }

    blocks.push({ block: blockName, instances, params });
  }

  // ----- emit drafts ---------------------------------------------------------
  mkdirSync(OUT_DIR, { recursive: true });

  const blockTypes = blocks.map((b) => ({ block: b.block, instances: b.instances }));
  writeFileSync(join(OUT_DIR, 'blockTypes.json'), JSON.stringify(blockTypes, null, 2));

  const flatParams = blocks.flatMap((b) => b.params);
  writeFileSync(join(OUT_DIR, 'params.json'), JSON.stringify(flatParams, null, 2));

  const enums = flatParams
    .filter((p) => p.enumValues)
    .map((p) => ({ block: p.block, param: p.paramName, count: p.enumValues!.length, values: p.enumValues }));
  writeFileSync(join(OUT_DIR, 'enums.json'), JSON.stringify(enums, null, 2));

  // ----- coverage report -----------------------------------------------------
  const totalParams = flatParams.length;
  const withRange = flatParams.filter((p) => p.decMax !== undefined).length;
  const enumParams = enums.length;
  const nonlinear = flatParams.filter((p) => p.display?.nonlinear).length;
  const linear = flatParams.filter((p) => p.display && !p.display.nonlinear).length;
  const noDescDecode = flatParams.filter((p) => !p.enumValues && !p.display).length;

  const lines: string[] = [];
  lines.push('# Axe-Fx gen-1 (Ultra) SysEx parse coverage');
  lines.push('');
  lines.push(`Source: docs/manuals/AxeFx-Ultra-SysEx-Messages.htm`);
  lines.push('');
  lines.push(`- Blocks parsed: ${blocks.length}`);
  lines.push(`- Block instances: ${blocks.reduce((n, b) => n + b.instances.length, 0)}`);
  lines.push(`- Parameters parsed: ${totalParams}`);
  lines.push(`- ... with numeric range: ${withRange}`);
  lines.push(`- ... enum params: ${enumParams} (total enum values: ${enums.reduce((n, e) => n + e.count, 0)})`);
  lines.push(`- ... linear display ranges: ${linear}`);
  lines.push(`- ... non-linear (\\*) display ranges: ${nonlinear}`);
  lines.push(`- ... no parseable description (review): ${noDescDecode}`);
  lines.push('');
  lines.push('## Nibble-split wire validation');
  lines.push('');
  lines.push(
    `Two checks, both directions, on every block id / param id / value-min/default/max cell: ` +
      `(a) decoder \`nibbleJoin(docHex) === docDecimal\` (doc self-consistency), and ` +
      `(b) **encoder** \`nibbleSplit(docDecimal) === docHex\` (our emit-side function under test).`,
  );
  lines.push('');
  lines.push(
    `Plus the doc's complete 0..255 decimal->hexpair conversion table (the strongest ` +
      `full-byte-range oracle): **${conv.count}/256 values checked, ${conv.bad.length} encoder mismatches.**`,
  );
  if (conv.bad.length) {
    for (const b of conv.bad.slice(0, 20)) lines.push(`- v${b.k}: doc \`${b.doc}\`, nibbleSplit -> \`${b.enc}\``);
  }
  lines.push('');
  lines.push(
    `Scope note: this establishes that the doc's decimal and hex columns are ` +
      `**self-consistent with low-nibble-first encoding across the catalog, and that our ` +
      `\`nibbleSplit\` encoder reproduces every documented value including the full 0..255 ` +
      `range.** It is NOT hardware verification: gen-1 Standard/Ultra is hardware the project ` +
      `does not own, so nothing here is confirmed against a device.`,
  );
  if (mismatches.length === 0) {
    lines.push('');
    lines.push(`**Catalog cells: 0 mismatches** (both directions).`);
  } else {
    lines.push('');
    lines.push(`**${mismatches.length} MISMATCHES** (investigate before trusting the encoder):`);
    lines.push('');
    for (const m of mismatches.slice(0, 50)) {
      lines.push(`- ${m.where}: doc decimal ${m.decimal}, hex \`${m.hex}\` decodes to ${m.decodedTo}, nibbleSplit emits \`${m.encodedTo}\``);
    }
    if (mismatches.length > 50) lines.push(`- ... and ${mismatches.length - 50} more`);
  }
  lines.push('');
  lines.push('## Per-block summary');
  lines.push('');
  lines.push('| Block | Instances | Params | Enum params |');
  lines.push('|---|---|---|---|');
  for (const b of blocks) {
    const en = b.params.filter((p) => p.enumValues).length;
    lines.push(`| ${b.block} | ${b.instances.map((i) => i.name).join(', ')} | ${b.params.length} | ${en} |`);
  }
  lines.push('');
  lines.push('## Worked-example self-test');
  lines.push('');
  // Reproduce the doc's example: Comp 2 Knee=SOFTER -> F0 00 01 74 01 02 05 06 05 00 02 00 01 F7
  const env = (block: number, param: number, value: number): string => {
    const b = nibbleSplit(block);
    const p = nibbleSplit(param);
    const v = nibbleSplit(value);
    const bytes = [0xf0, 0x00, 0x01, 0x74, 0x01, 0x02, ...b, ...p, ...v, 0x01, 0xf7];
    return bytes.map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  };
  const exampleWire = env(0x65 /*Comp2=101*/, 0x05 /*Knee=5*/, 0x02 /*SOFTER=2*/);
  const expected = 'F0 00 01 74 01 02 05 06 05 00 02 00 01 F7';
  lines.push(`- Built:    \`${exampleWire}\``);
  lines.push(`- Expected: \`${expected}\``);
  lines.push(`- Match: ${exampleWire === expected ? 'YES' : 'NO'}`);

  writeFileSync(join(OUT_DIR, 'coverage.md'), lines.join('\n'));

  // ----- console summary -----------------------------------------------------
  console.log(`blocks=${blocks.length} params=${totalParams} enums=${enumParams} mismatches=${mismatches.length}`);
  console.log(`0..255 conversion table: ${conv.count}/256 checked, ${conv.bad.length} encoder mismatches`);
  console.log(`worked-example match: ${exampleWire === expected ? 'YES' : 'NO'}`);
  console.log(`output -> ${OUT_DIR}`);
  if (mismatches.length) {
    console.log('FIRST MISMATCHES:');
    for (const m of mismatches.slice(0, 10)) {
      console.log(`  ${m.where}: dec ${m.decimal} hex ${m.hex} -> ${m.decodedTo}`);
    }
  }
}

main();
