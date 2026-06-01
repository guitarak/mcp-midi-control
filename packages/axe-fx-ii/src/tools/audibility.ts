/**
 * Audibility walker for the Axe-Fx II 4×12 routing grid. Pure function
 * over a parsed grid + optional bypass state. Surfaces routing breaks
 * (missing shunts, dead legs, signal that never reaches the output
 * column) and, when bypass state is provided, blocks bypassed in a
 * MUTE mode that sit on every input-to-output path.
 *
 * v1 scope (locked 2026-05-22 after wiki research):
 *   - Missing shunt mid-chain: cell past col 1 with routing_flags=0
 *   - Dead leg: cell points to an empty / non-existent source
 *   - No-path-to-output: rightmost-placed column has no input-reachable cell
 *   - Bypassed-MUTE-on-only-path: block bypassed with bypass_mode in
 *     {MUTE, MUTE OUT, MUTE IN} AND every audible input-to-output path
 *     traverses it
 *   - Output block bypassed: its bypass_mode is hardware-forced to MUTE
 *     even though the param dump shows THRU/MUTE options
 *   - FX Loop engaged on active path: soft note only (cable detection
 *     is hardware-only; engaged FXL with empty Return jack falls back
 *     to dry pass-through, so no silence flag is justified)
 *
 * Explicitly OUT of scope:
 *   - Bypassed-amp-leg as a tone judgement. THRU-bypass = audible dry
 *     signal; MUTE-bypass already handled above; intent (auditioning
 *     dry, external amp on FX Loop return) cannot be inferred.
 *   - Mixer block with every input row at -∞ — real failure mode but
 *     deferred; chasing per-param silence causes is a slippery slope
 *     and this case is rare in practice.
 *   - External send/return rig state — not MIDI-readable.
 *   - Global I/O menu mute — not a preset-stored param.
 */
import { BLOCK_BY_ID } from 'fractal-midi/axe-fx-ii';
import type { GridCell } from 'fractal-midi/axe-fx-ii';

const GRID_COLS = 12;
const FX_LOOP_BLOCK_ID = 136;
const OUTPUT_BLOCK_ID = 140;
/**
 * Hardware-fixed device output column on the Axe-Fx II XL+ (4×12 grid).
 * The DEVICE OUTPUT pulls from col 12; placing blocks elsewhere and
 * leaving cols past the chain empty leaves the chain DISCONNECTED from
 * the actual hardware output even though every placed cell is reachable
 * from the device input. Confirmed empirically from a real-world failure
 * trace 2026-05-23: grid was [comp, amp, mixer, cab, delay, reverb] at
 * cols 1-6; pre-fix `chain_integrity` returned ok:true because col 6
 * (reverb) was input-reachable; scene 1 was silent in practice because
 * cols 7-12 had no shunts and the device output sink at col 12 received
 * no signal.
 */
const DEVICE_OUTPUT_COL = 12;

/** Bypass-mode display labels that kill signal entirely. */
const MUTING_BYPASS_MODES = new Set(['MUTE', 'MUTE OUT', 'MUTE IN']);

/** A break carries enough context for the agent to surface the offending cell to the user. */
export interface AudibilityBreak {
  slot_ref: { row: number; col: number };
  reason: string;
}

export interface AudibilityNote {
  slot_ref: { row: number; col: number };
  note: string;
}

export interface AudibilityReport {
  ok: boolean;
  breaks: readonly AudibilityBreak[];
  notes: readonly AudibilityNote[];
  summary: string;
}

export interface AudibilityInput {
  cells: readonly GridCell[];
  /** True when the block is currently bypassed. Keyed by `effectId` (the cell's `blockId`). */
  bypassByBlockId?: ReadonlyMap<number, boolean>;
  /** Display label of the block's `bypass_mode` param (e.g. "THRU", "MUTE", "MUTE OUT"). Keyed by `effectId`. */
  bypassModeByBlockId?: ReadonlyMap<number, string>;
}

function isPlaced(cell: GridCell | undefined): cell is GridCell {
  return cell !== undefined && cell.blockId !== 0;
}

function isShunt(blockId: number): boolean {
  return blockId >= 200 && blockId <= 235;
}

function describeCell(cell: GridCell): string {
  if (isShunt(cell.blockId)) return `shunt at row ${cell.row} col ${cell.col}`;
  const block = BLOCK_BY_ID[cell.blockId];
  return `${block?.name ?? `block ${cell.blockId}`} at row ${cell.row} col ${cell.col}`;
}

interface Graph {
  /** Lookup by `${row}:${col}` → GridCell (placed cells only). */
  byPos: Map<string, GridCell>;
  /** For each placed cell, the placed cells in col-1 that feed its input per routing_flags. */
  predecessors: Map<string, GridCell[]>;
  /** Reverse of predecessors. */
  successors: Map<string, GridCell[]>;
}

function posKey(row: number, col: number): string {
  return `${row}:${col}`;
}

function buildGraph(cells: readonly GridCell[]): Graph {
  const byPos = new Map<string, GridCell>();
  for (const cell of cells) {
    if (!isPlaced(cell)) continue;
    byPos.set(posKey(cell.row, cell.col), cell);
  }
  const predecessors = new Map<string, GridCell[]>();
  const successors = new Map<string, GridCell[]>();
  for (const cell of byPos.values()) {
    if (cell.col === 1) continue;
    for (let bit = 0; bit < 4; bit++) {
      if ((cell.routingFlags & (1 << bit)) === 0) continue;
      const sourceRow = bit + 1;
      const source = byPos.get(posKey(sourceRow, cell.col - 1));
      if (source === undefined) continue;
      const key = posKey(cell.row, cell.col);
      const sourceKeyInverse = posKey(source.row, source.col);
      const preds = predecessors.get(key) ?? [];
      preds.push(source);
      predecessors.set(key, preds);
      const succs = successors.get(sourceKeyInverse) ?? [];
      succs.push(cell);
      successors.set(sourceKeyInverse, succs);
    }
  }
  return { byPos, predecessors, successors };
}

/** Cells reachable forward from any non-empty col-1 cell. */
function computeInputReachable(graph: Graph, excludeKey?: string): Set<string> {
  const reachable = new Set<string>();
  const queue: GridCell[] = [];
  for (const cell of graph.byPos.values()) {
    if (cell.col !== 1) continue;
    const key = posKey(cell.row, cell.col);
    if (key === excludeKey) continue;
    reachable.add(key);
    queue.push(cell);
  }
  while (queue.length > 0) {
    const cell = queue.shift()!;
    const succs = graph.successors.get(posKey(cell.row, cell.col)) ?? [];
    for (const succ of succs) {
      const succKey = posKey(succ.row, succ.col);
      if (succKey === excludeKey) continue;
      if (reachable.has(succKey)) continue;
      reachable.add(succKey);
      queue.push(succ);
    }
  }
  return reachable;
}

function rightmostPlacedCol(graph: Graph): number {
  let max = 0;
  for (const cell of graph.byPos.values()) {
    if (cell.col > max) max = cell.col;
  }
  return max;
}

/**
 * True when removing `cell` from the graph causes the rightmost
 * placed column to lose every input-reachable member. In a single
 * serial chain every cell is a cut vertex; in parallel paths the
 * answer is per-cell.
 */
function isCutVertex(graph: Graph, cell: GridCell, lastCol: number): boolean {
  const excludeKey = posKey(cell.row, cell.col);
  const reachable = computeInputReachable(graph, excludeKey);
  for (const c of graph.byPos.values()) {
    if (c.col !== lastCol) continue;
    if (posKey(c.row, c.col) === excludeKey) continue;
    if (reachable.has(posKey(c.row, c.col))) return false;
  }
  return true;
}

/** Pure check, no I/O. Caller assembles wire reads and passes the parsed data. */
export function checkAudibility(input: AudibilityInput): AudibilityReport {
  const { cells, bypassByBlockId, bypassModeByBlockId } = input;
  const graph = buildGraph(cells);
  const breaks: AudibilityBreak[] = [];
  const notes: AudibilityNote[] = [];

  if (graph.byPos.size === 0) {
    return {
      ok: true,
      breaks: [],
      notes: [],
      summary: 'Grid is empty: no placed blocks or shunts. Signal passes through but the preset is acoustically a wire.',
    };
  }

  // Detection 1: routing breaks. Every placed cell past col 1 needs
  // routing_flags pointing to a non-empty source in col-1.
  for (const cell of graph.byPos.values()) {
    if (cell.col === 1) continue;
    const preds = graph.predecessors.get(posKey(cell.row, cell.col)) ?? [];
    if (preds.length === 0) {
      if (cell.routingFlags === 0) {
        breaks.push({
          slot_ref: { row: cell.row, col: cell.col },
          reason: `${describeCell(cell)} has routing_mask=0: no input cable. Signal cannot enter this cell. Likely a missing shunt or a deliberate disconnect that left the chain broken.`,
        });
      } else {
        breaks.push({
          slot_ref: { row: cell.row, col: cell.col },
          reason: `${describeCell(cell)} has routing_mask=0x${cell.routingFlags.toString(16)} but every source row it points to in col ${cell.col - 1} is empty. Dead leg: signal cannot reach this cell.`,
        });
      }
    }
  }

  // Detection 2: no input-to-output path. The DEVICE OUTPUT is at
  // col 12 (hardware-fixed sink, not a placed block). The chain is
  // audible when EITHER:
  //   (a) col 12 has at least one input-reachable cell — the chain
  //       extended (via shunts or audio blocks) all the way to the
  //       hardware output column, OR
  //   (b) a placed OUTPUT block (id 140) is input-reachable — the
  //       II treats the placed Output block as a chain terminator
  //       that internally cables to the hardware output sink.
  //
  // A chain that ends at col 6 with empty cells at cols 7-12 and NO
  // placed Output block leaves the grid output unfed even though
  // every placed cell is internally reachable. This is the real-world
  // failure mode that pre-fix chain_integrity missed.
  const inputReachable = computeInputReachable(graph);
  const lastPlacedCol = rightmostPlacedCol(graph);
  const reachableAtOutputCol = [...graph.byPos.values()].filter(
    (c) => c.col === DEVICE_OUTPUT_COL && inputReachable.has(posKey(c.row, c.col)),
  );
  const reachableOutputBlocks = [...graph.byPos.values()].filter(
    (c) => c.blockId === OUTPUT_BLOCK_ID && inputReachable.has(posKey(c.row, c.col)),
  );
  // Anchor for cut-vertex / bypass-mute analysis below: if a placed
  // Output block is reachable, use its col as the "sink column" so
  // the cut-vertex check correctly asks "does muting this disconnect
  // the chain from the Output block." Otherwise use DEVICE_OUTPUT_COL.
  const sinkCol = reachableOutputBlocks.length > 0
    ? reachableOutputBlocks[0].col
    : DEVICE_OUTPUT_COL;
  const reachableAtSink = reachableOutputBlocks.length > 0
    ? reachableOutputBlocks
    : reachableAtOutputCol;
  if (reachableAtSink.length === 0) {
    // Only surface this as a top-level break when the routing-break
    // detection didn't already explain it. A chain that breaks at
    // col 5 will trigger both detections; the per-cell break is more
    // actionable, so we don't double-up.
    if (breaks.length === 0) {
      const gapSize = DEVICE_OUTPUT_COL - lastPlacedCol;
      if (lastPlacedCol < DEVICE_OUTPUT_COL && lastPlacedCol > 0) {
        breaks.push({
          slot_ref: { row: 1, col: DEVICE_OUTPUT_COL },
          reason: `Chain ends at col ${lastPlacedCol}; the device output is at col ${DEVICE_OUTPUT_COL}. ${gapSize} empty cell(s) separate the last placed block from the output sink, so no signal reaches the hardware output. Extend the chain with shunts (or audio blocks) through col ${DEVICE_OUTPUT_COL}, OR add explicit routing edges that span cols ${lastPlacedCol + 1}..${DEVICE_OUTPUT_COL}, OR place an Output block (id 140) at the chain's end as the terminator.`,
        });
      } else {
        breaks.push({
          slot_ref: { row: 1, col: DEVICE_OUTPUT_COL },
          reason: `No input-reachable cell in col ${DEVICE_OUTPUT_COL} (the device output column) and no placed Output block reachable. The chain has placed blocks but the routing-mask graph leaves the output sink unfed. Check for routing-mask gaps.`,
        });
      }
    }
  }

  // Detection 3: bypassed-MUTE blocks on every audible path. Requires
  // bypass state + bypass_mode lookups. Without them, this pass is a
  // no-op and the verifyChain path falls back to routing breaks only.
  // Cut-vertex check is anchored at `sinkCol` — either the placed
  // Output block's column or DEVICE_OUTPUT_COL — so "does muting this
  // cell disconnect the chain from the sink" is asked correctly.
  if (bypassByBlockId !== undefined && bypassModeByBlockId !== undefined && reachableAtSink.length > 0) {
    for (const cell of graph.byPos.values()) {
      if (isShunt(cell.blockId)) continue;
      const key = posKey(cell.row, cell.col);
      if (!inputReachable.has(key)) continue;
      const isBypassed = bypassByBlockId.get(cell.blockId) === true;
      if (!isBypassed) continue;

      // Output block: bypass mode is hardware-forced to MUTE regardless
      // of what the bypass_mode param shows. Special-case it so we
      // don't depend on the param dump faithfully reflecting the
      // forced setting.
      if (cell.blockId === OUTPUT_BLOCK_ID) {
        if (isCutVertex(graph, cell, sinkCol)) {
          breaks.push({
            slot_ref: { row: cell.row, col: cell.col },
            reason: `Output block at row ${cell.row} col ${cell.col} is bypassed. The Output block's bypass mode is hardware-forced to MUTE, so signal will not reach this output. Engage the block (clear bypass) or route around it.`,
          });
        }
        continue;
      }

      const mode = bypassModeByBlockId.get(cell.blockId);
      if (mode === undefined) continue;
      if (!MUTING_BYPASS_MODES.has(mode)) continue;
      if (!isCutVertex(graph, cell, sinkCol)) continue;
      breaks.push({
        slot_ref: { row: cell.row, col: cell.col },
        reason: `${describeCell(cell)} is bypassed with bypass_mode="${mode}", which kills signal. Every audible path goes through this cell, so the preset is silent. Either engage the block, change bypass_mode to "THRU", or add a parallel route.`,
      });
    }
  }

  // Notes: FX Loop engaged on an input-reachable path. Hardware
  // sense-on-Return means an engaged FXL with nothing plugged in
  // auto-falls back to dry pass-through, so this is informational,
  // not a silence flag.
  for (const cell of graph.byPos.values()) {
    if (cell.blockId !== FX_LOOP_BLOCK_ID) continue;
    if (!inputReachable.has(posKey(cell.row, cell.col))) continue;
    const isBypassed = bypassByBlockId?.get(cell.blockId) === true;
    if (isBypassed) continue;
    notes.push({
      slot_ref: { row: cell.row, col: cell.col },
      note: `FX Loop block at row ${cell.row} col ${cell.col} is engaged and sits on the active signal path. Audibility also depends on whatever's wired into the device's physical Send/Return jacks; nothing in the Return jack falls back to dry pass-through (hardware sense), but a powered-down external rig will go silent.`,
    });
  }

  const ok = breaks.length === 0;
  let summary: string;
  if (ok && notes.length === 0) {
    summary = `Audibility check: input-to-output path is intact across ${graph.byPos.size} placed cell${graph.byPos.size === 1 ? '' : 's'}.`;
  } else if (ok) {
    summary = `Audibility check: path intact, ${notes.length} informational note${notes.length === 1 ? '' : 's'} (see notes[]).`;
  } else {
    const first = breaks[0];
    summary = `Audibility check: ${breaks.length} issue${breaks.length === 1 ? '' : 's'} found; first is at row ${first.slot_ref.row} col ${first.slot_ref.col}.`;
  }

  return { ok, breaks, notes, summary };
}

/** Re-export for tests. */
export const __testing = {
  MUTING_BYPASS_MODES,
  FX_LOOP_BLOCK_ID,
  OUTPUT_BLOCK_ID,
  GRID_COLS,
};
