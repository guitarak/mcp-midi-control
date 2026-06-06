/**
 * sub=0x2e layout-map analysis (the occupancy/routing render-gate frame).
 *
 * `0x2e` is a DEVICE->editor response: it is served verbatim by the simulator,
 * so the sim alone cannot produce a NEW layout's `0x2e` to decode against. This
 * module does the offline structural work we CAN do (septet-unpack + isolate the
 * non-background bytes) and the diff that closes the decode the moment a second
 * known-layout `0x2e` exists (a real device, or a fresh device-connect capture).
 *
 * Established (sim sessions): the body is septet-packed 7->8 MSB-first
 * (iii-byte-stream-septet-pack-8to7); the empty grid unpacks to a constant 0x40
 * background; effect TYPES are absent (occupancy/routing only — types come from
 * sub=0x01 / sub=0x7b, addressed by effectId).
 */

const BACKGROUND = 0x40;

/** Septet 7->8 MSB-first regroup. */
export function unpack7to8(data: readonly number[]): number[] {
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const b of data) {
    acc = (acc << 7) | (b & 0x7f);
    bits += 7;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return out;
}

/** Payload = the response bytes between the 12-byte head and the [cks][F7] tail. */
export function payloadOf(frame: readonly number[]): number[] {
  return frame.slice(12, frame.length - 2);
}

export interface Layout2eAnalysis {
  packedLen: number;
  unpackedLen: number;
  /** Unpacked indices whose value is neither the 0x40 background nor 0x00. */
  content: { index: number; value: number }[];
}

export function analyze2e(frame: readonly number[]): Layout2eAnalysis {
  const payload = payloadOf(frame);
  const u = unpack7to8(payload);
  const content: { index: number; value: number }[] = [];
  for (let i = 0; i < u.length; i++) {
    if (u[i] !== BACKGROUND && u[i] !== 0x00) content.push({ index: i, value: u[i] });
  }
  return { packedLen: payload.length, unpackedLen: u.length, content };
}

/** Diff two 0x2e frames' unpacked streams — the indices that changed. */
export function diff2e(a: readonly number[], b: readonly number[]): { index: number; from: number; to: number }[] {
  const ua = unpack7to8(payloadOf(a));
  const ub = unpack7to8(payloadOf(b));
  const n = Math.max(ua.length, ub.length);
  const out: { index: number; from: number; to: number }[] = [];
  for (let i = 0; i < n; i++) {
    const from = ua[i] ?? -1;
    const to = ub[i] ?? -1;
    if (from !== to) out.push({ index: i, from, to });
  }
  return out;
}
