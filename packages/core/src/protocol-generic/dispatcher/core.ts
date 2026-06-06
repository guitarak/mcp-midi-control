/**
 * Dispatcher core — step-1 port resolution and step-5 connection setup.
 *
 * Every unified MCP tool routes through one of the `execute*` wrappers in
 * the sibling family files (`params.ts`, `navigation.ts`, etc.); each of
 * those wrappers starts by calling `requireDevice(port)` here, runs its
 * family-specific validation, then calls `openCtx(descriptor)` to obtain
 * the MIDI handle right before delegating to the descriptor's writer or
 * reader.
 */

import { ensureConnection } from '../../server-shared/connections.js';
import {
  DispatchError,
  type DeviceDescriptor,
  type DispatchCtx,
  type DispatchErrorDetails,
} from '../types.js';
import { listRegisteredDevices, resolveDevice } from '../registry.js';

/**
 * Resolves `port` to a registered descriptor or throws a
 * `port_not_found` DispatchError with the list of known devices.
 */
export function requireDevice(port: string): DeviceDescriptor {
  const desc = resolveDevice(port);
  if (desc) return desc;
  const known = listRegisteredDevices()
    .map((d) => d.display_name)
    .join(', ');
  const details: DispatchErrorDetails = {
    valid_options: listRegisteredDevices().map((d) => d.display_name),
    retry_action: 'Call list_midi_ports to see what is connected.',
  };
  throw new DispatchError(
    'port_not_found',
    '(no device matched)',
    known.length > 0
      ? `No registered device matches port '${port}'. Known devices: ${known}.`
      : `No registered device matches port '${port}'. No devices are registered yet.`,
    details,
  );
}

/**
 * Multi-instance gate. Devices that don't advertise
 * `capabilities.has_block_instances` (AM4, Hydrasynth) cannot address a
 * second instance of a block type; passing `instance > 1` to them would
 * be silently dropped and the write would land on instance 1. Refuse it
 * loudly instead. `instance` of undefined / 1 is always allowed, so the
 * single-instance contract is unchanged.
 *
 * `path` is an optional caller label (e.g. `ops[3] amp.gain`) folded into
 * the error so batch callers can point at the offending entry.
 */
export function assertInstanceSupported(
  descriptor: DeviceDescriptor,
  instance: number | undefined,
  path?: string,
): void {
  if (instance === undefined || instance === 1) return;
  if (descriptor.capabilities.has_block_instances) return;
  throw new DispatchError(
    'capability_not_supported',
    descriptor.display_name,
    `${path ? `${path}: ` : ''}${descriptor.display_name} has a single instance of each block type, ` +
      `so instance ${instance} is not addressable (only instance 1). Drop the \`instance\` arg ` +
      `(or pass instance: 1). Multi-instance addressing is available on grid Fractal devices ` +
      `(Axe-Fx II / III / FM3 / FM9).`,
  );
}

/**
 * Open the MIDI handle for a descriptor and bundle it into the
 * `DispatchCtx` envelope the writer / reader sees. Step-5 of the
 * dispatcher's 6-step lifecycle.
 */
export function openCtx(descriptor: DeviceDescriptor): DispatchCtx {
  const label = descriptor.connection_label ?? descriptor.id;
  const conn = ensureConnection(label);
  return { conn, descriptor };
}
