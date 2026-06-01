/**
 * Session slot-allocation state for set_mod_route / set_macro_route.
 *
 * A mod-matrix route is three NRPN writes (source, target, depth) into one
 * of N slots; a macro destination is two writes (target, depth) into one of
 * M slots per macro. The convenience tools pick the slot so the agent never
 * hand-manages the table.
 *
 * The device can't be read (Hydrasynth has no decoded read of mod state), so
 * "which slots are free" is tracked HERE, per process, per allocation
 * namespace. This is accurate for the dominant workflow - building a patch
 * from INIT, where every slot starts empty - which is exactly the
 * fresh-build path the agent_guidance already steers toward. On a factory
 * patch with pre-existing routes the server can't see them; callers who need
 * that pass an explicit slot.
 *
 * Reset: `switch_preset` clears the namespace (the new preset carries its own
 * routes, so the session's slot view is stale). `apply_patch` / `init_patch`
 * also replace the working buffer and SHOULD reset, but those tools live in
 * the hydrasynth package and don't call this yet - tracked as a follow-up
 * with the voice-recipe work (BK-074). The current gap is cosmetic: after an
 * apply_patch the next set_mod_route allocates a higher slot than necessary;
 * the route still lands and reuse-by-source-target still works.
 *
 * Namespaces:
 *   `${port}:mod`            - the 32-slot mod matrix
 *   `${port}:macro${m}`      - the 8 destination slots of macro m
 */

interface NamespaceState {
  /** itemKey (e.g. "129->296") -> allocated slot. Enables reuse. */
  readonly itemToSlot: Map<string, number>;
  /** Slots handed out this session. */
  readonly used: Set<number>;
}

const STATE = new Map<string, NamespaceState>();

function normPort(port: string): string {
  return port.trim().toLowerCase();
}

function nsState(ns: string): NamespaceState {
  let s = STATE.get(ns);
  if (s === undefined) {
    s = { itemToSlot: new Map(), used: new Set() };
    STATE.set(ns, s);
  }
  return s;
}

export interface SlotAllocation {
  readonly slot: number;
  /** True when an existing slot for the same itemKey was reused. */
  readonly reused: boolean;
}

/**
 * Allocate (or reuse) a 1-indexed slot in `namespace` for `itemKey`.
 *
 *   - explicit slot given → use it verbatim (record it as used), no search.
 *   - itemKey already routed this session → reuse its slot.
 *   - else → lowest free slot in 1..size.
 *
 * Throws (caller converts to DispatchError) when the matrix is full or the
 * explicit slot is out of range.
 */
export function allocateSlot(
  namespace: string,
  itemKey: string,
  size: number,
  explicit?: number,
): SlotAllocation {
  const s = nsState(namespace);
  if (explicit !== undefined) {
    if (!Number.isInteger(explicit) || explicit < 1 || explicit > size) {
      throw new Error(`slot ${explicit} out of range 1..${size}`);
    }
    s.itemToSlot.set(itemKey, explicit);
    s.used.add(explicit);
    return { slot: explicit, reused: false };
  }
  const existing = s.itemToSlot.get(itemKey);
  if (existing !== undefined) return { slot: existing, reused: true };
  for (let slot = 1; slot <= size; slot++) {
    if (!s.used.has(slot)) {
      s.used.add(slot);
      s.itemToSlot.set(itemKey, slot);
      return { slot, reused: false };
    }
  }
  throw new Error(`all ${size} slots are in use`);
}

/** Build a route allocation namespace for the device's mod matrix. */
export function modMatrixNamespace(port: string): string {
  return `${normPort(port)}:mod`;
}

/** Build a namespace for macro `m`'s destination slots. */
export function macroNamespace(port: string, macro: number): string {
  return `${normPort(port)}:macro${macro}`;
}

/**
 * Clear allocation state for a port (all mod + macro namespaces). Called
 * when the working buffer is replaced (apply_patch / switch_preset /
 * init_patch) so the next route allocation starts from a clean slate.
 * With no argument, clears everything (test reset).
 */
export function resetModRouteState(port?: string): void {
  if (port === undefined) {
    STATE.clear();
    return;
  }
  const prefix = `${normPort(port)}:`;
  for (const key of [...STATE.keys()]) {
    if (key.startsWith(prefix)) STATE.delete(key);
  }
}
