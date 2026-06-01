/**
 * BK-067: cross-device tone porting.
 *
 * `translatePresetSpec` takes a preset built for device A and returns
 * an equivalent preset spec for device B, handling differences in
 * chain topology, block availability, parameter naming, enum value
 * strings, and scene/channel cardinality. The smallest-useful-ship is
 * static presets (no modifier wiring); modifier translation is gated
 * on BK-063 and surfaces as `modifier_wirings_deferred` entries today.
 *
 * Pure function. No MIDI I/O, no descriptor mutation, no global state.
 * Inputs are read-only; the returned spec is fresh objects throughout.
 *
 * Translation passes:
 *
 *   1. **Slot topology.** AM4's 4 linear slots ↔ II's 4×12 grid ↔
 *      III's 4×14 grid. Linear→grid places blocks on row 2 (the
 *      conventional main signal row), col=source slot index. Grid→
 *      linear pulls blocks in column order, drops any over slot_count.
 *
 *   2. **Block availability.** AM4 collapses cab into the amp block;
 *      II/III have a separate cab block. II→AM4 drops cab with a
 *      warning so the user knows to choose the amp's integrated cab.
 *      AM4→II surfaces a hint that the user may want to add a cab
 *      block; we don't auto-insert (the IR choice is opinionated).
 *
 *   3. **Param name aliases (BK-065).** `drive.volume` (II vocab) gets
 *      resolved to `drive.level` (AM4 vocab) via `resolveParamAlias`.
 *      Counted in `params_aliased`.
 *
 *   4. **Enum value mapping (BK-066 Phase 2).** `"USA IIC+"` (II) gets
 *      resolved to `"USA MK IIC+"` (AM4) via `resolveEnumAlias`.
 *      Counted in `enums_mapped`. Unmapped enum strings (Phase 1 fuzzy
 *      tier or none) pass through unchanged with a warning so the
 *      downstream preflight surfaces them on apply.
 *
 *   5. **Scene + channel cardinality.** AM4 has 4 scenes × 4 channels
 *      (A/B/C/D); II has 8 scenes × 2 channels (X/Y); III has 8 scenes
 *      × 4 channels (A/B/C/D). Scene overflow (II 8 -> AM4 4) keeps
 *      the first 4 scenes and surfaces a `scene_collapses` count.
 *      Channel overflow (AM4 D -> II X/Y) maps A->X, B->Y, drops C/D
 *      with a warning.
 *
 *   6. **Modifier deferral.** Any slot with modifier wiring (currently
 *      not modeled in the unified spec; placeholder) lands a
 *      `modifier_wirings_deferred` entry until BK-063 closes.
 *
 * The translator does NOT call the dispatcher or the apply executor.
 * It returns a ready-to-apply `PresetSpec` plus the summary; whoever
 * called `translatePresetSpec` decides whether to apply via
 * `executeApplyPreset` or return the spec for review (dry_run).
 */

import { resolveParamAlias } from './cross-device-aliases.js';
import { resolveEnumAlias } from './cross-device-enums.js';
import type {
  DeviceDescriptor,
  PresetSpec,
  PresetSlotSpec,
  SceneSpec,
} from './types.js';

/**
 * Translation summary. Mirrors the BACKLOG entry's `port_summary`
 * shape so the dispatcher can pass it through unchanged.
 */
export interface PortPresetSummary {
  /** Slot entries that survived translation. */
  blocks_translated: number;
  /** Slot entries dropped because target device lacks the block. */
  blocks_dropped: ReadonlyArray<{ block: string; reason: string }>;
  /** Param-name substitutions made via BK-065 alias table. */
  params_aliased: number;
  /** Enum-value substitutions made via BK-066 Phase 2 concept-key table. */
  enums_mapped: number;
  /** Recipes / wirings that need BK-063 modifier support; deferred for now. */
  modifier_wirings_deferred: ReadonlyArray<{ block: string; recipe_needed: string }>;
  /** Scenes / channels lost in cardinality collapse. */
  scene_collapses: number;
}

export interface TranslatePresetResult {
  ok: boolean;
  port_summary: PortPresetSummary;
  applied_spec: PresetSpec;
  warnings: ReadonlyArray<string>;
}

/**
 * Translate a source spec written against `sourceDescriptor` into an
 * equivalent spec for `targetDescriptor`. Pure: inputs are not mutated.
 *
 * The output spec is the input to `executeApplyPreset(targetPort, ...)`
 * — its slot refs, block names, param names, and enum values are all
 * in the target device's canonical vocabulary as far as the cross-
 * device tables know how to resolve them. The downstream preflight
 * pass on the target device will still validate and surface any
 * remaining gaps (e.g. a param that exists on the source but not on
 * the target).
 */
export function translatePresetSpec(
  sourceDescriptor: DeviceDescriptor,
  sourceSpec: PresetSpec,
  targetDescriptor: DeviceDescriptor,
): TranslatePresetResult {
  const warnings: string[] = [];
  const blocksDropped: { block: string; reason: string }[] = [];
  const modifierDeferred: { block: string; recipe_needed: string }[] = [];
  let paramsAliased = 0;
  let enumsMapped = 0;
  let sceneCollapses = 0;

  const sourceCap = sourceDescriptor.capabilities;
  const targetCap = targetDescriptor.capabilities;
  // Ids of blocks that got collapsed away during the optimization pass.
  // Populated AFTER pass 1 but consumed by a cleanup walk over the
  // already-built scene maps so dangling refs (e.g. "amp_2" after
  // collapse) don't outlive the slot they referenced.
  const collapsedAwayBlockIds = new Set<string>();
  // When two same-type instances on a grid source (amp + amp_2 on X/Y)
  // collapse into one channel-rich block on a linear target (amp on
  // A/B/C/D), each scene's references to BOTH source blocks need to be
  // merged into a single reference on the merged block. Without this
  // merge, scenes that used the second instance lose their amp routing
  // and play silent. Populated in the grid→linear pre-collapse pass and
  // consumed inside translateScenes before the basic channel remap.
  const sceneCollapseRemap = new Map<
    string,
    { mergedId: string; channelMap: Record<string, string> }
  >();

  // Symmetric counterpart for the linear→grid EXPAND direction. When a
  // 4-channel linear amp (A/B/C/D) is split into two grid instances
  // (amp_1 carries A/B, amp_2 carries C/D), each scene's reference to the
  // single source block must be rewritten to the correct instance with
  // the right channel AND the other instance bypassed. Without this,
  // scenes that selected C/D lose their amp routing entirely (and don't
  // bypass amp_1), so they play the wrong amp. Populated in the
  // linear→grid expansion pass, consumed inside translateScenes.
  const sceneExpandRemap = new Map<
    string,
    {
      firstId: string;
      secondId: string;
      // source channel (UPPER A/B/C/D) → which instance + source-space
      // channel it lands on (the basic channel remap converts A→X, B→Y).
      map: Record<string, { id: string; channel: string }>;
    }
  >();

  // ── Pass 1: slots ─────────────────────────────────────────────────
  // Two-tier priority system (alpha.13 desktop-test design discussion):
  //
  //   Tier 1 — KEEP-OR-DROP priority: which block_types survive when the
  //   target has fewer slots than the source carries. Lower number =
  //   higher priority = keep. The user's spec:
  //     amp = drive > cab > delay = reverb > compressor > modulation
  //   When forced to drop, drop the highest-numbered (lowest-priority)
  //   blocks first.
  //
  //   Tier 2 — CHAIN ORDER: when the translator must restructure slot
  //   positions (vs. just preserving source order), use the standard
  //   signal chain:
  //     compressor → drive → amp → cab → modulation → delay → reverb
  //   But CRITICAL: respect the source's explicit order when it's
  //   already authored — only restructure when forced (budget-drop fired
  //   and survivors are not in a sensible order). This branch preserves
  //   source order by default; the restructure-on-force pass below kicks
  //   in only when budget pressure ATE a block.
  //
  // Pre-alpha.14 behavior was a SINGLE-tier system: BLOCK_PRIORITY was
  // used both for drop decisions AND for slot allocation, so the slot
  // allocator placed blocks in priority order — putting compressor LAST
  // (slot 4 on a 4-slot AM4) regardless of where the source authored it.
  // Bug 8 in the alpha.13 report: a source with comp at col 1 → amp at
  // col 2 → delay → reverb landed as amp(1) → delay(2) → reverb(3) →
  // comp(4) on AM4, breaking the signal chain (compressor compressing
  // the reverb tail instead of the input).
  const BLOCK_PRIORITY: Record<string, number> = {
    // Tier 0: the irreducible signal source.
    amp: 0, drive: 0,
    // Tier 1: cab (AM4 integrates, II/III separate).
    cab: 1,
    // Tier 2: time-domain FX.
    delay: 2, reverb: 2,
    // Tier 3: dynamics.
    compressor: 3,
    // Tier 4: modulation.
    chorus: 4, flanger: 4, phaser: 4, wah: 4, filter: 4, pitch: 4,
    enhancer: 4,
    // Tier 5+: niche / utility.
    volpan: 5, tremolo: 5, rotary: 5, gate: 6,
    geq: 7, peq: 7,
  };
  // Standard signal-chain ordering used by the restructure-on-force pass.
  // Source order wins by default; this only fires when we had to drop.
  const CHAIN_ORDER: Record<string, number> = {
    compressor: 0, drive: 1, amp: 2, cab: 3,
    chorus: 4, flanger: 4, phaser: 4, wah: 4, filter: 4, pitch: 4,
    enhancer: 5, volpan: 5, tremolo: 5, rotary: 5, gate: 5,
    geq: 6, peq: 6,
    delay: 7, reverb: 8,
  };
  // Blocks whose drop the agent must explicitly acknowledge.
  // Lower-impact blocks (chorus / wah / filter / etc.) just show in
  // blocks_dropped without a top-level warning.
  const POPULAR_BLOCKS = new Set([
    'amp', 'drive', 'compressor', 'reverb', 'delay',
  ]);
  // Walk slots in SOURCE order. The keep-or-drop priority below identifies
  // which slots to drop when over budget; the slot allocator places
  // survivors in source order so the user's intentional layout (e.g.
  // compressor BEFORE amp) is preserved on the target.
  const sortedSlots = [...sourceSpec.slots];
  // Pre-compute budget drops. When the source carries more blocks than
  // the target can fit (after subtracting auto-drops for blocks not
  // exposed and auto-merges for channel-cardinality collapse), drop the
  // lowest-priority blocks first. The auto-drop / auto-merge accounting
  // here is approximate — the per-slot loop below does the precise
  // bookkeeping — but it's good enough to identify which blocks to mark
  // as budget-drops so they get skipped before reaching slot allocation.
  const budgetDroppedSlots = new Set<PresetSlotSpec>();
  {
    const targetBudget = targetCap.slot_count
      ?? ((targetCap.grid?.rows ?? 4) * (targetCap.grid?.cols ?? 12));
    // Count source slots that would auto-drop (block not exposed on target)
    // or auto-merge (second instance of a channel-bearing block in a
    // grid→linear 2→4 collapse). Approximation: counts the source slots
    // we expect to survive into the per-slot loop.
    let effectiveCount = 0;
    const seenChannelType = new Set<string>();
    const doingGridToLinearMerge =
      sourceCap.slot_model === 'grid' &&
      targetCap.slot_model === 'linear' &&
      (sourceCap.channel_names ?? []).length === 2 &&
      (targetCap.channel_names ?? []).length === 4;
    const channelBlocksForMerge = doingGridToLinearMerge
      ? new Set((sourceCap.channel_blocks ?? []).map((b: string) => b.toLowerCase()))
      : new Set<string>();
    for (const slot of sortedSlots) {
      const bt = slot.block_type.toLowerCase();
      // Auto-drop: block not exposed on target (e.g. cab → AM4).
      if (
        targetDescriptor.blocks[slot.block_type] === undefined &&
        targetDescriptor.blocks[bt] === undefined &&
        targetDescriptor.block_aliases?.[slot.block_type] === undefined &&
        targetDescriptor.block_aliases?.[bt] === undefined
      ) {
        continue;
      }
      // Auto-merge: second instance of a channel-bearing block on grid→linear 2→4.
      if (doingGridToLinearMerge && channelBlocksForMerge.has(bt)) {
        if (seenChannelType.has(bt)) continue;
        seenChannelType.add(bt);
      }
      effectiveCount++;
    }
    if (effectiveCount > targetBudget) {
      const overage = effectiveCount - targetBudget;
      // Rank survivor candidates by priority DESC (lowest priority first).
      // Stable sort by source slot index breaks ties so drop selection is
      // deterministic — given equal priority, drop the later source slot.
      const dropCandidates = sortedSlots
        .map((slot, idx) => ({ slot, idx, priority: BLOCK_PRIORITY[slot.block_type.toLowerCase()] ?? 99 }))
        .filter((entry) => {
          const bt = entry.slot.block_type.toLowerCase();
          // Exclude auto-drops from the budget-drop pool.
          if (
            targetDescriptor.blocks[entry.slot.block_type] === undefined &&
            targetDescriptor.blocks[bt] === undefined &&
            targetDescriptor.block_aliases?.[entry.slot.block_type] === undefined &&
            targetDescriptor.block_aliases?.[bt] === undefined
          ) return false;
          return true;
        })
        .sort((a, b) => {
          if (b.priority !== a.priority) return b.priority - a.priority;
          return b.idx - a.idx;
        });
      for (let i = 0; i < overage && i < dropCandidates.length; i++) {
        budgetDroppedSlots.add(dropCandidates[i].slot);
      }
    }
  }

  // ── Linear → Grid expansion (F6c reverse direction) ───────────────
  // When the source is a linear device with 4 channels (AM4) and the
  // target is a grid device with 2 channels (II), a single channel-
  // bearing slot with C/D channels populated would otherwise have
  // those channels dropped by translateParams's collapse step. To
  // preserve them, pre-split such slots into two instances: instance
  // 1 carries A/B (→ X/Y on target), instance 2 carries C/D (→ X/Y
  // on target). The second instance gets placed at the next-available
  // grid column. Symmetric counterpart to the grid→linear collapse
  // implemented below.
  const sourceChannelNamesPre = sourceCap.channel_names ?? [];
  const targetChannelNamesPre = targetCap.channel_names ?? [];
  const sourceChannelBlocks = new Set(
    (sourceCap.channel_blocks ?? []).map((b: string) => b.toLowerCase()),
  );
  if (
    sourceCap.slot_model === 'linear' &&
    targetCap.slot_model === 'grid' &&
    sourceChannelNamesPre.length === 4 &&
    targetChannelNamesPre.length === 2
  ) {
    const expanded: PresetSlotSpec[] = [];
    for (const slot of sortedSlots) {
      const bt = slot.block_type.toLowerCase();
      if (
        !sourceChannelBlocks.has(bt) ||
        slot.params_by_channel === undefined
      ) {
        expanded.push(slot);
        continue;
      }
      const chKeys = Object.keys(slot.params_by_channel).map((c) =>
        c.toUpperCase(),
      );
      // Only split when channels beyond A/B are actually populated; if
      // the source only authored A/B, the normal A→X, B→Y mapping is
      // already correct without splitting.
      const hasExtraChannels = chKeys.some((c) => c === 'C' || c === 'D');
      if (!hasExtraChannels) {
        expanded.push(slot);
        continue;
      }
      const ab: Record<string, Record<string, number | string>> = {};
      const cd: Record<string, Record<string, number | string>> = {};
      for (const [ch, params] of Object.entries(slot.params_by_channel)) {
        const upper = ch.trim().toUpperCase();
        if (upper === 'A' || upper === 'B') {
          ab[upper] = { ...(params as Record<string, number | string>) };
        } else if (upper === 'C' || upper === 'D') {
          // C → A (which becomes X on target), D → B (which becomes Y).
          const remappedKey = upper === 'C' ? 'A' : 'B';
          cd[remappedKey] = { ...(params as Record<string, number | string>) };
        }
      }
      const first: PresetSlotSpec = {
        ...slot,
        params_by_channel: ab,
        instance: 1,
      };
      expanded.push(first);
      if (Object.keys(cd).length > 0) {
        const second: PresetSlotSpec = {
          ...slot,
          params_by_channel: cd,
          instance: 2,
          id: `${bt}_2`,
        };
        expanded.push(second);
        warnings.push(
          `expanded ${bt} channels A/B/C/D into two instances on ${targetDescriptor.display_name}: ` +
          `${bt}_1 (X=A, Y=B) and ${bt}_2 (X=C, Y=D).`,
        );
        // Record the scene remap so translateScenes can route each scene
        // to the correct instance and bypass the other. The second
        // instance stores C under its 'A' key and D under its 'B' key
        // (see the remappedKey logic above), so a scene selecting source
        // channel C → amp_2 channel 'A' (which the basic A→X remap then
        // turns into X). A/B stay on the first instance.
        const firstId = first.id ?? bt;
        const secondId = second.id ?? `${bt}_2`;
        const expandInfo = {
          firstId,
          secondId,
          map: {
            A: { id: firstId, channel: 'A' },
            B: { id: firstId, channel: 'B' },
            C: { id: secondId, channel: 'A' },
            D: { id: secondId, channel: 'B' },
          },
        };
        // Key by every spelling a source scene might use for the block.
        sceneExpandRemap.set(firstId, expandInfo);
        sceneExpandRemap.set(bt, expandInfo);
      }
    }
    sortedSlots.length = 0;
    sortedSlots.push(...expanded);
  }

  // ── Grid → Linear pre-collapse (F6c slot-budget fix) ──────────────
  // When a 2-channel grid source has two same-type instances (amp +
  // amp_2 from a recipe like "Shiver clean/lead + JCM800/JVM"), and the
  // target is a 4-channel linear device, an identical post-pass merges
  // them into one block via A/B/C/D channels — but the post-pass runs
  // AFTER the per-slot allocation loop, so until it fires the second
  // instance consumes a target slot it shouldn't. Net effect on a
  // 4-slot target: a 5th block (compressor) gets dropped with "out
  // of slots" even though the collapse would free a slot for it.
  // Pre-collapse here removes the second instance from sortedSlots so
  // the per-slot loop sees the merged budget. The merged params are
  // stored under target-channel keys (A/B/C/D), and the slot is marked
  // so `translateParams` skips its source→target channel remap.
  const sourceChannelCountPre = sourceChannelNamesPre.length;
  const targetChannelCountPre = targetChannelNamesPre.length;
  const slotsWithTargetChannelKeys = new WeakSet<PresetSlotSpec>();
  if (
    sourceCap.slot_model === 'grid' &&
    targetCap.slot_model === 'linear' &&
    sourceChannelCountPre === 2 &&
    targetChannelCountPre === 4
  ) {
    const targetChannelNamesLocal = targetCap.channel_names ?? [];
    const channelBlocksLocal = new Set(
      (targetCap.channel_blocks ?? []).map((b: string) => b.toLowerCase()),
    );
    const seenByType = new Map<string, PresetSlotSpec>();
    const collapsed: PresetSlotSpec[] = [];
    for (const slot of sortedSlots) {
      const bt = slot.block_type.toLowerCase();
      if (!channelBlocksLocal.has(bt)) {
        collapsed.push(slot);
        continue;
      }
      const prior = seenByType.get(bt);
      if (prior === undefined) {
        seenByType.set(bt, slot);
        collapsed.push(slot);
        continue;
      }
      // Remap each instance's source channels to target channel positions:
      //   prior  (X, Y) → target[0], target[1]   (A, B)
      //   second (X, Y) → target[2], target[3]   (C, D)
      // After this, `merged` is keyed by target channel names. Mark the
      // slot via slotsWithTargetChannelKeys so the slot loop tells
      // translateParams to skip the channel remap (else A/B/C/D would
      // not match the source's X→A, Y→B remap table and would drop).
      const merged: Record<string, Record<string, number | string>> = {};
      const remapInstance = (
        instSlot: PresetSlotSpec,
        targetOffset: number,
      ): void => {
        const chMap = (instSlot.params_by_channel ?? {}) as Record<
          string, Record<string, number | string>
        >;
        const chKeys = Object.keys(chMap);
        for (
          let i = 0;
          i < chKeys.length && targetOffset + i < targetChannelCountPre;
          i++
        ) {
          merged[targetChannelNamesLocal[targetOffset + i]] = { ...chMap[chKeys[i]] };
        }
        if (chKeys.length === 0 && instSlot.params !== undefined) {
          merged[targetChannelNamesLocal[targetOffset]] = {
            ...(instSlot.params as Record<string, number | string>),
          };
        }
      };
      remapInstance(prior, 0);
      remapInstance(slot, 2);
      // Record the second instance's id so the scene-cleanup pass strips
      // dangling refs (channels / bypassed maps that still name amp_2).
      const droppedId = slot.id ?? `${bt}_2`;
      collapsedAwayBlockIds.add(droppedId);
      collapsedAwayBlockIds.add(`${bt}_2`);
      collapsedAwayBlockIds.add(`${bt} 2`);
      collapsedAwayBlockIds.add(`${bt}2`);
      // Build the per-instance channel maps for translateScenes' merge.
      // Source channel 0 (X) on the 2nd instance lands at target channel 2 (C);
      // source channel 1 (Y) lands at target channel 3 (D). Cover the common
      // alternate spellings agents use in scene maps.
      const channelMap: Record<string, string> = {};
      const srcCh0 = sourceChannelNamesPre[0]?.toUpperCase();
      const srcCh1 = sourceChannelNamesPre[1]?.toUpperCase();
      const tgtCh2 = targetChannelNamesLocal[2];
      const tgtCh3 = targetChannelNamesLocal[3];
      if (srcCh0 !== undefined && tgtCh2 !== undefined) channelMap[srcCh0] = tgtCh2;
      if (srcCh1 !== undefined && tgtCh3 !== undefined) channelMap[srcCh1] = tgtCh3;
      const collapseInfo = { mergedId: bt, channelMap };
      sceneCollapseRemap.set(droppedId, collapseInfo);
      sceneCollapseRemap.set(`${bt}_2`, collapseInfo);
      sceneCollapseRemap.set(`${bt} 2`, collapseInfo);
      sceneCollapseRemap.set(`${bt}2`, collapseInfo);
      prior.params_by_channel = merged;
      prior.params = undefined;
      prior.instance = undefined;
      prior.id = bt;
      slotsWithTargetChannelKeys.add(prior);
      warnings.push(
        `collapsed ${bt} instances 1+2 into a single block with channels ${Object.keys(merged).join('/')}.`,
      );
    }
    sortedSlots.length = 0;
    sortedSlots.push(...collapsed);
  }

  const targetSlots: PresetSlotSpec[] = [];
  // Track grid cells (row:col) already occupied on the target to detect
  // collisions from linear→grid expansion (amp_1 + amp_2 share source
  // slot 1 → translateSlotRef returns the same {row:2, col:1} twice).
  // Bump col forward until the cell is free.
  const occupiedCells = new Set<string>();
  for (let i = 0; i < sortedSlots.length; i++) {
    const sourceSlot = sortedSlots[i];

    // Skip budget-priority drops identified upstream. Surface as a
    // top-level drop with the priority-based reason so the agent knows
    // WHY this block didn't survive (vs. an architectural auto-drop).
    if (budgetDroppedSlots.has(sourceSlot)) {
      const bt = sourceSlot.block_type.toLowerCase();
      const reason = `target ${targetDescriptor.display_name} is out of ${targetCap.slot_model} slots; lowest priority among source blocks (${bt}=tier ${BLOCK_PRIORITY[bt] ?? 99})`;
      blocksDropped.push({ block: sourceSlot.block_type, reason });
      if (POPULAR_BLOCKS.has(bt)) {
        warnings.push(
          `dropped "${sourceSlot.block_type}": ${reason}. ` +
          `This is a popular block — consider whether the target preset will sound right without it.`,
        );
      }
      continue;
    }

    // Slot ref translation. AM4 (linear) ↔ II/III (grid).
    let translatedRef = translateSlotRef(
      sourceSlot.slot,
      sourceCap,
      targetCap,
      targetSlots.length,
    );
    if (
      translatedRef !== undefined &&
      typeof translatedRef === 'object' &&
      translatedRef !== null
    ) {
      const gridCols = targetCap.grid?.cols ?? 12;
      let { row, col } = translatedRef;
      while (occupiedCells.has(`${row}:${col}`) && col < gridCols) {
        col += 1;
      }
      if (occupiedCells.has(`${row}:${col}`)) {
        translatedRef = undefined;
      } else {
        translatedRef = { row, col };
      }
    }
    if (translatedRef === undefined) {
      const reason = `target ${targetDescriptor.display_name} is out of ${targetCap.slot_model} slots`;
      blocksDropped.push({
        block: sourceSlot.block_type,
        reason,
      });
      // Popular blocks (amp/drive/compressor/reverb/delay) get a top-level
      // warning so the agent must acknowledge the drop, not just notice it
      // in blocks_dropped. Other blocks stay quiet in blocks_dropped only.
      const bt = sourceSlot.block_type.toLowerCase();
      if (POPULAR_BLOCKS.has(bt)) {
        warnings.push(
          `dropped "${sourceSlot.block_type}": ${reason}. ` +
          `This is a popular block — consider whether the target preset will sound right without it.`,
        );
      }
      continue;
    }

    // Block availability. AM4 has no separate cab block (integrated
    // into amp). II/III have a separate cab. Drop with a warning when
    // moving II/III → AM4 if the source has a cab block.
    const blockType = sourceSlot.block_type.toLowerCase();
    if (
      targetDescriptor.blocks[sourceSlot.block_type] === undefined &&
      targetDescriptor.blocks[blockType] === undefined
    ) {
      // Try the descriptor's block_aliases too.
      const alias = targetDescriptor.block_aliases?.[sourceSlot.block_type]
        ?? targetDescriptor.block_aliases?.[blockType];
      if (alias === undefined) {
        const reason = `block "${sourceSlot.block_type}" is not exposed on ${targetDescriptor.display_name}`;
        blocksDropped.push({
          block: sourceSlot.block_type,
          reason,
        });
        if (blockType === 'cab' && targetDescriptor.id === 'am4') {
          warnings.push(
            'AM4 has an integrated cab in the amp block, not a separate cab block. Pick the amp\'s preferred cab via the amp\'s native cab knob if your amp has one.',
          );
        } else if (POPULAR_BLOCKS.has(blockType)) {
          warnings.push(
            `dropped "${sourceSlot.block_type}": ${reason}. ` +
            `This is a popular block — consider whether the target preset will sound right without it.`,
          );
        }
        continue;
      }
    }

    // Param translation: aliases (BK-065) + enum mapping (BK-066 P2).
    //
    // Shape contract: the T-5 public MCP boundary (2026-05-21) splits
    // flat params (`params`) from channel-nested params (`params_by_channel`)
    // into two separate fields on PresetSlotSpec. AM4 sources use
    // `params_by_channel` exclusively for channel-bearing blocks. Read
    // BOTH fields here; if both are set on the same slot, that's a
    // schema-invalid source spec but we prefer params_by_channel since
    // it carries strictly more data (channel-aware).
    //
    // Output shape MUST also match: when source authored via
    // params_by_channel, emit the result there too (not in params).
    // Pre-fix this function only read `params` and only emitted
    // `params` — so AM4→II translation silently stripped every
    // channel-bearing slot's params and emitted "translated 4 blocks"
    // with no warnings. (Confirmed from live trace 2026-05-23.)
    const sourceParamsInput: PresetSlotSpec['params'] =
      sourceSlot.params_by_channel ?? sourceSlot.params;
    const sourceWasNested = sourceSlot.params_by_channel !== undefined;
    const translatedParams = translateParams(
      sourceParamsInput,
      blockType,
      sourceDescriptor,
      targetDescriptor,
      (n) => { paramsAliased += n; },
      (n) => { enumsMapped += n; },
      warnings,
      { channelsAreTarget: slotsWithTargetChannelKeys.has(sourceSlot) },
    );

    const translatedSlot: PresetSlotSpec = {
      slot: translatedRef,
      block_type: sourceSlot.block_type,
    };
    if (translatedParams !== undefined) {
      // Channel-nested input → emit params_by_channel; flat input → emit params.
      // The classifier inside translateParams detects shape by inspecting
      // the values; we trust the source-side shape signal here so a
      // single-channel nested map (e.g. only X populated) still lands as
      // params_by_channel rather than getting flattened.
      const looksNested = Object.values(
        translatedParams as Record<string, unknown>,
      ).every((v) => v !== null && typeof v === 'object' && !Array.isArray(v));
      if (sourceWasNested && looksNested) {
        translatedSlot.params_by_channel = translatedParams as Readonly<
          Record<string, Readonly<Record<string, number | string>>>
        >;
      } else {
        translatedSlot.params = translatedParams;
      }
    }
    if (sourceSlot.bypassed !== undefined) translatedSlot.bypassed = sourceSlot.bypassed;
    if (sourceSlot.id !== undefined) translatedSlot.id = sourceSlot.id;
    if (sourceSlot.instance !== undefined) translatedSlot.instance = sourceSlot.instance;

    if (
      typeof translatedRef === 'object' &&
      translatedRef !== null
    ) {
      occupiedCells.add(`${translatedRef.row}:${translatedRef.col}`);
    }
    targetSlots.push(translatedSlot);
  }

  // ── Pass 2: scenes ────────────────────────────────────────────────
  const droppedBlockNames = new Set(blocksDropped.map((d) => d.block));
  const targetChannelBlocks = targetCap.channel_blocks
    ? new Set(targetCap.channel_blocks.map((b: string) => b.toLowerCase()))
    : undefined;
  const targetScenes = translateScenes(
    sourceSpec.scenes,
    sourceCap,
    targetCap,
    (n) => { sceneCollapses += n; },
    warnings,
    droppedBlockNames,
    targetChannelBlocks,
    sceneCollapseRemap,
    sceneExpandRemap,
  );

  // ── Scene-collapse detection (F6h) ────────────────────────────────
  // Channel drops or block drops can leave two scenes with identical
  // channels + bypass maps. Warn so the agent can merge or adjust.
  if (targetScenes !== undefined && targetScenes.length > 1) {
    const fingerprint = (sc: SceneSpec): string => {
      const chPart = sc.channels
        ? Object.entries(sc.channels).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',')
        : '';
      const byPart = sc.bypassed
        ? Object.entries(sc.bypassed).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join(',')
        : '';
      return `ch[${chPart}]bp[${byPart}]`;
    };
    const seen = new Map<string, number>();
    for (const sc of targetScenes) {
      const fp = fingerprint(sc);
      const prior = seen.get(fp);
      if (prior !== undefined) {
        warnings.push(
          `scenes ${prior} and ${sc.scene} are identical after translation (same channels + bypass). ` +
          `Consider merging or differentiating them on the target device.`,
        );
      } else {
        seen.set(fp, sc.scene);
      }
    }
  }

  // ── Channel-cardinality optimization (F6c) ─────────────────────────
  // Grid -> Linear: collapse 2 instances of the same block into 1 block
  // using all target channels (e.g. amp_1 X/Y + amp_2 X/Y -> amp A/B/C/D).
  // Linear -> Grid: expand 1 block with 4 channels into 2 instances with
  // 2 channels each (e.g. amp A/B/C/D -> amp_1 X/Y + amp_2 X/Y).
  const sourceChannelCount = (sourceCap.channel_names ?? []).length;
  const targetChannelCount = (targetCap.channel_names ?? []).length;
  const targetChannelNames = targetCap.channel_names ?? [];
  const channelBlocks = new Set(
    (targetCap.channel_blocks ?? []).map((b: string) => b.toLowerCase()),
  );

  if (
    sourceCap.slot_model === 'grid' &&
    targetCap.slot_model === 'linear' &&
    sourceChannelCount === 2 &&
    targetChannelCount === 4
  ) {
    // Grid -> Linear instance collapse: merge 2 instances into 1 with 4 channels.
    const instanceGroups = new Map<string, PresetSlotSpec[]>();
    for (const slot of targetSlots) {
      const bt = slot.block_type.toLowerCase();
      if (!channelBlocks.has(bt)) continue;
      if (!instanceGroups.has(bt)) instanceGroups.set(bt, []);
      instanceGroups.get(bt)!.push(slot);
    }
    for (const [bt, group] of instanceGroups) {
      if (group.length < 2) continue;
      const merged = group[0];
      const second = group[1];
      const mergedParams: Record<string, Record<string, number | string>> = {};
      // First instance's channels map to target channels 0,1 (A,B)
      if (merged.params_by_channel) {
        const chKeys = Object.keys(merged.params_by_channel);
        for (let i = 0; i < chKeys.length && i < 2; i++) {
          mergedParams[targetChannelNames[i]] = { ...merged.params_by_channel[chKeys[i]] } as Record<string, number | string>;
        }
      } else if (merged.params) {
        mergedParams[targetChannelNames[0]] = { ...merged.params } as Record<string, number | string>;
      }
      // Second instance's channels map to target channels 2,3 (C,D)
      if (second.params_by_channel) {
        const chKeys = Object.keys(second.params_by_channel);
        for (let i = 0; i < chKeys.length && i + 2 < targetChannelCount; i++) {
          mergedParams[targetChannelNames[i + 2]] = { ...second.params_by_channel[chKeys[i]] } as Record<string, number | string>;
        }
      } else if (second.params) {
        mergedParams[targetChannelNames[2]] = { ...second.params } as Record<string, number | string>;
      }
      merged.params_by_channel = mergedParams;
      merged.params = undefined;
      merged.instance = undefined;
      merged.id = bt;
      // Record the id of the second instance so the scene-cleanup pass
      // below can strip dangling channels/bypassed refs for it.
      const droppedId = second.id ?? `${bt}_2`;
      collapsedAwayBlockIds.add(droppedId);
      // Common alternate spellings agents may have used in scene maps:
      // "amp_2", "amp 2", "amp2". Cover them all so cleanup is robust.
      collapsedAwayBlockIds.add(`${bt}_2`);
      collapsedAwayBlockIds.add(`${bt} 2`);
      collapsedAwayBlockIds.add(`${bt}2`);
      // Register a sceneCollapseRemap entry too, in case translateScenes
      // hasn't run yet (it has, normally — the pre-collapse pass already
      // populated this map — but stay defensive in case future refactors
      // move things around). Identical channel offsets to the pre-pass:
      // first instance's channels go to A/B, second's to C/D.
      if (!sceneCollapseRemap.has(droppedId)) {
        const srcChNames = sourceCap.channel_names ?? [];
        const tgtChNames = targetChannelNames;
        const channelMap: Record<string, string> = {};
        const srcCh0 = srcChNames[0]?.toUpperCase();
        const srcCh1 = srcChNames[1]?.toUpperCase();
        const tgtCh2 = tgtChNames[2];
        const tgtCh3 = tgtChNames[3];
        if (srcCh0 !== undefined && tgtCh2 !== undefined) channelMap[srcCh0] = tgtCh2;
        if (srcCh1 !== undefined && tgtCh3 !== undefined) channelMap[srcCh1] = tgtCh3;
        const collapseInfo = { mergedId: bt, channelMap };
        sceneCollapseRemap.set(droppedId, collapseInfo);
        sceneCollapseRemap.set(`${bt}_2`, collapseInfo);
        sceneCollapseRemap.set(`${bt} 2`, collapseInfo);
        sceneCollapseRemap.set(`${bt}2`, collapseInfo);
      }
      const secondIdx = targetSlots.indexOf(second);
      if (secondIdx >= 0) targetSlots.splice(secondIdx, 1);
      warnings.push(
        `collapsed ${bt} instances 1+2 into a single block with channels ${Object.keys(mergedParams).join('/')}.`,
      );
    }
  }

  // ── Cleanup: strip dangling scene refs for collapsed blocks (F6e) ───
  // After the collapse pass merges (say) amp_1 + amp_2 into one amp
  // block, the scene maps still mention amp_2 in their channels and
  // bypassed entries. Walk targetScenes and drop entries naming any id
  // that got collapsed away, so the resulting spec is internally
  // consistent and apply_preset doesn't surface phantom-param warnings
  // for blocks the spec claims to set but doesn't expose.
  if (collapsedAwayBlockIds.size > 0 && targetScenes !== undefined) {
    for (const sc of targetScenes) {
      if (sc.channels !== undefined) {
        for (const id of collapsedAwayBlockIds) {
          if (id in sc.channels) {
            delete (sc.channels as Record<string, unknown>)[id];
          }
        }
      }
      if (sc.bypassed !== undefined) {
        for (const id of collapsedAwayBlockIds) {
          if (id in sc.bypassed) {
            delete (sc.bypassed as Record<string, unknown>)[id];
          }
        }
      }
    }
  }

  // ── Cab auto-placement on linear → grid (F6g) ──────────────────────
  // AM4 (linear) carries the cab inside the amp block; II/III (grid)
  // expose a separate cab block. When translating linear→grid AND the
  // source had an amp AND the target supports a cab block, insert a
  // default cab block immediately after the amp at the next-available
  // grid column. The cab carries no params (uses device default IR);
  // the agent can swap to a different IR via set_param afterward.
  if (
    sourceCap.slot_model === 'linear' &&
    targetCap.slot_model === 'grid' &&
    targetDescriptor.blocks['cab'] !== undefined
  ) {
    const ampSlots = targetSlots.filter(
      (s) => s.block_type.toLowerCase() === 'amp',
    );
    const hasCab = targetSlots.some(
      (s) => s.block_type.toLowerCase() === 'cab',
    );
    if (ampSlots.length > 0 && !hasCab) {
      // Place cab one column past the rightmost amp, on the same row.
      let lastAmpRow = 2;
      let lastAmpCol = 0;
      for (const a of ampSlots) {
        if (typeof a.slot === 'object' && a.slot !== null) {
          if (a.slot.col > lastAmpCol) {
            lastAmpCol = a.slot.col;
            lastAmpRow = a.slot.row;
          }
        }
      }
      const targetCols = targetCap.grid?.cols ?? 12;
      // Shift any blocks currently at lastAmpCol+1 onward to make room.
      // The cab convention places it directly after the amp; pushing
      // delay/reverb downstream keeps the signal chain musically right.
      const cabCol = lastAmpCol + 1;
      if (cabCol <= targetCols) {
        for (const s of targetSlots) {
          if (typeof s.slot === 'object' && s.slot !== null) {
            if (s.slot.row === lastAmpRow && s.slot.col >= cabCol && s.slot.col < targetCols) {
              s.slot = { row: s.slot.row, col: s.slot.col + 1 };
            }
          }
        }
        const cabSlot: PresetSlotSpec = {
          slot: { row: lastAmpRow, col: cabCol },
          block_type: 'cab',
          id: 'cab',
        };
        targetSlots.push(cabSlot);
        warnings.push(
          `auto-placed a cab block at row ${lastAmpRow} col ${cabCol}: ` +
          `${sourceDescriptor.display_name} integrates the cab into the amp, ` +
          `but ${targetDescriptor.display_name} requires a separate cab block ` +
          `for the signal chain to model correctly. The cab uses the device ` +
          `default IR — swap via set_param if needed.`,
        );
      }
    }
  }
  // Linear -> Grid expansion (AM4 A/B/C/D -> II amp_1 X/Y + amp_2 X/Y)
  // is not implemented: translateParams already collapses channels before
  // this post-pass runs. The channel-drop warning surfaces to the agent
  // so they can manually split into 2 instances if needed.

  // ── Build the result spec ─────────────────────────────────────────
  const appliedSpec: PresetSpec = {
    slots: targetSlots,
    ...(targetScenes !== undefined && targetScenes.length > 0 ? { scenes: targetScenes } : {}),
    ...(sourceSpec.name !== undefined ? { name: sourceSpec.name } : {}),
    ...(sourceSpec.landingScene !== undefined && targetCap.has_scenes
      ? { landingScene: Math.min(sourceSpec.landingScene, targetCap.scene_count ?? 8) }
      : {}),
  };

  // Routing on grid devices: only carry it through when BOTH source
  // and target are grid devices, since linear devices ignore routing.
  if (
    sourceSpec.routing !== undefined &&
    sourceSpec.routing.length > 0 &&
    sourceCap.slot_model === 'grid' &&
    targetCap.slot_model === 'grid'
  ) {
    appliedSpec.routing = sourceSpec.routing;
  } else if (sourceSpec.routing !== undefined && sourceSpec.routing.length > 0) {
    warnings.push(
      `dropped ${sourceSpec.routing.length} routing edge(s): ${targetDescriptor.display_name} is a ${targetCap.slot_model}-slot device, routing is implicit.`,
    );
  }

  const port_summary: PortPresetSummary = {
    blocks_translated: targetSlots.length,
    blocks_dropped: blocksDropped,
    params_aliased: paramsAliased,
    enums_mapped: enumsMapped,
    modifier_wirings_deferred: modifierDeferred,
    scene_collapses: sceneCollapses,
  };

  return {
    ok: targetSlots.length > 0,
    port_summary,
    applied_spec: appliedSpec,
    warnings,
  };
}

/**
 * Translate a single slot reference between linear and grid models.
 *
 *   linear → linear: pass through unchanged (but clamp to target slot_count).
 *   linear → grid:   place on row 2, col = source slot number.
 *   grid → linear:   take the column index 1..N from the next-empty index.
 *   grid → grid:     pass through if both have room; otherwise reposition.
 *
 * Returns `undefined` when the target has run out of slots.
 */
function translateSlotRef(
  sourceSlot: PresetSlotSpec['slot'],
  sourceCap: DeviceDescriptor['capabilities'],
  targetCap: DeviceDescriptor['capabilities'],
  alreadyPlaced: number,
): PresetSlotSpec['slot'] | undefined {
  if (targetCap.slot_model === 'linear') {
    const targetSlotCount = targetCap.slot_count ?? 4;
    if (sourceCap.slot_model === 'linear') {
      const n = typeof sourceSlot === 'number' ? sourceSlot : alreadyPlaced + 1;
      if (n > targetSlotCount) return undefined;
      return n;
    }
    // grid → linear: assign sequential slot number based on placement order.
    const nextSlot = alreadyPlaced + 1;
    if (nextSlot > targetSlotCount) return undefined;
    return nextSlot;
  }
  // target is grid
  const rows = targetCap.grid?.rows ?? 4;
  const cols = targetCap.grid?.cols ?? 12;
  if (sourceCap.slot_model === 'linear') {
    const n = typeof sourceSlot === 'number' ? sourceSlot : alreadyPlaced + 1;
    // Place on row 2 (conventional main signal row on Fractal grids),
    // col = source slot index. Clamp to the target grid bounds.
    const row = 2 <= rows ? 2 : 1;
    const col = Math.min(n, cols);
    if (col < 1) return undefined;
    return { row, col };
  }
  // grid → grid: pass through if in bounds.
  if (typeof sourceSlot === 'object' && sourceSlot !== null) {
    const { row, col } = sourceSlot;
    if (row >= 1 && row <= rows && col >= 1 && col <= cols) {
      return { row, col };
    }
  }
  return undefined;
}

/**
 * Translate a slot's `params` map. Walks every entry, runs the BK-065
 * alias resolver on the param name, and the BK-066 Phase 2 resolver on
 * any string (enum-shaped) value. Counters land via the closures so
 * the caller can aggregate across all slots.
 *
 * Returns the translated params object in the same shape (flat or
 * channel-nested) as the input. Returns `undefined` when the input was
 * absent.
 *
 * Channel collapse: when the source has channels the target doesn't
 * model (A/B/C/D → X/Y or none), the function keeps only the
 * channels named in the target's `channel_names`. Source channels
 * outside that set drop with a warning.
 */
type FlatParams = Readonly<Record<string, number | string>>;
type NestedParams = Readonly<Record<string, FlatParams>>;

function translateParams(
  sourceParams: PresetSlotSpec['params'],
  blockType: string,
  sourceDescriptor: DeviceDescriptor,
  targetDescriptor: DeviceDescriptor,
  reportAlias: (n: number) => void,
  reportEnumMap: (n: number) => void,
  warnings: string[],
  options: { channelsAreTarget?: boolean } = {},
): PresetSlotSpec['params'] | undefined {
  if (sourceParams === undefined || sourceParams === null) return undefined;
  const entries = Object.entries(sourceParams);
  if (entries.length === 0) return undefined;

  // Classify: nested if every value is an object, flat otherwise.
  const looksNested = entries.every(
    ([, v]) => v !== null && typeof v === 'object' && !Array.isArray(v),
  );

  if (!looksNested) {
    return translateFlatParams(
      sourceParams as FlatParams,
      blockType,
      targetDescriptor,
      reportAlias,
      reportEnumMap,
    );
  }

  // Channel-nested. Collapse channels the target doesn't carry.
  const targetChannels = targetDescriptor.capabilities.channel_names ?? [];
  const targetChannelsUpper = targetChannels.map((c) => c.toUpperCase());
  const out: Record<string, FlatParams> = {};
  let droppedChannels = 0;
  // Lookup table for channel name remapping when channel sets differ.
  // AM4 (A/B/C/D) ↔ II (X/Y) ↔ III (A/B/C/D).
  // When `channelsAreTarget` is set, the caller pre-collapsed the slot
  // using target-channel keys already (grid→linear instance collapse),
  // so the source→target remap would drop every key. Use an identity
  // mapping instead.
  const sourceChannels = options.channelsAreTarget
    ? targetChannels
    : sourceDescriptor.capabilities.channel_names ?? [];
  const channelRemap = buildChannelRemap(sourceChannels, targetChannels);
  for (const [ch, paramMap] of entries) {
    const upperSource = ch.trim().toUpperCase();
    let targetCh = upperSource;
    if (channelRemap !== undefined) {
      const remapped = channelRemap[upperSource];
      if (remapped === undefined) {
        droppedChannels++;
        continue;
      }
      targetCh = remapped;
    }
    if (targetChannelsUpper.length > 0 && !targetChannelsUpper.includes(targetCh)) {
      droppedChannels++;
      continue;
    }
    const translated = translateFlatParams(
      paramMap as FlatParams,
      blockType,
      targetDescriptor,
      reportAlias,
      reportEnumMap,
    );
    if (translated !== undefined && Object.keys(translated).length > 0) {
      out[targetCh] = translated;
    }
  }
  if (droppedChannels > 0) {
    warnings.push(
      `dropped ${droppedChannels} channel slice(s) on ${blockType}: ${targetDescriptor.display_name} only exposes channels [${targetChannels.join(', ')}].`,
    );
  }
  if (Object.keys(out).length === 0) return undefined;
  return out as NestedParams;
}

/**
 * Translate a single flat params map. Used both for non-channel blocks
 * and for one channel slice of a nested map.
 */
function translateFlatParams(
  params: FlatParams,
  blockType: string,
  targetDescriptor: DeviceDescriptor,
  reportAlias: (n: number) => void,
  reportEnumMap: (n: number) => void,
): FlatParams {
  const out: Record<string, number | string> = {};
  for (const [name, value] of Object.entries(params)) {
    const aliasResult = resolveParamAlias(targetDescriptor.id, blockType, name);
    const canonicalName = aliasResult.canonical;
    if (aliasResult.aliasUsed !== undefined && aliasResult.canonical !== name) {
      reportAlias(1);
    }
    let translatedValue: number | string = value;
    if (typeof value === 'string') {
      const enumResult = resolveEnumAlias(targetDescriptor.id, blockType, canonicalName, value);
      if (enumResult.aliasUsed !== undefined && enumResult.canonical !== value) {
        translatedValue = enumResult.canonical;
        reportEnumMap(1);
      }
    }
    out[canonicalName] = translatedValue;
  }
  return out;
}

/**
 * Build a channel-name remap when source and target have different
 * channel sets. Returns `undefined` when both sets are identical so
 * the caller skips the remap step entirely.
 *
 *   AM4 (A/B/C/D) → II (X/Y):     A→X, B→Y, C and D drop.
 *   II (X/Y)      → AM4 (A/B/C/D): X→A, Y→B.
 *   AM4 (A/B/C/D) → III (A/B/C/D): identity (no remap returned).
 *   II (X/Y)      → III (A/B/C/D): X→A, Y→B.
 */
function buildChannelRemap(
  source: readonly string[],
  target: readonly string[],
): Record<string, string> | undefined {
  if (source.length === target.length && source.every((c, i) => c === target[i])) {
    return undefined;
  }
  const remap: Record<string, string> = {};
  // Position-based mapping: source[i] -> target[i] when both exist.
  for (let i = 0; i < source.length && i < target.length; i++) {
    remap[source[i].toUpperCase()] = target[i].toUpperCase();
  }
  return remap;
}

/**
 * Translate the scenes array. Collapses scene cardinality (e.g. II
 * 8 -> AM4 4) and rewrites per-scene channel/bypass references through
 * the channel remap.
 */
function translateScenes(
  sourceScenes: PresetSpec['scenes'],
  sourceCap: DeviceDescriptor['capabilities'],
  targetCap: DeviceDescriptor['capabilities'],
  reportCollapse: (n: number) => void,
  warnings: string[],
  droppedBlocks: ReadonlySet<string>,
  targetChannelBlocks: ReadonlySet<string> | undefined,
  sceneCollapseRemap?: ReadonlyMap<
    string,
    { mergedId: string; channelMap: Record<string, string> }
  >,
  sceneExpandRemap?: ReadonlyMap<
    string,
    {
      firstId: string;
      secondId: string;
      map: Record<string, { id: string; channel: string }>;
    }
  >,
): SceneSpec[] | undefined {
  if (sourceScenes === undefined || sourceScenes.length === 0) return undefined;
  if (!targetCap.has_scenes) {
    warnings.push(
      `dropped ${sourceScenes.length} scene(s): target device does not expose scenes.`,
    );
    reportCollapse(sourceScenes.length);
    return undefined;
  }
  const targetSceneCount = targetCap.scene_count ?? 8;
  const out: SceneSpec[] = [];
  const sourceChannels = sourceCap.channel_names ?? [];
  const targetChannels = targetCap.channel_names ?? [];
  const targetChannelSet = new Set(targetChannels.map((c) => c.toUpperCase()));
  const channelRemap = buildChannelRemap(sourceChannels, targetChannels);
  let collapsed = 0;
  // Deduplicate collapse-merge entries: the remap stores the same info
  // under multiple alternate spellings (amp_2, amp 2, amp2). Walk by
  // identity so a single source scene doesn't merge the same pair twice.
  const collapseEntries: Array<[string, { mergedId: string; channelMap: Record<string, string> }]> = [];
  if (sceneCollapseRemap !== undefined) {
    const seenInfo = new Set<{ mergedId: string; channelMap: Record<string, string> }>();
    for (const entry of sceneCollapseRemap) {
      if (!seenInfo.has(entry[1])) {
        seenInfo.add(entry[1]);
        // Use the canonical id (the one that was the actual source slot id).
        // Caller registers the canonical id first; alternates follow.
      }
      collapseEntries.push(entry);
    }
  }
  for (const sc of sourceScenes) {
    if (sc.scene > targetSceneCount) {
      collapsed++;
      continue;
    }
    // Build effective per-scene maps by merging collapsed-block state
    // into the merged block's entries BEFORE the simple X→A channel
    // remap. Otherwise scenes that used the second instance (amp_2) of
    // a collapsed pair lose their amp routing entirely and play silent:
    // amp_2's channel entry gets filtered by targetChannelBlocks, and
    // bypass merges aren't OR'd, so a scene where amp was off but amp_2
    // was on lands with merged amp.bypassed=true on the target. The
    // merge rewrites those references onto the merged block (amp) with
    // the right target channel (X→C, Y→D for the second instance).
    const effectiveChannels: Record<string, string | number> = { ...(sc.channels ?? {}) };
    const effectiveBypassed: Record<string, boolean> = { ...(sc.bypassed ?? {}) };
    if (sceneCollapseRemap !== undefined && sceneCollapseRemap.size > 0) {
      const mergedAlreadyHandled = new Set<string>();
      for (const [collapsedId, info] of collapseEntries) {
        const hasCh = collapsedId in effectiveChannels;
        const hasBy = collapsedId in effectiveBypassed;
        if (!hasCh && !hasBy) continue;
        const { mergedId, channelMap } = info;
        // Each merged-id pair is only resolved once per scene; the rest
        // of the alternate-spelling entries just need their dangling
        // refs stripped (handled by the delete below).
        const collapsedBy = effectiveBypassed[collapsedId] ?? false;
        const mergedBy = effectiveBypassed[mergedId] ?? false;
        const collapsedCh = effectiveChannels[collapsedId];
        if (!mergedAlreadyHandled.has(mergedId)) {
          mergedAlreadyHandled.add(mergedId);
          // Merged block is bypassed only when BOTH source blocks were
          // bypassed (bypass = OFF; the merged block plays whenever
          // either source block played).
          effectiveBypassed[mergedId] = mergedBy && collapsedBy;
          if (!collapsedBy && mergedBy) {
            // Only the second instance was on → use its channel mapped
            // through channelMap (X→C, Y→D).
            if (typeof collapsedCh === 'string') {
              const upper = collapsedCh.trim().toUpperCase();
              const mapped = channelMap[upper];
              if (mapped !== undefined) {
                effectiveChannels[mergedId] = mapped;
              }
            }
          } else if (!collapsedBy && !mergedBy) {
            // Both source blocks were on. The target's single merged
            // block can only play one channel at a time → primary wins,
            // warn that the parallel was lost in the cardinality collapse.
            warnings.push(
              `scene ${sc.scene}: both ${mergedId} and ${collapsedId} were active on the source; ` +
              `the target's merged ${mergedId} plays only ${mergedId}'s channel — ${collapsedId}'s tone is lost.`,
            );
          }
          // mergedBy && !collapsedBy → primary on, second off: keep primary
          //   channel (the simple X→A remap below handles it normally).
          // mergedBy && collapsedBy → both off: merged stays bypassed,
          //   no channel update needed.
        }
        delete effectiveChannels[collapsedId];
        delete effectiveBypassed[collapsedId];
      }
    }
    // Linear→grid EXPAND remap: a scene that referenced the single source
    // block (amp) must be rerouted to the instance carrying its channel
    // (A/B→amp_1, C/D→amp_2), with the OTHER instance bypassed. Mirror of
    // the collapse merge above. Runs on the (mutually exclusive) opposite
    // direction, so it never overlaps the collapse block.
    if (sceneExpandRemap !== undefined && sceneExpandRemap.size > 0) {
      const handledSrc = new Set<string>();
      for (const [srcId, info] of sceneExpandRemap) {
        if (handledSrc.has(srcId)) continue;
        handledSrc.add(srcId);
        const hasCh = srcId in effectiveChannels;
        const hasBy = srcId in effectiveBypassed;
        if (!hasCh && !hasBy) continue;
        const wasBypassed = effectiveBypassed[srcId] ?? false;
        const chVal = effectiveChannels[srcId];
        // Delete the source ref FIRST: the first instance keeps the same
        // id ('amp'), so deleting after the write would clobber the value
        // we just set (same for the other-instance bypass on C/D scenes).
        delete effectiveChannels[srcId];
        delete effectiveBypassed[srcId];
        if (wasBypassed) {
          // Source block off in this scene → both instances off.
          effectiveBypassed[info.firstId] = true;
          effectiveBypassed[info.secondId] = true;
        } else {
          // Pick the instance for the selected channel; default to the
          // first instance's A channel when the scene named no channel.
          let target = info.map['A'];
          if (typeof chVal === 'string') {
            const u = chVal.trim().toUpperCase();
            if (info.map[u] !== undefined) target = info.map[u];
          }
          const otherId = target.id === info.firstId ? info.secondId : info.firstId;
          effectiveChannels[target.id] = target.channel;
          effectiveBypassed[target.id] = false;
          effectiveBypassed[otherId] = true;
        }
      }
    }
    const channels: Record<string, string | number> = {};
    for (const [block, ch] of Object.entries(effectiveChannels)) {
      if (droppedBlocks.has(block)) continue;
      // Accept both a bare type ('amp') and an instance id ('amp_2',
      // 'amp 2', 'amp2') by stripping a trailing instance suffix before
      // the channel-bearing-type check. Without this, expanded second
      // instances (amp_2) would be filtered out and lose their routing.
      if (targetChannelBlocks !== undefined) {
        const blkLower = block.toLowerCase();
        const blkType = blkLower.replace(/[_ ]?\d+$/, '');
        if (!targetChannelBlocks.has(blkLower) && !targetChannelBlocks.has(blkType)) continue;
      }
      if (typeof ch === 'number') {
        channels[block] = ch;
        continue;
      }
      const upper = ch.trim().toUpperCase();
      // If the collapse-merge step above wrote a value that's ALREADY a
      // target channel (e.g. 'C' on AM4), pass it through verbatim — the
      // source→target remap only knows source-side channels (X/Y) and
      // would drop it otherwise.
      const isAlreadyTarget = targetChannelSet.has(upper);
      const mapped = isAlreadyTarget
        ? upper
        : channelRemap !== undefined ? channelRemap[upper] : upper;
      if (mapped !== undefined) {
        channels[block] = mapped;
      }
    }
    const translatedScene: SceneSpec = { scene: sc.scene, channels };
    if (sc.bypassed !== undefined || Object.keys(effectiveBypassed).length > 0) {
      const filtered: Record<string, boolean> = {};
      for (const [block, val] of Object.entries(effectiveBypassed)) {
        if (droppedBlocks.has(block)) continue;
        filtered[block] = val;
      }
      translatedScene.bypassed = filtered;
    }
    out.push(translatedScene);
  }
  if (collapsed > 0) reportCollapse(collapsed);
  if (collapsed > 0) {
    warnings.push(
      `collapsed ${collapsed} scene(s) past index ${targetSceneCount} on target device.`,
    );
  }
  return out;
}
