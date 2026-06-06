/**
 * Extract embedded JUCE-BinaryData resources from a Fractal editor .exe.
 *
 * JUCE bundles editor resources (block/amp layout XML, images, fonts) as
 * an embedded ZIP archive inside the executable. ZIP stores each member
 * with RAW DEFLATE (no zlib/gzip header) behind a `PK\x03\x04` local file
 * header — so a gzip/zlib magic-byte scan finds nothing. This carver
 * walks every local file header, reads the filename + compressed size,
 * and raw-inflates the member. It saves all `*.xml` members (the layout
 * files we mine) and prints the full member filename list.
 *
 * Usage:
 *   npx tsx scripts/_research/extract-editor-layout-xml.ts <exe> <outDir>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';

const exePath = process.argv[2];
const outDir = process.argv[3];
if (!exePath || !outDir) {
  console.error('usage: extract-editor-layout-xml.ts <exe> <outDir>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const buf = readFileSync(exePath);
console.log(`exe: ${exePath} (${(buf.length / 1048576).toFixed(1)} MB)`);

const PK = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

interface Member {
  name: string;
  method: number;
  compSize: number;
  uncompSize: number;
  dataOffset: number;
  flags: number;
}

function safeName(s: string): boolean {
  if (s.length === 0 || s.length > 256) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    // printable ASCII + a couple of path chars; reject control/high bytes
    if (c < 0x20 || c > 0x7e) return false;
  }
  return true;
}

const members: Member[] = [];
let pos = 0;
while ((pos = buf.indexOf(PK, pos)) >= 0) {
  // Local file header layout (see ZIP spec, APPNOTE 4.3.7).
  if (pos + 30 > buf.length) break;
  const flags = buf.readUInt16LE(pos + 6);
  const method = buf.readUInt16LE(pos + 8);
  const compSize = buf.readUInt32LE(pos + 18);
  const uncompSize = buf.readUInt32LE(pos + 22);
  const nameLen = buf.readUInt16LE(pos + 26);
  const extraLen = buf.readUInt16LE(pos + 28);
  const name = buf.toString('latin1', pos + 30, pos + 30 + nameLen);
  // Filter the dense false-positive PK hits in x86 code: a real header
  // has a sane method, a printable filename, and a plausible name length.
  if ((method === 0 || method === 8) && nameLen > 0 && nameLen < 256 && safeName(name)) {
    members.push({
      name,
      method,
      compSize,
      uncompSize,
      dataOffset: pos + 30 + nameLen + extraLen,
      flags,
    });
  }
  pos += 1;
}

console.log(`ZIP local file headers (validated): ${members.length}`);

const xmlMembers = members.filter((m) => /\.xml$/i.test(m.name));
console.log(`\nXML members (${xmlMembers.length}):`);
for (const m of xmlMembers) {
  console.log(
    `  ${m.name.padEnd(34)} method=${m.method} comp=${m.compSize} uncomp=${m.uncompSize} flags=0x${m.flags.toString(16)}`,
  );
}

function extract(m: Member): Buffer | undefined {
  try {
    if (m.method === 0) {
      // stored
      const size = m.uncompSize || 0;
      return buf.subarray(m.dataOffset, m.dataOffset + size);
    }
    // raw deflate. Use comp size when present; else a generous window
    // (inflateRawSync stops at the deflate end-of-stream marker).
    const end =
      m.compSize > 0
        ? m.dataOffset + m.compSize
        : Math.min(m.dataOffset + 16 * 1024 * 1024, buf.length);
    return zlib.inflateRawSync(buf.subarray(m.dataOffset, end));
  } catch (e) {
    console.log(`  ! inflate failed for ${m.name}: ${(e as Error).message}`);
    return undefined;
  }
}

const manifest: Array<Record<string, unknown>> = [];
console.log('');
// Dedupe by filename keeping the largest successful extraction (versioned
// duplicates can appear; the canonical full layout is the biggest).
const byName = new Map<string, { m: Member; out: Buffer }>();
for (const m of xmlMembers) {
  const out = extract(m);
  if (!out || out.length < 64) continue;
  const text = out.toString('latin1', 0, Math.min(out.length, 4096));
  if (!/<\?xml|<EditorControl|parameterName=|<EffectLayouts|<Page /.test(text) && !/parameterName=/.test(out.toString('latin1'))) {
    continue;
  }
  const prev = byName.get(m.name);
  if (!prev || out.length > prev.out.length) byName.set(m.name, { m, out });
}

for (const [name, { m, out }] of byName) {
  const text = out.toString('latin1');
  const ec = (text.match(/<EditorControl\b/g) ?? []).length;
  const pn = (text.match(/parameterName="/g) ?? []).length;
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outPath = `${outDir}/${safe}`;
  writeFileSync(outPath, out);
  console.log(`saved ${name.padEnd(34)} ${out.length}B  EditorControl=${ec}  parameterName=${pn}`);
  manifest.push({ name, file: safe, bytes: out.length, editorControls: ec, parameterNames: pn, method: m.method });
}

writeFileSync(`${outDir}/_manifest.json`, JSON.stringify({ exe: exePath, xml: manifest }, null, 2));
console.log(`\nwrote ${byName.size} XML files + _manifest.json to ${outDir}`);
