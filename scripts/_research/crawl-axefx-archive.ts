/**
 * Exhaustive crawler for archive.axefx.fr (Apache-style autoindex).
 *
 * Goal: guarantee we have a COMPLETE manifest of every file on the mirror so no
 * protocol / MIDI / SysEx document can be missed, then auto-download the small
 * text-class spec docs (the high-value RE material). Large binaries (firmware,
 * preset banks, IRs, amp-model gallery PDFs) are listed in the manifest but NOT
 * downloaded by default, run with `--download-all` to pull everything.
 *
 *   npx tsx scripts/_research/crawl-axefx-archive.ts            # manifest + spec docs
 *   npx tsx scripts/_research/crawl-axefx-archive.ts --manifest # manifest only
 *   npx tsx scripts/_research/crawl-axefx-archive.ts --download-all
 *
 * Read-only against the network; writes under scripts/_research/archive-crawl/.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, 'archive-crawl');
const MIRROR_DIR = join(OUT_DIR, 'mirror');
const ROOT = 'https://archive.axefx.fr/';

const args = new Set(process.argv.slice(2));
const MANIFEST_ONLY = args.has('--manifest');
const DOWNLOAD_ALL = args.has('--download-all');

// Text-class doc extensions worth pulling automatically (small, spec-bearing).
const SPEC_EXT = new Set(['htm', 'html', 'txt', 'rtf', 'csv', 'md', 'nfo']);
// Anything whose NAME hints at protocol material, pull regardless of extension.
const SPEC_NAME = /midi|sysex|spec|protocol|parameter|param|opcode|cc\b|nrpn/i;
// Bulk binaries: manifest only unless --download-all.
const BULK_EXT = new Set(['rar', 'zip', '7z', 'syx', 'exe', 'msi', 'dmg', 'pkg', 'bin', 'wav', 'mp4', 'mp3', 'jpg', 'jpeg', 'png', 'gif']);

interface FileEntry {
  url: string;
  path: string; // path relative to ROOT
  name: string;
  ext: string;
  sizeText: string;
  dir: string; // top-level folder
}

const files: FileEntry[] = [];
const visited = new Set<string>();
const errors: string[] = [];

function ext(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,5})$/i);
  return m ? m[1].toLowerCase() : '';
}

function topFolder(path: string): string {
  const seg = path.replace(/^\/+/, '').split('/')[0];
  return decodeURIComponent(seg || '(root)');
}

/** Parse an autoindex directory listing into {subdirs, files}. */
function parseListing(baseUrl: string, html: string): { subdirs: string[]; files: { url: string; name: string; sizeText: string }[] } {
  const subdirs: string[] = [];
  const fileLinks: { url: string; name: string; sizeText: string }[] = [];

  // Rows usually look like: <a href="NAME/">NAME/</a> ... date ... size
  const rowRe = /<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>([^\n<]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const href = m[1];
    const tail = (m[3] || '').trim();
    // Skip sort-column links, parent links, query/anchor links, absolute offsite.
    if (href.startsWith('?') || href.startsWith('#')) continue;
    if (href === '/' || href === '../' || href.toLowerCase().startsWith('http')) continue;
    if (/parent directory/i.test(m[2])) continue;

    let resolved: URL;
    try {
      resolved = new URL(href, baseUrl);
    } catch {
      continue;
    }
    // Stay on host and below ROOT.
    if (resolved.host !== new URL(ROOT).host) continue;
    if (!resolved.pathname.startsWith(new URL(ROOT).pathname)) continue;

    // size is the last whitespace-delimited token on the row tail (e.g. "12K", "4.0M", "-")
    const sizeMatch = tail.match(/([\d.]+[KMG]?|-)\s*$/);
    const sizeText = sizeMatch ? sizeMatch[1] : '';

    if (href.endsWith('/')) {
      subdirs.push(resolved.toString());
    } else {
      const name = decodeURIComponent(resolved.pathname.split('/').pop() || '');
      if (!name) continue;
      fileLinks.push({ url: resolved.toString(), name, sizeText });
    }
  }
  return { subdirs, files: fileLinks };
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': 'mcp-midi-tools archive inventory (research)' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function crawl(): Promise<void> {
  const queue: string[] = [ROOT];
  while (queue.length) {
    const dir = queue.shift()!;
    if (visited.has(dir)) continue;
    visited.add(dir);
    let html: string;
    try {
      html = await fetchText(dir);
    } catch (e) {
      errors.push(`${dir}: ${(e as Error).message}`);
      continue;
    }
    const { subdirs, files: fl } = parseListing(dir, html);
    for (const sd of subdirs) if (!visited.has(sd)) queue.push(sd);
    for (const f of fl) {
      const path = decodeURIComponent(new URL(f.url).pathname.replace(new URL(ROOT).pathname, ''));
      files.push({
        url: f.url,
        path,
        name: f.name,
        ext: ext(f.name),
        sizeText: f.sizeText,
        dir: topFolder(path),
      });
    }
    process.stdout.write(`\rcrawled dirs=${visited.size} files=${files.length} queue=${queue.length}   `);
  }
  process.stdout.write('\n');
}

function isSpecDoc(f: FileEntry): boolean {
  if (SPEC_NAME.test(f.name)) return true;
  return SPEC_EXT.has(f.ext);
}

async function download(f: FileEntry): Promise<boolean> {
  const dest = join(MIRROR_DIR, f.path);
  if (existsSync(dest)) return true;
  try {
    const res = await fetch(f.url, { headers: { 'User-Agent': 'mcp-midi-tools archive inventory (research)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    return true;
  } catch (e) {
    errors.push(`download ${f.url}: ${(e as Error).message}`);
    return false;
  }
}

function summarize(): string {
  const byExt = new Map<string, number>();
  const byDir = new Map<string, number>();
  for (const f of files) {
    byExt.set(f.ext || '(none)', (byExt.get(f.ext || '(none)') ?? 0) + 1);
    byDir.set(f.dir, (byDir.get(f.dir) ?? 0) + 1);
  }
  const specDocs = files.filter(isSpecDoc);
  const protocolHits = files.filter((f) => SPEC_NAME.test(f.name));

  const L: string[] = [];
  L.push('# archive.axefx.fr complete file manifest');
  L.push('');
  L.push(`- Directories crawled: ${visited.size}`);
  L.push(`- Total files: ${files.length}`);
  L.push(`- Spec/text-class docs (auto-download candidates): ${specDocs.length}`);
  L.push(`- Name-matched protocol/MIDI/SysEx hits: ${protocolHits.length}`);
  if (errors.length) L.push(`- Errors: ${errors.length} (see manifest.json)`);
  L.push('');
  L.push('## Files by top-level folder');
  L.push('');
  L.push('| Folder | Files |');
  L.push('|---|---|');
  for (const [d, n] of [...byDir.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${d} | ${n} |`);
  L.push('');
  L.push('## Files by extension');
  L.push('');
  L.push('| Ext | Files |');
  L.push('|---|---|');
  for (const [e, n] of [...byExt.entries()].sort((a, b) => b[1] - a[1])) L.push(`| ${e} | ${n} |`);
  L.push('');
  L.push('## Name-matched protocol / MIDI / SysEx / parameter docs (HIGH INTEREST)');
  L.push('');
  if (protocolHits.length === 0) L.push('_none_');
  for (const f of protocolHits.sort((a, b) => a.path.localeCompare(b.path))) {
    L.push(`- \`${f.path}\` (${f.sizeText || '?'}) -> ${f.url}`);
  }
  L.push('');
  L.push('## All spec/text-class docs');
  L.push('');
  for (const f of specDocs.sort((a, b) => a.path.localeCompare(b.path))) {
    L.push(`- \`${f.path}\` (${f.ext}, ${f.sizeText || '?'})`);
  }
  return L.join('\n');
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log('Crawling archive.axefx.fr ...');
  await crawl();

  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify({ root: ROOT, dirs: [...visited], files, errors }, null, 2));
  writeFileSync(join(OUT_DIR, 'manifest.md'), summarize());
  console.log(`manifest -> ${join(OUT_DIR, 'manifest.md')}`);

  if (MANIFEST_ONLY) {
    console.log('manifest-only mode; skipping downloads.');
    return;
  }

  const toDownload = files.filter((f) => {
    if (DOWNLOAD_ALL) return true;
    if (SPEC_NAME.test(f.name)) return true;
    if (BULK_EXT.has(f.ext)) return false;
    return SPEC_EXT.has(f.ext);
  });
  console.log(`Downloading ${toDownload.length} files into ${MIRROR_DIR} ...`);
  let ok = 0;
  for (const f of toDownload) {
    if (await download(f)) ok++;
    process.stdout.write(`\rdownloaded ${ok}/${toDownload.length}   `);
  }
  process.stdout.write('\n');
  if (errors.length) console.log(`${errors.length} errors (see manifest.json)`);
  console.log('done.');
}

main();
