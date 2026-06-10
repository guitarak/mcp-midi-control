/**
 * mine-iii-inbound-dispatcher.ts
 *
 * Mechanically extract two structured tables from the AxeEdit III inbound
 * dispatcher decompile dump:
 *
 *   1. The WORKFLOW REGISTRY (FUN_1401f0f10): each registered editor workflow
 *      with its name, request/response workflow-id pair, and the ordered list
 *      of executor step-ids (the second arg to FUN_1401bac70). Step-ids index
 *      the executor switch in FUN_1401f4390.
 *
 *   2. The inbound RESPONSE-FRAME FAMILIES from the request/response matcher
 *      FUN_14032b210: each `case` group of inbound fn-bytes, the request opcode
 *      it correlates to (cVar7 compare), and the length-decoder helper used to
 *      compute the expected frame count.
 *
 * Read-only. Cites source line numbers. Writes JSON to
 * samples/captured/decoded/iii-inbound-fn-table.json.
 *
 * Run: npx tsx scripts/_research/mine-iii-inbound-dispatcher.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DUMP = resolve(
  'packages/fractal-midi/samples/captured/decoded/ghidra-axe-edit-iii-inbound-dispatcher.txt',
);
const OUT = resolve('samples/captured/decoded/iii-inbound-fn-table.json');

const text = readFileSync(DUMP, 'utf8');
const lines = text.split(/\r?\n/);

// ---------------------------------------------------------------------------
// 1. Workflow registry: FUN_1401f0f10 body (between "--- #1" and "--- #2").
//    Pattern per workflow block:
//      *(undefined4 *)(param_1 + 0xREQOFF) = REQID;   (sometimes omitted)
//      *(undefined4 *)(param_1 + 0xRESPOFF) = RESPID;
//      FUN_1401bac70(<table>, STEP, 1);   x N
//      FUN_14005faa0(&local_xx, "NAME");
//    We accumulate the FUN_1401bac70 step-ids since the previous name, plus the
//    nearest preceding two int32 assignments as (reqId, respId), and bind them
//    to the NAME on the FUN_14005faa0 line.
// ---------------------------------------------------------------------------
interface Workflow {
  name: string;
  reqId: number | null;
  respId: number | null;
  steps: number[];
  nameLine: number;
}

const startRegistry = lines.findIndex((l) => l.includes('--- #1:'));
const endRegistry = lines.findIndex(
  (l, i) => i > startRegistry && l.includes('--- #2:'),
);

const workflows: Workflow[] = [];
let pendingSteps: number[] = [];
let recentInts: { off: number; val: number; line: number }[] = [];

const reInt = /\*\(undefined4 \*\)\(param_1 \+ (0x[0-9a-f]+)\) = (0x[0-9a-f]+|\d+);/;
const reStep = /FUN_1401bac70\([^,]+,\s*(0x[0-9a-f]+|\d+)\s*(?:,\s*1)?\)/;
const reName = /FUN_14005faa0\(&?[\w\[\]]+,"([^"]+)"\)/;

for (let i = startRegistry; i < endRegistry; i++) {
  const line = lines[i];
  const mInt = line.match(reInt);
  if (mInt) {
    recentInts.push({ off: parseInt(mInt[1], 16), val: parseInt(mInt[2]), line: i + 1 });
    if (recentInts.length > 4) recentInts.shift();
    continue;
  }
  const mStep = line.match(reStep);
  if (mStep) {
    pendingSteps.push(parseInt(mStep[1]));
    continue;
  }
  const mName = line.match(reName);
  if (mName) {
    // reqId/respId = the two consecutive int assignments whose offsets differ by 4.
    let reqId: number | null = null;
    let respId: number | null = null;
    for (let k = recentInts.length - 2; k >= 0; k--) {
      if (recentInts[k + 1].off - recentInts[k].off === 4) {
        reqId = recentInts[k].val;
        respId = recentInts[k + 1].val;
        break;
      }
    }
    if (respId === null && recentInts.length) {
      respId = recentInts[recentInts.length - 1].val;
    }
    workflows.push({
      name: mName[1],
      reqId,
      respId,
      steps: pendingSteps.slice(),
      nameLine: i + 1,
    });
    pendingSteps = [];
    recentInts = [];
  }
}

// ---------------------------------------------------------------------------
// 2. Response-frame families from the matcher FUN_14032b210 (--- #10).
//    Each `case 0xNN:` group, the cVar7 compare (request opcode), and the
//    length helper FUN_xxx invoked.
// ---------------------------------------------------------------------------
const startMatcher = lines.findIndex((l) => l.includes('--- #10:'));
interface Family {
  cases: string[];
  startLine: number;
  reqOpcodeCompare: string[];
  lengthHelper: string | null;
  note: string;
}
const families: Family[] = [];
let curCases: string[] = [];
let curStart = 0;
let curCompares: string[] = [];
let curHelper: string | null = null;

const reCase = /^\s*case (0x[0-9a-f]+|\d+):/;
const reCmp = /cVar7 == '(\\x[0-9a-f]+|.)'|cVar7 == ([A-Za-z@'])/;
const reHelper = /cVar7 = (FUN_[0-9a-f]+)\(param_3/;

function flushFamily() {
  if (curCases.length) {
    families.push({
      cases: curCases.slice(),
      startLine: curStart,
      reqOpcodeCompare: curCompares.slice(),
      lengthHelper: curHelper,
      note: '',
    });
  }
  curCases = [];
  curCompares = [];
  curHelper = null;
}

// The matcher switch begins around the "switch(uVar18)" line; iterate to EOF of #10.
let inSwitch = false;
for (let i = startMatcher; i < lines.length; i++) {
  const line = lines[i];
  if (line.includes('switch(uVar18)')) {
    inSwitch = true;
    continue;
  }
  if (!inSwitch) continue;
  if (line.includes('return bVar21;')) {
    flushFamily();
    break;
  }
  const mCase = line.match(reCase);
  if (mCase) {
    // A new case label that is NOT directly consecutive starts a new family.
    if (curCases.length && (curCompares.length || curHelper)) {
      flushFamily();
    }
    curCases.push(mCase[1]);
    if (curStart === 0 || curCases.length === 1) curStart = i + 1;
    continue;
  }
  const mCmp = line.match(/cVar7 == '(\\x[0-9a-f]+)'/g);
  if (mCmp) {
    for (const c of mCmp) {
      const hx = c.match(/\\x([0-9a-f]+)/);
      if (hx) curCompares.push('0x' + hx[1]);
    }
  }
  const mCmpChar = line.match(/cVar7 == '([A-Za-z@])'/g);
  if (mCmpChar) {
    for (const c of mCmpChar) {
      const ch = c.match(/cVar7 == '(.)'/);
      if (ch) curCompares.push('0x' + ch[1].charCodeAt(0).toString(16));
    }
  }
  if (/bVar21 = cVar7 == '\\x([0-9a-f]+)'/.test(line)) {
    const hx = line.match(/bVar21 = cVar7 == '\\x([0-9a-f]+)'/);
    if (hx) curCompares.push('0x' + hx[1]);
  }
  const mHelper = line.match(reHelper);
  if (mHelper) curHelper = mHelper[1];
  if (curCases.length && curStart === 0) curStart = i + 1;
}

const result = {
  source: 'ghidra-axe-edit-iii-inbound-dispatcher.txt',
  generatedBy: 'scripts/_research/mine-iii-inbound-dispatcher.ts',
  note:
    'Mechanical extraction. Workflow registry = FUN_1401f0f10. Response families = matcher FUN_14032b210. Step-ids index executor FUN_1401f4390 switch.',
  workflowCount: workflows.length,
  workflows,
  responseFamilies: families,
};

writeFileSync(OUT, JSON.stringify(result, null, 2));
console.log(`Wrote ${OUT}`);
console.log(`Workflows: ${workflows.length}`);
for (const w of workflows) {
  console.log(
    `  "${w.name}" req=${w.reqId} resp=${w.respId} steps=[${w.steps.map((s) => '0x' + s.toString(16)).join(',')}]  (L${w.nameLine})`,
  );
}
console.log(`\nResponse families: ${families.length}`);
for (const f of families) {
  console.log(
    `  cases [${f.cases.join(',')}]  reqOpcode=[${f.reqOpcodeCompare.join(',')}]  len=${f.lengthHelper ?? '-'}  (L${f.startLine})`,
  );
}
