/**
 * READ-ONLY analysis. Classify the 188 unmatched Axe-Fx II XML
 * parameterNames into annotation-gap (ship-now) vs true-missing
 * (hardware-gated).
 *
 * For each XML parameterName the type-applicability generator reports
 * as having no matching KNOWN_PARAMS.parameterName annotation, this
 * script pulls the XML displayLabel (`name=`) + controlType (`type=`)
 * and rigorously joins against the registry: same block, registry
 * entry lacks `parameterName`, displayLabel + controlType-class agree.
 *
 * Emits nothing to disk; prints a classified report to stdout.
 *
 * Run: npx tsx scripts/_research/wf-axefx2-188-classify.ts
 */
import { readFileSync } from 'node:fs';

import { KNOWN_PARAMS } from 'fractal-midi/axe-fx-ii';

const XML_PATH =
  'samples/captured/decoded/binarydata/axe-edit-extracted/__block_layout.xml';

// ── XML block name → params.ts block slug (copied from generator) ──
const XML_TO_FRIENDLY_BLOCK: Record<string, string | null> = {
  Amp: 'amp', Cab: 'cab', Chorus: 'chorus', Compressor: 'compressor',
  Controllers: 'controllers', Crossover: 'crossover', Delay: 'delay',
  Drive: 'drive', EffectsLoop: 'effectsloop', Enhancer: 'enhancer',
  FeedbackReturn: 'feedbackreturn', FeedbackSend: 'feedbacksend',
  Filter: 'filter', Flanger: 'flanger', Formant: 'formant',
  GateExpander: 'gateexpander', GraphicEQ: 'graphiceq', Looper: 'looper',
  MegaTap: 'megatap', Mixer: 'mixer', MultibandComp: 'multibandcomp',
  MultiDelay: 'multidelay', ModifierDlg: null, NoiseGate: null,
  Output: 'output', PanTrem: 'pantrem', ParametricEQ: 'parametriceq',
  Phaser: 'phaser', Pitch: 'pitch', QuadChorus: null, Resonator: 'resonator',
  Reverb: 'reverb', RingMod: 'ringmod', Rotary: 'rotary', Synth: 'synth',
  Tone: null, Vocoder: 'vocoder', VolPan: 'volpan', Wah: 'wah',
};

function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) out[m[1]] = m[2];
  return out;
}

// XML controlType → coarse class.
function ctClass(t: string | undefined): 'cont' | 'disc' | 'other' {
  if (!t) return 'other';
  if (t === 'knob' || t === 'slider' || t === 'knob-readonly') return 'cont';
  if (
    t.startsWith('dropdown') ||
    t === 'toggle' || t === 'toggleSingleLine' ||
    t === 'tristate_slider' || t === 'bistate_slider'
  )
    return 'disc';
  return 'other';
}

// registry controlType → coarse class.
function regClass(t: string): 'cont' | 'disc' | 'other' {
  if (t === 'knob') return 'cont';
  if (t === 'select' || t === 'switch') return 'disc';
  return 'other';
}

// ── Build XML displayLabel + controlType per (friendlyBlock, paramName) ──
const xml = readFileSync(XML_PATH, 'utf8');
type XmlMeta = { label: string; ctype: string; labels: Set<string> };
// friendlyBlock -> parameterName -> meta (first non-empty label wins)
const xmlMeta = new Map<string, Map<string, XmlMeta>>();

const blockRe = /<EditorControls\s+([^>]*?)>([\s\S]*?)<\/EditorControls>/g;
let bm;
while ((bm = blockRe.exec(xml)) !== null) {
  const blockAttrs = parseAttrs(bm[1]);
  const friendly = XML_TO_FRIENDLY_BLOCK[blockAttrs.name];
  if (!friendly) continue;
  let inner = xmlMeta.get(friendly);
  if (!inner) { inner = new Map(); xmlMeta.set(friendly, inner); }
  const ctrlRe = /<EditorControl\s+([^>]*?)\/?>/g;
  let cm;
  while ((cm = ctrlRe.exec(bm[2])) !== null) {
    const a = parseAttrs(cm[1]);
    if (!a.parameterName) continue;
    const existing = inner.get(a.parameterName);
    const label = (a.name ?? '').replace(/&#10;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!existing) {
      inner.set(a.parameterName, { label, ctype: a.type ?? '', labels: label ? new Set([label]) : new Set() });
    } else {
      if (label) existing.labels.add(label);
      if (!existing.label && label) { existing.label = label; existing.ctype = a.type || existing.ctype; }
    }
  }
}

// ── Registry: per block, all entries (with + without parameterName) ──
type P = { key: string; block: string; name: string; wikiName: string;
  controlType: string; parameterName?: string };
const allParams = Object.entries(KNOWN_PARAMS).map(([key, v]) => ({
  key, ...(v as Omit<P, 'key'>),
})) as P[];
const byBlock = new Map<string, P[]>();
for (const p of allParams) {
  const arr = byBlock.get(p.block) ?? [];
  arr.push(p);
  byBlock.set(p.block, arr);
}
// set of parameterNames already claimed by SOME registry entry
const claimedParamNames = new Set<string>();
for (const p of allParams) if (p.parameterName) claimedParamNames.add(`${p.block}|${p.parameterName}`);

// ── Reproduce the 188 unmatched set exactly as the generator does ──
// (parameterName under a registry-mapped block with no registry join)
const registryByBlockParam = new Map<string, Set<string>>();
for (const p of allParams) {
  if (!p.parameterName) continue;
  const s = registryByBlockParam.get(p.block) ?? new Set<string>();
  s.add(p.parameterName);
  registryByBlockParam.set(p.block, s);
}
const unmatched: { block: string; pname: string }[] = [];
const seen = new Set<string>();
{
  const re = /<EditorControls\s+([^>]*?)>([\s\S]*?)<\/EditorControls>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const ba = parseAttrs(m[1]);
    const friendly = XML_TO_FRIENDLY_BLOCK[ba.name];
    if (!friendly) continue;
    if (!registryByBlockParam.has(friendly)) continue; // block has no registry → generator skips entirely
    const ctrlRe = /<EditorControl\s+([^>]*?)\/?>/g;
    let cm;
    while ((cm = ctrlRe.exec(m[2])) !== null) {
      const a = parseAttrs(cm[1]);
      if (!a.parameterName) continue;
      const reg = registryByBlockParam.get(friendly)!;
      if (reg.has(a.parameterName)) continue;
      const k = `${friendly}|${a.parameterName}`;
      if (seen.has(k)) continue;
      seen.add(k);
      unmatched.push({ block: friendly, pname: a.parameterName });
    }
  }
}

// Levenshtein for tie-break / typo detection.
function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let p = prev[0]; prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, p + (a[i - 1] === b[j - 1] ? 0 : 1));
      p = tmp;
    }
  }
  return prev[b.length];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Standard Fractal UI abbreviation expansions (display token -> canonical).
// Drives token-set semantic matching for cases where the XML displayLabel
// uses a full word the registry name/wikiName abbreviates (or vice versa).
const ABBREV: Record<string, string> = {
  mid: 'middle', freq: 'frequency', thresh: 'threshold', fdbk: 'feedback',
  detune: 'tune', hpf: 'lowcut', hicut: 'highcut', lowcut: 'lowcut',
  locut: 'lowcut', lpf: 'highcut', span: 'span', fstart: 'frequencystart',
  fstop: 'frequencymax', fmin: 'frequencymin', numsprings: 'springnumber',
  hflevel: 'hilevel', threshlev: 'thresholdlevel', freqrange: 'frequencymultiplier',
  freqmulti: 'frequencymultiplier', fmultiplier: 'frequencymultiplier',
  manual: 'drydelay', lfofilter: 'lfohighcut', spkrlfgain: 'lowresonance',
  lowres: 'lowresonance', negfeedback: 'negativefeedback', beta: 'negativefeedback',
  cbratio: 'cathoderesistance', cathoderesist: 'cathoderesistance',
  timeconst: 'timeconstant', bias: 'tubegridbias', tubegridbias: 'tubegridbias',
  tonetype: 'tonestacktype', tonestack: 'tonestacktype',
  hi: 'high', const: 'constant', numsprings: 'springnumber',
  resonance: 'res', negative: 'neg', multiplier: 'multi', output: 'out',
};

// Build a canonical token-bag from a string, expanding abbreviations and
// dropping noise tokens. Used for semantic same-block matching.
function tokenBag(s: string): Set<string> {
  const raw = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    // split camel/word+digit boundaries: level1 -> level 1, lfo2depth -> lfo 2 depth
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const out = new Set<string>();
  for (const t of raw) {
    if (t === 'the' || t === 'a' || t === 'of') continue;
    out.add(ABBREV[t] ?? t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// ── Classify each unmatched ──
type Verdict =
  | { kind: 'annotation'; conf: 'high' | 'med'; regKey: string; regCtype: string; reason: string }
  | { kind: 'true-missing'; reason: string };

const results: {
  block: string; pname: string; label: string; ctype: string; verdict: Verdict;
}[] = [];

for (const { block, pname } of unmatched) {
  const meta = xmlMeta.get(block)?.get(pname) ?? { label: '', ctype: '', labels: new Set<string>() };
  const label = meta.label;
  const allLabels = [...meta.labels];
  const ctype = meta.ctype;
  const xClass = ctClass(ctype);

  const candidates = (byBlock.get(block) ?? []).filter((p) => !p.parameterName);
  // suffix after first underscore (block-family prefix strip)
  const us = pname.indexOf('_');
  const suffix = us === -1 ? pname : pname.slice(us + 1);

  let verdict: Verdict | undefined;

  // Strongest: ANY of the XML labels matches a candidate's wikiName/name
  // (normalized) AND controlType class agrees. Uses every label seen
  // across page contexts (the dual "Level 1"/"Level L" case).
  for (const c of candidates) {
    const wikiN = norm(c.wikiName);
    const nameN = norm(c.name);
    const suffixN = norm(suffix);
    const cClass = regClass(c.controlType);
    const classOk = xClass === 'other' || cClass === 'other' || xClass === cClass;
    let matchedLabel: string | undefined;
    for (const L of allLabels) {
      const Ln = norm(L);
      if (Ln && (Ln === wikiN || Ln === nameN)) { matchedLabel = L; break; }
    }
    if (matchedLabel && classOk) {
      verdict = { kind: 'annotation', conf: 'high', regKey: c.key, regCtype: c.controlType,
        reason: `label "${matchedLabel}" == "${c.wikiName}"/"${c.name}"; ctype ${ctype}~${c.controlType}` };
      break;
    }
    // suffix == name|wiki exact, class agrees → high
    if ((suffixN === wikiN || suffixN === nameN) && classOk) {
      verdict = { kind: 'annotation', conf: 'high', regKey: c.key, regCtype: c.controlType,
        reason: `suffix "${suffix}" == ${suffixN === wikiN ? 'wikiName' : 'name'} "${c.wikiName}"; ctype ${ctype}~${c.controlType}` };
      break;
    }
  }
  // Medium: suffix lev<=1 vs name/wiki AND class agrees AND label loosely supports.
  if (!verdict) {
    for (const c of candidates) {
      const wikiN = norm(c.wikiName);
      const nameN = norm(c.name);
      const suffixN = norm(suffix);
      const labelN = norm(label);
      const cClass = regClass(c.controlType);
      const classOk = xClass === 'other' || cClass === 'other' || xClass === cClass;
      if (!classOk) continue;
      const close = lev(suffixN, wikiN) <= 1 || lev(suffixN, nameN) <= 1;
      const labelClose = labelN && (lev(labelN, wikiN) <= 1 || lev(labelN, nameN) <= 1 || labelN === wikiN || labelN === nameN);
      if (close && (labelClose || !labelN)) {
        verdict = { kind: 'annotation', conf: 'med', regKey: c.key, regCtype: c.controlType,
          reason: `suffix~name "${suffix}"~"${c.name}" lev<=1; label "${label}"; ctype ${ctype}~${c.controlType}` };
        break;
      }
    }
  }
  // Token-bag semantic pass: expand abbreviations + ignore word order.
  // Score by Jaccard of canonical token bags built from (label + suffix)
  // vs candidate (wikiName + name). Require controlType-class agreement.
  if (!verdict) {
    const xBag = tokenBag(`${label} ${suffix}`);
    let bestScore = 0;
    let bestC: P | undefined;
    for (const c of candidates) {
      const cClass = regClass(c.controlType);
      const classOk = xClass === 'other' || cClass === 'other' || xClass === cClass;
      if (!classOk) continue;
      const cBag = tokenBag(`${c.wikiName} ${c.name}`);
      const sc = jaccard(xBag, cBag);
      if (sc > bestScore) { bestScore = sc; bestC = c; }
    }
    // Threshold: full token-set match (1.0) is high; >=0.5 is med.
    if (bestC && bestScore >= 0.99) {
      verdict = { kind: 'annotation', conf: 'high', regKey: bestC.key, regCtype: bestC.controlType,
        reason: `token-set match jaccard=1.0: "${label}|${suffix}" ~ "${bestC.wikiName}"; ctype ${ctype}~${bestC.controlType}` };
    } else if (bestC && bestScore >= 0.5) {
      verdict = { kind: 'annotation', conf: 'med', regKey: bestC.key, regCtype: bestC.controlType,
        reason: `token-set jaccard=${bestScore.toFixed(2)}: "${label}|${suffix}" ~ "${bestC.wikiName}"; ctype ${ctype}~${bestC.controlType}` };
    }
  }
  if (!verdict) {
    verdict = { kind: 'true-missing', reason: label ? `label "${label}" (${ctype}) — no unannotated same-block reg match` : `no UI label (${ctype || 'no ctrl'}) — likely UI-only/decl-only` };
  }
  results.push({ block, pname, label, ctype, verdict });
}

// ── Report ──
const ann = results.filter((r) => r.verdict.kind === 'annotation');
const annHigh = ann.filter((r) => (r.verdict as any).conf === 'high');
const annMed = ann.filter((r) => (r.verdict as any).conf === 'med');
const miss = results.filter((r) => r.verdict.kind === 'true-missing');

console.log(`TOTAL unmatched reproduced: ${results.length}`);
console.log(`ANNOTATION-GAP: ${ann.length} (high=${annHigh.length}, med=${annMed.length})`);
console.log(`TRUE-MISSING:   ${miss.length}`);
console.log('');
console.log('=== ANNOTATION-GAP (regKey  <-  parameterName) ===');
for (const r of [...ann].sort((a, b) => a.block.localeCompare(b.block) || a.pname.localeCompare(b.pname))) {
  const v = r.verdict as any;
  console.log(`[${v.conf}] ${v.regKey}  <-  parameterName: "${r.pname}"  | ${r.verdict.reason}`);
}
console.log('');
console.log('=== TRUE-MISSING (block, parameterName, label, ctype) ===');
for (const r of [...miss].sort((a, b) => a.block.localeCompare(b.block) || a.pname.localeCompare(b.pname))) {
  console.log(`${r.block} | ${r.pname} | "${r.label}" | ${r.ctype || '(no ctrl)'}`);
}

// Sanity: verify no proposed parameterName collides with an already-claimed one in same block.
console.log('');
console.log('=== COLLISION CHECK (proposed parameterName already claimed in block) ===');
let collisions = 0;
for (const r of ann) {
  const v = r.verdict as any;
  if (claimedParamNames.has(`${r.block}|${r.pname}`)) {
    console.log(`COLLISION: ${r.block}|${r.pname} already claimed`);
    collisions++;
  }
}
console.log(`collisions: ${collisions}`);

// Sanity: detect when TWO different XML parameterNames are proposed for
// the SAME registry key (would mis-gate — at most one can be correct).
console.log('');
console.log('=== DUPLICATE-TARGET CHECK (>1 parameterName -> same regKey) ===');
const byRegKey = new Map<string, { pname: string; conf: string }[]>();
for (const r of ann) {
  const v = r.verdict as any;
  const arr = byRegKey.get(v.regKey) ?? [];
  arr.push({ pname: r.pname, conf: v.conf });
  byRegKey.set(v.regKey, arr);
}
let dups = 0;
for (const [regKey, list] of byRegKey) {
  if (list.length > 1) {
    dups++;
    console.log(`DUP: ${regKey}  <-  ${list.map((x) => `${x.pname}[${x.conf}]`).join(' , ')}`);
  }
}
console.log(`duplicate-target groups: ${dups}`);
