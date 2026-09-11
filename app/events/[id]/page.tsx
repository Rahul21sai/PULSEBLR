import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { Metadata } from 'next';
import mongoose from 'mongoose';

import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { getCurrentUserId } from '@/lib/auth-helpers';
import { canViewEvent } from '@/lib/events/visibility';
import { publicEventScope } from '@/lib/events/query';
import { toFeedEvent, toFeedEvents } from '@/lib/events/serialize';
import {
  buildEventJsonLd,
  eventSeoDescription,
  isIndexableEvent,
  serializeJsonLd,
  type SeoEvent,
} from '@/lib/events/seo';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';
import { topicForDimension } from '@/lib/events/topics';
import {
  connectionVerdict,
  meterLabel,
  meterLevel,
  scoreReasons,
} from '@/lib/events/score-reason';
import type { SpeakerMatch } from '@/lib/events/speaker-match';
import { FeedEvent } from '@/lib/event-types';

import { DesktopNav, MobileBottomNav } from '../../components/NavBar';
import EventCover from '../../components/EventCover';
import EventActions from './EventDetailClient';
import Description from './Description';
import { loadSpeakerMatches } from './load-speaker-matches';
import {
  timeIST,
  fullDateIST,
  relativeTime,
  locationLabel,
  categoryAccent,
  priceLabel,
  dayLabelIST,
  shortDateIST,
  isHappeningNow,
  stripMarkdown,
} from '@/lib/format';

/**
 * The event page. A SERVER COMPONENT, and the conversion from a client one is the entire point.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT MOVED. This page was `'use client'` and fetched `/api/events/[id]` in a `useEffect`. Two
 * consequences, and the second is the expensive one:
 *
 *   · `generateMetadata` is supported ONLY in Server Components (Next's own metadata guide says so
 *     outright), so the page could not emit a title, description, canonical, OG card or JSON-LD.
 *   · The crawlers that produce a link preview — WhatsApp, LinkedIn, Slack, Twitter — and the ones
 *     that index a page run NO JavaScript. So sharing an event produced a bare URL with no preview,
 *     and Google saw an empty shell. The events surface is the acquisition half of this product and
 *     it was invisible to every acquisition channel.
 *
 * THE ACCESS CHECK IS THE SAME ONE `GET /api/events/[id]` MAKES, and it must stay that way: an
 * ObjectId is not a secret (it embeds a timestamp and a counter, so neighbours are enumerable), so
 * `canViewEvent` decides, and a refusal is ALWAYS 404 and never 403 — a 403 confirms the row exists.
 * `notFound()` is that 404.
 *
 * JSON-LD IS GATED ON THE SAME PREDICATE AS `robots`. `visibility: 'private'` and `'pending'` events
 * are reachable at this URL by their owner. Publishing structured data for one would put another
 * user's private event into a search index — strictly worse than an in-app disclosure, because an
 * index cannot be retracted. `lib/events/seo.ts` owns both decisions (`buildEventJsonLd` returns
 * null, `isIndexableEvent` drives `robots`) so they cannot drift apart here.
 *
 * THERE IS DELIBERATELY NO `loading.tsx` IN THIS SEGMENT, AND ADDING ONE BREAKS THE 404. Measured
 * against a dev server, same build, with and without the file:
 *
 *   | request                          | with loading.tsx | without |
 *   | -------------------------------- | ---------------- | ------- |
 *   | `/events/000000000000000000000000` | **200**        | 404     |
 *   | somebody else's private event      | **200**        | 404     |
 *
 * A segment-level loading boundary flushes the shell before this component runs, so the status is
 * already committed by the time `notFound()` is reached and every refusal becomes a SOFT 404 — a 200
 * whose body says "we couldn't find that event". That is a page Google may index, on a corpus that
 * PRUNES events a week after they end, so stale shared links are the normal case rather than an edge
 * one. The skeleton the client version showed is not recoverable here: the access check IS the slow
 * part, so there is nothing that can be rendered before it resolves. `not-found.tsx` keeps the
 * friendly panel; the status keeps the semantics.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 * THE COMPOSITION, AND THE ONE MEASUREMENT THAT DECIDED IT.
 *
 * This screen is one idea — a single event — and its reader is deciding "is this worth my evening
 * and my commute". Everything needed to answer that is the verdict, the clock, the venue and the
 * Register button. Everything else (a 1200-character scraped description, an agenda, a speaker
 * bill, a company list, a provenance line, six other events) is what you read AFTER deciding.
 *
 * The old layout was `flex flex-col lg:flex-row` with the main column first and the action rail
 * second. On a phone that stacks the rail LAST, so the order a reader actually met was: cover,
 * title, pills, the whole description, agenda, speakers, tags, companies, provenance, **six
 * competing events**, and only then the date, the venue, the connection verdict and Register. The
 * product's own thesis and its primary action sat below a list of other things to do instead.
 *
 * So the page is now THREE slots in one grid — head, decide, body — placed explicitly. DOM order
 * is head → decide → body, which is the correct phone stack with no duplicated markup; from `lg`
 * the `decide` slot moves to a sticky right rail spanning both rows. Nothing is rendered twice,
 * which matters because a duplicated section is a duplicated `<h2>` for a crawler.
 *
 * HIERARCHY IS EXPRESSED BY REMOVING CARDS, NOT BY ADDING WEIGHT. Six white `rounded-[18px]
 * card-shadow` boxes with identical radius and shadow gave the provenance footer the same
 * standing as the connection verdict — the thing CLAUDE.md calls "the app's one signal that Luma
 * and Meetup cannot show". The body sections lost their cards and now sit on the page ground,
 * hairline-separated, reading as one document; the verdict is the ONLY object on the page at
 * `--lift-2`, and the only other place using display type. That inversion — the most important
 * thing is the only thing in a card — is cheaper and quieter than making it louder.
 *
 * WHAT WAS TAKEN OFF, each for a measured reason:
 *   · **The pill row.** Every pill it drew is said better elsewhere on this page: live is already
 *     an overlay on the cover, price and format are rows in the facts card, food and the attendee
 *     count are clauses in the verdict, `Curated` moved into the provenance line, and the
 *     duration is derivable from a start and an end that are both shown. `EventPills` is
 *     untouched — `EventRow` and `EventGridCard` still need it, where a dense row has no space
 *     for prose.
 *   · **`event.tags`.** An unlabelled pill row directly above the company pills, firing on **4
 *     of 277** upcoming tech events, with six distinct values in the whole corpus
 *     (`diag-tag-supply.ts`). The category dots above the title answer "what is this about" at
 *     100% coverage.
 *   · **The 4px solid category bar** across the top of the facts card. The direction doc allows
 *     category colour as a tint or a thin spine and not as a fill, and the dots above the title
 *     already carry it — two elements competing to say one thing.
 *   · **Five material icons** from the facts card. "Thursday, 18 September" does not need a
 *     calendar glyph and `₹0` does not need a ticket; a two-column `<dl>` carries the same
 *     structure and says what each fact IS.
 *   · **Five ALL-CAPS `.t-label` eyebrows**, and every middle-dot meta string but one.
 *
 * WHAT WAS ADDED: `audience` and `perks`, which the tagger derives and this page rendered
 * nowhere. Measured on the same corpus — `audience` on **123 of 277** upcoming tech events,
 * `perks` on 28. "Aimed at students, juniors" is half of "is this worth my evening" answered in
 * three words, and it was already in the database.
 *
 * GREYS ARE TOKENS HERE, NOT LITERALS, WHICH IS A DEBT PAYMENT RATHER THAN A PREFERENCE. Three
 * text colours on this page failed 4.5:1 when measured in the harness — the `<dt>` labels and the
 * "Working against it" lead-in at `#8E8E93` (3.26 on white), the provenance line at `#86868B`
 * (3.33 on the page grey), the similar-event meta at `#86868B` (3.62) — all at 12–12.5px, where no
 * large-text exemption applies. globals.css retuned the whole ink scale for exactly this
 * (`--ink-2` #5C5C61, `--ink-3` #6F6F75, `#8E8E93` reclassified as `--ink-disabled` and no longer a
 * text colour) and its note asks that each file replace its literals with the token as it is
 * touched, because the failing hex is pasted into ~240 call sites and retuning the token alone
 * fixes almost none of them. So this file now references `var(--ink-2)` / `var(--ink-3)` and holds
 * no grey hex: the next retune reaches this page without an edit.
 *
 * ONE CONTRAST MISS IS LEFT AND IS NOT MINE TO FIX: `--blue` on `--paper` measures **4.31**, so the
 * description's "Read the full description" button and a strong speaker match both sit just under
 * 4.5:1 at 13.5px/600. Darkening blue on one page would break "one accent, rationed", which
 * globals.css owns and which the direction doc makes non-negotiable. Reported, not diverged from.
 * ═════════════════════════════════════════════════════════════════════════════════════════════
 */

interface LoadedEvent {
  event: FeedEvent;
  /** Kept beside the client shape because `FeedEvent` has no `visibility` — SEO needs it. */
  visibility: string | null;
  related: FeedEvent[];
  /**
   * Carried out of the loader so the page can do the viewer-scoped speaker lookup WITHOUT a second
   * `getCurrentUserId()`, and so `generateMetadata` never pays for it — metadata has no speakers in
   * it, and the lookup is per-viewer, which is the opposite of what a shared preview card wants.
   */
  viewerId: string | null;
}

/**
 * Read the event once per request, for `generateMetadata` AND the page.
 *
 * `cache()` from React memoises within a single render pass, which is exactly what Next's metadata
 * guide prescribes for this — without it the document, the access check and the related query all
 * run twice on every page view.
 */
const loadEvent = cache(async (id: string): Promise<LoadedEvent | null> => {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  await connectDB();
  /*
   * NO `.select()` HERE, DELIBERATELY. `canViewEvent` reads THREE fields — `visibility`,
   * `createdByUserId` and `deletedAt` — and every check in it treats absence as permissive,
   * because absence genuinely is the common case for the ~1500 scraped rows that predate those
   * fields. So a projection that forgets one does not throw and does not deny: it silently
   * returns true for everything. `POST /api/folders` shipped exactly that bug with `visibility`.
   * An unprojected read cannot have it.
   */
  const doc = await Event.findById(id).lean();
  if (!doc) return null;

  const viewerId = await getCurrentUserId();
  if (!canViewEvent(doc, viewerId)) return null;

  /*
   * "Similar events", same query as the API route.
   *
   * THE VISIBILITY CLAUSE HERE IS NOT BELT-AND-BRACES. Without it, other users' private events
   * appear as suggestions at the bottom of every public event page — a leak needing no id guessing
   * at all, just a visit to any event.
   */
  const related = await Event.find({
    _id: { $ne: doc._id },
    startDateTime: { $gte: new Date() },
    category: { $in: doc.category?.length ? doc.category : ['Networking/Meetup'] },
    // `publicEventScope`, NOT `visibilityClause` -- see the note on that function. It is what also
    // keeps a soft-deleted event from reappearing here as a suggestion.
    ...publicEventScope(viewerId),
  })
    .select('title startDateTime venue area format imageUrl category isFree price organizer')
    .sort({ startDateTime: 1 })
    .limit(6)
    .lean();

  return {
    event: toFeedEvent(doc),
    visibility: doc.visibility ?? null,
    related: toFeedEvents(related),
    viewerId,
  };
});

/** The narrow shape `lib/events/seo.ts` reads, assembled from what the loader returned. */
function seoInput(loaded: LoadedEvent): SeoEvent {
  return { ...loaded.event, visibility: loaded.visibility };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadEvent(id);

  /*
   * A refused or missing event gets NOTHING but a noindex title.
   *
   * `loadEvent` has already applied `canViewEvent`, so this branch also covers "somebody else's
   * private event": naming it here would leak through the `<title>` and `og:title` the very thing
   * the 404 below exists to withhold.
   */
  if (!loaded) {
    return { title: 'Event not found · PulseBLR', robots: { index: false, follow: false } };
  }

  const seo = seoInput(loaded);
  const canonical = absoluteUrl(`/events/${loaded.event._id}`);
  const description = eventSeoDescription(seo);
  const indexable = isIndexableEvent(seo);

  return {
    /*
     * `metadataBase` is set per page rather than in the root layout, and it is required: without
     * it Next resolves the generated OG image against a guessed origin (localhost in development,
     * `VERCEL_URL` otherwise) and a preview card then points at a host that is not ours.
     * `canonicalOrigin()` is `NEXTAUTH_URL`, the one pinned origin this app already trusts —
     * deliberately NOT the request's `Host` header, which is attacker-controlled because
     * `auth.ts` sets `trustHost: true`.
     *
     * IN DEVELOPMENT THE `og:image` URL WILL SHOW THE DEV PORT, NOT THIS ORIGIN, AND THAT IS NOT A
     * BUG TO FIX. Next overrides `metadataBase` for file-convention social images specifically:
     * `getSocialImageMetadataBaseFallback` (node_modules/next/dist/lib/metadata/resolvers/
     * resolve-url.js) returns `http://localhost:$PORT` unconditionally when
     * `NODE_ENV === 'development'`, and only in production does it fall through to
     * `metadataBase || VERCEL_PROJECT_PRODUCTION_URL`. Observed on a dev server: `og:url` and the
     * canonical read `:3000` from here while `og:image` read `:3105`. Production uses this value.
     */
    metadataBase: new URL(canonicalOrigin()),
    title: `${loaded.event.title} · PulseBLR`,
    description,
    alternates: { canonical },
    openGraph: {
      title: loaded.event.title,
      description,
      url: canonical,
      siteName: 'PulseBLR',
      type: 'website',
      locale: 'en_IN',
      /*
       * No `images` key on purpose. Next resolves the `opengraph-image.tsx` file convention in this
       * segment and merges it in; setting `images` here would OVERRIDE the generated card. The card
       * has to be generated rather than pointing at the scraped cover — the click-through crawl
       * measured 39 covers refusing cross-origin embedding (`ERR_BLOCKED_BY_ORB`,
       * `NotSameSite`) from the Snowflake, ClickHouse and Meetup CDNs, and an OG image that fails
       * to load fails SILENTLY in whatever app is rendering the preview.
       */
    },
    twitter: {
      card: 'summary_large_image',
      title: loaded.event.title,
      description,
    },
    // The security property, stated once and derived from one predicate. Any event carrying a
    // `visibility` value is owner-visible and must never be indexed.
    robots: indexable ? undefined : { index: false, follow: false },
  };
}

export default async function EventDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const loaded = await loadEvent(id);

  // ALWAYS 404, NEVER 403 — see the header. This covers a bad id, a deleted event, and somebody
  // else's private one, with an identical response for all three.
  if (!loaded) notFound();

  const { event, related } = loaded;
  const jsonLd = buildEventJsonLd(seoInput(loaded), absoluteUrl(`/events/${event._id}`));

  /*
   * Speakers matched to the VIEWER's own people, index-aligned with `event.speakers`.
   *
   * Costs nothing on almost every event: `speakers` is sparse, and the loader returns before its
   * first query for an anonymous visitor or an event with no bill. `matchSpeakers` never creates a
   * `Person` — it holds no model at all, which is the point of it being pure.
   */
  const speakerMatches = await loadSpeakerMatches(event.speakers, loaded.viewerId);

  const live = isHappeningNow(event.startDateTime, event.endDateTime);

  return (
    <Shell>
      {/*
       * Structured data. `serializeJsonLd` is the ONLY sanctioned serialiser: `JSON.stringify` does
       * not escape `<` (Next's JSON-LD guide says so), and every string in this object — title,
       * description, organizer, venue — is SCRAPED from a third-party page, so a title carrying
       * `</script><script>…` would be stored XSS on our own domain.
       *
       * `jsonLd` is null for a non-public event, and the block is then not rendered at all.
       */}
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: serializeJsonLd(jsonLd) }}
        />
      )}

      <article className="max-w-[1100px] mx-auto px-4 md:px-8 pt-3 md:pt-6">
        {/* A back link rather than a breadcrumb trail, and it keeps its arrow. This page's most
            common entry is a shared WhatsApp link, where there is no in-app history to go back
            through — so the one affordance that says "there is more here" has to be visible. The
            arrow points LEFT and marks direction; the decorative trailing `→` the direction doc
            names appears nowhere on this page. */}
        <Link
          href="/"
          className="pressable inline-flex min-h-[44px] items-center gap-1 text-[13px] font-semibold text-[color:var(--ink-2)] hover:text-[#1D1D1F] transition-colors"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[16px]">arrow_back</span>
          All events
        </Link>

        {/*
          THREE SLOTS, PLACED EXPLICITLY — see the header for why the phone order is the whole
          point. Auto-placement would work today and would silently reorder the moment a fourth
          child appeared, so every slot names its own row and column.
        */}
        <div className="mt-1 lg:grid lg:grid-cols-[minmax(0,1fr)_348px] lg:gap-x-10">
          {/* ── Head: what this is ──────────────────────────────────────── */}
          <header className="lg:col-start-1 lg:row-start-1">
            {/*
              A RATIO BOX, not a ratio on the image.
              `aspect-[2/1]` on the wrapper reserves the full height from the width alone, before a
              byte of the cover has arrived — so the title and everything below it are laid out
              once and never move. Putting the ratio on the `<img>` happens to work today and stops
              working the moment somebody changes its className, and the failure is a page that
              jumps under the reader's thumb as each cover lands. It also matters more here than
              anywhere: 79 of 277 upcoming tech events have no cover at all, so the box is holding
              space for `EventCover`'s fallback nearly a third of the time.

              FULL-BLEED ON A PHONE (`-mx-4`, cancelled at `md`). The cover is the only colourful
              thing on this page, and 16px of grey gutter either side of it on a 390px screen
              turned the showpiece into a thumbnail. The radius goes with the gutter, because a
              bled edge with rounded corners reads as a mistake rather than as a decision.
            */}
            <div
              className={`relative -mx-4 md:mx-0 overflow-hidden bg-white md:rounded-[18px] md:card-shadow ${
                event.imageUrl ? 'aspect-[2/1] max-h-[380px]' : 'h-[124px] md:h-[148px]'
              }`}
            >
              {/*
                THE BAND IS SHORTER WHEN THERE IS NO PHOTOGRAPH, and that is not an inconsistency.
                A 2:1 box exists to reserve the shape of a cover before it loads. With `imageUrl`
                absent the server already knows none is coming, so there is nothing to reserve and a
                195px tinted block on a 390px phone would only push the title and the verdict down.
                The 2:1 ratio IS kept when a URL exists, for the load, and for the one measured case
                where a URL fails (1 of 197) — `EventCover`'s own fallback then fills the same box
                and nothing shifts.

                `date` is passed, so a coverless page opens on the date in the category tint rather
                than on a two-letter monogram that carries no information. `.cover-date` sizes itself
                from the box through `cqmin`, so this band gets a ~52px day with no size prop.
              */}
              <EventCover
                src={event.imageUrl}
                title={event.title}
                category={event.category?.[0]}
                className="w-full h-full"
                monogramSize="text-6xl"
                date={event.startDateTime}
              />
              {live && (
                <span className="absolute left-4 top-4 pill pill-live shadow-sm bg-white">
                  <span className="live-dot w-1.5 h-1.5 rounded-full bg-[#FF3B30]" />
                  Happening now
                </span>
              )}
            </div>

            {/* Category as a dot plus a label, not a filled block. Saturated chips stacked
                directly above the title made the taxonomy the loudest thing on the page; the
                colour still identifies the category, at a tenth of the visual weight.

                A category links to its topic page only when one is PUBLISHED —
                `topicForDimension` is a lookup in that set, not a slugify, because only 16 of the
                22 categories have a page and a hand-rolled slug would link the rest to a 404. */}
            <div className="mt-5 flex flex-wrap items-center gap-x-3.5 gap-y-1.5">
              {(event.category || []).map(category => {
                const topic = topicForDimension('category', category);
                const dot = (
                  <span
                    aria-hidden="true"
                    className="h-[7px] w-[7px] rounded-full"
                    style={{ background: categoryAccent(category) }}
                  />
                );
                return topic ? (
                  <Link
                    key={category}
                    href={`/topics/${topic.slug}`}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#3a3a3c] hover:text-[color:var(--blue)] transition-colors"
                  >
                    {dot}
                    {category}
                  </Link>
                ) : (
                  <span
                    key={category}
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#3a3a3c]"
                  >
                    {dot}
                    {category}
                  </span>
                );
              })}
            </div>

            {/* The subject of the page, and the biggest thing on it. Tracking follows the
                globals.css rule that it is a function of size, so this is set tighter than the
                verdict below it rather than sharing one letter-spacing. */}
            <h1
              className="mt-2.5 text-[27px] md:text-[38px] font-bold leading-[1.06] tracking-[-0.035em] text-[#1D1D1F]"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {event.title}
            </h1>
          </header>

          {/* ── Decide: the verdict, the facts, the action ───────────────────
              SECOND IN THE DOM so a phone meets it immediately after the title; a sticky rail
              from `lg`. `row-span-2` makes the grid area as tall as the page, which is what gives
              the sticky child something to travel through. */}
          <aside className="lg:col-start-2 lg:row-start-1 lg:row-span-2">
            {/*
              THE RAIL HOLDS EXACTLY TWO CARDS, AND THE THIRD ONE WAS REMOVED FOR A MEASURED REASON.
              A `position: sticky` child taller than the viewport cannot stick — it pins at its
              offset and everything past the fold stays unreachable for the whole scroll. Measured in
              the harness at 1440x900 with the old three-card rail: **901px against 816px of
              available height (900 − 84)**, so the rail's bottom sat at viewport 985 and the
              Save / calendar / share row under Register was clipped for the entire descent through
              the description. Two cards measure 811px and everything is reachable.

              So the "mentions hiring" note moved into the body, where it also reads better — it is a
              remark about the listing's copy, not part of the decision instrument. That is the one
              thing taken off this surface, and it happened to be the weakest card on it.
            */}
            <div className="mt-6 lg:mt-0 lg:sticky lg:top-[84px] flex flex-col gap-3">
              {typeof event.connectionScore === 'number' && <WorthGoing event={event} />}
              <EventFacts event={event} />
            </div>
          </aside>

          {/* ── Body: what you read after deciding ──────────────────────────
              No cards. Hairline-separated sections on the page ground, so the verdict stays the
              only floating object and this reads as one document about one event. */}
          <div className="lg:col-start-1 lg:row-start-2 min-w-0 mt-9">
            {event.description && event.description !== event.title && (
              /* No heading. A block of prose under the facts is self-evidently the description,
                 and the direction doc's rule is to delete a label that says what the content
                 below already says. `stripMarkdown`, not the raw string: 494 of 1201 upcoming
                 descriptions carry markdown syntax (491 of them from Meetup), and this is plain
                 text with `whitespace-pre-line`, so `**Details**` and `## Heading` reached the
                 reader literally. Stripped rather than rendered because a description is
                 untrusted scraped text — see the note on stripMarkdown in lib/format.ts. */
              <Description text={stripMarkdown(event.description)} />
            )}

            {event.recruiterMentioned && (
              /* A LINE, NOT A CARD, AND GREYSCALE. It used to be a `bg-[#0071E3]/[0.06]` panel with
                 blue text in the action rail — but `--blue` means "you can act on this" and nothing
                 here is actionable, so a tinted informational box is exactly the decoration the
                 rationing rule exists to stop. As a remark about the listing's own copy it belongs
                 beside the copy. */
              <p className="mt-6 max-w-[64ch] text-[13px] leading-[1.5] text-[color:var(--ink-2)]">
                This listing names recruiting or open roles — worth logging who you meet.
              </p>
            )}

            {/*
              AGENDA AND SPEAKERS RENDER NOTHING WHEN ABSENT, which is the normal case — measured
              2026-09-12: **0 of 277** upcoming tech events carry either field.

              Both are sparse by nature — they come from richer Luma copy, organiser submissions
              and the company-microsite path, never from a platform API — so an empty shell headed
              "Agenda" would be on every page in the corpus, asserting that we know the schedule
              and that it is blank. That is the calendar's "No events this month" mistake in a
              different place: the most confident-looking answer standing in for missing data. A
              section that is not there makes no claim at all.
            */}
            <EventAgenda items={event.agenda} />
            <EventSpeakers speakers={event.speakers} matches={speakerMatches} />

            {event.companies && event.companies.length > 0 && (
              <Section heading="Companies">
                <div className="flex flex-wrap gap-2">
                  {event.companies.map(name => (
                    <Link
                      key={name}
                      href={`/companies?q=${encodeURIComponent(name)}`}
                      /* Painted taller than `.pill`'s natural 22px so the target is honest, but
                         NOT wrapped in a 44px overlay: at this gap two overlays would overhang
                         into each other and the later one in the DOM would win the tap — the
                         failure the direction doc's hit-area note describes. */
                      className="pill pill-quiet pressable min-h-[32px] px-3 hover:bg-[#F7F7F9]"
                    >
                      {name}
                    </Link>
                  ))}
                </div>
              </Section>
            )}

            <Provenance event={event} />

            {related.length > 0 && (
              <Section heading="Similar events">
                <div className="flex flex-col gap-2">
                  {related.map(item => (
                    <Link
                      key={item._id}
                      href={`/events/${item._id}`}
                      className="group pressable flex items-center gap-3 bg-white rounded-xl card-shadow p-3"
                    >
                      <EventCover
                        src={item.imageUrl}
                        title={item.title}
                        category={item.category?.[0]}
                        className="w-14 h-14 rounded-lg shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold text-[#1D1D1F] truncate group-hover:text-[color:var(--blue)] transition-colors">
                          {item.title}
                        </p>
                        {/* THE ONE middle-dot meta string left on this page, and it is the case
                            the direction doc allows: day, time and place genuinely are a list of
                            equals, and there is no room on a 56px-tall row to give any of them
                            its own line. Every other dot string on this page became a comma or a
                            separate row. */}
                        <p className="text-[12px] text-[color:var(--ink-3)] tnum">
                          {dayLabelIST(item.startDateTime)} · {timeIST(item.startDateTime)} ·{' '}
                          {locationLabel(item)}
                        </p>
                      </div>
                    </Link>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      </article>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />
      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
      </header>
      <main className="pt-14 pb-24 md:pb-10">{children}</main>
      <MobileBottomNav />
    </div>
  );
}

/**
 * A body section: a hairline, a sentence-case heading, the content.
 *
 * The hairline is doing the job six identical white cards used to do, at a fraction of the visual
 * weight — which is what leaves the verdict as the only elevated object on the page. Every heading
 * here earns itself: "Agenda", "Speaking", "Companies" and "Similar events" all name something a
 * reader could not infer from the content beneath. The description has NO heading for exactly that
 * reason.
 */
function Section({ heading, children }: { heading: string; children: React.ReactNode }) {
  return (
    <section className="mt-9 border-t border-[color:var(--hairline)] pt-7">
      <h2 className="t-sub text-[#1D1D1F]">{heading}</h2>
      <div className="mt-3">{children}</div>
    </section>
  );
}

/**
 * "Is this worth my evening?" — the question the whole product exists to answer, and the one place
 * on this page where any boldness is spent.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE REASONS ARE MEASURED, NOT RESTATED. This panel used to build its own list, including a
 * hand-copied `FUNNEL` regex — and that copy had already fallen behind `FUNNEL_PATTERN`: it knew
 * nothing of `demo class`, `trial class`, `placement` or `\d+% off`, all of which were added to the
 * real pattern after two coaching-centre adverts reached the top of the live feed. So the panel
 * confidently explained a heavily-penalised event WITHOUT MENTIONING THE PENALTY.
 * `lib/events/score-reason.ts` derives every clause by calling `connectionScore` twice and
 * differencing, so the words and the bars cannot disagree again. The bars and the verdict come from
 * the same module for the same reason: `>= 70 ? 3 : >= 50 ? 2` was written out by hand here AND in
 * `EventRow`, two copies of one threshold.
 *
 * STILL NO NUMBER. The score is a ranking signal, not a measurement; printing "83" implies a
 * precision it does not have. `ScoreReason.weight` orders the clauses and never reaches the DOM —
 * and note that the reasons are NOT drawn at lengths proportional to their weight either, which
 * would print the number graphically.
 *
 * WHY THE COUNTERWEIGHT GETS ITS OWN GROUP RATHER THAN A GREY ICON. Measured over the 277 upcoming
 * tech events on 2026-09-12: reason counts run 2–6 (median 4) and **154 of them — 56% — carry at
 * least one negative clause**. A majority of this feed has something arguing against it, so a
 * one-sided "here is why it is good" list would be wrong more often than right, and the penalty is
 * precisely what the shipped bug above buried. Grouping it under a lead-in costs one line and
 * cannot be mistaken for a positive; four per-row icons cost four and can.
 *
 * WHAT WAS REMOVED: an ALL-CAPS "WORTH GOING?" eyebrow (the verdict IS the heading now), three
 * green `check` glyphs and one grey `remove` glyph, and two sentences of fine print. "Our read on"
 * hedges in three words what "A ranking signal, not a promise. Powers the feed's Best for
 * connections sort" took two sentences and a line of app mechanics to say.
 *
 * Hooks-free, so it renders on the server with the rest of the page.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
function WorthGoing({ event }: { event: FeedEvent }) {
  const score = event.connectionScore ?? 0;
  const level = meterLevel(score);
  const reasons = scoreReasons(event);
  const forIt = reasons.filter(r => r.good);
  const against = reasons.filter(r => !r.good);

  return (
    /* THE ONLY `--lift-2` OBJECT ON THE PAGE, and a slightly larger radius than anything else, so
       it reads as the one thing standing above a flat document rather than as another card. */
    <section className="rounded-[22px] bg-white card-shadow-lg p-5 md:p-6">
      <div className="flex items-center gap-3">
        {/*
          THE SIGNATURE ELEMENT, AT TWICE ITS FEED SIZE.

          `.meter` (globals.css) is 11px tall with 3px bars — right in a dense feed row, far too
          quiet for the one object this page is built around. It is SCALED rather than reimplemented
          so it stays the same element: a change to the bar count, the colour or the `data-level`
          mapping reaches this automatically, and a second visual definition of the meter could
          drift from the rail the reader has already learnt. `scale(2)` exactly, because every
          dimension in the rule is an integer and 2× keeps them integers (3→6px bars, 5/8/11→10/16/22px
          heights, 2→4px gaps) — a fractional scale would blur the hairline geometry.

          The wrapper is a fixed box because `transform` does not affect layout: without it the row
          would reserve 13×11px for something painting at 26×22px.
        */}
        <span aria-hidden="true" className="block h-[22px] w-[26px] shrink-0">
          <span
            className="meter"
            data-level={level}
            style={{ transform: 'scale(2)', transformOrigin: 'left bottom' }}
          >
            <i />
            <i />
            <i />
          </span>
        </span>
        <h2
          className="text-[26px] font-bold leading-[1.1] tracking-[-0.028em] text-[#1D1D1F]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {connectionVerdict(score)}
        </h2>
      </div>

      {/* What the judgement is ABOUT, in sentence case, saying something — which is the job an
          ALL-CAPS eyebrow was doing here badly. `meterLabel` stays as the accessible name of the
          bars, because the bars themselves are `aria-hidden`. */}
      <p className="mt-1.5 text-[12.5px] leading-[1.45] text-[color:var(--ink-2)]">
        Our read on your chances of leaving with useful contacts
      </p>
      <span className="sr-only">{meterLabel(score)}</span>

      {reasons.length > 0 ? (
        <div className="mt-4 border-t border-[color:var(--hairline)] pt-3.5">
          {forIt.length > 0 && (
            <ul className="flex flex-col gap-2">
              {forIt.map(reason => (
                /* `signal` is a safe key: the module resolves to at most one reason per signal. */
                <li key={reason.signal} className="text-[13px] leading-[1.45] text-[#1D1D1F]">
                  {reason.long}
                </li>
              ))}
            </ul>
          )}

          {against.length > 0 && (
            <div className={forIt.length > 0 ? 'mt-3.5 border-t border-[color:var(--hairline)] pt-3.5' : ''}>
              {/* NOT quieter than the clauses above it. Greying the counterweight out is how a
                  panel comes to explain a course advert without mentioning the penalty. */}
              <p className="text-[12px] leading-[1.3] text-[color:var(--ink-3)]">Working against it</p>
              <ul className="mt-1.5 flex flex-col gap-2">
                {against.map(reason => (
                  <li key={reason.signal} className="text-[13px] leading-[1.45] text-[#1D1D1F]">
                    {reason.long}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        /* A listing with no format, no host and no categories genuinely has nothing to argue with.
           Saying so is better than an empty list under a confident verdict. Rare but reachable: the
           smallest reason count in the upcoming tech corpus is 2, so this is the hand-entered case. */
        <p className="mt-4 border-t border-[color:var(--hairline)] pt-3.5 text-[13px] leading-[1.45] text-[color:var(--ink-2)]">
          This listing carries too little detail to say much either way.
        </p>
      )}
    </section>
  );
}

/**
 * When, where, who it is for, what you get, who is behind it, what it costs — then the action.
 *
 * A TWO-COLUMN `<dl>`, NOT AN ICON LIST. The five material glyphs this replaces (calendar_month,
 * location_on, person, confirmation_number, schedule) were decoration: "Thursday, 18 September"
 * does not need a calendar to be understood, and the glyph could not say which of the two dates on
 * screen it belonged to. A `<dt>` says what the fact IS, in one word, and the alignment does the
 * grouping the icons were pretending to do — structure carrying information rather than restating
 * it. It is also the semantically correct element for a set of name/value pairs.
 *
 * SPARSE ROWS RENDER NOTHING, the same rule the agenda and the speaker bill follow. Measured over
 * the 277 upcoming tech events: `audience` 123, `perks` 28, `organizer` 263, `address` 70,
 * `registrationDeadline` **0** — so that last row is correct, guarded and currently dormant on the
 * whole tech corpus, which is worth knowing before debugging it as a bug.
 */
function EventFacts({ event }: { event: FeedEvent }) {
  const mapsQuery = encodeURIComponent(
    [event.venue, event.address, event.area, 'Bengaluru'].filter(Boolean).join(', ')
  );
  const audience = (event.audience || []).map(vocabLabel);
  const perks = (event.perks || []).map(vocabLabel);

  return (
    <section className="rounded-[18px] bg-white card-shadow p-5 md:p-6">
      <dl className="grid grid-cols-[62px_minmax(0,1fr)] gap-x-3 gap-y-4">
        <Fact label="When">
          <p className="text-[14.5px] font-semibold leading-[1.3] text-[#1D1D1F]">
            {fullDateIST(event.startDateTime)}
          </p>
          {/* THE DURATION IS GONE, DELIBERATELY: with a start and an end both printed, "2h" is
              arithmetic the reader can do, and cutting it takes this line from two commas to one.
              `relativeTime` is INK, not blue — it is a fact, and blue on this page means "you can
              act on this". */}
          <p className="mt-0.5 text-[13px] leading-[1.4] text-[color:var(--ink-2)] tnum">
            {timeIST(event.startDateTime)}
            {event.endDateTime && ` – ${timeIST(event.endDateTime)}`}
            {`, ${relativeTime(event.startDateTime)}`}
          </p>
        </Fact>

        <Fact label="Where">
          <p className="text-[14.5px] font-semibold leading-[1.3] text-[#1D1D1F]">
            {locationLabel(event)}
          </p>
          {/*
            THE FULL POSTAL ADDRESS IS NOT PRINTED, and that is a removal rather than an oversight.
            Measured in the harness at 1440x900: `event.address` took THREE lines of the 348px
            decision rail ("No. 11, Church Street, Shanthala Nagar, Ashok Nagar, Bengaluru 560001")
            directly under a venue name that had already wrapped. `locationLabel` folds the area in,
            and venue-plus-area is the whole commute signal for a Bengaluru reader — "Church Street"
            or "Whitefield" answers it; a PIN code does not. Nothing is lost: the address is still in
            the `mapsQuery` below, so Maps resolves the exact door. Coverage is 70 of 277 anyway.
          */}
          {event.format !== 'online' && (
            /* 44px, and it earns the space: "how far is the commute" is half the question this
               page exists to answer, and nothing sits beside this link to contest the band. */
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
              target="_blank"
              rel="noopener noreferrer"
              className="pressable inline-flex min-h-[44px] items-center text-[13px] font-semibold text-[color:var(--blue)] hover:text-[color:var(--blue-press)] transition-colors"
            >
              Open in Maps
            </a>
          )}
        </Fact>

        {audience.length > 0 && (
          <Fact label="Aimed at">
            <p className="text-[14.5px] leading-[1.35] text-[#1D1D1F]">{audience.join(', ')}</p>
          </Fact>
        )}

        {perks.length > 0 && (
          <Fact label="You get">
            <p className="text-[14.5px] leading-[1.35] text-[#1D1D1F]">{perks.join(', ')}</p>
          </Fact>
        )}

        {event.organizer && (
          <Fact label="Host">
            <div className="flex items-center gap-2">
              {event.hostAvatarUrl && (
                // eslint-disable-next-line @next/next/no-img-element -- third-party avatar CDN
                <img
                  src={event.hostAvatarUrl}
                  alt=""
                  className="w-7 h-7 rounded-full object-cover shrink-0"
                />
              )}
              <p className="text-[14.5px] font-semibold leading-[1.3] text-[#1D1D1F] min-w-0 truncate">
                {event.organizer}
              </p>
            </div>
          </Fact>
        )}

        <Fact label="Ticket">
          <p className="text-[14.5px] font-semibold leading-[1.3] text-[#1D1D1F]">
            {event.soldOut ? 'Sold out' : priceLabel(event)}
          </p>
        </Fact>

        {event.registrationDeadline && (
          <Fact label="Closes">
            <p className="text-[14.5px] leading-[1.3] text-[#1D1D1F]">
              {relativeTime(event.registrationDeadline)}
            </p>
          </Fact>
        )}
      </dl>

      {/* The only interactive block on the page — see EventDetailClient.tsx. */}
      <div className="mt-5 border-t border-[color:var(--hairline)] pt-4">
        <EventActions event={event} />
      </div>
    </section>
  );
}

/** One `<dt>`/`<dd>` pair. A fragment, so both land as direct grid items of the `<dl>`. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="pt-[3px] text-[12.5px] font-semibold leading-[1.3] text-[color:var(--ink-3)]">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/**
 * A LOCAL COPY OF `FilterRail.vocabLabel`, AND IT SHOULD NOT STAY ONE.
 *
 * `senior-engineers` -> `Senior engineers`. Sentence case, not Title Case: the vocabularies are
 * plain descriptions of people and things (`students`, `lunch`, `swag`), and Title-Casing them
 * would make them read like proper nouns.
 *
 * The original is a private, unexported function in `app/components/FilterRail.tsx`, which this
 * pass may not edit, so importing it is not available. It is duplicated rather than skipped
 * because the alternative was leaving `audience` — 123 of 277 upcoming tech events — rendered
 * nowhere. THE DRIFT RISK IS COSMETIC, not a wrong judgement: the vocabularies themselves live in
 * `lib/event-types.ts` and are not copied here, so the worst outcome is the rail and this page
 * capitalising the same word differently, which is visible on sight. It belongs in a shared
 * module; see the report.
 *
 * ONE ACRONYM EXCEPTION, WHICH THE RAIL DOES NOT HAVE. `sre` -> `SRE`. The rail declines the
 * exception on the grounds that it is "more machinery than one row of the shortest facet
 * deserves", and in a column of chips that is right. Here the value is read as prose — "Aimed at
 * senior engineers, Sre" — where it is simply wrong. 18 of 277 events carry it.
 */
const VOCAB_ACRONYMS: Record<string, string> = { sre: 'SRE' };

function vocabLabel(value: string): string {
  if (VOCAB_ACRONYMS[value]) return VOCAB_ACRONYMS[value];
  const spaced = value.replace(/-/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Where this listing came from. Builds trust and routes the reader to the authoritative page.
 *
 * THE HAND-ADDED CASE WAS A VISIBLE BUG. `POST /api/events` writes `source: 'manual'` for anything
 * typed in through `/add-event`, and this line rendered `Listed on Manual` — a `capitalize` on an
 * internal enum value, presented to the reader as the name of a platform. It now says what
 * actually happened, which is also where the `Curated` pill's claim went when the pill row was
 * removed: that a human chose to put this here, which changes how much of the rest to trust.
 */
function Provenance({ event }: { event: FeedEvent }) {
  const isManual = event.source === 'manual';
  const others = (event.seenInSources || []).filter(source => source !== event.source);
  // Only an http(s) URL is rendered as a link. `sourceUrl` on a hand-entered event is whatever the
  // submitter typed, and this string reaches an `href` — the same reason `manual-input.ts` refuses
  // a `javascript:` URL on `applyLink`.
  const linkable = /^https?:\/\//i.test(event.sourceUrl || '');

  return (
    <p className="mt-9 border-t border-[color:var(--hairline)] pt-7 text-[12.5px] leading-[1.5] text-[color:var(--ink-3)]">
      {isManual ? (
        <>
          Added to PulseBLR by hand rather than scraped.
          {linkable && (
            <>
              {' '}
              <a
                href={event.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[color:var(--blue)] hover:underline"
              >
                Organiser&rsquo;s page
              </a>
            </>
          )}
        </>
      ) : (
        <>
          Listed on{' '}
          {linkable ? (
            <a
              href={event.sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-[color:var(--blue)] hover:underline capitalize"
            >
              {event.source}
            </a>
          ) : (
            <span className="font-semibold capitalize">{event.source}</span>
          )}
          {/* "and on Luma, Devevents" rather than " · also seen on …" — one of the four middle-dot
              meta strings this page shed.

              THE `capitalize` WRAPS ONLY THE NAMES, AND THE HARNESS IS WHY. Stored source ids are
              lowercase (`meetup`, `luma`, `devevents`), so the list needs the same `capitalize` the
              primary source gets — but putting it on the whole phrase made `text-transform` case
              every word in it and the page rendered "Listed on Meetup **And On** Luma, Devevents".
              Not visible from the source, and not something `textContent` reveals either: the
              transform is paint-time only. */}
          {others.length > 0 && (
            <> and on <span className="capitalize">{others.join(', ')}</span></>
          )}
        </>
      )}
    </p>
  );
}

/**
 * The timed agenda, when an organiser published one.
 *
 * UNVERIFIED AGAINST REAL DATA: 0 of 277 upcoming tech events carry `agenda`, so only the absent
 * path above is reachable today. This markup is built from the `AgendaItem` type.
 *
 * Built on the feed's own time-rail idiom — clock time in a left gutter, a node, then the content —
 * rather than as another stack of rounded boxes. A schedule is the one thing on this page that IS a
 * sequence, so the rail is carrying information rather than decorating; and reusing the structure
 * the feed already teaches means a reader does not have to learn a second way to read a time. It is
 * also why there are no `01 / 02 / 03` markers: the clock times already number the sequence, and
 * the direction doc reserves numbered markers for content that has no other ordering.
 *
 * `startsAt` is optional, so a bill with titles and no times still renders — the gutter is simply
 * empty. Order is as PUBLISHED, never re-sorted: a partially-timed agenda sorted by time would put
 * the untimed rows in an order the organiser did not choose.
 */
function EventAgenda({ items }: { items?: FeedEvent['agenda'] }) {
  if (!items?.length) return null;

  return (
    <Section heading="Agenda">
      <ol className="flex flex-col">
        {items.map((item, index) => (
          <li key={`${item.title}-${index}`} className="flex gap-3 md:gap-4">
            <span className="w-[42px] shrink-0 pt-[2px] text-right tnum text-[12.5px] font-semibold leading-[1.3] text-[#1D1D1F]">
              {item.startsAt ? timeIST(item.startsAt) : ''}
            </span>
            {/* The connector, drawn on every row but the last, so the column reads as one
                sequence rather than as separate lines that happen to be stacked. */}
            <span aria-hidden="true" className="w-[9px] shrink-0 flex flex-col items-center pt-[6px]">
              <span className="h-[7px] w-[7px] rounded-full bg-[#c7c7cc] shrink-0" />
              {index < items.length - 1 && <span className="flex-1 w-px bg-[color:var(--hairline)]" />}
            </span>
            <div className={`min-w-0 flex-1 ${index < items.length - 1 ? 'pb-4' : ''}`}>
              <p className="text-[14.5px] font-semibold leading-[1.35] text-[#1D1D1F]">
                {item.title}
              </p>
              {(item.speakerName || item.speakerCompany) && (
                /* A comma, not a middle dot: a name and an employer are not a list of equals. */
                <p className="mt-0.5 text-[12.5px] leading-[1.4] text-[color:var(--ink-3)]">
                  {[item.speakerName, item.speakerCompany].filter(Boolean).join(', ')}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/**
 * The speaker bill, and the thing no competitor with no contact layer can print: which of these
 * people you have already met.
 *
 * UNVERIFIED AGAINST REAL DATA, like the agenda: 0 of 277 upcoming tech events carry `speakers`, so
 * neither this bill nor a single `MetBefore` line has been seen against a stored document. Built
 * from the `EventSpeaker` and `SpeakerMatch` types.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE MATCH IS A CLAIM ABOUT THE READER'S OWN MEMORY, so the copy is graded to the evidence.
 * `basis: 'name+company'` had both sides state an employer and agree, and reads as a statement:
 * "Met at IndiaFOSS". `basis: 'name'` had only an exact full name, so it reads as an observation
 * the reader can dismiss: "Same name as someone you met at IndiaFOSS". Rendering both identically
 * would put the weaker inference behind the stronger one's confidence, and the reader cannot check
 * it — not remembering is the entire reason they are reading the line.
 *
 * `matches` is index-aligned with `speakers` and is EMPTY for a signed-out reader, so an anonymous
 * visitor sees the bill and nothing else. A `Person` is per-user data and this page is public,
 * which is also why the join happens here and never in `GET /api/events/[id]` — `sw.js` lists that
 * route under `PRIVATE_API` precisely because a per-viewer response must never be cached.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
function EventSpeakers({
  speakers,
  matches,
}: {
  speakers?: FeedEvent['speakers'];
  matches: (SpeakerMatch | null)[];
}) {
  if (!speakers?.length) return null;

  return (
    <Section heading="Speaking">
      <div className="-mt-1 divide-y divide-[color:var(--hairline)]">
        {speakers.map((speaker, index) => (
          <div
            key={`${speaker.name}-${index}`}
            className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="min-w-0">
              <p className="text-[14.5px] font-semibold leading-[1.3] text-[#1D1D1F]">
                {speaker.linkedin ? (
                  <a
                    href={speaker.linkedin}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[color:var(--blue)] transition-colors"
                  >
                    {speaker.name}
                  </a>
                ) : (
                  speaker.name
                )}
              </p>
              {(speaker.title || speaker.company) && (
                /* A comma, not a middle dot — see the agenda. */
                <p className="mt-0.5 text-[12.5px] leading-[1.4] text-[color:var(--ink-3)]">
                  {[speaker.title, speaker.company].filter(Boolean).join(', ')}
                </p>
              )}
            </div>
            <MetBefore match={matches[index] ?? null} />
          </div>
        ))}
      </div>
    </Section>
  );
}

/** "Met at IndiaFOSS, 18 Jul", linked to the person. Renders nothing without a match. */
function MetBefore({ match }: { match: SpeakerMatch | null }) {
  if (!match) return null;

  const strong = match.basis === 'name+company';
  const when = match.metAt ? shortDateIST(match.metAt) : null;

  /*
   * Deliberately no pronoun. The spec's example reads "you met HER at IndiaFOSS", and nothing in
   * either record says which pronoun to use — `Person` has no gender field and guessing one from a
   * name would be wrong often and wrong in a way that stings. "Met at" needs none.
   */
  const where = match.metAtTitle
    ? strong
      ? `Met at ${match.metAtTitle}`
      : `Same name as someone you met at ${match.metAtTitle}`
    : strong
      ? 'Someone you have met'
      : 'Same name as someone you have met';

  return (
    <Link
      href={`/people/${match.personId}`}
      /* Blue because it is actionable — it opens the person. The one accent in this design system
         means "you can act on this" and is never decoration. The WEAK match stays ink until hover:
         a hedged observation should not be painted with the same confidence as a statement. */
      className={`pressable shrink-0 inline-flex min-h-[44px] items-center gap-1.5 text-[12.5px] font-semibold transition-colors ${
        strong
          ? 'text-[color:var(--blue)] hover:text-[color:var(--blue-press)]'
          : 'text-[color:var(--ink-2)] hover:text-[color:var(--blue)]'
      }`}
      title={
        strong
          ? 'Matched on their full name and their company'
          : 'Matched on their full name alone — no company was stated on either side, so this may be a different person'
      }
    >
      <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
        {strong ? 'how_to_reg' : 'person_search'}
      </span>
      <span>
        {/* Commas, not middle dots. `met 3 times` is spelt out rather than set as `met 3×`: the
            multiplication sign reads as a quantity of the event, not a count of meetings. */}
        {where}
        {when && <span className="tnum font-normal text-[color:var(--ink-3)]">, {when}</span>}
        {strong && match.eventCount > 1 && (
          <span className="tnum font-normal text-[color:var(--ink-3)]"> (met {match.eventCount} times)</span>
        )}
      </span>
    </Link>
  );
}
