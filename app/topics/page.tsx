import Link from 'next/link';
import type { Metadata } from 'next';

import AppShell from '../components/AppShell';
import { PageHeader } from '../components/ui';
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
  const published = await publishedTopics();
  const categories = published.filter(entry => entry.topic.kind === 'category');
  const areas = published.filter(entry => entry.topic.kind === 'area');

  return (
    <AppShell title="Topics">
      <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-4 md:pt-6">
        <PageHeader
          eyebrow="Browse"
          title="Topics and areas"
          subtitle={
            <>
              {DESCRIPTION} A page appears here once it has at least {MIN_TOPIC_EVENTS} upcoming
              events — a shorter list than that is not worth your click, so we do not publish one.
            </>
          }
        />

        {published.length === 0 ? (
          <div className="rounded-[18px] bg-white card-shadow p-6">
            <p className="text-[14px] text-[#3a3a3c]">
              Nothing clears the {MIN_TOPIC_EVENTS}-event floor at the moment, which usually means
              the calendar is between busy weeks rather than that anything is wrong.
            </p>
            <Link
              href="/"
              className="inline-block mt-4 px-5 py-2.5 rounded-full bg-[#1D1D1F] text-white text-label-md font-semibold hover:bg-black transition-colors"
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
      <h2 className="t-sub text-[#1D1D1F]">{heading}</h2>
      <p className="mt-0.5 mb-3 text-[13px] text-[#6E6E73]">{hint}</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map(({ topic, count }) => (
          <Link
            key={topic.slug}
            href={`/topics/${topic.slug}`}
            className="group rounded-[18px] bg-white card-shadow p-4 raise pressable"
          >
            <div className="flex items-start justify-between gap-3">
              <p className="text-[14.5px] font-semibold leading-snug text-[#1D1D1F] group-hover:text-[#0071E3] transition-colors">
                {topic.heading}
              </p>
              <span className="shrink-0 text-[12px] font-semibold text-[#86868B] tnum">{count}</span>
            </div>
            {/* One clause of the page's own written copy, so the card says something specific
                rather than repeating its heading in longer form. */}
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[#6E6E73]">
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
