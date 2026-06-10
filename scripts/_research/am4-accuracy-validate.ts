/** Post-apply validation for the 2026-06-09 AM4 accuracy pass. Read-only. */
import { KNOWN_PARAMS, decode, encode, type Param } from '../../packages/fractal-midi/src/am4/params.js';
import { CACHE_PARAMS } from '../../packages/fractal-midi/src/am4/cacheParams.js';

let bad = 0;
let matched = 0;
for (const [key, c] of Object.entries(CACHE_PARAMS) as Array<[string, Param]>) {
  const k = (KNOWN_PARAMS as Record<string, Param>)[key];
  if (!k) { console.log(`MISSING in KNOWN_PARAMS: ${key}`); bad++; continue; }
  const diffs: string[] = [];
  if (c.pidLow !== k.pidLow) diffs.push('pidLow');
  if (c.pidHigh !== k.pidHigh) diffs.push('pidHigh');
  if (c.unit !== k.unit) diffs.push('unit');
  if (c.displayMin !== k.displayMin) diffs.push('displayMin');
  if (c.displayMax !== k.displayMax) diffs.push('displayMax');
  if ((c.scaling ?? 'linear') !== (k.scaling ?? 'linear')) diffs.push('scaling');
  if (!!c.enumValues !== !!k.enumValues) diffs.push('enumPresence');
  else if (c.enumValues && k.enumValues && JSON.stringify(c.enumValues) !== JSON.stringify(k.enumValues)) diffs.push('enumValues');
  if (diffs.length) { console.log(`DIVERGE ${key}: ${diffs.join(',')}`); bad++; } else matched++;
}
console.log(`cache-vs-known: ${matched} matched, ${bad} diverged`);

const P = KNOWN_PARAMS as Record<string, Param>;
const rl = P['reverb.low_cut'];
console.log(`reverb.low_cut scaling=${rl.scaling} decode(0.5)=${decode(rl, 0.5).toFixed(1)} (geo mean of 20..2000 = 200)`);
const rt = P['rotary.low_time_constant'];
console.log(`rotary.low_time_constant unit=${rt.unit} decode(0.5)=${decode(rt, 0.5).toFixed(2)} (geo mean of 0.1..10 = 1)`);
console.log(`encode amp.cab_bass 6 dB -> ${encode(P['amp.cab_bass'], 6)} (db, scale 1)`);
console.log(`cathode_follower_compression present: ${'amp.cathode_follower_compression' in P}`);
console.log(`power_tube_type enum n=${Object.keys(P['amp.power_tube_type'].enumValues!).length}`);
console.log(`low_decay displayUnit='${P['reverb.low_decay'].displayUnit}'`);
console.log(`total KNOWN_PARAMS: ${Object.keys(P).length}`);
if (bad > 0) process.exit(1);
