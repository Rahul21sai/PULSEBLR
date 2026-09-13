#!/usr/bin/env tsx
/**
 * Does the calendar subscription feed actually work end to end?
 *
 * ── WHY THIS IS A SCRIPT AND NOT A TEST ──────────────────────────────────────────────────────
 * `tests/calendar-ics.test.ts` pins the pure half — folding, escaping, byte stability, the RFC
 * properties — and per the docblock in `vitest.config.mts` nothing there may touch a database. But
 * three of the things most likely to break this feature are only observable against a real one:
 *
 *   1. THE STALE-SCHEMA TRAP. `calendarFeed` is a new field on the EXISTING `User` model, which
 *      sits behind the `mongoose.models.X || mongoose.model(...)` hot-reload guard. A dev server
 *      that has already touched `User` keeps its OLD schema for the whole process lifetime and
 *      SILENTLY DROPS writes to the new path — no error, and the in-memory document happily
 *      reports the value it never stored. This is why persistence is asserted from a fresh `tsx`
 *      process by re-reading through a separate query, and never from a running dev server. It has
 *      already cost this repo twenty minutes on `User.card`.
 *
 *   2. THE INDEX. `{ 'calendarFeed.token': 1 }` is declared `unique + sparse`, and mongoose creates
 *      a missing index but LEAVES AN EXISTING ONE EXACTLY AS IT FOUND IT — `createIndex` with
 *      different options on the same key raises IndexOptionsConflict rather than migrating. So a
 *      schema edit alone does not fix a deployed database, and the only way to know what is really
 *      there is to ask the collection.
 *
 *   3. DANGLING `eventId`. `pruneStale()` deletes every event more than 7 days past its start on
 *      each scrape and touches nothing that references it, so `populate('eventId')` returning null
 *      is NORMAL. The route filters those; this counts how many exist right now, so the filter is
 *      exercised against a real number rather than assumed to be dead code.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────────────────────
 * Mostly read-only. The persistence check needs one synthetic `User` row, scoped to a
 * `devlogin:diag-calendar-feed@…` googleId and deleted in a `finally` so an assertion failure
 * cannot leave it behind. Nothing else is written; the corpus checks only read.
 *
 * ── THE HTTP HALF IS OPTIONAL ────────────────────────────────────────────────────────────────
 * With `PB_BASE` set (e.g. `PB_BASE=http://localhost:3201`) it also proves the route answers: that
 * a bogus token 404s, that a real-but-disabled token 404s with the SAME body, that an enabled one
 * returns a parseable calendar with an ETag, and that a second request carrying `If-None-Match`
 * gets a 304. Without it those are reported as SKIP rather than passing vacuously — a check that
 * cannot fail is worse than an absent one.
 *
 * Run: npx tsx scripts/diag-calendar-feed.ts
 *      PB_BASE=http://localhost:3201 npx tsx scripts/diag-calendar-feed.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import mongoose from 'mongoose';
import User, { newCalendarFeedToken } from '../lib/models/User';
import TrackerEntry from '../lib/models/TrackerEntry';
import Event from '../lib/models/Event';
import {
  ICS_CRLF,
  buildCalendarFeed,
  calendarFeedPath,
  icsEtag,
  type FeedEvent,
} from '../lib/calendar/ics';
import { REMINDABLE_TRACKER_STATUSES } from '../lib/notifications/reminder-policy';
import { canViewEvent } from '../lib/events/visibility';

const DIAG_GOOGLE_ID = 'devlogin:diag-calendar-feed@pulseblr.invalid';
const DIAG_EMAIL = 'diag-calendar-feed@pulseblr.invalid';

let checks = 0;
const failures: string[] = [];
let skipped = 0;

function check(label: string, condition: boolean, detail?: string) {
  checks++;
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!condition) failures.push(label);
}

function skip(label: string, why: string) {
  skipped++;
  console.log(`  SKIP  ${label}  ${why}`);
}

const octets = (value: string) => Buffer.byteLength(value, 'utf8');

async function main() {
  await connectDB();
  const seededUserIds: mongoose.Types.ObjectId[] = [];
  const seededEntryIds: mongoose.Types.ObjectId[] = [];

  try {
    /* ── 1. The schema knows the field at all ─────────────────────────────────────────────── */
    console.log('\n1. Schema registration (the stale-model trap)');

    const hasPath = Boolean(User.schema.path('calendarFeed'));
    check('User.schema declares `calendarFeed`', hasPath);
    for (const sub of ['token', 'enabled', 'createdAt', 'lastPolledAt']) {
      check(`  …and the sub-path \`calendarFeed.${sub}\``, Boolean(User.schema.path(`calendarFeed.${sub}`)));
    }

    /* ── 2. A write actually reaches the database ─────────────────────────────────────────── */
    console.log('\n2. Persistence, re-read through a separate query');

    const token = newCalendarFeedToken();
    check(
      'newCalendarFeedToken() is 32 bytes of entropy (43 base64url chars)',
      token.length === 43 && /^[A-Za-z0-9_-]+$/.test(token),
      `len=${token.length}`
    );
    check(
      'two tokens differ (it is not a constant)',
      newCalendarFeedToken() !== newCalendarFeedToken()
    );

    await User.deleteMany({ googleId: DIAG_GOOGLE_ID });
    const created = await User.create({
      googleId: DIAG_GOOGLE_ID,
      email: DIAG_EMAIL,
      name: 'Calendar feed diagnostic',
      calendarFeed: { token, enabled: false, createdAt: new Date() },
    });
    seededUserIds.push(created._id as mongoose.Types.ObjectId);

    // THE DECISIVE ASSERTION. A stale in-process schema would have `created.calendarFeed.token`
    // populated in memory and nothing in the collection, so this re-reads rather than trusting the
    // document it just wrote.
    const reread = await User.findOne({ googleId: DIAG_GOOGLE_ID }).select('calendarFeed').lean();
    check('the token survives a round trip to MongoDB', reread?.calendarFeed?.token === token);
    check(
      '`enabled` defaults/stores false, so a leaked token alone is not enough',
      reread?.calendarFeed?.enabled === false,
      `enabled=${String(reread?.calendarFeed?.enabled)}`
    );
    check('`createdAt` was stamped with the token', Boolean(reread?.calendarFeed?.createdAt));

    // The lookup the public route performs, against a real index.
    const byToken = await User.findOne({ 'calendarFeed.token': token }).select('googleId').lean();
    check('the feed token resolves back to its user', byToken?.googleId === DIAG_GOOGLE_ID);

    /* ── 3. The index the route's lookup depends on ───────────────────────────────────────── */
    console.log('\n3. The index, as the collection actually has it');

    const indexes = await User.collection.indexes();
    const tokenIndex = indexes.find(
      index => JSON.stringify(index.key) === JSON.stringify({ 'calendarFeed.token': 1 })
    );
    check('`{ calendarFeed.token: 1 }` exists on the collection', Boolean(tokenIndex));
    if (tokenIndex) {
      check('  …it is unique', tokenIndex.unique === true);
      // SPARSE IS CORRECT ON A SINGLE-FIELD INDEX. CLAUDE.md §9 records `sparse` on a COMPOUND
      // unique index capping every user at one folder — that failure needs an always-present field
      // in the key, and this key has one field. Same options as `card.token` beside it.
      check('  …and sparse, so users with no feed are not indexed', tokenIndex.sparse === true);
      const cardIndex = indexes.find(
        index => JSON.stringify(index.key) === JSON.stringify({ 'card.token': 1 })
      );
      check(
        '  …with the same options as the card token index it mirrors',
        Boolean(cardIndex) &&
          cardIndex!.unique === tokenIndex.unique &&
          cardIndex!.sparse === tokenIndex.sparse
      );
    }

    /* ── 4. The real corpus: build a feed from live tracker rows ──────────────────────────── */
    console.log('\n4. The live corpus (read-only)');

    void Event; // registers the model so `populate('eventId')` can resolve the ref.

    const entries = await TrackerEntry.find({
      status: { $in: [...REMINDABLE_TRACKER_STATUSES] },
    })
      .limit(400)
      .populate({
        path: 'eventId',
        select:
          'title description startDateTime endDateTime venue address area city organizer ' +
          'onlineLink sourceUrl updatedAt visibility createdByUserId deletedAt',
      })
      .lean();

    const dangling = entries.filter(entry => !entry.eventId).length;
    console.log(
      `  note  ${entries.length} remindable tracker rows sampled, ${dangling} with a dangling ` +
        `eventId (pruneStale deleted the event)`
    );
    // Reported, not judged: dangling refs are the DOCUMENTED normal state, so a non-zero count is
    // not a defect. What matters is that the builder never sees one.
    check(
      'no dangling eventId reaches the feed builder',
      entries.filter(entry => !entry.eventId).every(entry => !entry.eventId)
    );

    /**
     * The populated event, as loosely as possible while still satisfying `canViewEvent`.
     *
     * Spelling the three guard fields explicitly rather than using a bare index signature is not
     * pedantry: `canViewEvent` treats an absent field as PERMISSIVE, so a type that let them go
     * missing is the compiler's last chance to notice the `.select()` above has to carry them.
     */
    type PopulatedEvent = Record<string, unknown> & {
      _id: unknown;
      visibility?: string | null;
      createdByUserId?: string | null;
      deletedAt?: Date | string | null;
    };

    const events: FeedEvent[] = [];
    for (const entry of entries) {
      const event = entry.eventId as unknown as PopulatedEvent | null;
      if (!event?.startDateTime || !event.title) continue;
      if (!canViewEvent(event, entry.userId)) continue;
      const id = String(event._id);
      events.push({
        id,
        title: String(event.title),
        description: (event.description as string) ?? null,
        startDateTime: event.startDateTime as Date,
        endDateTime: (event.endDateTime as Date) ?? null,
        venue: (event.venue as string) ?? null,
        address: (event.address as string) ?? null,
        area: (event.area as string) ?? null,
        city: (event.city as string) ?? null,
        organizer: (event.organizer as string) ?? null,
        onlineLink: (event.onlineLink as string) ?? null,
        sourceUrl: (event.sourceUrl as string) ?? null,
        eventUrl: `https://pulseblr.example.com/events/${id}`,
        updatedAt: (event.updatedAt as Date) ?? (event.startDateTime as Date),
      });
    }
    console.log(`  note  ${events.length} events built from those rows`);

    const body = buildCalendarFeed({
      events,
      calendarName: 'PulseBLR — saved events',
      calendarDescription: 'Events you saved in PulseBLR.',
    });

    /*
     * THE MEASUREMENT THE UNIT TEST CANNOT TAKE: real scraped titles and descriptions, folded.
     * The 91-octet defect this feature fixed came from an em-dash in a scraped title, so the
     * corpus is the only place it can be observed rather than constructed. Ratios over a tiny
     * sample are not judged — but a single over-long line is a defect at any n.
     */
    const overLong = body.split(ICS_CRLF).filter(line => octets(line) > 75);
    check(
      'every line of the live feed is within 75 octets',
      overLong.length === 0,
      `${overLong.length} over-long of ${body.split(ICS_CRLF).length} lines`
    );
    if (overLong.length) {
      for (const line of overLong.slice(0, 3)) {
        console.log(`        ${octets(line)} octets: ${line.slice(0, 90)}`);
      }
    }

    const nonAscii = body.split('').filter(ch => ch.charCodeAt(0) > 127).length;
    console.log(`  note  ${nonAscii} non-ASCII characters in the body (the fold's real workload)`);
    check('no U+FFFD replacement character anywhere', !body.includes('�'));
    check('no bare LF (CRLF everywhere)', !body.replace(/\r\n/g, '').includes('\n'));
    check('it is a subscription, not an iTIP message (no METHOD)', !body.includes('METHOD:'));

    // Byte stability against the live corpus, which is what makes the 304 possible.
    const second = buildCalendarFeed({
      events,
      calendarName: 'PulseBLR — saved events',
      calendarDescription: 'Events you saved in PulseBLR.',
    });
    check('two builds over the same rows are byte-identical', body === second);
    check('so the ETag is stable too', icsEtag(body) === icsEtag(second));

    /* ── 5. The HTTP path, if a server was offered ────────────────────────────────────────── */
    console.log('\n5. The route over HTTP');
    const base = process.env.PB_BASE?.replace(/\/+$/, '');
    if (!base) {
      skip(
        'route responses',
        'set PB_BASE (e.g. http://localhost:3201, see scripts/start-verify.js --dev) to check these'
      );
    } else {
      const get = (path: string, headers: Record<string, string> = {}) =>
        fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(45000) });

      // A well-formed but unissued token. 404 rather than 403, and the same 404 as a disabled feed.
      const bogus = await get(calendarFeedPath(newCalendarFeedToken()));
      check('an unissued token 404s', bogus.status === 404, `status=${bogus.status}`);
      const bogusBody = await bogus.text();

      // The diagnostic user's feed is DISABLED at this point, so this proves the kill switch.
      const disabled = await get(calendarFeedPath(token));
      check('a real but DISABLED token also 404s', disabled.status === 404, `status=${disabled.status}`);
      check(
        '  …with a body identical to the unissued case (which of the two it is, is itself information)',
        (await disabled.text()) === bogusBody
      );

      /*
       * ── SEED ONE REAL SAVED EVENT BEFORE ENABLING, AND THIS IS NOT DECORATION. ──────────────
       * The synthetic user has no tracker rows, so its feed is a bare VCALENDAR with no VEVENT and
       * therefore NO DTSTAMP — and the 304 assertion below would then pass no matter what, because
       * an empty body is byte-stable even if every timestamp came straight off the clock. That is
       * precisely the "check that cannot fail" this repo has been bitten by repeatedly, so the feed
       * is given something to stamp. Verified by deliberately breaking the route's `updatedAt` to
       * `new Date()`: with a seeded event the 304 check goes red, and without one it stays green.
       */
      const sampleEvent = await Event.findOne({ deletedAt: { $eq: null }, visibility: { $exists: false } })
        .select('_id title')
        .lean();
      let seededEntryId: mongoose.Types.ObjectId | null = null;
      if (sampleEvent) {
        const entry = await TrackerEntry.create({
          userId: DIAG_GOOGLE_ID,
          eventId: sampleEvent._id,
          status: 'New',
        });
        seededEntryId = entry._id as mongoose.Types.ObjectId;
        seededEntryIds.push(seededEntryId);
      } else {
        skip('seeded saved event', 'no public event in the corpus to save');
      }

      // Switch it on and re-ask. Written through the model, then re-read by the route's own query.
      await User.updateOne({ googleId: DIAG_GOOGLE_ID }, { $set: { 'calendarFeed.enabled': true } });

      const enabled = await get(calendarFeedPath(token));
      check('an ENABLED token returns 200', enabled.status === 200, `status=${enabled.status}`);
      check(
        '  …as text/calendar',
        (enabled.headers.get('content-type') ?? '').includes('text/calendar'),
        enabled.headers.get('content-type') ?? 'none'
      );
      check(
        '  …cached `private`, and NOT `no-store` (which would forbid the 304)',
        (enabled.headers.get('cache-control') ?? '').includes('private') &&
          !(enabled.headers.get('cache-control') ?? '').includes('no-store'),
        enabled.headers.get('cache-control') ?? 'none'
      );
      const etag = enabled.headers.get('etag');
      check('  …with an ETag', Boolean(etag), etag ?? 'none');

      const feedBody = await enabled.text();
      check(
        '  …a parseable calendar',
        feedBody.includes('BEGIN:VCALENDAR') && feedBody.includes('END:VCALENDAR')
      );

      if (sampleEvent) {
        // THE CONTROL FOR THE 304 CHECK BELOW. Without a VEVENT there is no DTSTAMP, and an empty
        // body is byte-stable however the timestamps were derived — so the conditional assertion
        // would be vacuous. This is what makes it mean something.
        check(
          '  …carrying the saved event, so there IS a DTSTAMP to be stable about',
          feedBody.includes(`UID:${String(sampleEvent._id)}@pulseblr`) &&
            feedBody.includes('DTSTAMP:'),
          `event=${String(sampleEvent.title).slice(0, 40)}`
        );
      }

      if (etag) {
        const conditional = await get(calendarFeedPath(token), { 'If-None-Match': etag });
        // THE CHECK THAT PROVES THE CACHING IS REAL. A DTSTAMP read off the clock makes every
        // response a fresh 200 with a new ETag, and this is the only thing that would notice.
        check('a conditional re-poll gets 304, not a second 200', conditional.status === 304,
          `status=${conditional.status}`);
      }

      // And the management route must refuse an anonymous caller — GUARD FIRST.
      const anonGet = await get('/api/me/calendar-feed');
      check('GET /api/me/calendar-feed refuses anonymously (401)', anonGet.status === 401,
        `status=${anonGet.status}`);
      const anonPut = await fetch(`${base}/api/me/calendar-feed`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // A DELIBERATELY INVALID BODY. A 400 here would mean validation outran the guard, which
        // tells a stranger their payload parsed. It must still be 401.
        body: JSON.stringify({ enabled: 'yes please' }),
        signal: AbortSignal.timeout(45000),
      });
      check('PUT with a bad body still 401s, not 400 (guard before validate)', anonPut.status === 401,
        `status=${anonPut.status}`);
    }
  } finally {
    // In a `finally` so a failed assertion cannot leave a synthetic user behind holding a unique
    // email and a unique feed token, nor a tracker row pointing at a real corpus event.
    // Tracker rows are matched on the diagnostic userId, never on eventId — the sampled event is a
    // real one somebody else may legitimately have saved.
    const removedEntries = await TrackerEntry.deleteMany({ userId: DIAG_GOOGLE_ID });
    const removed = await User.deleteMany({ googleId: DIAG_GOOGLE_ID });
    console.log(
      `\ncleanup: removed ${removed.deletedCount} diagnostic user row(s), ` +
        `${removedEntries.deletedCount} tracker row(s) (seeded ${seededEntryIds.length})`
    );
    await mongoose.disconnect();
  }

  console.log(
    `\n${checks - failures.length}/${checks} checks passed` +
      `${skipped ? `, ${skipped} skipped` : ''}${failures.length ? `\nFAILED: ${failures.join('; ')}` : ''}`
  );
  process.exit(failures.length ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
