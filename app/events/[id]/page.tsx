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
import { FeedEvent } from '@/lib/event-types';

import { DesktopNav, MobileBottomNav } from '../../components/NavBar';
import EventCover from '../../components/EventCover';
import EventPills from '../../components/EventPills';
import EventActions from './EventDetailClient';
import {
  timeIST,
  fullDateIST,
  relativeTime,
  durationLabel,
  locationLabel,
  categoryAccent,
  priceLabel,
  dayLabelIST,
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
 */

interface LoadedEvent {
  event: FeedEvent;
  /** Kept beside the client shape because `FeedEvent` has no `visibility` — SEO needs it. */
  visibility: string | null;
  related: FeedEvent[];
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
    // `publicEventScope`, NOT `visibilityClause` -- see the note on that function.
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

  const accent = categoryAccent(event.category?.[0]);
  const live = isHappeningNow(event.startDateTime, event.endDateTime);
  const duration = durationLabel(event.startDateTime, event.endDateTime);
  const mapsQuery = encodeURIComponent(
    [event.venue, event.address, event.area, 'Bengaluru'].filter(Boolean).join(', ')
  );

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

      <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-4 md:pt-6">
        <Link
          href="/"
          className="inline-flex items-center gap-1 text-[13px] font-semibold text-[#6E6E73] hover:text-[#1D1D1F] transition-colors mb-4"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[16px]">arrow_back</span>
          All events
        </Link>

        <div className="flex flex-col lg:flex-row gap-8">
          {/* ── Main column ─────────────────────────────────────────────── */}
          <div className="flex-1 min-w-0">
            <div className="relative rounded-[18px] overflow-hidden mb-6 bg-white card-shadow">
              <EventCover
                src={event.imageUrl}
                title={event.title}
                category={event.category?.[0]}
                className="w-full aspect-[2/1] max-h-[380px]"
                monogramSize="text-6xl"
              />
              {live && (
                <span className="absolute left-4 top-4 pill pill-live shadow-sm bg-white">
                  <span className="live-dot w-1.5 h-1.5 rounded-full bg-[#FF3B30]" />
                  Happening now
                </span>
              )}
            </div>

            {/* Category as a dot plus a label, not a filled block. Saturated chips
                stacked directly above the title made the taxonomy the loudest thing on
                the page; the colour still identifies the category, at a tenth of the
                visual weight.

                A category links to its topic page only when one is PUBLISHED —
                `topicForDimension` is a lookup in that set, not a slugify, because only 16 of the
                22 categories have a page and a hand-rolled slug would link the rest to a 404. */}
            <div className="mb-3.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
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
                    className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-[#3a3a3c] hover:text-[#0071E3] transition-colors"
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

            <h1
              className="text-[27px] md:text-[38px] font-bold leading-[1.08] tracking-[-0.035em] text-[#1D1D1F] mb-4"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              {event.title}
            </h1>

            <EventPills event={event} />

            {event.description && event.description !== event.title && (
              <section className="mt-8">
                <h2 className="t-label text-[#8E8E93] mb-2.5">
                  About this event
                </h2>
                <div className="bg-white rounded-[18px] card-shadow p-5 md:p-6">
                  {/* stripMarkdown, not the raw string: 494 of 1201 upcoming descriptions carry
                      markdown syntax (491 of them from Meetup), and this <p> is plain text with
                      `whitespace-pre-line`, so `**Details**` and `## Heading` reached the reader
                      literally. Stripped rather than rendered because a description is untrusted
                      scraped text — see the note on stripMarkdown in lib/format.ts. */}
                  <p className="text-[15px] leading-[1.65] text-[#3a3a3c] whitespace-pre-line">
                    {stripMarkdown(event.description)}
                  </p>
                </div>
              </section>
            )}

            {event.tags && event.tags.length > 0 && (
              <section className="mt-6">
                <div className="flex flex-wrap gap-1.5">
                  {event.tags.map(tag => (
                    <span key={tag} className="pill pill-quiet">
                      {tag}
                    </span>
                  ))}
                </div>
              </section>
            )}

            {event.companies && event.companies.length > 0 && (
              <section className="mt-6">
                <h2 className="t-label text-[#8E8E93] mb-2.5">Companies involved</h2>
                <div className="flex flex-wrap gap-1.5">
                  {event.companies.map(name => (
                    <Link
                      key={name}
                      href={`/companies?q=${encodeURIComponent(name)}`}
                      className="pill pill-quiet hover:bg-[#F7F7F9]"
                    >
                      {name}
                    </Link>
                  ))}
                </div>
              </section>
            )}

            {/* Provenance — builds trust and routes the user to the authoritative page. */}
            <section className="mt-6 text-[12.5px] text-[#86868B]">
              Listed on{' '}
              <a
                href={event.sourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#0071E3] hover:underline capitalize"
              >
                {event.source}
              </a>
              {event.seenInSources && event.seenInSources.length > 1 && (
                <> · also seen on {event.seenInSources.filter(s => s !== event.source).join(', ')}</>
              )}
            </section>

            {related.length > 0 && (
              <section className="mt-10">
                <h2 className="t-sub text-[#1D1D1F] mb-3">
                  Similar events
                </h2>
                <div className="flex flex-col gap-2">
                  {related.map(item => (
                    <Link
                      key={item._id}
                      href={`/events/${item._id}`}
                      className="group flex items-center gap-3 bg-white rounded-xl card-shadow p-3 hover:shadow-[0_6px_24px_rgba(0,0,0,0.07)] transition-shadow"
                    >
                      <EventCover
                        src={item.imageUrl}
                        title={item.title}
                        category={item.category?.[0]}
                        className="w-14 h-14 rounded-lg shrink-0"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="text-[14px] font-semibold text-[#1D1D1F] truncate group-hover:text-[#0071E3] transition-colors">
                          {item.title}
                        </p>
                        <p className="text-[12px] text-[#86868B] tnum">
                          {dayLabelIST(item.startDateTime)} · {timeIST(item.startDateTime)} ·{' '}
                          {locationLabel(item)}
                        </p>
                      </div>
                      <span aria-hidden="true" className="material-symbols-outlined text-[18px] text-[#c7c7cc] shrink-0">
                        chevron_right
                      </span>
                    </Link>
                  ))}
                </div>
              </section>
            )}
          </div>

          {/* ── Sticky action card ──────────────────────────────────────── */}
          <aside className="lg:w-[336px] shrink-0">
            <div className="lg:sticky lg:top-[84px] flex flex-col gap-4 pb-8">
              {typeof event.connectionScore === 'number' && (
                <WorthGoing event={event} />
              )}
              <div className="bg-white rounded-[18px] card-shadow overflow-hidden">
                <div className="h-1" style={{ background: accent }} />
                <div className="p-5 flex flex-col gap-4">
                  <div className="flex gap-3">
                    <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0 mt-0.5">
                      calendar_month
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[#1D1D1F]">
                        {fullDateIST(event.startDateTime)}
                      </p>
                      <p className="text-[13px] text-[#6E6E73] tnum">
                        {timeIST(event.startDateTime)}
                        {event.endDateTime && ` – ${timeIST(event.endDateTime)}`}
                        {duration && ` · ${duration}`}
                      </p>
                      <p className="text-[12px] text-[#0071E3] font-semibold mt-0.5">
                        {relativeTime(event.startDateTime)}
                      </p>
                    </div>
                  </div>

                  <div className="flex gap-3">
                    <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0 mt-0.5">
                      {event.format === 'online' ? 'videocam' : 'location_on'}
                    </span>
                    <div className="min-w-0">
                      <p className="text-[14px] font-semibold text-[#1D1D1F]">
                        {locationLabel(event)}
                      </p>
                      {event.address && event.address !== event.venue && (
                        <p className="text-[12.5px] text-[#6E6E73] mt-0.5">{event.address}</p>
                      )}
                      {event.format !== 'online' && (
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${mapsQuery}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[12px] font-semibold text-[#0071E3] hover:underline mt-1 inline-block"
                        >
                          Open in Maps
                        </a>
                      )}
                    </div>
                  </div>

                  {event.organizer && (
                    <div className="flex gap-3 items-center">
                      {event.hostAvatarUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element -- third-party avatar CDN
                        <img
                          src={event.hostAvatarUrl}
                          alt=""
                          className="w-8 h-8 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0">
                          person
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-[11px] uppercase tracking-widest text-[#86868B]">Host</p>
                        <p className="text-[14px] font-semibold text-[#1D1D1F] truncate">
                          {event.organizer}
                        </p>
                      </div>
                    </div>
                  )}

                  <div className="flex gap-3 items-center">
                    <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[#86868B] shrink-0">
                      confirmation_number
                    </span>
                    <p className="text-[14px] font-semibold text-[#1D1D1F]">
                      {event.soldOut ? 'Sold out' : priceLabel(event)}
                    </p>
                  </div>

                  {event.registrationDeadline && (
                    <div className="flex gap-3 items-center">
                      <span aria-hidden="true" className="material-symbols-outlined text-[20px] text-[#FF9500] shrink-0">
                        schedule
                      </span>
                      <p className="text-[13px] text-[#1D1D1F]">
                        Registration closes {relativeTime(event.registrationDeadline)}
                      </p>
                    </div>
                  )}

                  {/* The only interactive block on the page — see EventDetailClient.tsx. */}
                  <EventActions event={event} />
                </div>
              </div>

              {event.recruiterMentioned && (
                <div className="bg-[#0071E3]/[0.06] border border-[#0071E3]/15 rounded-[18px] p-4">
                  <p className="text-[13px] font-semibold text-[#0060C0] flex items-center gap-1.5">
                    <span aria-hidden="true" className="material-symbols-outlined text-[16px]">work</span>
                    Hiring signal
                  </p>
                  <p className="text-[12.5px] text-[#3a3a3c] mt-1">
                    This listing mentions recruiting or open roles. Worth logging who you meet.
                  </p>
                </div>
              )}
            </div>
          </aside>
        </div>
      </div>
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
 * "Is this worth my evening?" — the question the whole product exists to answer.
 *
 * connectionScore is deterministic (lib/events/connection-score.ts), so the factors can
 * be restated here from the same fields rather than guessed at. Showing the reasoning
 * matters more than showing the number: a bare 83/100 is a black box, while "in person,
 * 60 going, food" is something a person can agree or disagree with.
 *
 * Hooks-free, so it renders on the server with the rest of the page.
 */
function WorthGoing({ event }: { event: FeedEvent }) {
  const score = event.connectionScore ?? 0;
  const level = score >= 70 ? 3 : score >= 50 ? 2 : 1;
  const verdict =
    level === 3 ? 'Strong chance' : level === 2 ? 'Worth a look' : 'Probably not';

  // Mirrors the weights in connection-score.ts. Ordered by how much they move the score.
  const FUNNEL = /\b(certifi\w*|cohort|bootcamp|training|masterclass|course|webinar|batch \d)\b/i;
  const reasons: Array<{ good: boolean; text: string }> = [];

  if (event.format === 'offline') reasons.push({ good: true, text: 'In person — you can actually meet people' });
  else if (event.format === 'hybrid') reasons.push({ good: true, text: 'Hybrid — go in person if you can' });
  else reasons.push({ good: false, text: 'Online — you will watch, not mingle' });

  if (typeof event.attendeeCount === 'number' && event.attendeeCount > 0) {
    reasons.push({ good: true, text: `${event.attendeeCount} people going` });
  }
  if (event.hasFood === 'yes') reasons.push({ good: true, text: 'Food — people stay and talk' });
  if (event.companies && event.companies.length > 0) {
    reasons.push({ good: true, text: `Hosted by ${event.companies.slice(0, 2).join(' & ')}` });
  }
  if (FUNNEL.test(event.title)) {
    reasons.push({ good: false, text: 'Reads like a course — you may be in an audience' });
  }
  if (event.isFree) reasons.push({ good: true, text: 'Free — draws practitioners' });

  return (
    <div className="rounded-[18px] bg-white card-shadow p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="t-label text-[#8E8E93]">Worth going?</h2>
        <span className="meter" data-level={level} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      </div>
      <p
        className="mt-1.5 text-[19px] font-bold tracking-[-0.025em] text-[#1D1D1F]"
        style={{ fontFamily: 'var(--font-display)' }}
      >
        {verdict}
      </p>
      <ul className="mt-3 space-y-1.5">
        {reasons.map(r => (
          <li key={r.text} className="flex items-start gap-2 text-[12.5px] leading-snug text-[#3a3a3c]">
            <span
              aria-hidden="true"
              className={`material-symbols-outlined mt-[1px] text-[15px] shrink-0 ${
                r.good ? 'text-[#1D8A44]' : 'text-[#8E8E93]'
              }`}
            >
              {r.good ? 'check' : 'remove'}
            </span>
            {r.text}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[11.5px] leading-relaxed text-[#8E8E93]">
        A ranking signal, not a promise. Powers the feed&rsquo;s &ldquo;Best for
        connections&rdquo; sort.
      </p>
    </div>
  );
}
