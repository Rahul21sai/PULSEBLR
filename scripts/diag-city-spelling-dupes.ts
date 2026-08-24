#!/usr/bin/env tsx
/**
 * Does cross-source dedup survive the two spellings of this city?
 *
 * Found while auditing events.heapheaphurray.com. Its listing said
 * "Founders Running Club :: Bengaluru" and our corpus held "Founders Running Club :: Bangalore"
 * from Meetup — the same event, spelled differently, which is why an exact-title overlap check
 * reported it as missing when it was not.
 *
 * That is a bug in a throwaway probe. The concerning part is what it implies about `clusterKey`,
 * which is the mechanism that stops the same event appearing twice in the feed when two platforms
 * both list it. It is built from a NORMALIZED TITLE plus the IST calendar day. If normalization
 * does not fold Bangalore and Bengaluru together, then:
 *
 *     "Founders Running Club :: Bangalore"  (Meetup)
 *     "Founders Running Club :: Bengaluru"  (Luma)
 *
 * produce two different keys, never match, and both render — as two cards for one event. This is
 * the single most common name variation in the entire corpus's home city, and organisers use both
 * spellings freely (`developers.events` uses "Bangalore"; District uses both in its slugs).
 *
 * This checks the real generator against the real corpus rather than reasoning about it: it asks
 * whether the two spellings collide, then hunts the corpus for actual pairs that differ only by
 * that word.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-city-spelling-dupes.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/** Strip the city word entirely, to find pairs that are otherwise identical. */
function cityAgnostic(title: string): string {
  return String(title)
    .toLowerCase()
    .replace(/\b(bengaluru|bangalore|blr)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

async function main() {
  await connectDB();

  console.log('════ 1. Does the real clusterKey generator fold the two spellings? ════\n');
  const EventModel = Event as unknown as {
    generateClusterKey?: (title: string, start: Date) => string;
  };
  const when = new Date('2026-08-30T07:30:00+05:30');

  if (typeof EventModel.generateClusterKey === 'function') {
    const a = EventModel.generateClusterKey('Founders Running Club :: Bangalore', when);
    const b = EventModel.generateClusterKey('Founders Running Club :: Bengaluru', when);
    console.log(`  Bangalore → ${a}`);
    console.log(`  Bengaluru → ${b}`);
    console.log(`\n  COLLIDE (same key, so dedup works)?  ${a === b ? 'YES' : 'NO — two cards for one event'}`);
  } else {
    console.log('  generateClusterKey is not exposed as a static; skipping the direct check.');
  }

  console.log('\n════ 2. Real pairs in the corpus that differ ONLY by the city spelling ════\n');
  const now = new Date();
  const rows = await Event.find(
    { $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }] },
    { title: 1, source: 1, startDateTime: 1, clusterKey: 1, city: 1 }
  ).lean();

  console.log(`  ${rows.length} upcoming events\n`);

  // Group by (city-agnostic title + IST day). Anything with 2+ rows AND 2+ distinct clusterKeys
  // is a dedup miss: same event, same day, different key.
  const groups = new Map<string, typeof rows>();
  for (const r of rows) {
    const t = cityAgnostic(String(r.title ?? ''));
    if (!t) continue;
    const istDay = new Date(new Date(r.startDateTime as unknown as string).getTime() + 5.5 * 3600_000)
      .toISOString()
      .slice(0, 10);
    const key = `${t}|${istDay}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }

  let missed = 0;
  let spellingPairs = 0;

  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const keys = new Set(group.map(g => String(g.clusterKey ?? '')));
    if (keys.size < 2) continue; // already collapsed, or will be

    // Does the group actually contain BOTH spellings? That is the specific failure mode.
    const titles = group.map(g => String(g.title ?? ''));
    const hasBangalore = titles.some(t => /\bbangalore\b/i.test(t));
    const hasBengaluru = titles.some(t => /\bbengaluru\b/i.test(t));
    const isSpelling = hasBangalore && hasBengaluru;
    if (isSpelling) spellingPairs++;
    missed++;

    console.log(`  ${isSpelling ? 'SPELLING' : 'other   '}  ${key.slice(0, 62)}`);
    for (const g of group) {
      console.log(`      [${String(g.source).padEnd(10)}] ${String(g.title).slice(0, 56).padEnd(56)} key=${String(g.clusterKey ?? '—').slice(0, 34)}`);
    }
    console.log('');
    if (missed >= 25) { console.log('  … truncated at 25 groups'); break; }
  }

  console.log(`\n  groups sharing a city-agnostic title + day but NOT a clusterKey: ${missed}`);
  console.log(`  of those, caused specifically by Bangalore vs Bengaluru:          ${spellingPairs}`);
  console.log('');
  console.log('  A non-zero spelling count means the feed is showing duplicate cards for events');
  console.log('  that two sources spell differently. The fix belongs in the clusterKey normalizer,');
  console.log('  NOT in a cleanup script — cleanup collapses what already leaked, normalization');
  console.log('  stops it recurring on every scrape.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
