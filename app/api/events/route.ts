import { NextRequest, NextResponse } from 'next/server';
import type { PipelineStage } from 'mongoose';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import TrackerEntry from '@/lib/models/TrackerEntry';
import {
  parseEventParams,
  buildEventFilter,
  buildSort,
  buildForYouPipeline,
  FEED_SELECT,
  SortKey,
} from '@/lib/events/query';
import User from '@/lib/models/User';
import { readPreferences, hasRankingPreferences, type RelevanceContext } from '@/lib/events/relevance';
import { requireAdmin, requireUser } from '@/lib/api-auth';
import { TECH_FLAG_CATEGORIES } from '@/lib/event-types';
import { validateManualEvent, manualEventError } from '@/lib/events/manual-input';
import { getCurrentUserId } from '@/lib/auth-helpers';

/**
 * GET /api/events — the feed.
 *
 * Supported params:
 *   q          free-text search (title/organizer/venue/tags)
 *   when       today | tomorrow | weekend | week | month   (resolved in IST)
 *   from,to    explicit ISO date range
 *   category   comma-separated
 *   area       comma-separated
 *   source     comma-separated
 *   format     online | offline | hybrid
 *   hasFood    yes | no | unknown
 *   isFree     true | false
 *   techOnly   true
 *   sort       soonest | newest | popular | relevance | connections | foryou
 *   page,limit pagination (limit capped at 100)
 *   includePast / includeAll   include events that have finished
 *
 * The list projection deliberately omits the full description: it is up to 6 KB
 * per event and the feed only renders a two-line excerpt, so sending it would
 * multiply the payload for nothing. The detail endpoint returns everything.
 *
 * Each row carries `tracked` for a signed-in caller — see `attachTracked` below.
 */
export async function GET(request: NextRequest) {
  /*
   * SESSION FIRST, BEFORE ANY PARAM WORK. Not a guard — the feed is public and this route must
   * keep answering an anonymous caller with 200 — but the ordering is the same discipline the
   * POST handler documents, and it is what stops `tracked` from being computed off a user id
   * resolved halfway down the function next to the thing it is scoping.
   */
  const userId = await getCurrentUserId();

  try {
    await connectDB();

    const searchParams = request.nextUrl.searchParams;
    const params = parseEventParams(searchParams);
    // Nullable, not `requireUser()`: the feed is public. See the note in the facets route.
    const filter = buildEventFilter(params, userId);

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '30', 10) || 30));
    const skip = (page - 1) * limit;

    const sort = (searchParams.get('sort') || (params.q ? 'relevance' : 'soonest')) as SortKey;
    const hasTextSearch = Boolean(filter.$text);

    /*
     * THE PERSONALISED FEED IS A DIFFERENT ORDER OVER THE SAME ROWS — NOTHING ELSE.
     *
     * `sort=foryou` runs the same `filter` through an aggregation that computes
     * `connectionScore × relevanceScore` and sorts on it. The pipeline adds no `$match` of its own,
     * so `total` below is still `countDocuments(filter)` and "For you" and "Everything" agree on
     * how many events exist — which is the arithmetic half of the promise that a recommender here
     * never hides anything.
     *
     * `relevanceContext` is null for an anonymous caller and for a signed-in user who has expressed
     * nothing the ranking can act on. Both then fall through to the ordinary `find()` path, where
     * `buildSort('foryou')` degrades to the corpus-wide ranking. So a user who skipped onboarding
     * gets today's feed exactly, and nobody ever gets an empty one.
     */
    const relevanceContext = sort === 'foryou' ? await loadRelevanceContext(userId) : null;

    // Both paths produce plain objects — `.lean()` on one, an aggregation cursor on the other — so
    // `attachTracked` and the JSON response are identical either way. Kept in one `Promise.all`
    // with the count, as before: making the list await the count (or the reverse) would add a
    // round trip to every request for no reason.
    const listQuery = (): Promise<Array<{ _id: unknown }>> => {
      if (relevanceContext) {
        /*
         * The cast is unavoidable and is confined to this line. `buildForYouPipeline` lives in
         * `lib/events/query.ts`, which `app/page.tsx` imports — so that module must stay free of
         * mongoose or its types would land in the browser bundle. It therefore returns plain
         * records, and mongoose's `PipelineStage` is a discriminated union that a plain record
         * cannot structurally satisfy. The stages themselves are asserted by
         * `tests/relevance.test.ts`, which evaluates the expression they carry.
         */
        return Event.aggregate<{ _id: unknown }>(
          buildForYouPipeline(filter, relevanceContext, { skip, limit }) as unknown as PipelineStage[]
        );
      }
      let query = Event.find(filter)
        .select(FEED_SELECT)
        .sort(buildSort(sort, hasTextSearch))
        .skip(skip)
        .limit(limit);
      if (hasTextSearch) query = query.select({ score: { $meta: 'textScore' } });
      return query.lean();
    };

    const [events, total] = await Promise.all([listQuery(), Event.countDocuments(filter)]);

    return NextResponse.json({
      events: await attachTracked(events, userId),
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit),
        hasMore: skip + events.length < total,
      },
    });
  } catch (error) {
    console.error('Error fetching events:', error);
    return NextResponse.json({ error: 'Failed to fetch events' }, { status: 500 });
  }
}

/**
 * Load the preferences the personalised ranking needs, or `null` if there is nothing to rank with.
 *
 * `null` is returned for three distinct situations that all have the same correct outcome — the
 * ordinary `connections` ranking:
 *
 *   · an anonymous caller whose URL says `sort=foryou` (a shared "For you" link),
 *   · a signed-in user with no `User` row yet, or none written since this field existed, and
 *   · a signed-in user who skipped onboarding, or who set only a digest cadence.
 *
 * WHY `findOne` AND NOT `ensureUser()`. CLAUDE.md's rule exists because a route that FAILS on a
 * missing `User` row breaks for a valid session — that is how `/api/me/card` came to 404. This
 * route does not fail: a missing row means "no preferences", which is a true and complete answer.
 * Creating a `User` document as a side effect of loading a public feed would be the worse bug, and
 * `ensureUser` writes on the paths where a row is absent. So this is the read-only exception, and
 * it is one deliberately.
 *
 * `.lean()` with an explicit projection: this runs on the feed's hot path, and the only fields it
 * needs are two small arrays and an object.
 *
 * A FAILURE HERE MUST NOT COST THE FEED, for the same reason `attachTracked` swallows its errors —
 * personalisation is an enhancement over a public list, and a 500 on the whole feed because a
 * preference lookup hiccuped is a far worse trade than an unpersonalised page.
 */
async function loadRelevanceContext(userId: string | null): Promise<RelevanceContext | null> {
  if (!userId) return null;
  try {
    const user = await User.findOne({ googleId: userId })
      .select('preferences targetCompanies')
      .lean<{ preferences?: unknown; targetCompanies?: string[] } | null>();
    if (!user) return null;
    const preferences = readPreferences(user.preferences);
    // The tab is only offered when the ranking can act on something; this is the server refusing
    // to pretend otherwise if the URL says `foryou` anyway.
    if (!hasRankingPreferences(preferences)) return null;
    return { preferences, targetCompanies: user.targetCompanies ?? [] };
  } catch (error) {
    console.error('Could not load preferences for the personalised feed:', error);
    return null;
  }
}

/**
 * Mark the rows this caller has already saved to their tracker.
 *
 * WHY THE FEED NEEDS THIS AT ALL. `SaveButton` has always accepted `initiallySaved` and derived
 * its whole visual state from it, and nothing ever passed it — so every card showed an empty
 * bookmark whatever the user had saved, and the only way to find out you had already saved
 * something was to save it again and get a 409. A click-through crawl recorded 20 of them in one
 * session. The button handled the 409 gracefully, which is exactly why it went unnoticed: the
 * defect was never an error, it was the feed being unable to state a fact it already owned.
 *
 * ONE QUERY, NOT ONE PER ROW. `distinct` over `{ userId, eventId: { $in: ids } }` rides the
 * compound unique index `{ userId, eventId }` the model already declares, and returns ids only —
 * so the cost does not grow with what a user has tracked, only with the page size (30).
 *
 * A FAILURE HERE MUST NOT COST THE FEED. `tracked` is an enhancement to a public list; if the
 * tracker lookup throws, every row simply comes back without the flag and the button behaves as
 * it did before — a 500 on the whole feed would be a far worse trade.
 *
 * Anonymous callers get the rows untouched: no key, no cost, and nothing per-user in a response
 * that `sw.js` may cache. (`/api/events` is in that file's `PRIVATE_API` list already, because
 * the feed can contain the caller's own private events — this adds no new class of leak.)
 */
async function attachTracked<T extends { _id: unknown }>(
  events: T[],
  userId: string | null
): Promise<T[]> {
  if (!userId || events.length === 0) return events;
  try {
    // Stringified, not the raw `_id`s: `lean()` types them loosely, and Mongoose casts a string to
    // an ObjectId for an ObjectId path anyway — so this keeps the query honestly typed without an
    // assertion that would hide a real shape change later.
    const ids = events.map(event => String(event._id));
    const trackedIds = await TrackerEntry.distinct('eventId', { userId, eventId: { $in: ids } });
    if (trackedIds.length === 0) return events;
    const tracked = new Set(trackedIds.map(String));
    return events.map(event => ({ ...event, tracked: tracked.has(String(event._id)) }));
  } catch (error) {
    console.error('Could not resolve tracked events for the feed:', error);
    return events;
  }
}

/**
 * POST /api/events — add an event by hand.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TWO THINGS A USER MIGHT MEAN, AND THEY NEED DIFFERENT PERMISSIONS.
 *
 *   "Add it just for me"     → `visibility: 'private'`. Any signed-in user. Only they see it, and
 *                              they can track it and scan people into it like any other event. This
 *                              is the common case and the reason the feature exists: the corpus
 *                              cannot know about a company's internal hackathon or a reading group.
 *   "Add it for everyone"    → `visibility: 'pending'`. Any signed-in user. Goes to an admin review
 *                              queue; visible meanwhile only to its author.
 *   Straight into the corpus → `visibility: 'public'`. ADMIN ONLY, and unchanged from before: no
 *                              owner, no visibility key, exactly what the scraper produces.
 *
 * WHY 'public' STAYS ADMIN-ONLY. This route was `requireAdmin()` outright, and the reason is
 * written down: Google sign-in is open to anyone with a Google account, so "signed in" is not a bar
 * for an operation that affects everyone. `app/events/[id]/page.tsx` renders `applyLink` straight
 * into an `href`, so direct publication is a phishing-link injector, and a stranger could otherwise
 * pollute the corpus the whole product depends on. The review step is what makes "contribute to
 * everyone" safe to OFFER rather than refuse — which is the point: before this, `/add-event` was
 * signed-in-only in `proxy.ts` while this route was admin-only, so the form was a dead end that
 * 403'd on submit.
 *
 * GUARD FIRST, VALIDATE SECOND. `requireUser()` runs before the body is read, so an anonymous
 * caller with a bad payload gets 401 and not 400 — a 400 would tell a stranger their body parsed
 * far enough to be judged, and `scripts/diag-api-auth.ts` asserts the refusal code.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  // Validated BEFORE connectDB(): a malformed request needs no database to refuse.
  const body = await request.json().catch(() => ({}));
  const { fields, visibility, issues } = validateManualEvent(body);
  if (!fields) return NextResponse.json(manualEventError(issues), { status: 400 });

  /**
   * Publishing straight to the corpus is re-checked against the admin allowlist here, not inferred
   * from the earlier guard. `session.user.isAdmin` exists only to decide whether to draw a nav
   * link — editing it in devtools must buy a 403, which is what `requireAdmin()` gives.
   */
  if (visibility === 'public') {
    const adminGate = await requireAdmin();
    if ('response' in adminGate) return adminGate.response;
  }

  try {
    await connectDB();

    /**
     * `source: 'manual'` is FORCED, never taken from the body. It is provenance, and a caller
     * claiming `source: 'luma'` would make their row look scraped to every diagnostic in
     * `scripts/` — and to `pruneStale`, whose ownership exclusion is the only thing keeping it.
     *
     * `createdByUserId` is assigned LAST and from the session, copying the `{ ...input, userId }`
     * ordering `POST /api/tracker` uses so a body cannot claim someone else's ownership.
     *
     * The derived keys are deliberately absent: the `pre('validate')` hook computes both, and for
     * an owned document it NAMESPACES them by owner — which is what makes the row structurally
     * incapable of being merged into by a scrape. See `Event.generateClusterKey`.
     */
    const owned = visibility !== 'public';
    const doc = {
      ...fields,
      source: 'manual' as const,
      sourceUrl: fields.sourceUrl ?? 'https://pulseblr.local/manual',
      lastSeenAt: new Date(),
      seenInSources: ['manual'],
      /**
       * A hand-entered event is NOT assumed to be a tech event.
       *
       * The old path spread the body into the document and never touched `isTechEvent`, so every
       * manual creation inherited the schema default of `true` — landing straight in the default
       * tech feed with no classification at all. `isTechEvent` is what `techOnly` filters on, so
       * getting it wrong for free is not a small thing. Derived from the chosen categories against
       * the same `TECH_FLAG_CATEGORIES` set the keyword tagger uses, so the app's two definitions of
       * "tech" cannot drift — that drift already hid `IndiaFOSS 2026` from the default feed once.
       */
      isTechEvent: fields.category.some(c => TECH_FLAG_CATEGORIES.has(c)),
      // Keyword-floor confidence: a human chose the categories, but nothing verified them.
      tagConfidence: 0.6,
      ...(owned ? { visibility, createdByUserId: gate.userId } : {}),
    };

    const event = await Event.create(doc);
    return NextResponse.json(event, { status: 201 });
  } catch (error) {
    const err = error as { code?: number; message?: string };
    console.error('Error creating event:', error);
    if (err.code === 11000) {
      // With the owner folded into `dedupHash`, this now means the SAME user adding the same event
      // twice — not a clash with somebody else's row, which is what it used to mean and which
      // handed the second user the first one's document.
      return NextResponse.json(
        { error: 'You have already added this event.' },
        { status: 409 }
      );
    }
    // No `details`. It carried `err.message`, which on a Mongoose error names the model and the
    // schema path — the leak the tracker write paths had to stop.
    return NextResponse.json({ error: 'Failed to create event' }, { status: 500 });
  }
}
