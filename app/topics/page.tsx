import Link from 'next/link';
import type { Metadata } from 'next';

import AppShell from '../components/AppShell';
import { publishedTopics } from '@/lib/events/topic-counts';
import { MIN_TOPIC_EVENTS } from '@/lib/events/topics';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';

/**
 * The topic index — every landing page that currently exists, and nothing that does not.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT LISTS THE PUBLISHED SET, NOT THE CANDIDATE SET. `publishedTopics()` applies the ≥
 * `MIN_TOPIC_EVENTS` floor, so a topic with two upcoming events is absent here AND 404s at its own
 * URL. Listing it with a count of 2 would be worse than either: an internal link to a page we have
 * decided is too thin to publish is the fastest way to get it crawled anyway.
 *
 * THE COUNTS ARE SHOWN, deliberately. A directory of links with no numbers forces the reader to open
 * pages to find out which ones are worth reading — the same mistake `/companies` made when it
 * offered 375 companies of which 44 had any events.
 *
 * A NOTE ON THE EMPTY STATE: it says the calendar is thin, not that the feature is broken. Every
 * page here depends on live supply, so "nothing clears the floor today" is a real and temporary
 * answer, and the link back to the feed is what the reader actually wants in that case.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Hourly. The set changes when the scrape runs, which is once a day. */
export const revalidate = 3600;

const TITLE = 'Browse Bengaluru tech events by topic and area';
const DESCRIPTION =
  'Every subject and neighbourhood with enough upcoming Bengaluru engineering events to be worth a ' +
  'page of its own — AI, cloud, open source, hardware, and the areas where they actually happen.';

export const metadata: Metadata = {
  metadataBase: new URL(canonicalOrigin()),
  title: `${TITLE} · PulseBLR`,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/topics') },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: absoluteUrl('/topics'),
    siteName: 'PulseBLR',
    type: 'website',
    locale: 'en_IN',
  },
};

export default async function TopicsIndexPage() {
  /*
   * ── A DATABASE FAILURE MUST NOT FAIL THE BUILD, AND MUST NOT CLAIM THERE ARE NO TOPICS ──────
   *
   * This is a single statically-rendered page, so unlike `/topics/[slug]` it cannot opt out of
   * prerendering by returning no params — it renders at build time or not at all. Unguarded,
   * `publishedTopics()` calls `connectDB()` and an unreachable Atlas takes the whole deployment
   * down over a page that lists links. Same reasoning `app/sitemap.ts` records: a stale page costs
   * a day of freshness, a failed build costs the release.
   *
   * `loadFailed` IS TRACKED SEPARATELY FROM AN EMPTY LIST, and that distinction is the point. Both
   * produce zero rows, and they mean opposite things — "no topic has cleared the 3-event floor yet"
   * versus "we could not ask". Collapsing them is the defect this repo has already shipped twice:
   * the calendar rendered "No events this month" for a 500, and the home page printed "0 upcoming"
   * whenever its request was in flight. The most alarming failure must not read as the most
   * reassuring answer.
   */
  let published: Awaited<ReturnType<typeof publishedTopics>> = [];
  let loadFailed = false;
  try {
    published = await publishedTopics();
  } catch (error) {
    loadFailed = true;
    console.error('topics index: could not load the published set', error);
  }
  const categories = published.filter(entry => entry.topic.kind === 'category');
  const areas = published.filter(entry => entry.topic.kind === 'area');

  return (
    <AppShell title="Topics">
      <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-4 md:pt-6">
        {/*
          SANS, and no eyebrow. `PageHeader` sets `.t-title` — the SERIF display face — for every page
          in the app, which is wrong here for the same reason it is wrong on `/topics/[slug]`: a topic
          is a grouping this product invented, and the serif belongs to things that exist in the city.
          The `eyebrow` slot also printed "Browse" as a small tracked label above the title, saying
          nothing the nav and the heading do not already say.
        */}
        <div className="mb-[var(--s-6)]">
          <h1 className="ty-section text-[var(--ink)]">Topics and areas</h1>
          <p className="mt-[var(--s-2)] ty-body max-w-[68ch] text-[color:var(--ink-2)]">
            {DESCRIPTION} A page appears here once it has at least {MIN_TOPIC_EVENTS} upcoming events
            — a shorter list than that is not worth your click, so we do not publish one.
          </p>
        </div>

        {/*
          TWO ZERO-ROW STATES, AND THEY SAY OPPOSITE THINGS. The reassurance below — "the calendar is
          between busy weeks rather than anything being wrong" — is true when the floor genuinely
          admitted nothing, and a lie when the query never returned. Rendering it for a failure is
          the calendar's "No events this month" for a 500, on a different page.
        */}
        {loadFailed ? (
          /* Flat and ruled. `card-shadow` resolves to `--lift-1: none`, so the rounded surface was a
             radius with nothing under it; and `hover:bg-black` was a tenth colour outside the nine —
             the press affordance carries the interaction instead. */
          <div className="rule-y py-[var(--s-8)]">
            <p className="ty-body max-w-[62ch] text-[color:var(--ink-2)]">
              We could not load the topic list just now. The events themselves are unaffected — this
              page groups them, so only the grouping is missing.
            </p>
            <Link
              href="/"
              className="inline-block mt-[var(--s-4)] px-5 py-2.5 r-touch bg-[var(--ink)] text-[var(--accent-ink)] text-[13.5px] font-semibold pressable"
            >
              Browse everything upcoming
            </Link>
          </div>
        ) : published.length === 0 ? (
          <div className="rule-y py-[var(--s-8)]">
            <p className="ty-body max-w-[62ch] text-[color:var(--ink-2)]">
              Nothing clears the {MIN_TOPIC_EVENTS}-event floor at the moment, which usually means
              the calendar is between busy weeks rather than that anything is wrong.
            </p>
            <Link
              href="/"
              className="inline-block mt-[var(--s-4)] px-5 py-2.5 r-touch bg-[var(--ink)] text-[var(--accent-ink)] text-[13.5px] font-semibold pressable"
            >
              Browse everything upcoming
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-8 pb-10">
            <TopicSection
              heading="By subject"
              hint="What the event is about, or what kind of gathering it is"
              entries={categories}
            />
            <TopicSection
              heading="By area"
              hint="Where in Bengaluru it happens — the commute decides more attendance than the topic does"
              entries={areas}
            />
          </div>
        )}
      </div>
    </AppShell>
  );
}

function TopicSection({
  heading,
  hint,
  entries,
}: {
  heading: string;
  hint: string;
  entries: Awaited<ReturnType<typeof publishedTopics>>;
}) {
  if (entries.length === 0) return null;

  return (
    <section>
      {/* SANS: a topic is a grouping the PRODUCT made, not a thing that exists in the city. That
          is the whole reason the section heading and the topic names below it are not serif. */}
      <h2 className="ty-section text-[var(--ink)]">{heading}</h2>
      <p className="ty-meta mt-[var(--s-2)] mb-[var(--s-4)]">{hint}</p>
      {/* 4px and a hairline ring, because each of these IS a touchable — the one thing radius is
          allowed to mean in this system. `raise` resolved to `--lift-2: none`, so the hover promised
          a lift that could not happen; the press does the work. */}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(({ topic, count }) => (
          <Link
            key={topic.slug}
            href={`/topics/${topic.slug}`}
            className="group r-touch bg-[var(--surface)] p-4 shadow-[inset_0_0_0_1px_var(--rule)] pressable"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-[14.5px] font-semibold leading-snug text-[var(--ink)] group-hover:text-[var(--accent)] transition-colors">
                {topic.heading}
              </p>
              <span className="ty-meta shrink-0">{count}</span>
            </div>
            {/* One clause of the page's own written copy, so the card says something specific
                rather than repeating its heading in longer form. */}
            <p className="mt-[var(--s-2)] text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
              {firstClause(topic.blurb)}
            </p>
          </Link>
        ))}
      </div>
    </section>
  );
}

/** The blurb's opening sentence, for a card. Falls back to a hard cut if there is no full stop. */
function firstClause(blurb: string): string {
  const text = blurb.replace(/\s+/g, ' ').trim();
  const stop = text.indexOf('. ');
  if (stop > 30 && stop < 150) return text.slice(0, stop + 1);
  return text.length > 140 ? `${text.slice(0, 137).trimEnd()}…` : text;
}
