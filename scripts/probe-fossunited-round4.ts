#!/usr/bin/env tsx
/**
 * Round 4: is the FOSS United <time datetime> actually the event start?
 *
 * Round 3 established the shape — the chapter page lists 22 /c/bengaluru/* event links, and
 * each event page carries <time datetime>, og:title and og:description. That combination is
 * parseable WITHOUT selector guessing, because <time datetime> and og: are both standards
 * rather than someone's CSS class names. But "there is a <time> element" is not the same as
 * "the event start is in it", and the difference decides whether an adapter is possible.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-fossunited-round4.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html' },
    signal: AbortSignal.timeout(25000),
    redirect: 'follow',
  });
  return { status: res.status, text: await res.text() };
}

function meta(html: string, prop: string): string | undefined {
  return (
    html.match(new RegExp(`property=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i'))?.[1] ??
    html.match(new RegExp(`content=["']([^"']+)["'][^>]*property=["']${prop}["']`, 'i'))?.[1]
  );
}

async function main() {
  // Take the chapter index, then read the newest few event pages in full.
  const index = await get('https://fossunited.org/c/bengaluru');
  const links = [
    ...new Set(
      [...index.text.matchAll(/href=["'](\/c\/bengaluru\/[a-z0-9][a-z0-9/_-]{2,60})["']/gi)].map(m => m[1])
    ),
  ];
  console.log(`chapter index lists ${links.length} event page(s)\n`);

  for (const link of links.slice(0, 5)) {
    const url = `https://fossunited.org${link}`;
    const page = await get(url);
    console.log(`── ${link}  (${page.status}, ${page.text.length}B)`);

    console.log(`   og:title       ${meta(page.text, 'og:title') ?? '-'}`);
    console.log(`   og:description ${(meta(page.text, 'og:description') ?? '-').slice(0, 80)}`);
    console.log(`   og:image       ${(meta(page.text, 'og:image') ?? '-').slice(0, 70)}`);

    // Every <time datetime> on the page, which is the candidate start.
    const times = [...page.text.matchAll(/<time[^>]*datetime=["']([^"']+)["'][^>]*>([^<]{0,40})/gi)];
    console.log(`   <time> elements: ${times.length}`);
    for (const t of times.slice(0, 4)) {
      const parsed = new Date(t[1]);
      const valid = !Number.isNaN(parsed.getTime());
      console.log(
        `      datetime="${t[1]}"  ${valid ? parsed.toISOString() : 'UNPARSEABLE'}  text="${t[2].trim().slice(0, 26)}"`
      );
    }

    // Venue / city, which the feed needs for the geo gate.
    for (const [label, re] of [
      ['Bengaluru mentioned', /bengaluru|bangalore/i],
      ['venue-ish label', /\b(venue|location|address)\b/i],
    ] as Array<[string, RegExp]>) {
      console.log(`   ${label.padEnd(22)} ${re.test(page.text) ? 'YES' : 'no'}`);
    }
    console.log('');
  }

  console.log('DECISION RULE: an adapter is viable if <time datetime> parses to the event start');
  console.log('on most pages. If the only <time> values are post dates or comment timestamps,');
  console.log('it is not, and FOSS United stays out of the pipeline.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
