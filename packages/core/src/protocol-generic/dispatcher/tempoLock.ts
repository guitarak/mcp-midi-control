/**
 * Tempo-lock co-write advisory.
 *
 * On AM4 / Axe-Fx II a delay or modulation block locks its timing param
 * (`delay.time`, modulation `rate`) to (song tempo × division) whenever
 * its `tempo` enum is set to anything other than NONE — and SILENTLY
 * IGNORES absolute writes to the timing param. The tempo-first guidance
 * pushes agents toward the synced state, which makes this silent no-op
 * MORE likely, so the dispatcher surfaces it.
 *
 * Scope (deliberately minimal, zero new wire reads): this only catches
 * the case where a SINGLE call (a `set_params` batch or one `apply_preset`
 * slot) sets BOTH the tempo to a non-NONE division AND the absolute
 * time/rate for the same block. That is a pure inspection of the writes
 * already in hand — no device read. The standalone case (writing the
 * time alone while the tempo was synced on an earlier turn) needs the
 * device's current tempo value, which is not in any cached state, so it
 * is intentionally NOT detected here; the always-in-context `set_param`
 * description caveat + the per-device `tempo_time_discipline` guidance
 * backstop it.
 *
 * Advisory only: like the phantom-param / routing-mask collectors, the
 * write proceeds and the warning rides `validation_info[]` so the agent
 * self-corrects (set tempo to NONE first) instead of reporting false
 * success.
 */

import type { DeviceDescriptor, ValidationInfo } from '../types.js';

/** A single resolved write, in canonical `block` / `name` + display value. */
export interface TempoLockWrite {
  block: string;
  name: string;
  value: number | string;
}

/**
 * A tempo enum value counts as "synced" (locking the timing param) when
 * it is anything other than NONE. Tempo enums encode NONE at wire 0 and
 * as the display label "NONE" (AM4 ships it as "NONE " with a trailing
 * space; II as "None"); everything else is a musical division.
 */
function isTempoSynced(value: number | string): boolean {
  if (typeof value === 'number') return value !== 0;
  return value.trim().toLowerCase() !== 'none';
}

/**
 * Inspect a set of resolved writes for the tempo-lock co-write trap and
 * return a `ValidationInfo[]` warning per offending block. Returns an
 * empty array when the descriptor declares no tempo-lock map, or no
 * block in the writes has both its tempo synced and its time/rate set.
 *
 * `pathPrefix` is prepended to the `path` field so apply_preset callers
 * can scope the notice to a slot (e.g. `slots[2].params`); set_params
 * passes none.
 */
export function collectTempoLockCowriteWarnings(
  descriptor: DeviceDescriptor,
  writes: readonly TempoLockWrite[],
  pathPrefix?: string,
): ValidationInfo[] {
  const lockMap = descriptor.tempo_locked_params;
  if (lockMap === undefined) return [];

  // Index the writes by canonical `block.name` path → display value.
  const byPath = new Map<string, number | string>();
  for (const w of writes) {
    byPath.set(`${w.block}.${w.name}`, w.value);
  }

  const out: ValidationInfo[] = [];
  for (const [timePath, tempoPath] of Object.entries(lockMap)) {
    if (!byPath.has(timePath)) continue;
    if (!byPath.has(tempoPath)) continue;
    const tempoValue = byPath.get(tempoPath)!;
    if (!isTempoSynced(tempoValue)) continue;
    const tempoName = tempoPath.split('.').slice(1).join('.');
    const fullPath = pathPrefix !== undefined ? `${pathPrefix}.${timePath.split('.').slice(1).join('.')}` : timePath;
    out.push({
      path: fullPath,
      info:
        `${timePath} was set in the same call as ${tempoPath}="${tempoValue}". ` +
        `On ${descriptor.display_name} a non-NONE tempo locks ${timePath} to the ` +
        `song tempo and SILENTLY IGNORES the absolute value, so it is not audible. ` +
        `Either drop ${timePath} (let the division drive timing), or set ${tempoPath} ` +
        `to "NONE" if you meant the absolute value.`,
      level: 'warning',
      dropped_param: timePath.split('.').slice(1).join('.'),
      reason:
        `${tempoPath} is synced ("${tempoValue}"), which locks ${timePath} to ` +
        `(song tempo × division) on ${descriptor.display_name}; absolute writes to ` +
        `${timePath} ack on the wire but never reach the timing engine.`,
      retry_action:
        `Keep ${tempoPath}="${tempoValue}" and remove ${timePath} (tempo-synced is the ` +
        `default for rhythmic delays/modulation), OR set ${tempoPath} to "NONE" and ` +
        `re-send ${timePath} to use the absolute value.`,
    });
  }
  return out;
}
