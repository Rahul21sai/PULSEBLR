import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { parseEventParams, buildEventFilter, buildSort, SortKey } from '@/lib/events/query';
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
 *   sort       soonest | newest | popular | relevance
 *   page,limit pagination (limit capped at 100)
 *   includePast / includeAll   include events that have finished
 *
 * The list projection deliberately omits the full description: it is up to 6 KB
 * per event and the feed only renders a two-line excerpt, so sending it would
 * multiply the payload for nothing. The detail endpoint returns everything.
 */
export async function GET(request: NextRequest) {
  try {
    await connectDB();

    const searchParams = request.nextUrl.searchParams;
    const params = parseEventParams(searchParams);
    // Nullable, not `requireUser()`: the feed is public. See the note in the facets route.
    const filter = buildEventFilter(params, await getCurrentUserId());

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '30', 10) || 30));
    const skip = (page - 1) * limit;

    const sort = (searchParams.get('sort') || (params.q ? 'relevance' : 'soonest')) as SortKey;
    const hasTextSearch = Boolean(filter.$text);

    let query = Event.find(filter)
      .select(
        'title source sourceUrl slug organizer hostAvatarUrl category tags format hasFood ' +
          'isFree price priceMax currency soldOut venue area city lat lng onlineLink imageUrl ' +
          'startDateTime endDateTime applyLink registrationDeadline attendeeCount capacity ' +
          'isTechEvent companies connectionScore isTargetCompany recruiterMentioned seenInSources ' +
          'spotlightAt createdAt'
      )
      .sort(buildSort(sort, hasTextSearch))
      .skip(skip)
      .limit(limit);

    if (hasTextSearch) {
      query = query.select({ score: { $meta: 'textScore' } });
    }

    const [events, total] = await Promise.all([
      query.lean(),
      Event.countDocuments(filter),
    ]);

    return NextResponse.json({
      events,
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
