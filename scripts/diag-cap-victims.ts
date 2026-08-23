#!/usr/bin/env tsx
/**
 * Did the Meetup group cap cause the "company events" gap?
 *
 * Two findings arrived separately and look like they are the same finding:
 *
 *   · diag-source-caps.ts: 200 Meetup groups known, cap 120, so 80 dropped — the SAME 80 every
 *     run, because the query had no sort and the slice took a stable order. The visible tail
 *     started around "l" alphabetically, so late-alphabet handles were never scraped.
 *   · diag-organizers.ts: 26 registry companies have no upcoming events, including ServiceNow,
 *     ThoughtWorks, Razorpay, Zomato, Zerodha, Zoho — conspicuously late in the alphabet.
 *
 * CLAUDE.md names `servicenow-bangalore` and `thoughtworks-bangalore` as company-run Meetup
 * groups that DO yield. If those sit past the cap, then "company events" was never a supply
 * problem: the groups were discovered, stored, and then skipped on every single run.
 *
 * This checks the old ordering (unsorted, as it was) against the new one (yield-ranked) and
 * reports which named handles each would drop. Read-only — it does not scrape.
 *
 * Run: npx tsx scripts/diag-cap-victims.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Source from '../lib/models/Source';
import mongoose from 'mongoose';

/** Company- and community-run groups whose absence was blamed on supply. */
const NAMED = [
  'servicenow', 'thoughtworks', 'razorpay', 'zomato', 'zerodha', 'zoho', 'meesho',
  'microsoft', 'owasp', 'lfdt', 'makers', 'docker', 'mongodb', 'postman', 'browserstack',
  'hasura', 'walmart', 'wipro', 'infosys', 'sap', 'ibm', 'adobe', 'samsung', 'vmware',
];

const OLD_CAP = 120;
const NEW_CAP = 260;

async function main() {
  await connectDB();

  type Row = {
    name?: string;
    handle?: string;
    lastScrapedAt?: Date;
    lastEventCount?: number;
    consecutiveEmptyScrapes?: number;
  };

  const rows = (await Source.find({ kind: 'meetup-group', enabled: true })
    .select('name handle lastScrapedAt lastEventCount consecutiveEmptyScrapes')
    .lean()) as Row[];

  console.log(`${rows.length} enabled meetup-group source(s)\n`);

  // The OLD behaviour: whatever order Mongo returned, sliced.
  const oldOrder = rows.filter(r => r.handle);
  const oldKept = new Set(oldOrder.slice(0, OLD_CAP).map(r => r.handle));

  // The NEW behaviour: yield-ranked (mirrors loadDiscovered in pipeline.ts).
  const rank = (r: Row) => (!r.lastScrapedAt ? 0 : (r.lastEventCount ?? 0) > 0 ? 1 : 2);
  const newOrder = [...oldOrder].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    const byYield = (b.lastEventCount ?? 0) - (a.lastEventCount ?? 0);
    if (byYield !== 0) return byYield;
    return (a.consecutiveEmptyScrapes ?? 0) - (b.consecutiveEmptyScrapes ?? 0);
  });
  const newKept = new Set(newOrder.slice(0, NEW_CAP).map(r => r.handle));

  console.log(`OLD: cap ${OLD_CAP}, unsorted → ${oldOrder.length - Math.min(OLD_CAP, oldOrder.length)} dropped`);
  console.log(`NEW: cap ${NEW_CAP}, yield-ranked → ${Math.max(0, oldOrder.length - NEW_CAP)} dropped\n`);

  console.log('── named handles: was it scraped before, is it scraped now?\n');
  let rescued = 0;

  for (const needle of NAMED) {
    const matches = oldOrder.filter(r =>
      `${r.handle ?? ''} ${r.name ?? ''}`.toLowerCase().includes(needle)
    );
    if (matches.length === 0) {
      console.log(`  ${needle.padEnd(15)} no such group discovered — genuine gap, seed or leave`);
      continue;
    }
    for (const m of matches) {
      const wasKept = oldKept.has(m.handle);
      const isKept = newKept.has(m.handle);
      if (!wasKept && isKept) rescued++;
      const verdict = !wasKept && isKept
        ? 'RESCUED — was never scraped, now will be'
        : wasKept && isKept
          ? 'was and is scraped'
          : !wasKept && !isKept
            ? 'still dropped'
            : 'was scraped, now dropped (investigate)';
      console.log(
        `  ${needle.padEnd(15)} ${String(m.handle).slice(0, 34).padEnd(34)} ` +
          `lastEvents=${String(m.lastEventCount ?? '-').padStart(3)}  ${verdict}`
      );
    }
  }

  console.log(`\n  RESCUED by the fix: ${rescued} named group(s) that were never being scraped.`);
  console.log('  Their absence from the feed read as a supply gap. It was a cap.');

  // Also: how many groups had NEVER been scraped at all under the old order?
  const neverScraped = oldOrder.filter(r => !r.lastScrapedAt);
  const neverScrapedDropped = neverScraped.filter(r => !oldKept.has(r.handle));
  console.log(`\n  groups never scraped at all: ${neverScraped.length}`);
  console.log(`  of those, dropped by the OLD cap: ${neverScrapedDropped.length} ← could never prove themselves`);
  console.log(`  the new order puts never-scraped FIRST, so each gets its first look.`);

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
