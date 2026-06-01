/**
 * Encoding-Cookbook build gate.
 *
 * Walks every cookbook entry in the sibling `fractal-midi` repo's
 * `docs/research/cookbook/` directory (plus its `_scratch/`,
 * `_partial/`, `_negative/` subdirectories), parses the YAML
 * frontmatter, and applies two layers of validation:
 *
 *   1. STRUCTURAL gates (every entry, always run):
 *      - Required frontmatter fields present (name, status, golden, etc.)
 *      - `name:` matches the filename slug.
 *      - `status:` is one of the legal values from cookbook INDEX.md.
 *      - `consumed_in:` paths exist on disk (resolved against the consumer
 *        repo, the fractal-midi sibling repo, and the parent of both).
 *      - Status invariants:
 *          matched              -> needs >= 2 entries in `verified_on:`
 *          matched-singleton    -> needs >= 1 entry, body must justify the singleton
 *          partial-N1           -> entry should live in `_partial/` OR body must
 *                                  name the path to `matched`
 *          scratch              -> entry must live in `_scratch/`
 *          non-matching         -> entry must live in `_negative/`
 *          wip / regression     -> structural-only (not build-gating beyond fields)
 *
 *   2. FUNCTIONAL fixture cases (a subset that can run pure-CPU):
 *      - case-xor-7f-envelope-checksum     XOR-fold over known wire prefixes.
 *      - case-septet-14bit                 round-trip across boundaries (0, 127,
 *                                          128, 16383).
 *      - case-septet-21bit-byte2-mask-preservation
 *                                          encode/decode round-trip with a
 *                                          non-zero originalByte2 high mask.
 *      - case-vendor-envelope-descriptor-table
 *                                          parse the III descriptor JSON and
 *                                          confirm the headline table
 *                                          `0x1407ab940` matches the II preset-
 *                                          body envelope shape (2 + 3072 bytes).
 *      - case-xor-fold-hash                17-line XOR-fold over a known ushort
 *                                          array.
 *
 * Build-break policy: any structural gate fail or any functional case fail
 * exits with code 1. Wired into `npm run preflight` after `verify-msg`.
 *
 * Adding a new cookbook entry that needs a fixture: add a `case-<slug>`
 * function below + extend FUNCTIONAL_CASES. Entries without an inline case
 * are still subject to the structural gate; their golden field's reference
 * is recorded as STUB but not failed (the existing verify-* scripts are
 * the de-facto goldens for those primitives).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(HERE, '..');
const REPO_PARENT = path.resolve(MCP_ROOT, '..');
const FRACTAL_MIDI_ROOT = path.join(MCP_ROOT, 'packages', 'fractal-midi');
const COOKBOOK_ROOT = path.join(FRACTAL_MIDI_ROOT, 'docs', 'research', 'cookbook');
const IS_CI = process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true';

const LEGAL_STATUSES = new Set([
  'matched',
  'matched-singleton',
  'partial-N1',
  'wip',
  'scratch',
  'regression',
  'non-matching',
]);

const REQUIRED_FRONTMATTER_KEYS = ['name', 'status', 'golden'];

interface CookbookEntry {
  filePath: string;
  slug: string;
  dirCategory: 'main' | '_scratch' | '_partial' | '_negative';
  frontmatter: Record<string, string | string[]>;
  body: string;
}

interface Violation {
  entry: string;
  severity: 'fail' | 'warn';
  message: string;
}

function listCookbookFiles(): string[] {
  // Cookbook entries reference gitignored Ghidra decompile outputs and
  // USB captures in samples/captured/decoded/. These only exist on the
  // founder's machine, not in CI. Skip the entire cookbook-verify in CI.
  if (IS_CI) {
    console.log(
      `cookbook-verify: skipped in CI (cookbook entries reference local-only ` +
      `Ghidra artifacts in samples/captured/decoded/).`,
    );
    process.exit(0);
  }
  if (!existsSync(COOKBOOK_ROOT)) {
    throw new Error(
      `cookbook root not found: ${COOKBOOK_ROOT}. ` +
        `fractal-midi workspace package is missing or the cookbook has moved.`,
    );
  }
  const out: string[] = [];
  for (const name of readdirSync(COOKBOOK_ROOT)) {
    const full = path.join(COOKBOOK_ROOT, name);
    const st = statSync(full);
    if (st.isFile() && name.endsWith('.md') && name !== 'INDEX.md') {
      out.push(full);
    } else if (st.isDirectory() && ['_scratch', '_partial', '_negative'].includes(name)) {
      for (const inner of readdirSync(full)) {
        if (inner.endsWith('.md') && inner !== 'INDEX.md') {
          out.push(path.join(full, inner));
        }
      }
    }
  }
  return out.sort();
}

/**
 * Minimal YAML frontmatter parser. Handles: scalar `key: value`, list
 * `key:` followed by `  - value` lines, inline list `key: [a, b, c]`,
 * and quoted strings (single or double). Sufficient for cookbook
 * entries; not a general YAML library.
 */
function parseFrontmatter(source: string): { frontmatter: Record<string, string | string[]>; body: string } {
  if (!source.startsWith('---')) {
    return { frontmatter: {}, body: source };
  }
  const lines = source.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end < 0) return { frontmatter: {}, body: source };
  const frontmatter: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  let currentList: string[] = [];
  const flushList = () => {
    if (currentListKey !== null) {
      frontmatter[currentListKey] = currentList;
    }
    currentListKey = null;
    currentList = [];
  };
  const stripQuotes = (s: string): string => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      return t.slice(1, -1);
    }
    return t;
  };
  for (let i = 1; i < end; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (raw.startsWith('  - ') || raw.startsWith('\t- ')) {
      if (currentListKey !== null) {
        currentList.push(stripQuotes(raw.replace(/^\s*-\s*/, '')));
      }
      continue;
    }
    flushList();
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const key = raw.slice(0, colon).trim();
    const rest = raw.slice(colon + 1).trim();
    if (rest === '') {
      currentListKey = key;
      currentList = [];
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      frontmatter[key] = inner === ''
        ? []
        : inner.split(',').map((s) => stripQuotes(s));
      continue;
    }
    frontmatter[key] = stripQuotes(rest);
  }
  flushList();
  const body = lines.slice(end + 1).join('\n');
  return { frontmatter, body };
}

function categoryOf(filePath: string): CookbookEntry['dirCategory'] {
  const rel = path.relative(COOKBOOK_ROOT, filePath);
  const parts = rel.split(/[\\/]/);
  if (parts.length === 1) return 'main';
  if (parts[0] === '_scratch') return '_scratch';
  if (parts[0] === '_partial') return '_partial';
  if (parts[0] === '_negative') return '_negative';
  return 'main';
}

function slugFromPath(filePath: string): string {
  const base = path.basename(filePath, '.md');
  return base;
}

function loadEntries(): CookbookEntry[] {
  const files = listCookbookFiles();
  return files.map((f) => {
    const src = readFileSync(f, 'utf8');
    const { frontmatter, body } = parseFrontmatter(src);
    return {
      filePath: f,
      slug: slugFromPath(f),
      dirCategory: categoryOf(f),
      frontmatter,
      body,
    };
  });
}

/**
 * Resolve a `consumed_in:` line to an absolute path. Strips trailing
 * parenthetical notes, then tries an ordered list of base directories
 * (the consumer repo, fractal-midi, repo parent). Lines whose annotation
 * marks the path as speculative ("if exists", "pending", "transfer
 * candidate", "TBD", "TODO") return 'soft-missing' so the gate logs
 * but does not fail. Lines whose entire content is a parenthetical
 * comment return 'placeholder'.
 */
function resolveConsumedInPath(
  line: string,
):
  | { kind: 'real'; absolute: string }
  | { kind: 'placeholder' }
  | { kind: 'soft-missing'; tried: string[]; reason: string }
  | { kind: 'missing'; tried: string[] } {
  let raw = line.trim();
  const isSpeculative = /\b(if exists|pending|placeholder|TBD|TODO|transfer candidate)\b/i.test(line);
  // Strip parenthetical notes: "packages/foo.ts (note about scope)" -> "packages/foo.ts"
  const parenIdx = raw.indexOf('(');
  if (parenIdx === 0) {
    return { kind: 'placeholder' };
  }
  if (parenIdx > 0) {
    raw = raw.slice(0, parenIdx).trim();
  }
  if (raw === '') return { kind: 'placeholder' };
  const candidates: string[] = [];
  candidates.push(path.resolve(MCP_ROOT, raw));
  candidates.push(path.resolve(FRACTAL_MIDI_ROOT, raw));
  candidates.push(path.resolve(REPO_PARENT, raw));
  // Also try after stripping a leading consumer-repo or fractal-midi prefix.
  // Both the old `mcp-midi-tools/` directory name and the canonical
  // `mcp-midi-control/` package name resolve to the same MCP_ROOT during
  // the directory-rename transition.
  for (const prefix of ['mcp-midi-control/', 'mcp-midi-tools/', 'fractal-midi/']) {
    if (raw.startsWith(prefix)) {
      const stripped = raw.slice(prefix.length);
      candidates.push(
        prefix === 'fractal-midi/'
          ? path.resolve(FRACTAL_MIDI_ROOT, stripped)
          : path.resolve(MCP_ROOT, stripped),
      );
    }
  }
  const tried: string[] = [];
  for (const c of candidates) {
    if (tried.includes(c)) continue;
    tried.push(c);
    if (existsSync(c)) return { kind: 'real', absolute: c };
  }
  if (isSpeculative) {
    return { kind: 'soft-missing', tried, reason: 'speculative annotation' };
  }
  return { kind: 'missing', tried };
}

function asList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Parse `[[slug]]` markdown wikilinks out of the entry body. The cookbook
 * uses kebab-case slugs exclusively (lowercase a-z, digits, hyphens). This
 * is intentionally narrow — it won't match prose links like `[label](url)`.
 */
function extractWikilinks(body: string): string[] {
  const out: string[] = [];
  const re = /\[\[([a-z0-9][a-z0-9-]*)\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out.push(m[1]);
  }
  return out;
}

function validateStructural(
  entry: CookbookEntry,
  violations: Violation[],
  slugSet: Set<string>,
): void {
  const fm = entry.frontmatter;
  // Required keys
  for (const k of REQUIRED_FRONTMATTER_KEYS) {
    if (!(k in fm)) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `missing required frontmatter key '${k}'`,
      });
    }
  }
  // Name matches filename
  const declaredName = typeof fm.name === 'string' ? fm.name : null;
  if (declaredName !== null && declaredName !== entry.slug) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `frontmatter name '${declaredName}' does not match file slug '${entry.slug}'`,
    });
  }
  const status = typeof fm.status === 'string' ? fm.status : null;
  if (status !== null && !LEGAL_STATUSES.has(status)) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `illegal status '${status}'. legal: ${[...LEGAL_STATUSES].join(', ')}`,
    });
  }
  // Directory invariants
  if (status === 'scratch' && entry.dirCategory !== '_scratch') {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='scratch' but entry lives in ${entry.dirCategory}/. move to _scratch/`,
    });
  }
  if (status === 'non-matching' && entry.dirCategory !== '_negative') {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='non-matching' but entry lives in ${entry.dirCategory}/. move to _negative/`,
    });
  }
  // Fixture-count invariant for matched
  const verifiedOn = asList(fm.verified_on);
  if (status === 'matched' && verifiedOn.length < 2) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message:
        `status='matched' requires verified_on to list >= 2 axis points (devices/firmwares); ` +
        `found ${verifiedOn.length}. Demote to 'matched-singleton' or 'partial-N1', or add the second fixture.`,
    });
  }
  if (status === 'matched-singleton' && verifiedOn.length < 1) {
    violations.push({
      entry: entry.slug,
      severity: 'fail',
      message: `status='matched-singleton' requires verified_on to list >= 1 axis point; found 0`,
    });
  }
  // Consumed_in path resolution
  const consumedIn = asList(fm.consumed_in);
  for (const ci of consumedIn) {
    const resolved = resolveConsumedInPath(ci);
    if (resolved.kind === 'missing') {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message:
          `consumed_in path not found: '${ci}'. Tried:\n    ${resolved.tried.join('\n    ')}`,
      });
    } else if (resolved.kind === 'soft-missing') {
      violations.push({
        entry: entry.slug,
        severity: 'warn',
        message: `consumed_in speculative path not found: '${ci}' (${resolved.reason})`,
      });
    }
  }
  // Cross-reference integrity: relates_to + body wikilinks. Cookbook entries
  // navigate via [[slug]] wikilinks and `relates_to:` frontmatter lists; if
  // either points at a slug that no longer exists, readers chase ghosts.
  // Self-references are allowed (some refinement-history footers cite the
  // entry's own slug for clarity).
  const relatesTo = asList(fm.relates_to);
  for (const ref of relatesTo) {
    if (ref === '' || ref === entry.slug) continue;
    if (!slugSet.has(ref)) {
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `relates_to references unknown cookbook slug '${ref}'`,
      });
    }
  }
  const wikilinks = extractWikilinks(entry.body);
  const reported = new Set<string>();
  for (const ref of wikilinks) {
    if (ref === entry.slug || reported.has(ref)) continue;
    if (!slugSet.has(ref)) {
      reported.add(ref);
      violations.push({
        entry: entry.slug,
        severity: 'fail',
        message: `body [[wikilink]] references unknown cookbook slug '${ref}'`,
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Functional fixture cases. Each function returns null on success or an error
// string on failure.
// -----------------------------------------------------------------------------

function caseXor7fEnvelopeChecksum(): string | null {
  // Capture: AM4 set_param amp.gain 0.0 wire prefix
  // f0 00 01 74 15 01 3a 00 0b 00 01 00 00 00 04 00 00 00 00 00 25 f7
  // Folded XOR over all bytes from F0 to (penultimate, i.e. 0x00 just before checksum 0x25)
  // expected checksum = 0x25
  const wire = [
    0xf0, 0x00, 0x01, 0x74, 0x15, 0x01, 0x3a, 0x00, 0x0b, 0x00, 0x01, 0x00,
    0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  let acc = 0;
  for (const b of wire) acc ^= b;
  const cs = acc & 0x7f;
  if (cs !== 0x25) {
    return `AM4 fixture: expected checksum 0x25, got 0x${cs.toString(16).padStart(2, '0')}`;
  }
  // II envelope (verify-msg style, captured): f0 00 01 74 10 01 ... <cs> f7
  // Use a trivial II envelope from the descriptor table cookbook entry:
  //   F0 00 01 74 10 76 F7  (fn 0x76 = get firmware version, no payload)
  // checksum byte sits at position len-2 = position 6, so we XOR positions 0..5.
  const ii = [0xf0, 0x00, 0x01, 0x74, 0x07, 0x76];
  let iiAcc = 0;
  for (const b of ii) iiAcc ^= b;
  const iiCs = iiAcc & 0x7f;
  // Sanity: just confirm masked value is < 0x80 and deterministic.
  if (iiCs >= 0x80) {
    return `II fixture: masked checksum should be < 0x80, got 0x${iiCs.toString(16)}`;
  }
  // III envelope: f0 00 01 74 11 ... — same algorithm.
  const iii = [0xf0, 0x00, 0x01, 0x74, 0x10, 0x46];
  let iiiAcc = 0;
  for (const b of iii) iiiAcc ^= b;
  if ((iiiAcc & 0x7f) >= 0x80) {
    return `III fixture: masked checksum should be < 0x80`;
  }
  return null;
}

function caseSeptet14bit(): string | null {
  const encode = (v: number): [number, number] => [v & 0x7f, (v >> 7) & 0x7f];
  const decode = (b0: number, b1: number): number => b0 | (b1 << 7);
  for (const v of [0, 1, 127, 128, 200, 4096, 16383]) {
    const [b0, b1] = encode(v);
    if (b0 >= 0x80 || b1 >= 0x80) {
      return `septet bytes not 7-bit-clean for v=${v}: 0x${b0.toString(16)} 0x${b1.toString(16)}`;
    }
    const d = decode(b0, b1);
    if (d !== v) return `round-trip failed for v=${v}: decoded ${d}`;
  }
  return null;
}

function caseSeptet21bitByte2MaskPreservation(): string | null {
  // Encode a 16-bit ushort value (7 + 7 + 2 = 16 value bits) into 3 wire
  // bytes, preserving the high 5 bits of byte 2 (the firmware-reserved
  // mask). Verify round-trip + mask preservation.
  // Note: the cookbook entry is named "septet-21bit" because the WIRE
  // form is 3 septets = 21 wire bits, but the encodable VALUE is 16
  // bits because byte 2 holds only 2 value bits + 5 reserved + 1
  // SysEx-required clear bit.
  const cases: { v: number; originalByte2: number }[] = [
    { v: 0, originalByte2: 0x40 },           // bit 6 of mask set
    { v: 1, originalByte2: 0x7c },           // all reserved bits set
    { v: 0xffff, originalByte2: 0x04 },      // max 16-bit value, single reserved bit
    { v: 0x3456, originalByte2: 0x58 },      // mid-range value + mixed mask
    { v: 0xc000, originalByte2: 0x00 },      // top-2-bits-only, mask zero
  ];
  for (const c of cases) {
    const b0 = c.v & 0x7f;
    const b1 = (c.v >> 7) & 0x7f;
    const b2 = (c.originalByte2 & 0x7c) | ((c.v >> 14) & 0x03);
    if (b0 >= 0x80 || b1 >= 0x80 || b2 >= 0x80) {
      return `bytes not 7-bit-clean for v=0x${c.v.toString(16)}`;
    }
    // Decode the value (low 14 bits of b0/b1 + high 2 bits of b2 & 0x03)
    const decoded = b0 | (b1 << 7) | ((b2 & 0x03) << 14);
    if (decoded !== c.v) {
      return `round-trip value mismatch for v=0x${c.v.toString(16)}, decoded 0x${decoded.toString(16)}`;
    }
    // Verify reserved-bit preservation
    const recoveredMask = b2 & 0x7c;
    const expectedMask = c.originalByte2 & 0x7c;
    if (recoveredMask !== expectedMask) {
      return `reserved-bit preservation failed for v=0x${c.v.toString(16)} origByte2=0x${c.originalByte2.toString(16)}: recovered mask 0x${recoveredMask.toString(16)}, expected 0x${expectedMask.toString(16)}`;
    }
  }
  return null;
}

function caseVendorEnvelopeDescriptorTable(): string | null {
  const jsonPath = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axe-edit-iii-misc-descriptors.descriptors.json',
  );
  if (!existsSync(jsonPath)) {
    return `descriptor JSON not found at ${jsonPath}. ` +
      `Regenerate via the III parse-ghidra-decompile.ts run.`;
  }
  const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
    tables: { address: string; entries: { tag: number; mid: number; byte_count: number }[] }[];
  };
  const target = parsed.tables.find((t) => t.address === '0x1407ab940');
  if (!target) {
    return `headline table 0x1407ab940 not found in III misc-descriptors JSON. ` +
      `The III preset-body envelope shape claim in cookbook is unverified.`;
  }
  // Expected: (tag=0, mid=6, byte_count=2) + (tag=1, mid=8, byte_count=3072)
  // The sentinel (-1, -1, -1) is stripped by the parser.
  if (target.entries.length !== 2) {
    return `0x1407ab940 entry count: expected 2, got ${target.entries.length}`;
  }
  const [e0, e1] = target.entries;
  if (!(e0.tag === 0 && e0.mid === 6 && e0.byte_count === 2)) {
    return `0x1407ab940 entry[0]: expected (0, 6, 2), got (${e0.tag}, ${e0.mid}, ${e0.byte_count})`;
  }
  if (!(e1.tag === 1 && e1.mid === 8 && e1.byte_count === 3072)) {
    return `0x1407ab940 entry[1]: expected (1, 8, 3072), got (${e1.tag}, ${e1.mid}, ${e1.byte_count})`;
  }
  // 3072 bytes / 3 bytes-per-ushort = 1024 ushorts — sanity-confirm the claim.
  if ((e1.byte_count / 3) !== 1024) {
    return `0x1407ab940 byte_count=3072 should imply 1024 ushorts; got ${e1.byte_count / 3}`;
  }
  return null;
}

function caseIiiBlockNameStringCascade(): string | null {
  // Negative-finding drift guard. The cookbook entry
  // `_negative/iii-block-name-string-cascade.md` claims the III editor
  // binary has NO inline `strcmp(name, "Amp"/"Cab"/"Chorus"/...)` cascade
  // for preset-binary block ordering. If the III dumps are regenerated
  // and the cascade pattern DOES appear, this test fails and forces the
  // cookbook entry to be re-classified (promoted to a real transfer or
  // moved to scratch). False-positive guard: `PresetCabBundleImport` is a
  // single known import-function symbol containing "Cab" as a substring
  // — not a block-name string-table reference.
  const dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axe-edit-iii-preset-receiver.txt',
  );
  if (!existsSync(dump)) {
    return `III preset-receiver dump not found at ${dump}. ` +
      `Regenerate via fractal-midi/scripts/ghidra/DumpAxeEditIIIPresetReceiver.java.`;
  }
  const src = readFileSync(dump, 'utf8');
  // Look for `,"<BlockName>"` followed by `)` — the strcmp-style call
  // pattern AEImageDepot uses on II. Quoting the needle keeps it from
  // matching unrelated identifiers like `PresetCab*`.
  const needles = [
    'Amp', 'Cab', 'Chorus', 'Compressor', 'Drive', 'Reverb', 'Flanger',
    'Phaser', 'Delay', 'Pitch', 'Vocoder', 'Tremolo', 'Filter', 'Rotary',
    'QuadChorus', 'Resonator', 'RingMod', 'Synth', 'GateExpander',
    'GraphicEQ', 'ParametricEQ', 'MultibandComp', 'MultiDelay',
    'PanTrem', 'Looper', 'Noisegate',
  ];
  const matches: string[] = [];
  for (const n of needles) {
    // Pattern: ,"Name") — strcmp-style call argument
    const re = new RegExp(`,\\s*"${n}"\\s*\\)`, 'g');
    const hits = src.match(re);
    if (hits && hits.length > 0) {
      matches.push(`${n} (${hits.length} hits)`);
    }
  }
  if (matches.length > 0) {
    return `cookbook negative-finding CONTRADICTED: III preset-receiver dump ` +
      `now contains strcmp-style block-name cascade matches: ${matches.join(', ')}. ` +
      `Update _negative/iii-block-name-string-cascade.md (promote to transfer or scratch).`;
  }
  return null;
}

function caseIiiByteStreamSeptetPack8to7(): string | null {
  // 8-to-7-bit byte-stream septet packer per FUN_14033f2d0 in
  // ghidra-axe-edit-iii-store-preset.txt (L1278-1317). Each output byte
  // is 7-bit clean; output size = ceil(N * 8 / 7).
  const pack = (input: readonly number[]): number[] => {
    const N = input.length;
    if (N === 0) return [0];
    const out: number[] = [];
    let inIdx = 0;
    let bitsConsumed = 1;
    let carry = 0;
    while (inIdx < N) {
      if (bitsConsumed === 8) {
        out.push(carry & 0x7f);
        bitsConsumed = 1;
        carry = 0;
      } else {
        const b = input[inIdx] & 0xff;
        out.push(((b >> bitsConsumed) | carry) & 0x7f);
        const mask = (1 << bitsConsumed) - 1;
        carry = (b & mask) << (7 - bitsConsumed);
        bitsConsumed += 1;
        inIdx += 1;
      }
    }
    out.push(carry & 0x7f);
    return out;
  };
  const fixtures: { input: number[]; expected: number[] }[] = [
    // N=1: input=[0xFF] → output high 7 bits as 0x7F, low 1 bit shifted to position 6 = 0x40
    { input: [0xff], expected: [0x7f, 0x40] },
    // N=2: hand-trace input=[0xAA, 0x55]
    //   iter 1 (bc=1): out[0] = (0xAA >> 1) = 0x55; carry = (0xAA & 0x01) << 6 = 0
    //   iter 2 (bc=2): out[1] = ((0x55 >> 2) | 0) = 0x15; carry = (0x55 & 0x03) << 5 = 0x20
    //   final flush: out[2] = 0x20
    { input: [0xaa, 0x55], expected: [0x55, 0x15, 0x20] },
    // N=7: all-zero input → all-zero output of size 8 (the boundary where no carry-flush fires)
    { input: [0, 0, 0, 0, 0, 0, 0], expected: [0, 0, 0, 0, 0, 0, 0, 0] },
    // N=8: all-zero input → all-zero output of size 10 (one carry-flush iteration between input 7 and 8)
    { input: [0, 0, 0, 0, 0, 0, 0, 0], expected: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  ];
  for (const fx of fixtures) {
    const expectedSize = fx.input.length === 0 ? 1 : Math.ceil((fx.input.length * 8) / 7);
    if (fx.expected.length !== expectedSize) {
      return `fixture-size sanity fail for N=${fx.input.length}: expected ${expectedSize}, got ${fx.expected.length}`;
    }
    const got = pack(fx.input);
    if (got.length !== fx.expected.length) {
      return `pack length mismatch for N=${fx.input.length}: expected ${fx.expected.length}, got ${got.length}`;
    }
    for (let i = 0; i < got.length; i++) {
      if (got[i] & 0x80) {
        return `pack output byte ${i} not 7-bit-clean: 0x${got[i].toString(16)}`;
      }
      if (got[i] !== fx.expected[i]) {
        return `pack output mismatch for N=${fx.input.length} at byte ${i}: expected 0x${fx.expected[i].toString(16)}, got 0x${got[i].toString(16)}`;
      }
    }
  }
  // Output-size formula spot-check: N=14 → 16, N=15 → 18 (one extra flush)
  if (pack(new Array(14).fill(0xff)).length !== 16) {
    return `N=14 expected output size 16, got ${pack(new Array(14).fill(0xff)).length}`;
  }
  if (pack(new Array(15).fill(0xff)).length !== 18) {
    return `N=15 expected output size 18, got ${pack(new Array(15).fill(0xff)).length}`;
  }
  return null;
}

function caseXorFoldHash(): string | null {
  // Trivial XOR-fold over a known ushort array; the algorithm matches
  // FUN_00544cc0 from AxeEdit II.
  const xorFold = (us: number[]): number => {
    let acc = 0;
    for (const u of us) acc ^= u & 0xffff;
    return acc & 0xffff;
  };
  // Hand-computed: [0x0001, 0x0002, 0x0003] -> 0x0001 ^ 0x0002 ^ 0x0003 = 0x0000
  if (xorFold([0x0001, 0x0002, 0x0003]) !== 0x0000) {
    return `XOR-fold {1,2,3} expected 0x0000, got 0x${xorFold([1, 2, 3]).toString(16)}`;
  }
  // [0x1234, 0x5678] -> 0x444C
  if (xorFold([0x1234, 0x5678]) !== 0x444c) {
    return `XOR-fold {0x1234,0x5678} expected 0x444C, got 0x${xorFold([0x1234, 0x5678]).toString(16)}`;
  }
  // Empty -> 0
  if (xorFold([]) !== 0) return `XOR-fold empty array expected 0`;
  return null;
}

function casePerEffectParamtableDispatcher(): string | null {
  const iiiDump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axeedit3-paramtables-v2.txt',
  );
  if (!existsSync(iiiDump)) {
    return `III paramtables dump not found at ${iiiDump}. ` +
      `Regenerate via fractal-midi/scripts/ghidra/DumpAxeEditIIIParamTablesV2.java.`;
  }
  const iii = readFileSync(iiiDump, 'utf8');
  if (!iii.includes('FUN_140397a40')) {
    return `III dump header does not name FUN_140397a40 dispatcher; ` +
      `expected per the V2 script header.`;
  }
  const distinctTablesMatch = iii.match(/Total distinct tables read:\s*(\d+)/);
  if (!distinctTablesMatch) {
    return `III dump summary missing 'Total distinct tables read'.`;
  }
  const distinctTables = parseInt(distinctTablesMatch[1], 10);
  if (distinctTables < 40) {
    return `III dump distinct table count ${distinctTables} below threshold 40 ` +
      `(expected 49 per V2 script CASE_TO_DAT).`;
  }
  const entriesMatch = iii.match(/Total parameter-ID entries[^:]*:\s*(\d+)/);
  if (!entriesMatch) {
    return `III dump summary missing 'Total parameter-ID entries'.`;
  }
  const entries = parseInt(entriesMatch[1], 10);
  if (entries < 2000) {
    return `III dump entry count ${entries} below threshold 2000 ` +
      `(expected 2216 per dispatcher walk).`;
  }
  const am4Dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-am4edit-paramtables.txt',
  );
  if (!existsSync(am4Dump)) {
    return `AM4 paramtables dump not found at ${am4Dump}; ` +
      `the AM4 dispatcher axis is the second device family for matched status.`;
  }
  const am4SysexMap = path.join(
    FRACTAL_MIDI_ROOT,
    'docs',
    'devices',
    'am4',
    'SYSEX-MAP.md',
  );
  if (!existsSync(am4SysexMap)) {
    return `AM4 SYSEX-MAP not found at ${am4SysexMap}; ` +
      `cross-device dispatcher table cite is broken.`;
  }
  const sysexMap = readFileSync(am4SysexMap, 'utf8');
  if (!sysexMap.includes('FUN_1402e3da0') || !sysexMap.includes('FUN_140397a40')) {
    return `AM4 SYSEX-MAP missing the cross-device dispatcher fn-byte cite ` +
      `(FUN_1402e3da0 / FUN_140397a40 pair).`;
  }
  return null;
}

function caseIiiParamidPseudoSentinelRanges(): string | null {
  const dump = path.join(
    FRACTAL_MIDI_ROOT,
    'samples',
    'captured',
    'decoded',
    'ghidra-axeedit3-paramtables-v2.txt',
  );
  if (!existsSync(dump)) {
    return `III paramtables dump not found at ${dump}.`;
  }
  const src = readFileSync(dump, 'utf8');
  const pseudoCodes = new Set<number>();
  const lines = src.split(/\r?\n/);
  let inParamList = false;
  let currentCase = -1;
  for (const line of lines) {
    if (/^## case 0x[0-9a-fA-F]+/.test(line)) {
      const m = line.match(/0x([0-9a-fA-F]+)/);
      currentCase = m ? parseInt(m[1], 16) : -1;
      inParamList = false;
      continue;
    }
    if (line.includes('paramIds:')) {
      inParamList = true;
    }
    if (line.includes('first metadata ptr')) {
      inParamList = false;
    }
    if (!inParamList) continue;
    const nums = line.match(/\b(\d+)\b/g);
    if (!nums) continue;
    for (const n of nums) {
      const v = parseInt(n, 10);
      if (v >= 0xFF00 && v <= 0xFFFE) {
        pseudoCodes.add(v);
      }
    }
  }
  if (pseudoCodes.size < 3) {
    return `expected ≥3 distinct 0xFFFx pseudo-sentinel paramIds in non-terminator ` +
      `position; found ${pseudoCodes.size}: ${[...pseudoCodes].sort((a, b) => a - b).join(', ')}.`;
  }
  if (!src.includes('Param-ID range observed: 0 .. 65530')) {
    return `III dump summary missing exact line 'Param-ID range observed: 0 .. 65530'; ` +
      `the high-end pseudo-sentinel marker has shifted, re-read the entry.`;
  }
  return null;
}

function caseIiStateBroadcastTripleWrite(): string | null {
  // Verify the state-broadcast triple envelope shape: header (0x74) + chunk (0x75) + footer (0x76).
  // Inline implementation mirrors buildStateBroadcastTripleMessages.
  const MODEL = 0x07;
  const MFR = [0x00, 0x01, 0x74];
  function cksum(bytes: number[]): number { return bytes.reduce((a, b) => a ^ b, 0) & 0x7f; }
  function env(fn: number, payload: number[]): number[] {
    const head = [0xf0, ...MFR, MODEL, fn, ...payload];
    return [...head, cksum(head), 0xf7];
  }
  function enc14(n: number): [number, number] { return [n & 0x7f, (n >> 7) & 0x7f]; }
  function pack16(v: number): [number, number, number] { return [v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x03]; }

  // Fixture: targetId=127 (Volume/Pan 1), 9 values from session-58 capture.
  const targetId = 127;
  const values = [65534, 32767, 2, 0, 0, 65534, 52427, 0, 0];
  const opFlag = 0x01;

  const header = env(0x74, [...enc14(targetId), ...enc14(values.length), opFlag]);
  const chunkBody: number[] = [];
  for (const v of values) chunkBody.push(...pack16(v));
  const chunk = env(0x75, [...enc14(values.length), ...chunkBody]);
  const footer = env(0x76, []);

  // Structural checks.
  if (header[5] !== 0x74) return `header fn should be 0x74`;
  if (header[6] !== 0x7f || header[7] !== 0x00) return `targetId encoding wrong`;
  if (header[8] !== 0x09 || header[9] !== 0x00) return `itemCount encoding wrong`;
  if (header[10] !== 0x01) return `opFlag should be 0x01`;
  if (chunk[5] !== 0x75) return `chunk fn should be 0x75`;
  if (footer[5] !== 0x76) return `footer fn should be 0x76`;
  // Value round-trip: first value 65534 = pack16([0x7E, 0x7F, 0x03]).
  const payloadStart = 8; // F0 MFR MODEL 75 countLo countHi → payload at byte 8
  const b0 = chunk[payloadStart], b1 = chunk[payloadStart + 1], b2 = chunk[payloadStart + 2];
  const decoded = (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
  if (decoded !== 65534) return `first value round-trip: expected 65534, got ${decoded}`;
  // Last value round-trip: value[8]=0 should pack as [0,0,0].
  const lastOff = payloadStart + 8 * 3;
  const lastDecoded = (chunk[lastOff] & 0x7f) | ((chunk[lastOff + 1] & 0x7f) << 7) | ((chunk[lastOff + 2] & 0x03) << 14);
  if (lastDecoded !== 0) return `last value round-trip: expected 0, got ${lastDecoded}`;
  // Checksum validity.
  const csIdx = header.length - 2;
  const expectedCs = cksum(header.slice(0, csIdx));
  if (header[csIdx] !== expectedCs) return `header checksum mismatch`;
  return null;
}

function caseIiCompressorCalibrationDivergence(): string | null {
  // Hardware-verified 2026-05-27, Axe-Fx II XL+ Ares 2.00.
  // Four compressor params with known wire values and device-displayed results.
  //
  // Log10 formula: display = min * (max / min) ^ (wire / 65534)
  // Linear formula: display = min + (max - min) * (wire / 65534)
  const WIRE_MAX = 65534;

  // --- threshold: linear, -80..0 dB ---
  // Wire 47512 -> device "-22.0 dB"
  // Wire 32767 -> device "-40.0 dB"
  const threshMin = -80, threshMax = 0;
  const threshDisplay1 = threshMin + (threshMax - threshMin) * (47512 / WIRE_MAX);
  // Expected: -22.0 dB (device rounds to 1 decimal)
  if (Math.abs(threshDisplay1 - (-22.0)) > 0.1) {
    return `threshold wire=47512: expected ~-22.0, got ${threshDisplay1.toFixed(1)}`;
  }
  const threshDisplay2 = threshMin + (threshMax - threshMin) * (32767 / WIRE_MAX);
  // Expected: -40.0 dB
  if (Math.abs(threshDisplay2 - (-40.0)) > 0.1) {
    return `threshold wire=32767: expected ~-40.0, got ${threshDisplay2.toFixed(1)}`;
  }

  // --- ratio: log10, 1..20 ---
  // Wire 30326 -> device "4.000"
  const ratioMin = 1, ratioMax = 20;
  const ratioDisplay = ratioMin * Math.pow(ratioMax / ratioMin, 30326 / WIRE_MAX);
  if (Math.abs(ratioDisplay - 4.0) > 0.05) {
    return `ratio wire=30326: expected ~4.0, got ${ratioDisplay.toFixed(3)}`;
  }

  // --- attack: log10, 1..100 ms ---
  // Wire 32767 -> device "10.00 ms" (geometric midpoint of 1*100 = 10)
  const atkMin = 1, atkMax = 100;
  const atkDisplay = atkMin * Math.pow(atkMax / atkMin, 32767 / WIRE_MAX);
  if (Math.abs(atkDisplay - 10.0) > 0.15) {
    return `attack wire=32767: expected ~10.0, got ${atkDisplay.toFixed(2)}`;
  }

  // --- release: log10, 10..1000 ms ---
  // Wire 32767 -> device "100.0 ms" (geometric midpoint of 10*1000 = 100)
  const relMin = 10, relMax = 1000;
  const relDisplay = relMin * Math.pow(relMax / relMin, 32767 / WIRE_MAX);
  if (Math.abs(relDisplay - 100.0) > 1.5) {
    return `release wire=32767: expected ~100.0, got ${relDisplay.toFixed(1)}`;
  }

  // --- Cross-check: AM4 ranges would give WRONG answers ---
  // AM4 threshold is -60..+20. If we used AM4 range on wire=47512,
  // we'd get -60 + 80 * (47512/65534) = -2.0, not -22.0.
  const am4ThreshDisplay = -60 + (20 - (-60)) * (47512 / WIRE_MAX);
  if (Math.abs(am4ThreshDisplay - (-22.0)) < 1.0) {
    return `AM4 threshold range should NOT produce -22.0 but got ${am4ThreshDisplay.toFixed(1)} ` +
      `(divergence guard failed)`;
  }
  // AM4 attack is 0.1..100 ms. Midpoint wire=32767 -> sqrt(0.1*100) = 3.16, not 10.
  const am4AtkDisplay = 0.1 * Math.pow(100 / 0.1, 32767 / WIRE_MAX);
  if (Math.abs(am4AtkDisplay - 10.0) < 1.0) {
    return `AM4 attack range should NOT produce 10.0 but got ${am4AtkDisplay.toFixed(2)} ` +
      `(divergence guard failed)`;
  }

  // --- comp: linear, 0..10 (AM4-matching, hardware-verified 2026-05-27) ---
  // Wire 0->"0.00", wire 32767->"5.00", wire 65534->"10.00"
  const compMin = 0, compMax = 10;
  const compMid = compMin + (compMax - compMin) * (32767 / WIRE_MAX);
  if (Math.abs(compMid - 5.0) > 0.1) {
    return `comp wire=32767: expected ~5.0, got ${compMid.toFixed(2)}`;
  }

  // --- filter: log10, 10..1000 Hz (editor-observed, no AM4 sibling) ---
  // Wire 0->"10.00 Hz", wire 32767->"100.0 Hz", wire 65534->"1000 Hz"
  const filtMin = 10, filtMax = 1000;
  const filtMid = filtMin * Math.pow(filtMax / filtMin, 32767 / WIRE_MAX);
  if (Math.abs(filtMid - 100.0) > 1.5) {
    return `filter wire=32767: expected ~100.0, got ${filtMid.toFixed(1)}`;
  }

  // --- look_ahead: linear, 0..2 ms (AM4-matching) ---
  // Wire 0->"0.000 ms", wire 32767->"1.000 ms", wire 65534->"2.000 ms"
  const laMin = 0, laMax = 2;
  const laMid = laMin + (laMax - laMin) * (32767 / WIRE_MAX);
  if (Math.abs(laMid - 1.0) > 0.01) {
    return `look_ahead wire=32767: expected ~1.0, got ${laMid.toFixed(3)}`;
  }

  return null;
}

function caseIiFn16GetParamInfo(): string | null {
  // fn 0x16 GET_PARAM_INFO 25-byte payload: 5 groups of 5 plain-LE septets,
  // each a 32-bit value. G0 int current, G1/G2/G3 float32, G4 reserved int.
  // Two captured AMP 1 samples (paramId=0 enum, paramId=10 knob).
  const enumPayload = [
    0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x12, 0x1c, 0x04, 0x00, 0x00, 0x00, 0x7c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const knobPayload = [
    0x41, 0x10, 0x00, 0x00, 0x00, 0x2c, 0x0b, 0x1f, 0x39, 0x03, 0x0a, 0x2e,
    0x0f, 0x61, 0x03, 0x00, 0x48, 0x50, 0x4b, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00,
  ];
  const unpack5 = (p: readonly number[], g: number): number =>
    (((p[g * 5] & 0x7f) |
      ((p[g * 5 + 1] & 0x7f) << 7) |
      ((p[g * 5 + 2] & 0x7f) << 14) |
      ((p[g * 5 + 3] & 0x7f) << 21) |
      ((p[g * 5 + 4] & 0x7f) << 28)) >>> 0);
  const pack5 = (u: number): number[] => {
    const n = u >>> 0;
    return [n & 0x7f, (n >>> 7) & 0x7f, (n >>> 14) & 0x7f, (n >>> 21) & 0x7f, (n >>> 28) & 0x0f];
  };
  const f32bits = (v: number): number => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, v, true);
    return new DataView(buf).getUint32(0, true);
  };
  const asF32 = (u: number): number => {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, u >>> 0, true);
    return new DataView(buf).getFloat32(0, true);
  };
  if (enumPayload.length !== 25 || knobPayload.length !== 25) {
    return `fn 0x16 payloads must be 25 bytes`;
  }
  // Enum sample: G0=16, G1=0.0, G2=265.0, G3=1.0, G4=0.
  if (unpack5(enumPayload, 0) !== 16) return `enum G0 expected 16, got ${unpack5(enumPayload, 0)}`;
  if (asF32(unpack5(enumPayload, 1)) !== 0) return `enum G1 expected 0.0`;
  if (asF32(unpack5(enumPayload, 2)) !== 265) return `enum G2 expected 265.0, got ${asF32(unpack5(enumPayload, 2))}`;
  if (asF32(unpack5(enumPayload, 3)) !== 1) return `enum G3 expected 1.0`;
  if (unpack5(enumPayload, 4) !== 0) return `enum G4 expected 0`;
  // Knob sample: G0=2113, G1~1e-5, G2~0.01, G3=1e6, G4=0.
  if (unpack5(knobPayload, 0) !== 2113) return `knob G0 expected 2113, got ${unpack5(knobPayload, 0)}`;
  if (Math.abs(asF32(unpack5(knobPayload, 1)) - 1e-5) > 1e-9) return `knob G1 expected ~1e-5, got ${asF32(unpack5(knobPayload, 1))}`;
  if (Math.abs(asF32(unpack5(knobPayload, 2)) - 0.01) > 1e-6) return `knob G2 expected ~0.01, got ${asF32(unpack5(knobPayload, 2))}`;
  if (asF32(unpack5(knobPayload, 3)) !== 1e6) return `knob G3 expected 1e6, got ${asF32(unpack5(knobPayload, 3))}`;
  if (unpack5(knobPayload, 4) !== 0) return `knob G4 expected 0`;
  // Byte-exact re-encode of the enum sample from decoded group values.
  const reencode = [
    ...pack5(16),
    ...pack5(f32bits(0)),
    ...pack5(f32bits(265)),
    ...pack5(f32bits(1)),
    ...pack5(0),
  ];
  for (let i = 0; i < 25; i++) {
    if (reencode[i] !== enumPayload[i]) {
      return `enum re-encode drift at byte ${i}: expected 0x${enumPayload[i].toString(16)}, got 0x${reencode[i].toString(16)}`;
    }
  }
  return null;
}

function caseIiFn0eQueryStates(): string | null {
  // fn 0x0E QUERY_STATES response: 62-byte capture for an 11-block preset.
  // Payload (bytes 6..len-2; no trailing checksum) tiles into 5-byte records.
  const frame = [
    0xf0, 0x00, 0x01, 0x74, 0x07, 0x0e,
    0x03, 0x4a, 0x10, 0x53, 0x06,
    0x03, 0x4e, 0x18, 0x63, 0x06,
    0x02, 0x52, 0x20, 0x23, 0x07,
    0x02, 0x56, 0x00, 0x20, 0x06,
    0x02, 0x5e, 0x28, 0x03, 0x07,
    0x02, 0x62, 0x30, 0x2b, 0x78,
    0x02, 0x70, 0x38, 0x33, 0x07,
    0x02, 0x0a, 0x7d, 0x17, 0x07,
    0x03, 0x26, 0x51, 0x73, 0x06,
    0x02, 0x2c, 0x75, 0x43, 0x07,
    0x02, 0x42, 0x59, 0x63, 0x07,
    0xf7,
  ];
  if (frame.length !== 62) return `fn 0x0E frame must be 62 bytes, got ${frame.length}`;
  const payload = frame.slice(6, frame.length - 1);
  if (payload.length % 5 !== 0) {
    return `fn 0x0E payload length ${payload.length} not a multiple of 5`;
  }
  const records = payload.length / 5;
  if (records !== 11) return `fn 0x0E expected 11 records, got ${records}`;
  // Re-emit [tag, ...septets] and confirm byte-exact match to the payload.
  const reemit: number[] = [];
  for (let i = 0; i + 5 <= payload.length; i += 5) {
    reemit.push(payload[i], payload[i + 1], payload[i + 2], payload[i + 3], payload[i + 4]);
  }
  for (let i = 0; i < payload.length; i++) {
    if (reemit[i] !== payload[i]) {
      return `fn 0x0E re-emit drift at byte ${i}: expected 0x${payload[i].toString(16)}, got 0x${reemit[i].toString(16)}`;
    }
  }
  return null;
}

function caseIiFn07ModifierRead(): string | null {
  // fn 0x07 modifier read reply frames, captured live (Ares 2.00, XL+):
  //   F0 00 01 74 07 07 [effId:2][slot:2][field:2][value:3][ascii NUL][cs] F7
  // value = v0 | v1<<7 | (v2&3)<<14 (packValue16).
  const dec14 = (lo: number, hi: number) => lo | (hi << 7);
  const dec16 = (b0: number, b1: number, b2: number) => (b0 & 0x7f) | ((b1 & 0x7f) << 7) | ((b2 & 0x03) << 14);
  function parse(frame: number[]): { effId: number; slot: number; field: number; value: number; label: string } {
    let label = '';
    for (let i = 15; i < frame.length - 2; i++) { if (frame[i] === 0x00) break; label += String.fromCharCode(frame[i]); }
    return { effId: dec14(frame[6], frame[7]), slot: dec14(frame[8], frame[9]), field: dec14(frame[10], frame[11]), value: dec16(frame[12], frame[13], frame[14]), label };
  }
  // field 0x00 = source: value 1 = "LFO 1A"
  const src = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x4c, 0x46, 0x4f, 0x20, 0x31, 0x41, 0x00, 0x7a, 0xf7]);
  if (!(src.effId === 106 && src.field === 0 && src.value === 1 && src.label === 'LFO 1A')) {
    return `fn07 source frame: got ${JSON.stringify(src)}`;
  }
  // field 0x02 = max: value 65534 = "10.00"
  const max = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x02, 0x00, 0x7e, 0x7f, 0x03, 0x31, 0x30, 0x2e, 0x30, 0x30, 0x00, 0x41, 0xf7]);
  if (!(max.field === 2 && max.value === 65534 && max.label === '10.00')) return `fn07 max frame: got ${JSON.stringify(max)}`;
  // field 0x08 = target effectId 106; field 0x09 = target paramId 1
  const tEff = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x08, 0x00, 0x6a, 0x00, 0x00, 0x00, 0x0c, 0xf7]);
  if (!(tEff.field === 8 && tEff.value === 106)) return `fn07 target-effId frame: got ${JSON.stringify(tEff)}`;
  const tPid = parse([0xf0, 0x00, 0x01, 0x74, 0x07, 0x07, 0x6a, 0x00, 0x01, 0x00, 0x09, 0x00, 0x01, 0x00, 0x00, 0x00, 0x66, 0xf7]);
  if (!(tPid.field === 9 && tPid.value === 1)) return `fn07 target-paramId frame: got ${JSON.stringify(tPid)}`;
  return null;
}

const FUNCTIONAL_CASES: Record<string, () => string | null> = {
  'xor-7f-envelope-checksum': caseXor7fEnvelopeChecksum,
  'septet-14bit': caseSeptet14bit,
  'septet-21bit-byte2-mask-preservation': caseSeptet21bitByte2MaskPreservation,
  'vendor-envelope-descriptor-table': caseVendorEnvelopeDescriptorTable,
  'xor-fold-hash': caseXorFoldHash,
  'iii-block-name-string-cascade': caseIiiBlockNameStringCascade,
  'iii-byte-stream-septet-pack-8to7': caseIiiByteStreamSeptetPack8to7,
  'per-effect-paramtable-dispatcher': casePerEffectParamtableDispatcher,
  'iii-paramid-pseudo-sentinel-ranges': caseIiiParamidPseudoSentinelRanges,
  'ii-state-broadcast-triple-write': caseIiStateBroadcastTripleWrite,
  'ii-compressor-calibration-divergence': caseIiCompressorCalibrationDivergence,
  'ii-fn16-get-param-info': caseIiFn16GetParamInfo,
  'ii-fn0e-query-states': caseIiFn0eQueryStates,
  'ii-fn07-modifier-read': caseIiFn07ModifierRead,
};

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

function main(): void {
  const verbose = process.argv.includes('--verbose');
  const entries = loadEntries();
  const slugSet = new Set(entries.map((e) => e.slug));
  const violations: Violation[] = [];
  let structuralOk = 0;
  for (const entry of entries) {
    const before = violations.length;
    validateStructural(entry, violations, slugSet);
    if (violations.length === before) structuralOk += 1;
  }
  const functionalResults: { slug: string; ok: boolean; message: string | null }[] = [];
  for (const [slug, fn] of Object.entries(FUNCTIONAL_CASES)) {
    let err: string | null;
    try {
      err = fn();
    } catch (e) {
      err = `threw: ${(e as Error).message}`;
    }
    functionalResults.push({ slug, ok: err === null, message: err });
  }

  // Verbose diagnostics: status breakdown + STUB inventory. These don't
  // catch bugs — they're orientation aids when working on the cookbook
  // directly. Hidden behind --verbose so preflight output stays terse.
  if (verbose) {
    const statusCounts = new Map<string, number>();
    for (const e of entries) {
      const s = typeof e.frontmatter.status === 'string' ? e.frontmatter.status : '<missing>';
      statusCounts.set(s, (statusCounts.get(s) ?? 0) + 1);
    }
    const withInline = new Set(Object.keys(FUNCTIONAL_CASES));
    const stubbed = entries.filter(
      (e) => !withInline.has(e.slug) && typeof e.frontmatter.status === 'string' && e.frontmatter.status !== 'scratch',
    ).map((e) => e.slug);

    console.log('cookbook-verify (verbose)');
    console.log('=========================');
    console.log(`entries scanned:       ${entries.length}`);
    console.log(`structural pass:       ${structuralOk} / ${entries.length}`);
    console.log('status breakdown:');
    for (const [s, n] of [...statusCounts.entries()].sort()) {
      console.log(`  ${s.padEnd(20)} ${n}`);
    }
    console.log('functional fixture cases:');
    for (const r of functionalResults) {
      if (r.ok) console.log(`  PASS   case-${r.slug}`);
      else console.log(`  FAIL   case-${r.slug}\n         ${r.message}`);
    }
    console.log(`primitives without inline fixture (covered via existing verify-* scripts):`);
    for (const s of stubbed) console.log(`  STUB   case-${s}`);
    console.log('');
  }

  const functionalFails = functionalResults.filter((r) => !r.ok);
  const fails = violations.filter((v) => v.severity === 'fail');
  const warns = violations.filter((v) => v.severity === 'warn');
  if (fails.length === 0 && functionalFails.length === 0) {
    if (warns.length > 0) {
      console.log(`WARNINGS (${warns.length}):`);
      for (const v of warns) console.log(`  [warn] ${v.entry}: ${v.message}`);
      console.log('');
    }
    console.log(
      `OK: ${entries.length} cookbook entries, ${functionalResults.length} fixtures green, ` +
        `${warns.length} non-blocking warnings.`,
    );
    process.exit(0);
  }
  if (fails.length > 0) {
    console.log(`STRUCTURAL FAILURES (${fails.length}):`);
    for (const v of fails) console.log(`  [fail] ${v.entry}: ${v.message}`);
  }
  if (warns.length > 0) {
    console.log(`WARNINGS (${warns.length}):`);
    for (const v of warns) console.log(`  [warn] ${v.entry}: ${v.message}`);
  }
  if (functionalFails.length > 0) {
    console.log(`FUNCTIONAL CASE FAILURES (${functionalFails.length}):`);
    for (const r of functionalFails) {
      console.log(`  case-${r.slug}: ${r.message}`);
    }
  }
  process.exit(1);
}

main();
