#!/usr/bin/env tsx
/**
 * scripts/_research/scrape-fractal-wiki.ts
 *
 * Systematic enumeration of the Fractal Audio MediaWiki instances via the
 * `list=allpages` API, so we have a COMPLETE page inventory instead of
 * discovering protocol docs one URL at a time. Walks apcontinue to the end,
 * filters the gift-card spam that pollutes the gen1 wiki, and flags pages whose
 * titles look protocol/MIDI/SysEx-relevant.
 *
 * Output: writes the full title list per wiki to samples/ (gitignored scratch)
 * and prints the protocol-relevant matches to stdout.
 *
 * Run: npx tsx scripts/_research/scrape-fractal-wiki.ts
 */
import fs from 'node:fs';
import path from 'node:path';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36';

const WIKIS = [
  { name: 'gen1', api: 'https://wiki.fractalaudio.com/gen1/api.php' },
  { name: 'modern', api: 'https://wiki.fractalaudio.com/wiki/api.php' },
];

// Title keywords worth a human look (protocol / MIDI / control surface).
const RELEVANT =
  /sysex|midi|parameter|param|effect|block|controller|\bcc\b|nrpn|fractal.?bot|preset|patch|dump|spec|message|function|scene|channel|bank|tempo|modifier|firmware|axe-?edit|remote/i;

// Obvious spam signature on the gen1 wiki.
const SPAM =
  /gift card|generator|gen2026|codes?\)|free .* (robux|v-?bucks|coins)|crypto|casino|\bnsfw\b|porn|escort/i;

interface Page { pageid: number; title: string; ns: number }

async function fetchAllPages(api: string): Promise<Page[]> {
  const pages: Page[] = [];
  let apcontinue: string | undefined;
  for (let guard = 0; guard < 200; guard++) {
    const url = new URL(api);
    url.searchParams.set('action', 'query');
    url.searchParams.set('list', 'allpages');
    url.searchParams.set('aplimit', '500');
    url.searchParams.set('format', 'json');
    if (apcontinue) url.searchParams.set('apcontinue', apcontinue);
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`${api}: HTTP ${res.status}`);
    const json = (await res.json()) as {
      query?: { allpages?: Page[] };
      continue?: { apcontinue?: string };
    };
    for (const p of json.query?.allpages ?? []) pages.push(p);
    apcontinue = json.continue?.apcontinue;
    if (!apcontinue) break;
  }
  return pages;
}

async function main() {
  const outDir = path.resolve(import.meta.dirname, '../../samples/wiki-inventory');
  fs.mkdirSync(outDir, { recursive: true });

  for (const wiki of WIKIS) {
    process.stdout.write(`\n================ ${wiki.name} (${wiki.api}) ================\n`);
    const all = await fetchAllPages(wiki.api);
    const spam = all.filter((p) => SPAM.test(p.title));
    const real = all.filter((p) => !SPAM.test(p.title));
    const relevant = real.filter((p) => RELEVANT.test(p.title));

    fs.writeFileSync(
      path.join(outDir, `${wiki.name}-all-titles.txt`),
      real.map((p) => p.title).sort().join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(outDir, `${wiki.name}-relevant.txt`),
      relevant.map((p) => p.title).sort().join('\n') + '\n',
    );

    console.log(`  total pages:    ${all.length}`);
    console.log(`  spam filtered:  ${spam.length}`);
    console.log(`  real pages:     ${real.length}`);
    console.log(`  protocol-relevant titles (${relevant.length}):`);
    for (const p of relevant.sort((a, b) => a.title.localeCompare(b.title))) {
      console.log(`    - ${p.title}`);
    }
  }
  console.log(`\nFull title lists written to samples/wiki-inventory/.`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
