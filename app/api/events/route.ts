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
import { isTechFromCategories } from '@/lib/event-types';
import { validateManualEvent, manualEventError } from '@/lib/events/manual-input';
import { PLACEHOLDER_SOURCE_URL } from '@/lib/events/placeholder';
import { connectionScore } from '@/lib/events/connection-score';
/**
 * The KEYWORD FLOOR only — never `tagEvents()`. This is the create path for one event with a person
 * waiting on the response, so it must not depend on a provider: `keywordTagging` is regex over title
 * and description, and `lib/llm/tagger.ts` instantiates no SDK at module scope, so importing it here
 * adds no network call and cannot fail when ICA is down. See the note at the call site.
 */
import { keywordTagging } from '@/lib/llm/tagger';
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
 *   audience   comma-separated (AUDIENCE_NAMES)
 *   perks      comma-separated (PERK_NAMES)
 *   tier       comma-separated (EVENT_TIERS)
 *   followed   true — narrow to companies the SIGNED-IN caller follows. The list is read from
 *              their `User.targetCompanies`, never from the querystring; anonymous callers and
 *              users following nobody get an empty result set, not an unfiltered one.
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

    /*
     * `?followed=true` — the "Hosted by a company you follow" shelf.
     *
     * RESOLVED HERE FROM THE SESSION, never from the querystring. `parseEventParams` deliberately
     * does not read `followedCompanies`, because a client-supplied list would make "companies you
     * follow" indistinguishable from "companies you named" while the shelf's heading asserts the
     * first. The querystring carries only the REQUEST (`followed=true`); the answer comes from the
     * caller's own `User` row.
     *
     * `?? []` IS THE FAIL-CLOSED PATH AND IT IS THE IMPORTANT LINE. Anonymous caller, no `User`
     * row, a row predating the field, or a user who cleared their list — all four land on an empty
     * array, and `buildEventFilter` turns that into `{ companies: { $in: [] } }`, which matches
     * nothing. The alternative, leaving `followedCompanies` undefined, would drop the clause and
     * answer a request for a personal shelf with the WHOLE feed under a heading claiming every row
     * is a company the reader follows. The empty array is not a degenerate case to tidy away; it is
     * the guard.
     */
    if (searchParams.get('followed') === 'true') {
      params.followedCompanies = await loadFollowedCompanies(userId);
    }

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
      /*
       * The resolved follow list, echoed back ONLY on the `?followed=true` path.
       *
       * The shelf's caption names the companies it matched on, and it can only do that honestly if
       * it knows which of a row's `companies` the reader actually follows — an event can name three
       * companies while only one of them is followed, and a caption naming the other two would be a
       * false claim sitting under a heading that says "a company you follow".
       *
       * Not a leak: it is the caller's own `targetCompanies`, derived from their own session, and it
       * is absent from every other request. `undefined` is dropped by `JSON.stringify`, so the
       * ordinary feed response is byte-identical to what it was.
       */
      followed: params.followedCompanies,
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
 * The canonical company names this caller follows (`User.targetCompanies`), or `[]`.
 *
 * `[]` FOR EVERY "WE DO NOT KNOW" CASE, and never `null`/`undefined`. The distinction matters
 * because the caller assigns the result straight to `params.followedCompanies`, where an absent
 * value drops the clause and an empty array matches nothing — so returning nothing-ish here would
 * turn "you follow nobody" into "show everything". Anonymous, no `User` row, field absent, list
 * cleared: one answer, and it is the safe one.
 *
 * `findOne` rather than `ensureUser()`, for the same reason `loadRelevanceContext` below does it:
 * a missing row means "follows nothing we know about", which is a true and complete answer, and
 * creating a `User` document as a side effect of reading a public feed would be the worse bug.
 *
 * A THROW MUST NOT COST THE FEED — but note the failure here is not "no shelf", it is a shelf that
 * would show the wrong thing, so the catch also returns `[]`. An empty shelf hides itself; a
 * wrongly-populated one lies.
 */
async function loadFollowedCompanies(userId: string | null): Promise<string[]> {
  if (!userId) return [];
  try {
    const user = await User.findOne({ googleId: userId })
      .select('targetCompanies')
      .lean<{ targetCompanies?: string[] } | null>();
    return user?.targetCompanies ?? [];
  } catch (error) {
    console.error('Could not load followed companies:', error);
    return [];
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
   * ── NO CATEGORY? READ THE TITLE. STILL NOTHING? REFUSE. ──────────────────────────────────────
   *
   * `validateManualEvent` no longer invents `'Meetup'` (see its note), so `category` can arrive
   * empty — and empty is exactly the case that produced the reported bug, because whatever fills it
   * decides `isTechEvent`, which decides whether the event exists as far as the feed is concerned.
   *
   * WHY THE FLOOR RUNS HERE AND NOT IN THE FORM. The common path is the URL importer: a user pastes
   * a Luma link, `POST /api/scrape-url` fills title, date, venue and image, and returns **no
   * category** — so the one field that governs visibility is the only one the import cannot supply.
   * Making the form require a category would break that flow for every import; running
   * `keywordTagging()` server-side fixes it silently and correctly. Measured against the 12 stored
   * rows: the floor recovers a real topic for 10 of them from the title alone
   * (`Hacktoberfest Hack Day Bengaluru` → `[AI/ML, Open Source, Hackathon]`).
   *
   * WHY IT STILL REFUSES. `keywordTagging` has its own fallback — `tagger.ts` ends with
   * `if (chosen.length === 0) chosen.push('Meetup')` — so accepting its output blindly reinstates
   * the identical fabrication one layer down. And a floor result carrying only NON-tech topics is
   * the `Dev Days | Bangalore` case, which the floor reads as `[Community/Social]`: a plausible
   * guess that would store another permanently-invisible row while reporting success.
   *
   * So the rule is: the SERVER may fill a category it can justify from the text, and only a HUMAN
   * may assert a non-tech one. That is not a tech-only gate on the corpus — an explicit
   * `['Community/Social']` in the body is accepted on the first line below. It refuses exactly one
   * thing: storing an uncategorised event under a guess nobody made.
   *
   * `keywordTagging` is pure and needs no provider: `lib/llm/tagger.ts` instantiates no SDK at
   * module scope, and the floor is regex over title + description. So this adds no network call and
   * cannot fail when ICA is down.
   */
  let category = fields.category;
  let tagConfidence = 0.6;
  if (!category.length) {
    const floor = keywordTagging({
      title: fields.title,
      description: fields.description,
      venue: fields.venue,
      onlineLink: fields.onlineLink,
    });
    if (!isTechFromCategories(floor.categories)) {
      // Names what it saw, so the answer is one tap rather than a guessing game. `guessed` is
      // omitted when the floor only produced its own 'Meetup' fallback — reporting that as a
      // reading of their event would be the same false assertion in a friendlier voice.
      const guessed = floor.categories.filter(c => c !== 'Meetup');
      return NextResponse.json(
        {
          error:
            'Pick at least one category — we could not work out the topic from the title and description.'
            + (guessed.length ? ` Closest we found: ${guessed.join(', ')}.` : ''),
          issues: [{ field: 'category', message: 'Choose a category so this event can be found.' }],
          ...(guessed.length ? { suggestedCategory: guessed } : {}),
        },
        { status: 400 }
      );
    }
    category = floor.categories;
    // The floor's own confidence, not the 0.6 a human-chosen list gets. `diag-recent-writes.ts`
    // fingerprints keyword tagging on exactly this value, so passing it through keeps that honest.
    tagConfidence = floor.confidence;
  }

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
      // `category` rather than `fields.category`: the floor above may have resolved it from the
      // title, and the spread would otherwise put the empty array back.
      category,
      source: 'manual' as const,
      sourceUrl: fields.sourceUrl ?? PLACEHOLDER_SOURCE_URL,
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
       *
       * Through `isTechFromCategories()` now rather than an inline `.some()`. The derivation here was
       * always correct; three OTHER paths that change `category` forgot to repeat it, which is why it
       * is a named function — see its note in `lib/event-types.ts`.
       */
      isTechEvent: isTechFromCategories(category),
      tagConfidence,
      /**
       * SCORED, NOT DEFAULTED — and the coincidence that hid this is worth naming.
       *
       * `connectionScore` was never computed on this path: `lib/scrapers/normalizer.ts` is the only
       * runtime caller, so a hand-added event kept the schema default at `lib/models/Event.ts`, which
       * is `default: 20`. And `connectionScore()` itself opens with `let score = 20 // baseline`, so
       * the stored placeholder is numerically identical to the score of an event that earns nothing —
       * which is precisely why twelve rows reading exactly 20 looked computed rather than absent.
       *
       * It matters because the default sort is `connections`. An in-person event with a venue and
       * food scores 80+; leaving it at 20 ranks it below ~190 of 249 upcoming tech events, i.e. page
       * 7 of a 30-row feed. Fixing `isTechEvent` alone would have made these events *reachable* and
       * still invisible, so this is the half that answers the actual complaint.
       *
       * Additive, not a behaviour change elsewhere: the scorer is pure, takes no clock and no
       * network, and this is a second call site rather than an edit to the first.
       */
      connectionScore: connectionScore({
        format: fields.format,
        hasFood: fields.hasFood,
        category,
        organizer: fields.organizer,
        title: fields.title,
        isFree: fields.isFree,
        price: fields.price,
      }),
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
