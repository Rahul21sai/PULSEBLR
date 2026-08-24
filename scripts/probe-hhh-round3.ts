#!/usr/bin/env tsx
/**
 * Round 3 on events.heapheaphurray.com: the only question that changes what we build.
 *
 * Rounds 1-2 established what it IS: a single-page Next.js app on Vercel with no event detail
 * pages (every path 404s, including /login and /signup, so nothing is gated and no account is
 * needed), a one-URL sitemap, and 20 JSON-LD events whose `url` points OFF-SITE — 15 to lu.ma,
 * 4 to devfolio.co, 1 to wemakedevs.org.
 *
 * That last fact is the important one. Its upstreams are Luma and Devfolio, and PulseBLR already
 * scrapes BOTH. So it is not a new source of supply; it is a different SELECTION over the same
 * supply. Which makes the actionable question:
 *
 *      Of the events it shows, which ones are missing from PulseBLR's corpus — and why?
 *
 * A miss on a Luma event means our Luma coverage has a hole (a calendar we do not know, or a
 * city we do not fetch). A miss on Devfolio means our filter dropped it. Either is a bug we can
 * fix; "they have events we don't" on its own is not diagnostic.
 *
 * Also counts events in the RSC payload rather than only the JSON-LD, because SEO markup is
 * routinely capped at the first page while the rendered list is longer — 20 in JSON-LD is not
 * proof of a 20-event corpus.
 *
 * Read-only against both the site and our database. No writes.
 *
 * Run: npx tsx scripts/probe-hhh-round3.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

const HOST = 'https://events.heapheaphurray.com';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

async function get(url: string) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-IN,en;q=0.9' },
    signal: AbortSignal.timeout(30000),
  });
  return res.text();
}

interface TheirEvent {
  name: string;
  startDate: string;
  url: string;
  city: string;
  keywords: string;
  mode: string;
}

function extractJsonLdEvents(html: string): TheirEvent[] {
  const out: TheirEvent[] = [];
  for (const b of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    try { parsed = JSON.parse(b[1]); } catch { continue; }
    const stack: unknown[] = [parsed];
    const seen = new Set<unknown>();
    while (stack.length) {
      const n = stack.pop();
      if (!n || typeof n !== 'object' || seen.has(n)) continue;
      seen.add(n);
      if (Array.isArray(n)) { stack.push(...n); continue; }
      const o = n as Record<string, unknown>;
      const t = o['@type'];
      if ((Array.isArray(t) ? t : [t]).some(x => typeof x === 'string' && /Event$/i.test(x))) {
        const loc = o.location as Record<string, unknown> | undefined;
        const addr = loc?.address as Record<string, unknown> | string | undefined;
        out.push({
          name: String(o.name ?? ''),
          startDate: String(o.startDate ?? ''),
          url: String(o.url ?? ''),
          city:
            typeof addr === 'string'
              ? addr
              : String((addr?.addressLocality as string) ?? (loc?.name as string) ?? ''),
          keywords: Array.isArray(o.keywords) ? o.keywords.join(', ') : String(o.keywords ?? ''),
          mode: String(o.eventAttendanceMode ?? '').replace(/.*\//, ''),
        });
      }
      stack.push(...Object.values(o));
    }
  }
  return out;
}

/** Luma slug from a lu.ma URL, which is the join key our own Luma rows carry. */
function lumaSlug(url: string): string | null {
  const m = url.match(/lu\.ma\/([a-z0-9-]+)/i);
  return m ? m[1].toLowerCase() : null;
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

async function main() {
  const html = await get(`${HOST}/`);

  console.log('════ 1. How many events does the page really hold? ════\n');
  const jsonLd = extractJsonLdEvents(html);
  console.log(`  JSON-LD Event nodes:        ${jsonLd.length}`);

  // The RSC payload is where an App Router page puts its real data. Count distinct lu.ma /
  // devfolio links there — if it exceeds the JSON-LD count, the markup is capped for SEO.
  const allLinks = new Set<string>();
  for (const m of html.matchAll(/https?:\\?\/\\?\/(?:lu\.ma|[a-z0-9-]+\.devfolio\.co|www\.wemakedevs\.org)[^"'\\\s)]{0,60}/gi)) {
    allLinks.add(m[0].replace(/\\/g, ''));
  }
  console.log(`  distinct upstream links in the whole payload: ${allLinks.size}`);
  console.log(`  → ${allLinks.size > jsonLd.length ? 'JSON-LD IS CAPPED; the rendered list is longer' : 'JSON-LD covers everything the page holds'}`);

  const byHost = new Map<string, number>();
  for (const l of allLinks) {
    const h = l.match(/^https?:\/\/([^/]+)/)?.[1] ?? '?';
    byHost.set(h, (byHost.get(h) ?? 0) + 1);
  }
  console.log('\n  upstream hosts:');
  for (const [h, n] of [...byHost.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${h}`);
  }

  console.log('\n════ 2. Their keyword taxonomy (100% coverage — ours is categories) ════\n');
  const kw = new Map<string, number>();
  for (const e of jsonLd) {
    for (const k of e.keywords.split(',').map(s => s.trim()).filter(Boolean)) {
      kw.set(k, (kw.get(k) ?? 0) + 1);
    }
  }
  for (const [k, n] of [...kw.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${k}`);
  }

  console.log('\n════ 3. Cities they cover vs our single city ════\n');
  const cities = new Map<string, number>();
  for (const e of jsonLd) cities.set(e.city || '(none)', (cities.get(e.city || '(none)') ?? 0) + 1);
  for (const [c, n] of [...cities.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(3)}  ${c}`);
  }

  console.log('\n════ 4. OVERLAP: which of theirs are missing from PulseBLR? ════\n');
  await connectDB();

  const ours = await Event.find(
    {},
    { title: 1, sourceUrl: 1, applyLink: 1, source: 1, startDateTime: 1, isTechEvent: 1, city: 1 }
  ).lean();
  console.log(`  our corpus: ${ours.length} events\n`);

  // Index our rows three ways, because a match on any of them is a match.
  const ourSlugs = new Map<string, (typeof ours)[number]>();
  const ourTitles = new Map<string, (typeof ours)[number]>();
  for (const o of ours) {
    for (const u of [o.sourceUrl, o.applyLink]) {
      const s = u ? lumaSlug(String(u)) : null;
      if (s) ourSlugs.set(s, o);
    }
    ourTitles.set(normTitle(String(o.title ?? '')), o);
  }

  let matched = 0;
  const missing: TheirEvent[] = [];

  for (const t of jsonLd) {
    const slug = lumaSlug(t.url);
    const bySlug = slug ? ourSlugs.get(slug) : undefined;
    const byTitle = ourTitles.get(normTitle(t.name));
    const hit = bySlug ?? byTitle;

    if (hit) {
      matched++;
      console.log(`  HAVE   ${t.name.slice(0, 50).padEnd(50)} via ${bySlug ? 'luma slug' : 'title'}  [${hit.source}]`);
    } else {
      missing.push(t);
    }
  }

  console.log(`\n  matched ${matched}/${jsonLd.length}   MISSING ${missing.length}/${jsonLd.length}\n`);

  console.log('  ── MISSING, with the diagnosis for each ──');
  for (const t of missing) {
    const slug = lumaSlug(t.url);
    const isBlr = /bengaluru|bangalore/i.test(t.city);
    const reason = !isBlr
      ? 'NOT BENGALURU — correctly out of scope for a Bengaluru product'
      : slug
        ? 'BENGALURU + Luma → a Luma calendar we do not know about. ACTIONABLE.'
        : 'BENGALURU + non-Luma → check the source adapter. ACTIONABLE.';
    console.log(`    ${t.startDate.slice(0, 10)}  ${t.name.slice(0, 46).padEnd(46)} ${t.city.slice(0, 14).padEnd(14)}`);
    console.log(`              ${t.url.slice(0, 76)}`);
    console.log(`              ${reason}`);
  }

  const blrMissing = missing.filter(t => /bengaluru|bangalore/i.test(t.city));
  console.log(`\n  Bengaluru events they have and we do NOT: ${blrMissing.length}`);
  console.log('  That number is the whole verdict on them as a source. Anything else they show is');
  console.log('  either another city (out of scope) or something we already have.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
