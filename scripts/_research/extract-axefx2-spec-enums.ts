/**
 * Extract the C-enum declarations from the public Axe-Fx II MIDI spec
 *   (Adam Cook, "Fractal MIDI Spec Public", 22 Jan 2014).
 *
 * The doc embeds two kinds of enum: a single effect-ID table (ID_COMP1 = 100,
 * ID_COMP2, ...) that maps each block to its effect ID, and many per-block
 * parameter enums (COMP_THRESH, COMP_RATIO, ...) whose ordinal IS the param ID
 * within that block. C enum semantics: first member = its explicit value or 0,
 * each subsequent member = previous + 1 unless it carries its own `= N`.
 *
 * Output: scripts/_research/gen2-out/{effectIds,paramEnums}.json + a flat
 * (block, paramName, paramId) list ready to diff against our shipped catalog.
 *
 *   npx tsx scripts/_research/extract-axefx2-spec-enums.ts
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');
const SRC = join(REPO, 'docs', 'manuals', 'AxeFx2-Fractal-MIDI-Spec-Public-2014-01-22.htm');
const OUT_DIR = join(HERE, 'gen2-out');

/** Strip the HTML to plain text, preserving paragraph breaks as newlines. */
function toPlainText(html: string): string {
  return html
    .replace(/<\/p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .join('\n');
}

interface EnumMember {
  name: string;
  value: number;
}
interface EnumDecl {
  /** Text on the line(s) just before `enum {` (lets us label the block). */
  context: string;
  members: EnumMember[];
}

/**
 * Walk the plain text and pull every `enum { ... }` block with C value
 * semantics. We track a small window of preceding non-empty lines as context
 * so a reader can tell which block a param enum belongs to.
 */
function parseEnums(text: string): EnumDecl[] {
  const lines = text.split('\n');
  const decls: EnumDecl[] = [];
  const recentContext: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!/^enum\b/.test(line) && line !== 'enum') {
      if (line) {
        recentContext.push(line);
        if (recentContext.length > 4) recentContext.shift();
      }
      continue;
    }

    // Found an enum. Gather text until the closing brace.
    const context = recentContext.join(' ');
    const body: string[] = [];
    // The `{` may be on this line or the next; members follow until `}`.
    let j = i;
    let started = false;
    let depth = 0;
    for (; j < lines.length; j++) {
      const seg = lines[j];
      for (const ch of seg) {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') {
          depth--;
        }
      }
      // collect member text (without braces / enum keyword)
      body.push(seg);
      if (started && depth === 0) break;
    }

    // Join the body, drop the enum/{/} scaffolding and any trailing typedef name.
    const inner = body
      .join('\n')
      .replace(/^[^\{]*\{/s, '') // up to and including first {
      .replace(/\}[^}]*$/s, '') // last } and anything after (typedef name / ;)
      .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
      .replace(/\/\/[^\n]*/g, ''); // line comments

    const members: EnumMember[] = [];
    let counter = 0;
    for (const rawTok of inner.split(/[,\n]/)) {
      const tok = rawTok.trim();
      if (!tok) continue;
      const m = tok.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:=\s*(0x[0-9a-fA-F]+|-?\d+))?$/);
      if (!m) continue; // skip stray tokens
      let value: number;
      if (m[2] !== undefined) {
        value = m[2].startsWith('0x') ? parseInt(m[2], 16) : parseInt(m[2], 10);
      } else {
        value = counter;
      }
      members.push({ name: m[1], value });
      counter = value + 1;
    }
    if (members.length) decls.push({ context, members });
    i = j;
    recentContext.length = 0;
  }
  return decls;
}

/** Derive a block label from an enum's member-name prefix (COMP_* -> COMP). */
function blockPrefix(members: EnumMember[]): string {
  const names = members.map((m) => m.name);
  // strip trailing _END / _MAX sentinels for prefix detection
  const real = names.filter((n) => !/_(END|MAX|COUNT|NUM)$/.test(n));
  if (!real.length) return '';
  const parts = real.map((n) => n.split('_')[0]);
  const first = parts[0];
  return parts.every((p) => p === first) ? first : '';
}

function main(): void {
  const html = readFileSync(SRC, 'utf8');
  const text = toPlainText(html);
  const decls = parseEnums(text);

  // The effect-ID table is the enum whose members are mostly ID_*.
  const effectDecl = decls.find((d) => d.members.filter((m) => m.name.startsWith('ID_')).length >= 5);
  const effectIds = effectDecl
    ? effectDecl.members.filter((m) => m.name.startsWith('ID_')).map((m) => ({ name: m.name, id: m.value }))
    : [];

  // Param enums: every other enum, keyed by detected block prefix.
  const paramEnums = decls
    .filter((d) => d !== effectDecl)
    .map((d) => ({ block: blockPrefix(d.members) || d.context.slice(0, 40), context: d.context, members: d.members }))
    .filter((d) => d.members.length);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'effectIds.json'), JSON.stringify(effectIds, null, 2));
  writeFileSync(join(OUT_DIR, 'paramEnums.json'), JSON.stringify(paramEnums, null, 2));

  // Flat (block, param, id) list for diffing.
  const flat = paramEnums.flatMap((pe) =>
    pe.members
      .filter((m) => !/_(END|MAX|COUNT|NUM)$/.test(m.name))
      .map((m) => ({ block: pe.block, param: m.name, paramId: m.value })),
  );
  writeFileSync(join(OUT_DIR, 'flatParams.json'), JSON.stringify(flat, null, 2));

  console.log(`enum decls: ${decls.length}`);
  console.log(`effect IDs: ${effectIds.length}`);
  console.log(`param enums (blocks): ${paramEnums.length}`);
  console.log(`flat params: ${flat.length}`);
  console.log('sample effect IDs:', effectIds.slice(0, 6).map((e) => `${e.name}=${e.id}`).join(', '));
  console.log('param-enum blocks:', paramEnums.map((p) => `${p.block}(${p.members.length})`).join(', '));
  console.log(`output -> ${OUT_DIR}`);
}

main();
