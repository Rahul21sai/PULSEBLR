/**
 * Does the daily digest leak another user's private events?
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS. `getNewEventsSince()` and `getEventsWithDeadlineSoon()` hand-roll their own
 * `Event.find()` rather than going through `buildEventFilter`, and when §12 introduced
 * `visibility` they were missed. `GET /api/notifications/send-digest` is only `requireUser()`, so
 * for a while any signed-in Google account could read every event ANY user had created in the last
 * 24 hours — private rows and unreviewed `pending` submissions included, with title, venue,
 * description and `createdByUserId`. No id guessing, no parameters.
 *
 * `viewerId` is now a REQUIRED, POSITIONAL first argument on both, so the type checker refuses a
 * caller that forgets. This script is the behavioural half of that guarantee: types cannot prove
 * the Mongo predicate is right, only a fixture can.
 *
 * BOTH DIRECTIONS ARE ASSERTED, and the second is the one that catches a lazy fix. A guard that
 * simply returns nothing passes every leak test and silently empties the digest for everybody — the
 * same failure mode CLAUDE.md records for the `{visibility: {$exists: false}}` arm, where omitting
 * it does not narrow the feed but EMPTIES it. So user A must still see their own private and
 * pending events, and both users must still see public ones.
 *
 * Content is asserted as well as ids: the venue markers must not appear anywhere in B's serialised
 * payload, in case a future change carries the data through some other field.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * WRITES THEN DELETES its own rows, scoped to two synthetic `devlogin:` ids, in a `finally` so a
 * failed assertion still cleans up. Needs a database; needs no server and no sign-in.
 *
 * Exits non-zero on any failure, so it is safe to wire into a check.
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { generateDailyDigest } from '../lib/notifications/digest';

const OWNER = 'devlogin:audit-owner-a@pulseblr.local';
const OTHER = 'devlogin:audit-other-b@pulseblr.local';

async function main() {
  await connectDB();

  const soon = new Date(Date.now() + 5 * 24 * 3600 * 1000);
  const seeded: string[] = [];

  const mk = async (
    title: string,
    visibility: string | undefined,
    owner: string | undefined,
    venue: string
  ) => {
    const doc = new Event({
      title,
      description: 'audit fixture — should be deleted immediately after this run',
      startDateTime: soon,
      source: 'manual',
      sourceUrl: `https://example.com/audit-${title.replace(/\W+/g, '-')}`,
      city: 'Bengaluru',
      format: 'offline',
      venue,
      category: ['Meetup'],
      registrationDeadline: new Date(Date.now() + 2 * 24 * 3600 * 1000),
      ...(visibility ? { visibility } : {}),
      ...(owner ? { createdByUserId: owner } : {}),
    });
    await doc.save();
    seeded.push(String(doc._id));
    return doc;
  };

  const priv = await mk('AUDIT PRIVATE EVENT OF USER A', 'private', OWNER, 'PRIVATE-VENUE-MUST-NOT-LEAK');
  const pend = await mk('AUDIT PENDING EVENT OF USER A', 'pending', OWNER, 'PENDING-VENUE-MUST-NOT-LEAK');
  const pub = await mk('AUDIT PUBLIC EVENT', undefined, undefined, 'public-venue-fine');

  const idsIn = (d: { newEvents: unknown[]; upcomingDeadlines: unknown[] }) => {
    const all = [...d.newEvents, ...d.upcomingDeadlines] as Array<{ _id: unknown }>;
    return new Set(all.map(e => String(e._id)));
  };

  let failures = 0;
  const check = (label: string, pass: boolean) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}`);
    if (!pass) failures++;
  };

  try {
    const bDigest = await generateDailyDigest(OTHER);
    const bIds = idsIn(bDigest);
    console.log(`\nUser B's digest: ${bDigest.newEvents.length} new + ${bDigest.upcomingDeadlines.length} deadlines\n`);
    check("B does NOT see A's private event", !bIds.has(String(priv._id)));
    check("B does NOT see A's pending event", !bIds.has(String(pend._id)));
    check('B DOES see the public event (not over-blocked)', bIds.has(String(pub._id)));

    const aDigest = await generateDailyDigest(OWNER);
    const aIds = idsIn(aDigest);
    console.log(`\nUser A's digest: ${aDigest.newEvents.length} new + ${aDigest.upcomingDeadlines.length} deadlines\n`);
    check('A DOES see their own private event', aIds.has(String(priv._id)));
    check('A DOES see their own pending event', aIds.has(String(pend._id)));
    check('A DOES see the public event', aIds.has(String(pub._id)));

    /*
     * The id checks above could pass while the payload still carried the data through some other
     * field, so assert on the CONTENT too: B's serialised digest must not contain either private
     * venue marker anywhere.
     */
    const bBlob = JSON.stringify(bDigest);
    check("B's payload contains no PRIVATE venue marker", !bBlob.includes('PRIVATE-VENUE-MUST-NOT-LEAK'));
    check("B's payload contains no PENDING venue marker", !bBlob.includes('PENDING-VENUE-MUST-NOT-LEAK'));
  } finally {
    const del = await Event.deleteMany({ _id: { $in: seeded } });
    console.log(`\n  cleaned up ${del.deletedCount} fixture events`);
  }

  console.log(failures ? `\n  ${failures} CHECK(S) FAILED` : '\n  all checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
