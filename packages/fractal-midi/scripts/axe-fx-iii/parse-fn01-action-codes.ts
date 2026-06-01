/**
 * Parse the existing Ghidra dump of FUN_14033ec70 callers and extract
 * fn=0x01 SET_PARAMETER action codes per caller.
 *
 * Context: AxeEdit III emits fn=0x01 via the wrapper FUN_14033ec70.
 * Each of the 93 callers initializes the action struct (passed as
 * `*(undefined8 *)(param_1 + N)`) with an action code in its first
 * field. The Ghidra script MineAxeEditIIIActionsAndShapes.java
 * already dumped full decompiles of all 93 callers to
 *   samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt
 * (PART A.2 section, 25,300 lines).
 *
 * The handoff doc hypothesized that action codes live in class
 * constructors. Reading the actual decompiles shows the codes are
 * computed INSIDE the emit method itself, usually as a switch on
 * `*(char *)(param_1 + 0x38)` (the model byte: III=0x10, FM3=0x11,
 * FM9/Mark II=0x12) plus a default-zero fallthrough.
 *
 * This parser:
 *   1. Splits the dump at `CALLER #N:` boundaries.
 *   2. For each caller, finds the action-struct write
 *      `**(undefined4 **)(param_1 + OFFSET) = VAR;`
 *   3. Traces VAR backwards through the function body, collecting
 *      every constant assignment to it (including under model-byte
 *      branch guards).
 *   4. Emits a markdown table per caller: (model byte → action code).
 *
 * Output: stdout (pipe into the doc).
 *
 * Run: npx tsx scripts/axe-fx-iii/parse-fn01-action-codes.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname ?? __dirname, '../..');
const DUMP_PATH = resolve(
  REPO_ROOT,
  'samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt',
);

interface Caller {
  index: number;
  name: string;
  entryHex: string;
  body: string;
  /** Offset of action-struct pointer in caller's `this` (e.g. 0x40, 0x248, 0x290, 0x148). */
  actionStructOffset?: number;
  /** The variable name flowing into the action-code slot (action_struct[0]). */
  actionCodeVar?: string;
  /** Constants assigned to actionCodeVar, with optional guard context. */
  assignments: Assignment[];
  /** Final III (model 0x10) action code, if extractable. */
  iiiActionCode?: number;
  /** All distinct codes seen (independent of model branching). */
  allCodes: number[];
  notes: string[];
}

interface Assignment {
  value: number;
  /** Human-readable guard description (e.g. "model 0x10", "fallthrough"). */
  guard: string;
}

const dump = readFileSync(DUMP_PATH, 'utf8');

// ── Split at caller boundaries. The PART A.2 header introduces them. ──
const partA2Idx = dump.indexOf('## PART A.2');
if (partA2Idx < 0) {
  console.error('Could not find "## PART A.2" section header in dump.');
  process.exit(1);
}
const partB = dump.slice(partA2Idx);

// Pattern: `CALLER #N: FUN_xxxxxx @ xxxxxx`
const callerHeader = /CALLER #(\d+):\s+(\S+)\s+@\s+([0-9a-fA-F]+)/g;
const callers: Caller[] = [];
const headerMatches = [...partB.matchAll(callerHeader)];
for (let i = 0; i < headerMatches.length; i += 1) {
  const m = headerMatches[i];
  const start = m.index ?? 0;
  const end = i + 1 < headerMatches.length ? (headerMatches[i + 1].index ?? partB.length) : partB.length;
  callers.push({
    index: Number.parseInt(m[1], 10),
    name: m[2],
    entryHex: m[3],
    body: partB.slice(start, end),
    assignments: [],
    allCodes: [],
    notes: [],
  });
}

// ── Per-caller extraction ─────────────────────────────────────────────

/** Strip casts like `(uint)` and surrounding whitespace. */
function stripCasts(s: string): string {
  return s.replace(/\(\s*\w+\s*\*?\s*\)/g, '').trim();
}

/** Parse a constant literal: `0x84`, `'\x10'`, `123`. Returns undefined if not literal. */
function parseLiteral(s: string): number | undefined {
  const trimmed = stripCasts(s);
  // hex
  const hex = trimmed.match(/^0x([0-9a-fA-F]+)$/);
  if (hex) return Number.parseInt(hex[1], 16);
  // char escape: '\xNN'
  const ch = trimmed.match(/^'\\x([0-9a-fA-F]+)'$/);
  if (ch) return Number.parseInt(ch[1], 16);
  // simple decimal
  const dec = trimmed.match(/^(\d+)$/);
  if (dec) return Number.parseInt(dec[1], 10);
  return undefined;
}

for (const c of callers) {
  // Find the action-struct-pointer write of form:
  //   **(undefined4 **)(param_1 + OFFSET) = VAR;
  // (sometimes the offset is `+ N` with N decimal, but in practice always
  //  hex in this dump.)
  const writeRe = /\*\*\(undefined4\s*\*\*\)\(param_1\s*\+\s*(0x[0-9a-fA-F]+|\d+)\)\s*=\s*([^;]+);/g;
  const writes = [...c.body.matchAll(writeRe)];
  if (writes.length === 0) {
    c.notes.push('no action-struct write found (caller may use a different builder path)');
    continue;
  }
  // Use the FIRST write — that's the one before the FUN_14033ec70 call.
  // (Later writes can be for follow-up calls or unrelated state.)
  const firstWrite = writes[0];
  c.actionStructOffset = Number.parseInt(firstWrite[1], firstWrite[1].startsWith('0x') ? 16 : 10);
  const rhs = stripCasts(firstWrite[2]);

  // Case A: RHS is a direct literal — easy.
  const direct = parseLiteral(rhs);
  if (direct !== undefined) {
    c.actionCodeVar = '(literal)';
    c.assignments.push({ value: direct, guard: 'always' });
    c.allCodes.push(direct);
    c.iiiActionCode = direct;
    continue;
  }

  // Case B: RHS is a variable. Trace it back.
  // Strip leading deref / addr-of.
  const varName = rhs.replace(/^[*&]+/, '').replace(/\(.*\)/, '').trim();
  // Filter to plausible Ghidra var names: uVarN, local_NN, lVarN, etc.
  const isVar = /^[a-zA-Z_][\w]*$/.test(varName);
  if (!isVar) {
    c.notes.push(`RHS not parseable as variable: "${rhs}"`);
    continue;
  }
  c.actionCodeVar = varName;

  // Collect every assignment to this var that's a literal: `varName = 0xNN;`
  // Track surrounding line context for guard inference.
  const lines = c.body.split('\n');
  const assignRe = new RegExp(`^\\s*${varName}\\s*=\\s*([^;]+);\\s*$`);
  // Active guard stack: top is the most recent unclosed `if (cVar1 == '\xNN')`.
  // For simplicity we capture the guard string per-line by scanning preceding
  // lines for the nearest `if ((cVar1 == '\\xNN') ...)` chain.
  for (let i = 0; i < lines.length; i += 1) {
    const am = lines[i].match(assignRe);
    if (!am) continue;
    const lit = parseLiteral(am[1]);
    if (lit === undefined) continue;
    // Look back up to 10 lines for an `if (cVar1 == '\xNN')` chain.
    const guard = inferGuard(lines, i);
    c.assignments.push({ value: lit, guard });
    if (!c.allCodes.includes(lit)) c.allCodes.push(lit);
  }

  // Determine III action code: prefer assignments guarded by model 0x10,
  // then fall back to "any/all-models" assignments, then fall back to the
  // first non-zero literal.
  for (const a of c.assignments) {
    if (a.guard.includes('0x10') && a.value !== 0) {
      c.iiiActionCode = a.value;
      break;
    }
  }
  if (c.iiiActionCode === undefined) {
    for (const a of c.assignments) {
      if (
        (a.guard === 'always' || a.guard === 'all III models' || a.guard.includes('0x10')) &&
        a.value !== 0
      ) {
        c.iiiActionCode = a.value;
        break;
      }
    }
  }
  if (c.iiiActionCode === undefined && c.assignments.length > 0) {
    // Last resort: first non-zero literal.
    const nz = c.assignments.find((a) => a.value !== 0);
    if (nz) {
      c.iiiActionCode = nz.value;
      c.notes.push('iiiActionCode inferred from non-zero assignment without explicit model guard');
    } else {
      c.notes.push('all assignments are zero — likely dynamic or runtime-determined');
    }
  }
}

/** Heuristically infer the guard for a literal assignment by looking backward. */
function inferGuard(lines: string[], idx: number): string {
  // Walk back up to 20 lines looking for guards.
  const guards: string[] = [];
  let depth = 0;
  for (let i = idx - 1; i >= Math.max(0, idx - 30); i -= 1) {
    const ln = lines[i];
    if (/^\s*\}\s*$/.test(ln)) {
      depth += 1;
      continue;
    }
    if (/^\s*\{/.test(ln)) {
      depth -= 1;
    }
    if (depth > 0) continue;
    // Match `if (cVar1 == '\xNN')` or `if ((cVar1 == '\xNN') || (cVar1 == '\xNM'))`
    const condMatches = [...ln.matchAll(/cVar1\s*==\s*'\\x([0-9a-fA-F]+)'/g)];
    if (condMatches.length > 0) {
      const models = condMatches.map((m) => `0x${m[1].toLowerCase()}`).join('+');
      guards.push(models);
      // Stop — we found the nearest guard.
      break;
    }
    // Negated: `if (cVar1 != '\xNN')` — guards the FALL-THROUGH branch.
    const neg = ln.match(/cVar1\s*!=\s*'\\x([0-9a-fA-F]+)'/);
    if (neg) {
      // We're INSIDE the != branch — model is NOT this one.
      // For practical extraction, this typically means model is the OTHER ones.
      guards.push(`not 0x${neg[1].toLowerCase()}`);
      break;
    }
    // Goto LAB_xxx with model-byte switch above — too complex to model perfectly.
  }
  return guards.length === 0 ? 'always' : guards.join(' and ');
}

// ── Reporting ─────────────────────────────────────────────────────────

function formatHex(n: number, width = 2): string {
  return '0x' + n.toString(16).padStart(width, '0').toUpperCase();
}

// Workflow guesses based on caller-name ranges + adjacent named workflows.
// Filled in based on README + workflow catalog. The action-code-only output
// is the authoritative finding; these labels are heuristic context.

const workflowHints: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /^FUN_1401e3/, label: 'preset-buffer/scene state writes (UI control path)' },
  { pattern: /^FUN_1401e4/, label: 'preset-buffer/scene state writes (UI control path, cont.)' },
  { pattern: /^FUN_1401e6/, label: 'preset-buffer/scene state writes (UI control path, cont.)' },
  { pattern: /^FUN_140226/, label: 'block-editor operations (param dialog cluster A)' },
  { pattern: /^FUN_140227/, label: 'block-editor operations (param dialog cluster A, cont.)' },
  { pattern: /^FUN_140228/, label: 'block-editor operations (param dialog cluster B)' },
  { pattern: /^FUN_14022[9a]/, label: 'block-editor operations (param dialog cluster C)' },
  { pattern: /^FUN_140246/, label: 'preset-management / save flow' },
  { pattern: /^FUN_140247/, label: 'preset-management / save flow (cont.)' },
  { pattern: /^FUN_14014/, label: 'main-app UI driver' },
];

function inferWorkflow(callerName: string): string {
  for (const h of workflowHints) {
    if (h.pattern.test(callerName)) return h.label;
  }
  return 'unclassified';
}

console.log('# Axe-Fx III — fn=0x01 SET_PARAMETER action codes (Ghidra-decoded)');
console.log('');
console.log('**Status:** Decoded by parsing the existing Ghidra decompile dump');
console.log('(`samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`).');
console.log('Each of the 93 callers of `FUN_14033ec70` (fn=0x01 wrapper) sets the');
console.log('action code (Field A in `fn01-builder-ghidra.md`) into the first slot');
console.log('of the action struct, which is reached via a class field at offset');
console.log('+0x40 / +0x148 / +0x248 / +0x290 (varies per caller class).');
console.log('');
console.log('## How action codes are computed');
console.log('');
console.log('Contrary to the handoff doc\'s hypothesis (constructor-set per-class');
console.log('constants), action codes are **selected inside the emit method itself**');
console.log('via a switch on the model byte at `*(char *)(param_1 + 0x38)`:');
console.log('');
console.log('| Model byte | Device |');
console.log('|---|---|');
console.log('| `0x10` | Axe-Fx III |');
console.log('| `0x11` | FM3 |');
console.log('| `0x12` | FM9 (and presumably III Mark II / III Turbo) |');
console.log('');
console.log('Most emit methods have an `if (cVar1 == \\x10/0x11/0x12)` chain that');
console.log('maps each model to its own action code; some emit zero for unknown');
console.log('models (probably a no-op safety fallthrough).');
console.log('');
console.log('Three IIIs-only `0x52` (SET), `0x04 01` (STATE_BROADCAST), `0x01 00`');
console.log('(long broadcast) were already known from public captures. This pass');
console.log('extends the table with the per-emit-site III action codes.');
console.log('');

// ── Per-caller table ──
console.log('## Per-caller table (III model 0x10)');
console.log('');
console.log('| # | Caller | Field offset | III action code | Other models | Workflow context |');
console.log('|---:|---|---:|---:|---|---|');
for (const c of callers) {
  const offset = c.actionStructOffset !== undefined ? formatHex(c.actionStructOffset) : '?';
  const iiiCode = c.iiiActionCode !== undefined ? formatHex(c.iiiActionCode) : '(dynamic)';
  const others = c.assignments
    .filter((a) => !a.guard.includes('0x10') && a.guard !== 'always' && a.value !== 0)
    .map((a) => `${formatHex(a.value)} (${a.guard})`)
    .join(', ');
  const workflow = inferWorkflow(c.name);
  console.log(
    `| ${c.index} | \`${c.name}\` @ ${c.entryHex} | ${offset} | ${iiiCode} | ${others || '—'} | ${workflow} |`,
  );
}

// ── Unique III action codes ──
const iiiCodeHist = new Map<number, Caller[]>();
for (const c of callers) {
  if (c.iiiActionCode === undefined) continue;
  const arr = iiiCodeHist.get(c.iiiActionCode) ?? [];
  arr.push(c);
  iiiCodeHist.set(c.iiiActionCode, arr);
}
const sortedCodes = [...iiiCodeHist.keys()].sort((a, b) => a - b);

console.log('');
console.log('## Unique III (model 0x10) action codes recovered');
console.log('');
console.log(`Total distinct codes: **${sortedCodes.length}**`);
console.log('');
console.log('| Action code (14-bit Field A) | Caller count | Example caller |');
console.log('|---:|---:|---|');
for (const code of sortedCodes) {
  const arr = iiiCodeHist.get(code)!;
  const example = `${arr[0].name} @ ${arr[0].entryHex}`;
  console.log(`| ${formatHex(code, 4)} | ${arr.length} | \`${example}\` |`);
}

console.log('');
console.log('## Cross-model action-code map');
console.log('');
console.log('Where a caller emits different codes per model byte, the mapping is:');
console.log('');
console.log('| Caller | III (0x10) | FM3 (0x11) | FM9/IIITurbo (0x12) |');
console.log('|---|---:|---:|---:|');
let crossModelRows = 0;
for (const c of callers) {
  const byGuard = new Map<string, number>();
  for (const a of c.assignments) {
    // Capture distinct model-byte guards explicitly.
    if (a.guard.includes('0x10') || a.guard.includes('0x11') || a.guard.includes('0x12')) {
      // Split combined guards like '0x10+0x11+0x12' into individual entries.
      for (const tok of a.guard.split('+')) {
        const t = tok.trim();
        if (t === '0x10' || t === '0x11' || t === '0x12') byGuard.set(t, a.value);
      }
    }
  }
  const c10 = byGuard.get('0x10');
  const c11 = byGuard.get('0x11');
  const c12 = byGuard.get('0x12');
  if (c10 === undefined && c11 === undefined && c12 === undefined) continue;
  const distinct = new Set([c10, c11, c12].filter((v) => v !== undefined));
  if (distinct.size <= 1) continue; // only interesting when models diverge
  crossModelRows += 1;
  console.log(
    `| \`${c.name}\` @ ${c.entryHex} | ${c10 !== undefined ? formatHex(c10) : '—'} | ${
      c11 !== undefined ? formatHex(c11) : '—'
    } | ${c12 !== undefined ? formatHex(c12) : '—'} |`,
  );
}
if (crossModelRows === 0) {
  console.log('| (no callers emit divergent codes across models) | | | |');
}

// ── Diagnostics ──
console.log('');
console.log('## Unresolved callers');
console.log('');
const unresolved = callers.filter((c) => c.iiiActionCode === undefined);
console.log(`${unresolved.length} of ${callers.length} callers had no extractable III action code.`);
console.log('Typical reasons: RHS is `*puVar5` (read from a UI control struct),');
console.log('`*(undefined4 *)(param_2 + 2)` (read from an argument), or `param_4`');
console.log('(passed as a function arg). These are runtime-determined operations');
console.log('where the action code is set by the CALLER of the emit method.');
console.log('');
if (unresolved.length > 0) {
  console.log('| Caller | Note |');
  console.log('|---|---|');
  for (const c of unresolved) {
    console.log(`| \`${c.name}\` @ ${c.entryHex} | ${c.notes.join('; ') || 'no constant assignments to action-code var'} |`);
  }
}

console.log('');
console.log('## Source');
console.log('');
console.log('- Decompile dump: `samples/captured/decoded/ghidra-axe-edit-iii-actions-and-shapes.txt`');
console.log('- Generator: `scripts/ghidra/MineAxeEditIIIActionsAndShapes.java`');
console.log('- Parser: `scripts/axe-fx-iii/parse-fn01-action-codes.ts`');
console.log('- Builder wire shape: [`fn01-builder-ghidra.md`](fn01-builder-ghidra.md)');
console.log('- Empirical (capture-side): [`fn01-decode.md`](fn01-decode.md)');
console.log('');
console.log('Re-run via: `npx tsx scripts/axe-fx-iii/parse-fn01-action-codes.ts > docs/devices/axe-fx-iii/fn01-action-codes-decoded.md`');
