/**
 * Enumerate the TRUE set of Axe-Fx II amp params that surface as opaque
 * (no display calibration → raw wire integer) through the shared
 * param-kind resolver.
 *
 * This is the grounded input list for the calibration-overlay workflow.
 * Grepping params.ts over-counts: many uncalibrated catalog entries are
 * rescued at resolve time by AM4_SHARED or the SUFFIX_RULES in
 * calibration.ts. A param is only genuinely opaque (the get_preset
 * deep-amp-decode bug) when resolveAxeFxIIParamKind returns no
 * `decodeWire` closure.
 *
 * Read-only. Run: npx tsx scripts/_research/enumerate-ii-opaque-amp-params.ts
 */
import { resolveAxeFxIIParamKind } from '../../packages/fractal-gen2/src/calibration.js';
import { KNOWN_PARAMS, type AxeFxIIParam } from 'fractal-midi/gen2/axe-fx-ii';

interface Row {
  key: string;
  name: string;
  paramId: number;
  controlType: string;
  parameterName?: string;
  xmlLabel?: string;
  unit: string;
  hasDecode: boolean;
}

const rows: Row[] = [];
for (const key of Object.keys(KNOWN_PARAMS)) {
  const p = KNOWN_PARAMS[key as keyof typeof KNOWN_PARAMS] as AxeFxIIParam;
  if (p.block !== 'amp') continue;
  const kind = resolveAxeFxIIParamKind(p.block, p.name);
  const hasDecode = kind?.decodeWire !== undefined;
  rows.push({
    key,
    name: p.name,
    paramId: p.paramId,
    controlType: p.controlType,
    parameterName: (p as { parameterName?: string }).parameterName,
    xmlLabel: (p as { xmlLabel?: string }).xmlLabel,
    unit: kind?.unit ?? '(unresolved)',
    hasDecode,
  });
}

const opaque = rows.filter((r) => !r.hasDecode);
opaque.sort((a, b) => a.paramId - b.paramId);

console.log(`amp params total: ${rows.length}`);
console.log(`amp params with decodeWire (decode OK): ${rows.length - opaque.length}`);
console.log(`amp params OPAQUE (raw wire in get_preset): ${opaque.length}\n`);
console.log('paramId\tname\tcontrolType\tunit\tparameterName\txmlLabel');
for (const r of opaque) {
  console.log(
    `${r.paramId}\t${r.name}\t${r.controlType}\t${r.unit}\t${r.parameterName ?? ''}\t${(r.xmlLabel ?? '').replace(/\n/g, ' ')}`,
  );
}

// Emit a JSON block the workflow can consume verbatim.
console.log('\n---JSON---');
console.log(JSON.stringify(opaque.map((r) => ({
  key: r.key,
  name: r.name,
  paramId: r.paramId,
  controlType: r.controlType,
  parameterName: r.parameterName,
  xmlLabel: r.xmlLabel,
})), null, 2));
