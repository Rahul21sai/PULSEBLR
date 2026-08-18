#!/usr/bin/env tsx
/**
 * Does the admin dashboard's data layer produce real, self-consistent numbers?
 *
 * GET /api/admin/stats requires an admin session, and Google OAuth cannot be completed
 * headlessly, so the HTTP path cannot be exercised here. This runs the same queries
 * against the same database and asserts the invariants the dashboard's UI assumes —
 * which is the part that would actually be wrong if a query were mis-written.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-admin-stats.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import Source from '../lib/models/Source';
import TrackerEntry from '../lib/models/TrackerEntry';
import User from '../lib/models/User';

let failures = 0;
function check(label: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

async function main() {
  await connectDB();
  const now = new Date();
  const dayAgo = new Date(now.getTime() - 24 * 3600 * 1000);

  const total = await Event.countDocuments({});
  const upcoming = await Event.countDocuments({ startDateTime: { $gte: now } });
  const tech = await Event.countDocuments({ startDateTime: { $gte: now }, isTechEvent: true });
  const addedToday = await Event.countDocuments({ createdAt: { $gte: dayAgo } });
  const withoutClusterKey = await Event.countDocuments({
    $or: [{ clusterKey: { $exists: false } }, { clusterKey: null }, { clusterKey: '' }],
  });

  const sources = await Source.find({})
    .select('enabled lastScrapedAt lastEventCount consecutiveEmptyScrapes')
    .lean();
  const producing = sources.filter(s => (s.lastEventCount || 0) > 0).length;
  const quiet = sources.filter(s => s.lastScrapedAt && (s.lastEventCount || 0) === 0).length;
  const never = sources.filter(s => !s.lastScrapedAt).length;
  const dead = sources.filter(s => (s.consecutiveEmptyScrapes || 0) >= 6).length;

  const users = await User.countDocuments({});
  const trackerEntries = await TrackerEntry.countDocuments({});

  console.log('Corpus');
  console.log(`  total=${total}  upcoming=${upcoming}  tech=${tech}  addedIn24h=${addedToday}`);
  console.log('Sources');
  console.log(`  total=${sources.length}  producing=${producing}  quiet=${quiet}  never=${never}  dead=${dead}`);
  console.log('Users');
  console.log(`  users=${users}  trackerEntries=${trackerEntries}`);
  console.log('');

  console.log('Invariants the dashboard UI relies on\n');
  check('upcoming <= total', upcoming <= total, `${upcoming} vs ${total}`);
  check('tech <= upcoming', tech <= upcoming, `${tech} vs ${upcoming}`);
  check('nonTech is not negative', upcoming - tech >= 0, `${upcoming - tech}`);
  check(
    'source buckets sum to the total (producing + quiet + never)',
    producing + quiet + never === sources.length,
    `${producing}+${quiet}+${never} = ${producing + quiet + never}, total ${sources.length}`
  );
  check('dead is a subset of non-producing', dead <= quiet + never, `dead=${dead}, non-producing=${quiet + never}`);
  check('there is at least one source', sources.length > 0);
  check('there are upcoming events to show', upcoming > 0);

  // The banner the dashboard shows only when this is non-zero.
  check(
    'no documents missing clusterKey (else the dashboard raises its warning banner)',
    withoutClusterKey === 0,
    `${withoutClusterKey} missing`
  );

  // The category and source breakdowns must be non-empty for the bar charts to render
  // as something other than an empty state.
  const byCategory = await Event.aggregate([
    { $match: { startDateTime: { $gte: now }, isTechEvent: true } },
    { $unwind: '$category' },
    { $group: { _id: '$category', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
    { $limit: 12 },
  ]);
  const bySource = await Event.aggregate([
    { $match: { startDateTime: { $gte: now } } },
    { $group: { _id: '$source', n: { $sum: 1 } } },
    { $sort: { n: -1 } },
  ]);
  check('tech category breakdown is non-empty', byCategory.length > 0, `${byCategory.length} categories`);
  check('source breakdown is non-empty', bySource.length > 0, `${bySource.length} adapters`);
  check(
    'every category count is <= tech total',
    byCategory.every(c => c.n <= tech),
    'a category cannot exceed the tech corpus'
  );

  console.log('\nTop tech categories:');
  for (const c of byCategory.slice(0, 6)) console.log(`   ${String(c.n).padStart(4)}  ${c._id}`);
  console.log('\nBy adapter:');
  for (const s of bySource) console.log(`   ${String(s.n).padStart(4)}  ${s._id ?? 'unknown'}`);

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`);
  await mongoose.disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
