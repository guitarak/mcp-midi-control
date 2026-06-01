/**
 * Golden test for Hydrasynth NRPN display formulas.
 *
 * Each row is a `(canonical-name, wire-value, expected-device-display)`
 * tuple. The first batch is grounded in the actual front-panel
 * readings the founder reported during the yungatita lo-fi test on
 * 2026-05-12 — wire values are derived from `resolveNrpnValue` for
 * the display inputs the agent passed.
 *
 * Spec-derived rows fill in the param families the test didn't cover
 * (delaywet, reverbwet, mutator*wet, etc.).
 */
import { resolveNrpnValue, resolveFxAwareValue } from '@mcp-midi-control/hydrasynth/encoding.js';
import { findHydraNrpn } from '@mcp-midi-control/hydrasynth/nrpn.js';
import { decodeFxNrpnDisplay, decodeNrpnDisplay } from '@mcp-midi-control/hydrasynth/nrpnDisplay.js';
import { HYDRASYNTH_ENUMS } from '@mcp-midi-control/hydrasynth/enums.js';

interface DisplayCase {
  readonly desc: string;
  readonly name: string;
  /** Caller-facing input run through resolveNrpnValue (display value). */
  readonly userInput?: number | string;
  /**
   * Raw wire value, decoded DIRECTLY (skips resolveNrpnValue). Use for
   * hardware-captured wire→display anchors (e.g. HW-109) so the row pins
   * the device's decode table independent of tool-input semantics. The
   * device's env byte N corresponds to wire N×64.
   */
  readonly wire?: number;
  /** prefxtype context (display name) for FX-aware sub-params. */
  readonly prefxType?: string;
  readonly expectDisplay: string;
}

const CASES: DisplayCase[] = [
  // ── Yungatita lo-fi test ground truth (founder front-panel readings) ──
  {
    desc: 'filter1cutoff = 78 user input → device shows "78.0" (NOT percent)',
    name: 'filter1cutoff',
    userInput: 78,
    expectDisplay: '78.0',
  },
  {
    desc: 'filter1resonance = 14 user input → device shows "14.0"',
    name: 'filter1resonance',
    userInput: 14,
    expectDisplay: '14.0',
  },
  {
    desc: 'env2sustain = 105 user input → device shows "105.0"',
    name: 'env2sustain',
    userInput: 105,
    expectDisplay: '105.0',
  },

  // ── FX wets (percent) ──
  {
    desc: 'reverbwet = 42 user input (already a percent) → "42.0%"',
    name: 'reverbwet',
    userInput: 42,
    expectDisplay: '42.0%',
  },
  {
    desc: 'delaywet = 18 → "18.0%"',
    name: 'delaywet',
    userInput: 18,
    expectDisplay: '18.0%',
  },
  {
    desc: 'prefxwet = 100 → "100.0%"',
    name: 'prefxwet',
    userInput: 100,
    expectDisplay: '100.0%',
  },

  // ── 0..128 raw knobs ──
  {
    desc: 'amplevel = 100 → "100.0"',
    name: 'amplevel',
    userInput: 100,
    expectDisplay: '100.0',
  },
  {
    desc: 'mixerosc1vol = 110 → "110.0"',
    name: 'mixerosc1vol',
    userInput: 110,
    expectDisplay: '110.0',
  },

  // ── Lo-Fi FX sub-params (per-type-aware path) ──
  // The agent's "value=88" for prefxparam1 went to 170 Hz before the
  // fix because the generic entry was used. With the fix, the fx5param1
  // entry is used: wire = 88 × 8192 / 128 = 5632 → Hz table index 88
  // → ~6500 Hz (not 170). The exact Hz depends on the table; we just
  // verify the decoder runs and returns a Hz string.
  {
    desc: 'Lo-Fi prefxparam1 = 88 + prefxtype=Lo-Fi → device shows Hz value (not raw 88)',
    name: 'prefxparam1',
    userInput: 88,
    prefxType: 'Lo-Fi',
    // Wire 88 × 8192/128 = 5632; cutoff table index 88 lands in the
    // 1600..7000 Hz band at the 64th entry of that band → ~6400 Hz.
    expectDisplay: '6400 Hz',
  },
  {
    desc: 'Lo-Fi prefxparam5 = "22050" + prefxtype=Lo-Fi → device shows 22050',
    name: 'prefxparam5',
    userInput: '22050',
    prefxType: 'Lo-Fi',
    expectDisplay: '22050',
  },

  // ── HW-109 (2026-05-17): env time wire→display, 27 points captured live
  //    from front panel of Hydrasynth Explorer. These pin the ATTACK/HOLD
  //    table (0..36 s) and the DECAY/RELEASE table (0..60 s) to byte-exact
  //    device output. Decay and release share the same table — covering
  //    both protects against a future refactor that diverges them.
  { desc: 'HW-109 env2attacksyncoff byte 0   → "0 ms"',     name: 'env2attacksyncoff',  wire: 0,    expectDisplay: '0 ms'      },
  { desc: 'HW-109 env2attacksyncoff byte 5   → "5 ms"',     name: 'env2attacksyncoff',  wire: 320,  expectDisplay: '5 ms'      },
  { desc: 'HW-109 env2attacksyncoff byte 10  → "10 ms"',    name: 'env2attacksyncoff',  wire: 640,  expectDisplay: '10 ms'     },
  { desc: 'HW-109 env2attacksyncoff byte 25  → "30 ms"',    name: 'env2attacksyncoff',  wire: 1600, expectDisplay: '30 ms'     },
  { desc: 'HW-109 env2attacksyncoff byte 50  → "160 ms"',   name: 'env2attacksyncoff',  wire: 3200, expectDisplay: '160 ms'    },
  { desc: 'HW-109 env2attacksyncoff byte 75  → "960 ms"',   name: 'env2attacksyncoff',  wire: 4800, expectDisplay: '960 ms'    },
  { desc: 'HW-109 env2attacksyncoff byte 100 → "5.12 Sec"', name: 'env2attacksyncoff',  wire: 6400, expectDisplay: '5.12 Sec'  },
  { desc: 'HW-109 env2attacksyncoff byte 120 → "20.0 Sec"', name: 'env2attacksyncoff',  wire: 7680, expectDisplay: '20.0 Sec'  },
  { desc: 'HW-109 env2attacksyncoff byte 127 → "34.0 Sec"', name: 'env2attacksyncoff',  wire: 8128, expectDisplay: '34.0 Sec'  },

  { desc: 'HW-109 env2decaysyncoff byte 0    → "0 ms"',     name: 'env2decaysyncoff',   wire: 0,    expectDisplay: '0 ms'      },
  { desc: 'HW-109 env2decaysyncoff byte 5    → "10 ms"',    name: 'env2decaysyncoff',   wire: 320,  expectDisplay: '10 ms'     },
  { desc: 'HW-109 env2decaysyncoff byte 10   → "20 ms"',    name: 'env2decaysyncoff',   wire: 640,  expectDisplay: '20 ms'     },
  { desc: 'HW-109 env2decaysyncoff byte 25   → "60 ms"',    name: 'env2decaysyncoff',   wire: 1600, expectDisplay: '60 ms'     },
  { desc: 'HW-109 env2decaysyncoff byte 50   → "320 ms"',   name: 'env2decaysyncoff',   wire: 3200, expectDisplay: '320 ms'    },
  { desc: 'HW-109 env2decaysyncoff byte 75   → "1.92 Sec"', name: 'env2decaysyncoff',   wire: 4800, expectDisplay: '1.92 Sec'  },
  { desc: 'HW-109 env2decaysyncoff byte 100  → "10.0 Sec"', name: 'env2decaysyncoff',   wire: 6400, expectDisplay: '10.0 Sec'  },
  { desc: 'HW-109 env2decaysyncoff byte 120  → "44.0 Sec"', name: 'env2decaysyncoff',   wire: 7680, expectDisplay: '44.0 Sec'  },
  { desc: 'HW-109 env2decaysyncoff byte 127  → "58.0 Sec"', name: 'env2decaysyncoff',   wire: 8128, expectDisplay: '58.0 Sec'  },

  { desc: 'HW-109 env2releasesyncoff byte 0    → "0 ms"',     name: 'env2releasesyncoff', wire: 0,    expectDisplay: '0 ms'      },
  { desc: 'HW-109 env2releasesyncoff byte 5    → "10 ms"',    name: 'env2releasesyncoff', wire: 320,  expectDisplay: '10 ms'     },
  { desc: 'HW-109 env2releasesyncoff byte 10   → "20 ms"',    name: 'env2releasesyncoff', wire: 640,  expectDisplay: '20 ms'     },
  { desc: 'HW-109 env2releasesyncoff byte 25   → "60 ms"',    name: 'env2releasesyncoff', wire: 1600, expectDisplay: '60 ms'     },
  { desc: 'HW-109 env2releasesyncoff byte 50   → "320 ms"',   name: 'env2releasesyncoff', wire: 3200, expectDisplay: '320 ms'    },
  { desc: 'HW-109 env2releasesyncoff byte 75   → "1.92 Sec"', name: 'env2releasesyncoff', wire: 4800, expectDisplay: '1.92 Sec'  },
  { desc: 'HW-109 env2releasesyncoff byte 100  → "10.0 Sec"', name: 'env2releasesyncoff', wire: 6400, expectDisplay: '10.0 Sec'  },
  { desc: 'HW-109 env2releasesyncoff byte 120  → "44.0 Sec"', name: 'env2releasesyncoff', wire: 7680, expectDisplay: '44.0 Sec'  },
  { desc: 'HW-109 env2releasesyncoff byte 127  → "58.0 Sec"', name: 'env2releasesyncoff', wire: 8128, expectDisplay: '58.0 Sec'  },

  // ── LFO free-run rate (display-first Hz; wire = LFO_RATES_SYNC_OFF index) ──
  { desc: 'lfo1ratesyncoff index 70  → "0.04 Hz" (founder anchor)',  name: 'lfo1ratesyncoff', wire: 70,  expectDisplay: '0.04 Hz' },
  { desc: 'lfo1ratesyncoff index 510 → "1.70 Hz" (founder anchor)',  name: 'lfo1ratesyncoff', wire: 510, expectDisplay: '1.70 Hz' },
  { desc: 'lfo1ratesyncoff index 620 → "4.44 Hz" (founder anchor)',  name: 'lfo1ratesyncoff', wire: 620, expectDisplay: '4.44 Hz' },
  { desc: 'lfo1ratesyncoff input "4.44 Hz" round-trips',             name: 'lfo1ratesyncoff', userInput: '4.44 Hz', expectDisplay: '4.44 Hz' },
  { desc: 'lfo1ratesyncoff input 1.70 (number=Hz) → "1.70 Hz"',      name: 'lfo1ratesyncoff', userInput: 1.70,      expectDisplay: '1.70 Hz' },

  // ── Reverb time (display-first seconds; wire = REVERB_TIMES index × 64) ──
  { desc: 'reverbtime index 80 (wire 5120) → "4.00s"',              name: 'reverbtime', wire: 5120, expectDisplay: '4.00s' },
  { desc: 'reverbtime input "2.6s" → "2.60s"',                      name: 'reverbtime', userInput: '2.6s',   expectDisplay: '2.60s' },
  { desc: 'reverbtime input 2.6 (number=seconds) → "2.60s"',        name: 'reverbtime', userInput: 2.6,      expectDisplay: '2.60s' },
  { desc: 'reverbtime input "Freeze" round-trips',                  name: 'reverbtime', userInput: 'Freeze', expectDisplay: 'Freeze' },
];

function actualDisplay(c: DisplayCase): string {
  // Direct wire→display decode anchor (hardware-captured points).
  if (c.wire !== undefined) {
    return decodeNrpnDisplay(c.name, c.wire) ?? `wire ${c.wire}`;
  }
  if (c.prefxType !== undefined) {
    // FX-aware route.
    const enumIdx = resolveNrpnValue(findHydraNrpn('prefxtype')!, c.prefxType);
    const fxTypeIdx = Math.round(enumIdx.wire / 8); // FX_TYPES is enumValueScale: 8
    const resolved = resolveFxAwareValue(c.name, c.userInput!, { prefxTypeIdx: fxTypeIdx });
    // Try FX-specific decoder first, then enum table fallback.
    const fx = decodeFxNrpnDisplay(resolved.entry.name, resolved.wire);
    if (fx !== undefined) return fx;
    if (resolved.entry.enumTable) {
      const table = HYDRASYNTH_ENUMS[resolved.entry.enumTable];
      const idx = resolved.entry.enumValueScale
        ? Math.round(resolved.wire / resolved.entry.enumValueScale)
        : resolved.wire;
      return String(table?.[idx] ?? `wire ${resolved.wire}`);
    }
    return `wire ${resolved.wire}`;
  }
  // Generic curated formula path.
  const entry = findHydraNrpn(c.name)!;
  const resolved = resolveNrpnValue(entry, c.userInput!);
  const display = decodeNrpnDisplay(c.name, resolved.wire);
  return display ?? `wire ${resolved.wire}`;
}

let failures = 0;
for (const c of CASES) {
  const got = actualDisplay(c);
  const ok = got === c.expectDisplay;
  if (!ok) {
    failures++;
    console.error(`✗ ${c.desc}`);
    console.error(`    expected: ${c.expectDisplay}`);
    console.error(`    got:      ${got}`);
  } else {
    console.log(`✓ ${c.desc}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures}/${CASES.length} display-formula cases failed.`);
  process.exit(1);
}
console.log(`\n✓ ${CASES.length}/${CASES.length} hydrasynth NRPN display cases pass.`);
