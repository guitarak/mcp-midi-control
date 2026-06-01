/**
 * set_mod_route / set_macro_route dispatchers.
 *
 * Convenience write-side primitives over the mod-matrix and macro-page NRPN
 * fields. They compile down to the SAME verified set_param encode path
 * (executeSetParam -> resolveNrpnValue -> resolveModRoutingWire), adding only
 * slot allocation so the agent references routes by source/target NAME and
 * never tracks which of the device's slots are free.
 *
 *   set_mod_route(port, source, target, depth?, slot?)
 *     -> writes modmatrix<slot>modsource / <slot>modtarget / <slot>depth
 *   set_macro_route(port, macro, target, depth?, slot?)
 *     -> writes macro<macro>target<slot> / macro<macro>depth<slot>
 *
 * Capability-gated: a device opts in via capabilities.has_mod_matrix
 * (+ mod_matrix_slots) and has_macro_routing (+ macro_dest_slots). Devices
 * without a matrix return capability_not_supported. The design is
 * cross-device by construction; only the Hydrasynth wires it today.
 */
import { requireDevice } from './core.js';
import { executeSetParam } from './params.js';
import { DispatchError } from '../types.js';
import {
  allocateSlot,
  modMatrixNamespace,
  macroNamespace,
} from './modRouteState.js';

export interface SetModRouteArgs {
  port: string;
  source: string | number;
  target: string | number;
  depth?: number;
  slot?: number;
}

export interface SetModRouteResult {
  op: 'set_mod_route';
  slot: number;
  reused: boolean;
  source: string | number;
  target: string | number;
  depth: number;
  device: string;
  port: string;
  acked: boolean;
  info: string;
}

export async function dispatchSetModRoute(args: SetModRouteArgs): Promise<SetModRouteResult> {
  const descriptor = requireDevice(args.port);
  const caps = descriptor.capabilities;
  if (caps.has_mod_matrix !== true) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} has no modulation matrix to route into.`,
    );
  }
  const size = caps.mod_matrix_slots ?? 32;
  const depth = args.depth ?? 0;

  const block = 'modmatrix';
  const srcSchema = descriptor.blocks[block]?.params['1modsource'];
  const tgtSchema = descriptor.blocks[block]?.params['1modtarget'];
  if (srcSchema === undefined || tgtSchema === undefined) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} mod matrix params are not registered.`,
    );
  }
  // Dry-encode to (a) validate the names early with a clean error and
  // (b) get a stable itemKey so "Env 2" and "env2" reuse the same slot.
  let srcWire: number;
  let tgtWire: number;
  try {
    srcWire = srcSchema.encode(args.source);
  } catch (err) {
    throw new DispatchError('value_out_of_range', descriptor.display_name,
      err instanceof Error ? err.message : `unknown mod source "${args.source}"`);
  }
  try {
    tgtWire = tgtSchema.encode(args.target);
  } catch (err) {
    throw new DispatchError('value_out_of_range', descriptor.display_name,
      err instanceof Error ? err.message : `unknown mod target "${args.target}"`);
  }

  let alloc;
  try {
    // Namespace by descriptor.id (stable) not the raw port string - the
    // same device can be addressed as "hydra" or "hydrasynth".
    alloc = allocateSlot(modMatrixNamespace(descriptor.id), `${srcWire}->${tgtWire}`, size, args.slot);
  } catch (err) {
    throw new DispatchError('value_out_of_range', descriptor.display_name,
      `set_mod_route: ${err instanceof Error ? err.message : String(err)}. Pass an explicit slot 1..${size}, or call init_patch to start fresh.`);
  }

  const n = alloc.slot;
  // Three writes through the verified set_param encode path.
  await executeSetParam({ port: args.port, block, name: `${n}modsource`, value: args.source });
  await executeSetParam({ port: args.port, block, name: `${n}modtarget`, value: args.target });
  await executeSetParam({ port: args.port, block, name: `${n}depth`, value: depth });

  const srcLabel = srcSchema.decode(srcWire);
  const tgtLabel = tgtSchema.decode(tgtWire);
  return {
    op: 'set_mod_route',
    slot: n,
    reused: alloc.reused,
    source: srcLabel,
    target: tgtLabel,
    depth,
    device: descriptor.display_name,
    port: args.port,
    acked: true,
    info: `${alloc.reused ? 'Updated' : 'Created'} mod route in slot ${n}: ${srcLabel} -> ${tgtLabel} @ depth ${depth}. ` +
      `Slots are tracked per session assuming a fresh/INIT patch; on a factory patch with existing routes pass an explicit slot. ` +
      `NRPN writes are fire-and-forget; confirm audibly on the device.`,
  };
}

export interface SetMacroRouteArgs {
  port: string;
  macro: number;
  target: string | number;
  depth?: number;
  slot?: number;
}

export interface SetMacroRouteResult {
  op: 'set_macro_route';
  macro: number;
  slot: number;
  reused: boolean;
  target: string | number;
  depth: number;
  device: string;
  port: string;
  acked: boolean;
  info: string;
}

export async function dispatchSetMacroRoute(args: SetMacroRouteArgs): Promise<SetMacroRouteResult> {
  const descriptor = requireDevice(args.port);
  const caps = descriptor.capabilities;
  if (caps.has_macro_routing !== true) {
    throw new DispatchError(
      'capability_not_supported',
      descriptor.display_name,
      `${descriptor.display_name} does not support authoring macro destinations.`,
    );
  }
  const macroCount = caps.macro_count ?? 8;
  const destSlots = caps.macro_dest_slots ?? 8;
  if (!Number.isInteger(args.macro) || args.macro < 1 || args.macro > macroCount) {
    throw new DispatchError('value_out_of_range', descriptor.display_name,
      `macro must be 1..${macroCount}; got ${args.macro}.`);
  }
  const depth = args.depth ?? 0;
  const block = 'macros';
  const tgtSchema = descriptor.blocks[block]?.params[`macro${args.macro}target1`];
  if (tgtSchema === undefined) {
    throw new DispatchError('capability_not_supported', descriptor.display_name,
      `${descriptor.display_name} macro-routing params are not registered.`);
  }
  let tgtWire: number;
  try {
    tgtWire = tgtSchema.encode(args.target);
  } catch (err) {
    throw new DispatchError('value_out_of_range', descriptor.display_name,
      err instanceof Error ? err.message : `unknown macro target "${args.target}"`);
  }
  let alloc;
  try {
    alloc = allocateSlot(macroNamespace(descriptor.id, args.macro), `${tgtWire}`, destSlots, args.slot);
  } catch (err) {
    throw new DispatchError('value_out_of_range', descriptor.display_name,
      `set_macro_route: ${err instanceof Error ? err.message : String(err)}. Macro ${args.macro} has ${destSlots} destination slots; pass an explicit slot or pick another macro.`);
  }
  const s = alloc.slot;
  await executeSetParam({ port: args.port, block, name: `macro${args.macro}target${s}`, value: args.target });
  await executeSetParam({ port: args.port, block, name: `macro${args.macro}depth${s}`, value: depth });

  const tgtLabel = tgtSchema.decode(tgtWire);
  return {
    op: 'set_macro_route',
    macro: args.macro,
    slot: s,
    reused: alloc.reused,
    target: tgtLabel,
    depth,
    device: descriptor.display_name,
    port: args.port,
    acked: true,
    info: `${alloc.reused ? 'Updated' : 'Created'} Macro ${args.macro} destination ${s}: -> ${tgtLabel} @ depth ${depth}. ` +
      `set_macro(${args.macro}, value) drives this destination. This writes the destination target + the sweep END ` +
      `(depth, bipolar -128..+128). NOTE: the macro destination also has a per-destination START (the bottom of the sweep ` +
      `range), which this tool does NOT set yet — so a newly-created slot reads an uninitialized start, shown on the panel ` +
      `as -128 for slots past the first. For a unipolar destination whose floor is 0 (cutoff, reverb mix, resonance) that ` +
      `-128 clamps to the floor and the sweep still sounds correct (0 -> depth); for a bipolar destination, or when a ` +
      `non-floor start is wanted, the start is wrong until set on the device. Slots tracked per session (fresh-patch ` +
      `assumption); pass an explicit slot on a factory patch. acked=true means the NRPN bytes were SENT, not that the ` +
      `device applied them — the front-panel macro page may not redraw until you page away and back. Confirm by ear.`,
  };
}
