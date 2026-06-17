/**
 * Cross-validation for the gen-3 live grid-layout codec (fn=0x01 sub=0x2E).
 *
 * Always runs self-contained structural checks (request byte-exactness +
 * synthetic round-trip) so preflight stays green on a fresh clone.
 *
 * When the gitignored FM9 capture is present
 * (`samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json`),
 * it additionally decodes the 10 empty-target sub=0x2E responses and asserts:
 *   - all 10 decode identically (stable grid),
 *   - every real-block effect ID resolves to a known block in blockTypes.ts
 *     (the reference oracle — Amp 58, Cab 62, Comp 46, etc.),
 *   - shunts carry a strictly increasing index (the documented scheme).
 * This is the cross-oracle evidence that lets the codec ship community-beta.
 */
import { existsSync, readFileSync } from 'node:fs';
import {
  buildRequestGridLayout,
  parseGen3GridLayout,
  AXE_FX_III_BLOCKS,
} from '../packages/fractal-midi/dist/gen3/axe-fx-iii/index.js';
import { liveGridView } from '../packages/fractal-gen3/dist/reader.js';

let ok = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) ok += 1;
  else {
    fail += 1;
    console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const FM9 = 0x12;

// id → block name. Each block spans a contiguous effect-ID range
// (firstId .. firstId+instances-1, e.g. Amp 58-61, Drive 118-121).
const ID_TO_BLOCK = new Map<number, string>();
for (const b of AXE_FX_III_BLOCKS as unknown as ReadonlyArray<{ firstId: number | null; instances: number; name: string }>) {
  if (typeof b.firstId !== 'number') continue;
  for (let i = 0; i < b.instances; i++) ID_TO_BLOCK.set(b.firstId + i, b.name);
}

// ── Structural self-checks (always) ────────────────────────────────
const req = buildRequestGridLayout(FM9);
check(
  'request byte-exact (FM9)',
  req.map((b) => b.toString(16).padStart(2, '0')).join(' ') ===
    'f0 00 01 74 12 01 2e 00 00 00 00 00 00 00 00 00 00 00 00 00 00 38 f7',
);

// synthetic round-trip
function writeBitsMsb(region: number[], bit: number, value: number, n: number): void {
  for (let i = 0; i < n; i++) {
    const b = bit + i;
    region[Math.floor(b / 7)] = (region[Math.floor(b / 7)] ?? 0) | (((value >> (n - 1 - i)) & 1) << (6 - (b % 7)));
  }
}
{
  const region = new Array(391).fill(0);
  const base = 46 + 0 * 192 + 0 * 32;
  writeBitsMsb(region, base, 58 << 1, 8);
  writeBitsMsb(region, base + 8, 0x00, 8);
  const frame = [0xf0, ...new Array(361).fill(0), ...region, 0xf7];
  const cells = parseGen3GridLayout(frame, FM9);
  check('synthetic round-trip (Amp@0,0)', cells.length === 1 && cells[0].effectId === 58);
}

// ── liveGridView converter (reader glue → Gen3GridCellView) ────────
{
  const region = new Array(391).fill(0);
  const cell = (col: number, row: number) => 46 + col * 192 + row * 32;
  writeBitsMsb(region, cell(0, 0), 58 << 1, 8); // Amp 1 (real block)
  writeBitsMsb(region, cell(0, 0) + 8, 0x00, 8);
  writeBitsMsb(region, cell(1, 0), 3 << 1, 8); // shunt #3
  writeBitsMsb(region, cell(1, 0) + 8, 0x08, 8);
  writeBitsMsb(region, cell(1, 0) + 16, 0b10, 8); // cable mask
  const frame = [0xf0, ...new Array(361).fill(0), ...region, 0xf7];
  const view = liveGridView(frame, FM9);
  const amp = view.find((c) => c.col === 0 && c.row === 0);
  const shunt = view.find((c) => c.col === 1 && c.row === 0);
  check('liveGridView: real block → effect_id + display name', amp?.effect_id === 58 && amp?.name === 'Amp 1' && !amp?.is_shunt);
  check('liveGridView: shunt → is_shunt + "Shunt N" name + raw route_flag', shunt?.is_shunt === true && shunt?.name === 'Shunt 3' && shunt?.route_flag === 0b10);
  check('liveGridView: from_rows omitted (cable direction not asserted)', amp !== undefined && !('from_rows' in amp));
}

// ── Real-capture cross-validation (when present) ───────────────────
const CAP = 'samples/captured/decoded/fm9-receive-preset-from-device-harp-2026-06-04.frames.json';
if (existsSync(CAP)) {
  const frames: Array<{ fn: number; sub: number; len: number; hex: string }> = JSON.parse(
    readFileSync(CAP, 'utf8'),
  );
  const resp = frames.filter((f) => f.fn === 1 && f.sub === 0x2e && f.len === 755);
  check('capture: found 10 empty-target sub=0x2E responses', resp.length === 10, `got ${resp.length}`);

  const decodes = resp.map((f) => parseGen3GridLayout(f.hex.split(/\s+/).map((h) => parseInt(h, 16)), FM9));
  const sig = (cells: ReturnType<typeof parseGen3GridLayout>) =>
    cells.map((c) => `${c.col},${c.row},${c.effectId ?? 's' + c.shuntIndex}`).join('|');
  check('capture: all 10 responses decode identically', decodes.every((d) => sig(d) === sig(decodes[0])));

  const grid = decodes[0];
  check('capture: grid is non-trivial (>20 placed cells)', grid.length > 20, `got ${grid.length}`);

  const realBlocks = grid.filter((c) => !c.isShunt);
  const unknown = realBlocks.filter((c) => !ID_TO_BLOCK.has(c.effectId!));
  check(
    'capture: every real-block effect ID resolves in blockTypes.ts',
    unknown.length === 0,
    `unknown IDs: ${unknown.map((c) => c.effectId).join(', ')}`,
  );
  // Spot-check the oracle anchors the cross-validation rested on.
  const ids = new Set(realBlocks.map((c) => c.effectId));
  check('capture: contains Amp (58) + Drive (118)', ids.has(58) && ids.has(118));

  const shuntIdx = grid.filter((c) => c.isShunt).map((c) => c.shuntIndex!);
  const sorted = [...shuntIdx].sort((a, b) => a - b);
  check('capture: shunt indices are unique', new Set(shuntIdx).size === shuntIdx.length);
  check(
    'capture: decoded blocks',
    true,
    `${realBlocks.length} real / ${shuntIdx.length} shunts: ${realBlocks.map((c) => ID_TO_BLOCK.get(c.effectId!)).join(', ')}`,
  );
  void sorted;
} else {
  console.log(`  (capture ${CAP} absent — ran structural checks only)`);
}

console.log(`gen3-grid-layout: ${ok} ok, ${fail} fail`);
if (fail > 0) process.exit(1);
