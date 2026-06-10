/**
 * mine-iii-subactions.ts
 *
 * Mechanical extractor for the gen-3 fn=0x01 sub-action code table from
 * the Ghidra decompile dump produced by MineAxeEditIIIActionsAndShapes.java:
 *
 *   packages/fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
 *
 * Output: samples/captured/decoded/iii-subaction-table.json
 *
 * What it extracts, per fn=0x01 caller body (PART A.2, 93 callers):
 *   - caller name, address, 1-based dump line span
 *   - action-code constants written into the action struct slot 0
 *     (uniform constants AND per-model-byte chained-equality arms for
 *     0x10 / 0x11 / 0x12)
 *   - action-struct field writes (offsets +4 blockId, +8 paramId,
 *     +0xc value32, +0x10 modifier, +0x14 tailCount, +0x18.. tail bytes)
 *     with their RHS expressions (constant vs argument vs runtime)
 *   - string literals appearing in the body (purpose evidence: FACT tier)
 *   - helper functions called from the body (excluding the fn=0x01
 *     builder FUN_14033ec70 itself)
 *
 * Plus PART B (host-emit wire shapes for other fn bytes): section label,
 * caller bodies, line spans, strings.
 *
 * Run: npx tsx scripts/_research/mine-iii-subactions.ts
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DUMP = resolve(
  'packages/fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt',
);
const OUT = resolve('samples/captured/decoded/iii-subaction-table.json');

const lines = readFileSync(DUMP, 'utf8').split(/\r?\n/);

// ---------------------------------------------------------------- types

interface FieldWrite {
  /** byte offset into the action struct (0 = action code slot) */
  offset: number;
  /** raw RHS text */
  rhs: string;
  /** classification of the RHS */
  kind: 'constant' | 'argument' | 'runtime';
  /** parsed numeric value when kind === 'constant' */
  value?: number;
  /** 1-based dump line */
  line: number;
}

interface ActionCodeFinding {
  /** numeric action code */
  code: number;
  /** model bytes this constant is assigned under; 'all' if unconditional
   *  or guarded by the (0x10||0x11||0x12) catch-all */
  models: string;
  /** 1-based dump line of the assignment */
  line: number;
}

interface CallerRecord {
  index: number;
  fn: string;
  addr: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  actionCodes: ActionCodeFinding[];
  /** writes through the action-struct pointer */
  fieldWrites: FieldWrite[];
  tailCount?: number;
  strings: { text: string; line: number }[];
  callees: string[];
  bodyLineCount: number;
  notes: string[];
}

interface PartBSection {
  label: string;
  lineStart: number;
  lineEnd: number;
  callers: {
    fn: string;
    addr: string;
    lineStart: number;
    lineEnd: number;
    strings: { text: string; line: number }[];
    callees: string[];
  }[];
}

// ------------------------------------------------------------ locate parts

function findLine(re: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) if (re.test(lines[i])) return i;
  return -1;
}

const partA2Start = findLine(/^## PART A\.2/);
const partBStart = findLine(/^## PART B/);
if (partA2Start < 0 || partBStart < 0) throw new Error('dump structure not recognized');

// ------------------------------------------------------- parse PART A.2

const callerHeads: { index: number; fn: string; addr: string; line: number }[] = [];
for (let i = partA2Start; i < partBStart; i++) {
  const m = lines[i].match(/^CALLER #(\d+): (FUN_[0-9a-f]+) @ ([0-9a-f]+)/);
  if (m) callerHeads.push({ index: Number(m[1]), fn: m[2], addr: m[3], line: i });
}

const HEX = /0x[0-9a-fA-F]+|\d+/;

function classifyRhs(rhs: string): { kind: FieldWrite['kind']; value?: number } {
  const t = rhs.trim().replace(/;$/, '');
  if (/^(0x[0-9a-fA-F]+|\d+)$/.test(t)) return { kind: 'constant', value: Number(t) };
  if (/^param_\d+$/.test(t)) return { kind: 'argument' };
  return { kind: 'runtime' };
}

function extractStrings(body: string[], base: number) {
  const out: { text: string; line: number }[] = [];
  body.forEach((l, i) => {
    // string literals in decompiled C; skip type keywords in casts
    const re = /"((?:[^"\\]|\\.){3,})"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) out.push({ text: m[1], line: base + i + 1 });
  });
  return out;
}

function extractCallees(body: string[], selfFn: string): string[] {
  const set = new Set<string>();
  for (const l of body) {
    const re = /FUN_14[0-9a-f]{7}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(l)) !== null) {
      if (m[0] !== selfFn && m[0] !== 'FUN_14033ec70') set.add(m[0]);
    }
  }
  return [...set].sort();
}

/**
 * Find action-code constants. Strategy:
 *  1. Find writes to the struct's slot 0: `**(undefined4 **)(EXPR) = RHS;`
 *  2. If RHS is a constant, record it (models from guard scan).
 *  3. If RHS is a variable (uVarN/local_NN), collect every `VAR = CONST;`
 *     assignment in the body and attribute model bytes by scanning the
 *     nearest preceding `cVar == '\xNN'` guard within 3 lines.
 */
function extractActionCodes(body: string[], base: number): { codes: ActionCodeFinding[]; notes: string[] } {
  const codes: ActionCodeFinding[] = [];
  const notes: string[] = [];

  const slotWriteRe = /^\s*\*\*\(undefined4 \*\*\)\([^)]*\)\s*=\s*(.+);/;
  const slotVars = new Set<string>();

  body.forEach((l, i) => {
    const m = l.match(slotWriteRe);
    if (!m) return;
    const rhs = m[1].trim();
    if (/^(0x[0-9a-fA-F]+|\d+)$/.test(rhs)) {
      codes.push({ code: Number(rhs), models: modelsForLine(body, i), line: base + i + 1 });
    } else if (/^[A-Za-z_]\w*$/.test(rhs)) {
      slotVars.add(rhs);
    } else {
      notes.push(`slot-0 write with non-trivial RHS at L${base + i + 1}: ${rhs}`);
    }
  });

  for (const v of slotVars) {
    const assignRe = new RegExp(`^\\s*${v}\\s*=\\s*(0x[0-9a-fA-F]+|\\d+);`);
    body.forEach((l, i) => {
      const m = l.match(assignRe);
      if (!m) return;
      const val = Number(m[1]);
      if (val === 0) return; // the `uVar = 0` unknown-model fallthrough
      codes.push({ code: val, models: modelsForLine(body, i), line: base + i + 1 });
    });
  }

  return { codes, notes };
}

/**
 * Attribute the model byte(s) guarding an assignment line, with brace
 * tracking. Walking upward from the assignment:
 *   - a `}` opens a skipped sibling block; a `{` closes one. While
 *     skip-depth > 0 we are passing over sibling arms: any `== '\xNN'`
 *     compares seen there are recorded as SIBLING models (the assignment
 *     runs on their complement when reached via else/goto fallthrough).
 *   - when a `{`-opener line brings skip-depth below 0, that block
 *     contains the assignment: if the line carries model compares it
 *     GOVERNS the assignment ( `==` arms: those models; `!=` exclusion
 *     form: all three). A bare `{` / `else {` resets depth and continues.
 *   - if the walk reaches the function head with no governing guard:
 *     complement of sibling `==` models if any were skipped, else
 *     'all' if `!=` model compares were skipped, else 'unconditional'.
 */
const ALL = ['0x10', '0x11', '0x12'];
function modelsForLine(body: string[], i: number): string {
  const eqModelsOn = (l: string) => ALL.filter((m) => new RegExp(`== '\\\\x${m.slice(2)}'`).test(l));
  const neqModelsOn = (l: string) => ALL.filter((m) => new RegExp(`!= '\\\\x${m.slice(2)}'`).test(l));

  let depth = 0;
  const sibling = new Set<string>();
  let sawNeqSkipped = false;

  for (let j = i - 1; j >= 0; j--) {
    const l = body[j];
    const opens = (l.match(/{/g) ?? []).length;
    const closes = (l.match(/}/g) ?? []).length;
    const newDepth = depth + closes - opens;

    const eq = eqModelsOn(l);
    const neq = neqModelsOn(l);

    if (newDepth < 0) {
      // this line opens the block that contains the assignment
      if (neq.length > 0) return 'all(0x10|0x11|0x12)';
      if (eq.length === 3) return 'all(0x10|0x11|0x12)';
      if (eq.length > 0) return eq.join('|');
      // bare `{` or `else {` — keep walking in the enclosing scope
      depth = 0;
      continue;
    }
    depth = newDepth;
    if (depth > 0) {
      // inside a skipped sibling block
      eq.forEach((m) => sibling.add(m));
      if (neq.length > 0) sawNeqSkipped = true;
      continue;
    }
    // depth === 0: same scope as the assignment
    if (eq.length > 0 && opens > 0) {
      // sibling arm header we just finished skipping (its `{` balanced)
      eq.forEach((m) => sibling.add(m));
    }
    if (neq.length > 0 && opens > 0) sawNeqSkipped = true;
    if (/^\s*(void|undefined|int|char|ulonglong|longlong)\b.*\(/.test(l)) break; // function head
  }

  if (sibling.size > 0) {
    const comp = ALL.filter((m) => !sibling.has(m));
    if (comp.length === 0 || comp.length === 3) return 'all(0x10|0x11|0x12)';
    return comp.join('|');
  }
  if (sawNeqSkipped) return 'all(0x10|0x11|0x12)';
  return 'unconditional';
}

/** writes through the action-struct pointer: `*(T *)(*(longlong *)(BASE) + OFF) = RHS;` */
function extractFieldWrites(body: string[], base: number): FieldWrite[] {
  const out: FieldWrite[] = [];
  const re = /^\s*\*\(undefined[1248] \*\)\(\*\(longlong \*\)\([^)]*\)\s*\+\s*(0x[0-9a-f]+|\d+)\)\s*=\s*(.+);/;
  body.forEach((l, i) => {
    const m = l.match(re);
    if (!m) return;
    const { kind, value } = classifyRhs(m[2]);
    out.push({ offset: Number(m[1]), rhs: m[2].trim(), kind, value, line: base + i + 1 });
  });
  return out;
}

const callers: CallerRecord[] = callerHeads.map((h, idx) => {
  const end = idx + 1 < callerHeads.length ? callerHeads[idx + 1].line - 1 : partBStart - 1;
  const body = lines.slice(h.line, end + 1);
  const sigLine = body.find((l) => /^\s*signature:/.test(l)) ?? '';
  const { codes, notes } = extractActionCodes(body, h.line);
  const fieldWrites = extractFieldWrites(body, h.line);
  const tail = fieldWrites.find((f) => f.offset === 0x14 && f.kind === 'constant');
  return {
    index: h.index,
    fn: h.fn,
    addr: h.addr,
    lineStart: h.line + 1,
    lineEnd: end + 1,
    signature: sigLine.replace(/^\s*signature:\s*/, ''),
    actionCodes: dedupeCodes(codes),
    fieldWrites,
    tailCount: tail?.value,
    strings: extractStrings(body, h.line),
    callees: extractCallees(body, h.fn),
    bodyLineCount: body.length,
    notes,
  };
});

function dedupeCodes(codes: ActionCodeFinding[]): ActionCodeFinding[] {
  const seen = new Map<string, ActionCodeFinding>();
  for (const c of codes) {
    const k = `${c.code}|${c.models}`;
    if (!seen.has(k)) seen.set(k, c);
  }
  return [...seen.values()].sort((a, b) => a.code - b.code);
}

// --------------------------------------------------------- parse PART B

const partB: PartBSection[] = [];
{
  let current: PartBSection | null = null;
  let curCaller: PartBSection['callers'][number] | null = null;
  for (let i = partBStart; i < lines.length; i++) {
    const sec = lines[i].match(/^## (fn=0x[0-9a-f]+\s+—\s+.+)$/);
    if (sec) {
      if (current) {
        current.lineEnd = i;
        partB.push(current);
      }
      current = { label: sec[1].trim(), lineStart: i + 1, lineEnd: lines.length, callers: [] };
      curCaller = null;
      continue;
    }
    const cal = lines[i].match(/^--- (FUN_[0-9a-f]+) @ ([0-9a-f]+) ---/);
    if (cal && current) {
      if (curCaller) curCaller.lineEnd = i;
      curCaller = { fn: cal[1], addr: cal[2], lineStart: i + 1, lineEnd: lines.length, strings: [], callees: [] };
      current.callers.push(curCaller);
    }
  }
  if (current) partB.push(current);
  // fill caller strings/callees
  for (const sec of partB) {
    for (let c = 0; c < sec.callers.length; c++) {
      const caller = sec.callers[c];
      const end =
        c + 1 < sec.callers.length ? sec.callers[c + 1].lineStart - 1 : sec.lineEnd;
      caller.lineEnd = end;
      const body = lines.slice(caller.lineStart - 1, end);
      caller.strings = extractStrings(body, caller.lineStart - 1);
      caller.callees = extractCallees(body, caller.fn);
    }
  }
}

// ----------------------------------------------------- aggregate by code

interface CodeAggregate {
  code: number;
  hex: string;
  callers: {
    fn: string;
    addr: string;
    models: string;
    assignLine: number;
    siteLine: number;
    callerLines: [number, number];
    /** true when the emission is followed (within ~25 lines) by the
     *  3000 ms reply-wait helper FUN_14032eb90 — i.e. a request that
     *  expects an fn=0x01 response frame */
    waitsForReply: boolean;
    tailCount?: number;
    /** simplified payload shape from the emission-site field writes */
    payload: Record<string, string>;
    stringEvidence: string[];
  }[];
}

const FIELD_NAMES: Record<number, string> = {
  0x0: 'action14',
  0x4: 'blockId14',
  0x8: 'paramId14',
  0xc: 'value32',
  0x10: 'modifier14',
  0x14: 'tailCount',
};

/**
 * Cluster field writes per EMISSION SITE. A caller body can build the
 * action struct several times on different paths (e.g. 0x47 with no
 * tail on one path, 0x48 with a 1024-byte tail on another). Each write
 * to slot 0 (`**(undefined4 **)(BASE) = ...`) opens a site; struct
 * field writes after it (and before the next site) belong to it.
 * Action-code constants are matched to the site whose slot-0 line is
 * nearest below/at the assignment (var-assigned codes precede the
 * slot-0 write; direct-constant codes ARE the slot-0 write).
 */
function emissionSites(c: CallerRecord) {
  const slotLines = new Set<number>();
  // direct-constant slot writes ARE actionCode lines with offset-0 writes;
  // recover slot-0 write lines from the raw dump text in the caller span.
  for (let ln = c.lineStart; ln <= c.lineEnd; ln++) {
    if (/^\s*\*\*\(undefined4 \*\*\)\([^)]*\)\s*=\s*.+;/.test(lines[ln - 1])) slotLines.add(ln);
  }
  const sites = [...slotLines].sort((a, b) => a - b);
  const siteFor = (line: number, codeMode: boolean): number | undefined => {
    if (codeMode) {
      // a code assignment belongs to the first site AT or AFTER it
      for (const s of sites) if (s >= line) return s;
      return undefined;
    }
    // a field write belongs to the last site at or before it
    let best: number | undefined;
    for (const s of sites) if (s <= line) best = s;
    return best;
  };
  const bySite = new Map<number, { codes: ActionCodeFinding[]; fields: FieldWrite[] }>();
  for (const s of sites) bySite.set(s, { codes: [], fields: [] });
  for (const ac of c.actionCodes) {
    const s = siteFor(ac.line, true);
    if (s !== undefined) bySite.get(s)!.codes.push(ac);
  }
  for (const fw of c.fieldWrites) {
    const s = siteFor(fw.line, false);
    if (s !== undefined) bySite.get(s)!.fields.push(fw);
  }
  return bySite;
}

const byCode = new Map<number, CodeAggregate>();
for (const c of callers) {
  const sites = emissionSites(c);
  for (const [siteLine, site] of sites) {
    for (const ac of site.codes) {
      let agg = byCode.get(ac.code);
      if (!agg) {
        agg = { code: ac.code, hex: '0x' + ac.code.toString(16).padStart(2, '0'), callers: [] };
        byCode.set(ac.code, agg);
      }
      const payload: Record<string, string> = {};
      let siteTail: number | undefined;
      for (const fw of site.fields) {
        const name =
          FIELD_NAMES[fw.offset] ?? (fw.offset >= 0x18 ? `tail[${fw.offset - 0x18}]` : `+0x${fw.offset.toString(16)}`);
        if (!(name in payload)) {
          payload[name] =
            fw.kind === 'constant' ? `const ${fw.value} (0x${fw.value!.toString(16)})` : fw.kind === 'argument' ? fw.rhs : `runtime: ${fw.rhs}`;
        }
        if (fw.offset === 0x14 && fw.kind === 'constant' && siteTail === undefined) siteTail = fw.value;
      }
      agg.callers.push({
        fn: c.fn,
        addr: c.addr,
        models: ac.models,
        assignLine: ac.line,
        siteLine,
        callerLines: [c.lineStart, c.lineEnd],
        waitsForReply: /FUN_14032eb90/.test(
          lines.slice(siteLine - 1, Math.min(siteLine + 25, c.lineEnd)).join(' '),
        ),
        tailCount: siteTail,
        payload,
        stringEvidence: c.strings.map((s) => s.text).slice(0, 10),
      });
    }
  }
}

const aggregates = [...byCode.values()].sort((a, b) => a.code - b.code);

// ----------------------------------------------------------------- emit

const result = {
  source: 'packages/fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt',
  generator: 'scripts/_research/mine-iii-subactions.ts',
  generated: new Date().toISOString().slice(0, 10),
  dumpLineCount: lines.length,
  partA2: { lineStart: partA2Start + 1, lineEnd: partBStart, callerCount: callers.length },
  partB: partB.map((s) => ({
    label: s.label,
    lines: [s.lineStart, s.lineEnd],
    callers: s.callers.map((c) => ({
      fn: c.fn,
      addr: c.addr,
      lines: [c.lineStart, c.lineEnd],
      strings: c.strings,
      callees: c.callees,
    })),
  })),
  uniqueActionCodes: aggregates.length,
  actionCodes: aggregates,
  callers,
};

writeFileSync(OUT, JSON.stringify(result, null, 2));

// ------------------------------------------------------------- console

console.log(`dump lines: ${lines.length}`);
console.log(`PART A.2 callers parsed: ${callers.length}`);
console.log(`unique action codes (static): ${aggregates.length}`);
console.log('');
console.log('code | callers | models | tailCounts');
for (const a of aggregates) {
  const models = [...new Set(a.callers.map((c) => c.models))].join(', ');
  const tails = [...new Set(a.callers.map((c) => c.tailCount ?? '?'))].join(',');
  console.log(
    `${a.hex.padEnd(5)}| ${String(a.callers.length).padStart(2)}      | ${models.padEnd(24)} | ${tails}`,
  );
}
console.log('');
console.log('PART B sections:');
for (const s of partB) {
  console.log(`  ${s.label}  L${s.lineStart}-${s.lineEnd}  callers: ${s.callers.map((c) => c.fn).join(', ')}`);
}
console.log('');
console.log('callers with NO static action code (dynamic):');
for (const c of callers.filter((c) => c.actionCodes.length === 0)) {
  console.log(`  #${c.index} ${c.fn} L${c.lineStart}-${c.lineEnd} (${c.bodyLineCount} lines)`);
}
console.log('');
console.log(`wrote ${OUT}`);
