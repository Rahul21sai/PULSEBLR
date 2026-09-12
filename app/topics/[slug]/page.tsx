import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache } from 'react';
import type { Metadata } from 'next';

import Event from '@/lib/models/Event';
import connectDB from '@/lib/mongodb';
import { buildEventFilter, buildSort } from '@/lib/events/query';
import { publishedTopics } from '@/lib/events/topic-counts';
import {
  describeRhythm,
  findTopic,
  topicMetaDescription,
  topicPageTitle,
  topicQueryParams,
  topicStaticParams,
  type RhythmInput,
  type Topic,
} from '@/lib/events/topics';
import { toFeedEvents } from '@/lib/events/serialize';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';
import type { FeedEvent } from '@/lib/event-types';

import AppShell from '../../components/AppShell';
import EventRow from '../../components/EventRow';

/**
 * A topic landing page — `/topics/ai-ml`, `/topics/in-koramangala`.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THIS PAGE IS DESIGNED AROUND A PENALTY, NOT A FEATURE. Google treats thin templated pages with a
 * swapped noun as DOORWAY pages and penalises the whole site for them, so "one page per category ×
 * area" is not free traffic — it is a liability that scales with the matrix. Two floors keep the set
 * small and real, and both are enforced rather than intended:
 *
 *   1. WRITTEN COPY MUST EXIST. `findTopic` only resolves slugs in `lib/events/topics.ts`, and every
 *      entry there carries a hand-written paragraph about that topic in this city. An unwritten
 *      dimension 404s here; there is no template that interpolates a name into a sentence.
 *   2. ≥ `MIN_TOPIC_EVENTS` UPCOMING EVENTS, checked against the live corpus on every revalidation
 *      through `publishedTopics()` — the same call the index and the sitemap use, so the three can
 *      never disagree about which URLs exist. Below the floor this returns a 404 even though the
 *      copy exists.
 *
 * WHAT MAKES A PAGE WORTH LANDING ON, beyond the listing: the written paragraph, and a rhythm
 * sentence computed from the events themselves ("Saturday is the busiest day, and these typically
 * start around 18:00"). The second one is the part a template cannot fake — it is a real measurement
 * over live supply, it differs per topic, and `describeRhythm` refuses to produce it below the floor
 * rather than describing a pattern it cannot see.
 *
 * `generateStaticParams` IS DELIBERATELY PURE. It returns every candidate slug without touching the
 * database, so a build never depends on Atlas being reachable to decide which pages exist. The floor
 * is applied at render, which means a slug that is thin at build time is prerendered as a 404 and
 * becomes a real page on a later revalidation when supply arrives — the correct behaviour for a set
 * that changes daily.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Hourly ISR. The supply behind these pages changes once a day, when the scrape runs. */
export const revalidate = 3600;

/** How many rows the page renders. The rhythm sentence still reads the whole matched set. */
const LIST_LIMIT = 24;

/*
 * ── PURE, AND IT RETURNS NOTHING WHEN THERE IS NO DATABASE TO RENDER AGAINST ─────────────────
 *
 * `generateStaticParams` touching no database is the right property and is kept. It was not
 * sufficient, and that gap broke CI on `main`: deciding WHICH pages exist needs no Atlas, but
 * PRERENDERING each of them does — the page body queries Mongo for its events — so a build with
 * no reachable database died on the first slug:
 *
 *     Error occurred prerendering page "/topics/hackathon"
 *     MongooseServerSelectionError: connect ECONNREFUSED
 *     Export encountered an error on /topics/[slug]/page, exiting the build.
 *
 * It passed locally and failed on CI for one reason: `.env.local` supplies `MONGODB_URI` here and
 * the workflow deliberately supplies no secrets. `.github/workflows/ci.yml` predicted exactly this
 * — "the build needs no secrets… if that ever changes this step is where it will surface."
 *
 * So the presence of `MONGODB_URI` is the signal, and it is the honest one: without it `connectDB`
 * falls back to `mongodb://localhost:27017`, which on a CI runner is nothing at all. Returning `[]`
 * prerenders no slugs, `dynamicParams` (true by default) then serves every one on demand, and the
 * first request after deploy populates the ISR cache exactly as a revalidation would. Nothing is
 * lost in production, where the variable is always set.
 *
 * CHECKING THE VARIABLE RATHER THAN ATTEMPTING A CONNECTION is deliberate: a connection attempt
 * here would make the build's page set depend on Atlas being up at that moment, which is the
 * fragility the "deliberately pure" note above exists to prevent. This keys off configuration.
 *
 * `app/sitemap.ts` reaches the same conclusion by a different route — it wraps its query and
 * degrades to static entries, because "a short sitemap costs a day of crawl freshness; a failed
 * build costs the release."
 */
export function generateStaticParams(): Array<{ slug: string }> {
  if (!process.env.MONGODB_URI) return [];
  return topicStaticParams();
}

interface LoadedTopic {
  topic: Topic;
  /** Total upcoming events, from the shared floor definition — not `events.length`. */
  count: number;
  events: FeedEvent[];
  rhythm: string | null;
  siblings: Array<{ topic: Topic; count: number }>;
}

/*
 * ── A DATABASE OUTAGE AT BUILD TIME RETURNS null, IT DOES NOT THROW ─────────────────────────
 *
 * The `MONGODB_URI` check on `generateStaticParams` above stops a build with NO database
 * configured from prerendering these pages at all, which is what CI needed. It does nothing for
 * the other case: a real deployment where the variable IS set and Atlas is briefly unreachable.
 * There the page set is still enumerated, prerendering still runs, and an unguarded throw here
 * takes down the release — the precise fragility `app/sitemap.ts` wraps its own query to avoid.
 *
 * Returning null makes the caller `notFound()`, so the slug is prerendered as a 404 rather than
 * killing the build. That is a real cost and worth naming: with `revalidate = 3600` the page is a
 * 404 for at most an hour and then becomes itself. The header above already accepts this exact
 * trade for a different reason — a slug below the event floor is "prerendered as a 404 and becomes
 * a real page on a later revalidation" — so an outage lands in a lane the design already has.
 *
 * A failed release, by contrast, is not self-healing.
 */
const loadTopic = cache(async (slug: string): Promise<LoadedTopic | null> => {
  const topic = findTopic(slug);
  if (!topic) return null;
  try {
    return await readTopic(topic);
  } catch (error) {
    console.error(`topics: could not load "${slug}" — prerendering it as not-found`, error);
    return null;
  }
});

const readTopic = async (topic: Topic): Promise<LoadedTopic | null> => {

  await connectDB();

  /*
   * The floor and the sibling rail come from ONE aggregation, which is also what decides whether
   * this page exists. Using `publishedTopics()` rather than a local `countDocuments` is the point:
   * if the index links here, this page renders, because both asked the same function.
   */
  const published = await publishedTopics();
  const mine = published.find(entry => entry.topic.slug === topic.slug);
  if (!mine) return null;

  const filter = buildEventFilter(topicQueryParams(topic), null);

  const [events, rhythmRows] = await Promise.all([
    Event.find(filter)
      // The feed's own default ordering, through the feed's own sort builder. A topic page ranked
      // chronologically would put the online 07:00 webinars first — measured on the default feed as
      // 15 of the first 20 rows online before the ranking changed.
      .sort(buildSort('connections', false))
      .limit(LIST_LIMIT)
      .lean(),
    // Minimal projection over the WHOLE matched set, so the rhythm sentence describes the topic
    // rather than describing the first page of it.
    Event.find(filter).select('startDateTime format isFree').lean(),
  ]);

  const rhythm = describeRhythm(
    rhythmRows.map<RhythmInput>(row => ({
      startDateTime: new Date(row.startDateTime).toISOString(),
      format: row.format,
      isFree: row.isFree,
    }))
  );

  return {
    topic,
    count: mine.count,
    events: toFeedEvents(events),
    rhythm,
    siblings: published.filter(entry => entry.topic.kind === topic.kind && entry.topic.slug !== topic.slug).slice(0, 8),
  };
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const topic = findTopic(slug);

  // Metadata is resolved before the page's floor check runs, so an unwritten slug is handled here
  // and a thin-but-written one still gets its title. Either way the page below decides the 404.
  if (!topic) {
    return { title: 'Topic not found · PulseBLR', robots: { index: false, follow: false } };
  }

  const canonical = absoluteUrl(`/topics/${topic.slug}`);
  const description = topicMetaDescription(topic);

  return {
    metadataBase: new URL(canonicalOrigin()),
    title: topicPageTitle(topic),
    description,
    alternates: { canonical },
    openGraph: {
      title: topic.heading,
      description,
      url: canonical,
      siteName: 'PulseBLR',
      type: 'website',
      locale: 'en_IN',
    },
    twitter: { card: 'summary_large_image', title: topic.heading, description },
  };
}

export default async function TopicPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const loaded = await loadTopic(slug);

  // Unwritten slug, or fewer than MIN_TOPIC_EVENTS upcoming events. Both are pages this app has
  // decided not to publish, and a 404 is the honest answer for both.
  if (!loaded) notFound();

  const { topic, count, events, rhythm, siblings } = loaded;

  return (
    <AppShell title="Topics">
      <div className="max-w-[900px] mx-auto px-4 md:px-8 pt-4 md:pt-6 pb-10">
        <nav className="mb-4 flex items-center gap-1.5 text-[13px] font-semibold text-[#6E6E73]">
          <Link href="/topics" className="hover:text-[#1D1D1F] transition-colors">
            Topics
          </Link>
          <span aria-hidden="true" className="material-symbols-outlined text-[16px] text-[#c7c7cc]">
            chevron_right
          </span>
          <span className="text-[#1D1D1F]">{topic.name}</span>
        </nav>

        <h1
          className="text-[27px] md:text-[38px] font-bold leading-[1.08] tracking-[-0.035em] text-[#1D1D1F]"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          {topic.heading}
        </h1>

        <p className="mt-1.5 text-[13px] font-semibold text-[#86868B] tnum">
          {count} upcoming {count === 1 ? 'event' : 'events'}
        </p>

        {/* The written paragraph. This is the half of the page that makes it not a doorway. */}
        <div className="mt-5 rounded-[18px] bg-white card-shadow p-5 md:p-6">
          <p className="text-[15px] leading-[1.65] text-[#3a3a3c]">{topic.blurb}</p>
          {rhythm && (
            <p className="mt-4 border-t border-[rgba(0,0,0,0.07)] pt-4 text-[13.5px] leading-relaxed text-[#6E6E73]">
              <span className="t-label text-[#8E8E93]">When these happen</span>
              <br />
              {rhythm}
            </p>
          )}
        </div>

        <section className="mt-8">
          <h2 className="t-sub text-[#1D1D1F] mb-1">Upcoming</h2>
          <p className="mb-3 text-[12.5px] text-[#6E6E73]">
            Ranked by how likely you are to leave with a useful contact, not by date — in-person
            events with a real venue come first.
          </p>
          <div className="flex flex-col gap-2">
            {events.map(event => (
              // showDate is ON because this list is RANKED and has no day headings: without it the
              // rail shows a clock time and the date appears nowhere on the row.
              <EventRow key={event._id} event={event} showDate />
            ))}
          </div>
          {count > events.length && (
            <Link
              href={
                topic.kind === 'category'
                  ? `/?category=${encodeURIComponent(topic.name)}`
                  : `/?area=${encodeURIComponent(topic.name)}`
              }
              className="mt-4 inline-block px-5 py-2.5 rounded-full bg-[#1D1D1F] text-white text-label-md font-semibold hover:bg-black transition-colors"
            >
              See all {count} in the feed
            </Link>
          )}
        </section>

        {siblings.length > 0 && (
          <section className="mt-10">
            <h2 className="t-label text-[#8E8E93] mb-2.5">
              {topic.kind === 'category' ? 'Other subjects' : 'Other areas'}
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {siblings.map(({ topic: sibling, count: siblingCount }) => (
                <Link
                  key={sibling.slug}
                  href={`/topics/${sibling.slug}`}
                  className="pill pill-quiet hover:bg-[#F7F7F9]"
                >
                  {sibling.name} <span className="tnum text-[#86868B]">{siblingCount}</span>
                </Link>
              ))}
            </div>
          </section>
        )}
      </div>
    </AppShell>
  );
}
