#!/usr/bin/env tsx
/**
 * Which HasGeek accounts actually exist, and which are worth seeding?
 *
 * The adapter seeds 7 accounts, but the Bengaluru search surfaced more active hosts —
 * ReactFoo, Meta Refresh, droidconIN, Bangalore Observability Meetup, Papers We Love,
 * Girls Who Javascript, Construkt, 50p, Bangalore Site Speed. Each is one request per run
 * and each is a community that publishes independently of Meetup and Luma, which is the
 * whole reason HasGeek is in the pipeline.
 *
 * Slugs are RESOLVED from the search results rather than guessed. Guessing is what fails in
 * this project: 0 of 35 Meetup slugs, 5 of 36 Bevy hosts, 18 of 107 Luma handles. The one
 * guess already made here — `blrsystems` for Bengaluru Systems Meetup — was a 404.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-hasgeek-accounts.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const BASE = 'https://hasgeek.com';
const JSON_HEADERS = { 'User-Agent': UA, Accept: 'application/json' };

interface Project {
  title?: string;
  start_at?: string;
  location?: string;
  absolute_url?: string;
  account?: { title?: string; absolute_url?: string };
}

/** Harvest account slugs from the search results — the only reliable source of them. */
async function harvestAccounts(): Promise<Map<string, string>> {
  const found = new Map<string, string>(); // slug -> display title
  for (const term of ['bangalore', 'bengaluru', 'meetup', 'conference']) {
    for (let page = 1; page <= 4; page++) {
      try {
        const res = await fetch(
          `${BASE}/search?q=${encodeURIComponent(term)}&type=project&page=${page}`,
          { headers: JSON_HEADERS, signal: AbortSignal.timeout(25000) }
        );
        if (!res.ok) break;
        const body = (await res.json()) as { results?: { items?: Array<{ obj?: Project }> } };
        const items = body.results?.items ?? [];
        if (items.length === 0) break;
        for (const it of items) {
          const acc = it.obj?.account;
          const url = acc?.absolute_url;
          if (!url) continue;
          const slug = url.replace(`${BASE}/`, '').replace(/\/$/, '');
          if (slug && !slug.includes('/')) found.set(slug, acc?.title ?? slug);
        }
      } catch {
        break;
      }
    }
  }
  return found;
}

/** Does this account page return JSON, and does it have anything upcoming? */
async function inspect(slug: string) {
  try {
    const res = await fetch(`${BASE}/${slug}`, {
      headers: JSON_HEADERS,
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return { ok: false, status: res.status, upcoming: 0, next: '' };
    const text = await res.text();
    const now = Date.now();
    const future = [...text.matchAll(/"(20\d{2}-\d{2}-\d{2})T\d{2}:\d{2}/g)]
      .map(m => m[1])
      .filter(d => Date.parse(d) > now)
      .sort();
    return {
      ok: true,
      status: res.status,
      upcoming: new Set(future).size,
      next: future[0] ?? '',
    };
  } catch {
    return { ok: false, status: 0, upcoming: 0, next: '' };
  }
}

async function main() {
  console.log('Harvesting account slugs from search results…\n');
  const accounts = await harvestAccounts();
  console.log(`${accounts.size} distinct account(s) found\n`);

  const rows: Array<{ slug: string; title: string; ok: boolean; status: number; upcoming: number; next: string }> = [];
  for (const [slug, title] of accounts) {
    const r = await inspect(slug);
    rows.push({ slug, title, ...r });
  }

  rows.sort((a, b) => b.upcoming - a.upcoming || a.slug.localeCompare(b.slug));

  console.log('Accounts, by upcoming activity:\n');
  for (const r of rows) {
    const mark = !r.ok ? `HTTP ${r.status}` : r.upcoming > 0 ? 'HAS UPCOMING' : 'quiet';
    console.log(
      `  ${mark.padEnd(13)} ${r.slug.padEnd(22)} ${String(r.upcoming).padStart(2)} future date(s)` +
        `${r.next ? ` next ${r.next}` : ''}   ${r.title.slice(0, 34)}`
    );
  }

  const live = rows.filter(r => r.ok);
  console.log(`\n${live.length} of ${rows.length} accounts return JSON.`);
  console.log('\nSeed list for HASGEEK_SEED_ACCOUNTS (every account that resolves — a quiet');
  console.log('community today is one that publishes next month, and each costs one request):');
  for (const r of live) console.log(`  '${r.slug}',`.padEnd(28) + `// ${r.title.slice(0, 40)}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
