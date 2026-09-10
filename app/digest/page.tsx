import Link from 'next/link';
import type { Metadata } from 'next';

import AppShell from '../components/AppShell';
import EventRow from '../components/EventRow';
import { Card, PageHeader, Stat } from '../components/ui';
import RetryButton from './RetryButton';
import { getPublicDigestWeek, type PublicDigestWeek } from '@/lib/notifications/digest';
import { WEEKLY_WINDOW_DAYS } from '@/lib/notifications/digest-schedule';
import { shortDateIST } from '@/lib/format';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';

/**
 * `/digest` — the week ahead in Bengaluru tech, as a public page.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * IT IS THE EMAIL'S PUBLIC TWIN, and that is the whole point of it existing. Two jobs, one page:
 *
 *   1. DISTRIBUTION (spec §5, Phase 5). An indexable weekly summary is a page that changes every
 *      week, is about a real place, and is worth linking to — which is what the topic pages are for
 *      too, except this one needs no per-topic copy to justify itself.
 *   2. A LANDING PAGE FOR THE EMAIL. Every digest links here, so a reader who wants the whole week
 *      rather than five events has somewhere to go that does not need a sign-in.
 *
 * NO USER DATA REACHES IT. `getPublicDigestWeek()` calls `buildEventFilter(params, null)` with an
 * explicit `null` viewer, so the anonymous visibility clause admits `visibility: 'public'` and the
 * ~1500 documents predating the field, and nothing else; `notDeletedClause()` comes with it. Nothing
 * here reads a session, and there is deliberately no `getCurrentUserId()` in the chain — a page that
 * personalised itself would be uncacheable, unshareable and one refactor away from putting somebody's
 * private submission in Google's index.
 *
 * A FAILURE MUST NOT RENDER A CONFIDENT CLAIM. "No events this week" is a factual statement about
 * Bengaluru, and printing it because a database query threw is the exact defect CLAUDE.md records for
 * the calendar — the most alarming failure reading as the most reassuring answer. So the loader
 * THROWS on a database error rather than returning an empty week, this page catches, and the two
 * outcomes render differently: an error card with a working retry, versus a genuinely quiet week that
 * says so and points at the calendar.
 *
 * WHY `force-dynamic` RATHER THAN `revalidate`. An ISR page would be cheaper, and it would also cache
 * the ERROR render for the length of the revalidation window — which makes the retry button a lie,
 * because `router.refresh()` would be handed the same cached failure. One indexed `find` plus three
 * `countDocuments` on a page with negligible traffic is the cheaper mistake. If this ever gets enough
 * traffic to matter, the fix is to move the load behind a cache with the ERROR PATH EXCLUDED, not to
 * add `revalidate` and leave the button in place.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

export const dynamic = 'force-dynamic';

/** How many ranked events the page lists. The counts above them describe the whole window. */
const LIST_LIMIT = 12;

const TITLE = 'This week in Bengaluru tech';
const DESCRIPTION =
  'The Bengaluru engineering events worth your time over the next seven days — meetups, ' +
  'conferences, hackathons and workshops, ranked by how likely you are to leave having met ' +
  'someone useful.';

export const metadata: Metadata = {
  metadataBase: new URL(canonicalOrigin()),
  title: `${TITLE} · PulseBLR`,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/digest') },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: absoluteUrl('/digest'),
    siteName: 'PulseBLR',
    type: 'website',
    locale: 'en_IN',
  },
};

export default async function DigestPage() {
  let week: PublicDigestWeek | null = null;
  let failed = false;

  try {
    week = await getPublicDigestWeek({ limit: LIST_LIMIT });
  } catch (error) {
    // Logged, never rendered. The message can name a model and a schema path — the same reason the
    // API routes in this app stopped returning `details: err.message`.
    console.error('Failed to build the public digest week:', error);
    failed = true;
  }

  return (
    <AppShell title="This week">
      <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-4 md:pt-6 pb-10">
        <PageHeader
          eyebrow="The week ahead"
          title={TITLE}
          subtitle={
            week
              ? `${shortDateIST(week.from)} — ${shortDateIST(
                  new Date(week.to.getTime() - 1)
                )}. Everything here is upcoming and open to anyone; there is no sign-in behind this page.`
              : DESCRIPTION
          }
        />

        {failed || !week ? (
          <Card>
            <h2 className="t-sub text-[#1D1D1F]">We could not load this week</h2>
            {/*
              STATED AS OUR FAULT AND AS UNKNOWN, both. The one thing this must not say is
              anything about how many events there are, because that is precisely what we
              failed to find out.
            */}
            <p className="mt-1.5 mb-4 text-[13.5px] leading-relaxed text-[#6E6E73]">
              Something went wrong on our side while reading the calendar, so we do not know what is
              on this week rather than knowing that nothing is. Nothing is wrong with the events
              themselves.
            </p>
            <RetryButton />
            <p className="mt-4 text-[12.5px] text-[#6E6E73]">
              The{' '}
              <Link href="/" className="text-[#0071E3] hover:underline">
                full feed
              </Link>{' '}
              and the{' '}
              <Link href="/calendar" className="text-[#0071E3] hover:underline">
                calendar
              </Link>{' '}
              are worth a try too — they read the same data by a different path, so one of them may
              well work.
            </p>
          </Card>
        ) : (
          <div className="flex flex-col gap-6">
            <Card>
              <div className="grid grid-cols-3 gap-4">
                <Stat
                  label={`Next ${WEEKLY_WINDOW_DAYS} days`}
                  value={week.total}
                  sub={week.total === 1 ? 'tech event' : 'tech events'}
                />
                <Stat label="In person" value={week.inPerson} sub="worth the commute" tone="accent" />
                <Stat label="Free" value={week.free} sub="no ticket needed" />
              </div>
            </Card>

            {week.events.length === 0 ? (
              <Card>
                {/* A REAL, TEMPORARY ANSWER — and it is only ever printed when the query
                    SUCCEEDED and returned nothing. See the header. */}
                <h2 className="t-sub text-[#1D1D1F]">A quiet week</h2>
                <p className="mt-1.5 mb-4 text-[13.5px] leading-relaxed text-[#6E6E73]">
                  Nothing is scheduled in the next {WEEKLY_WINDOW_DAYS} days that clears the bar for
                  this page. That happens between busy weeks — Bengaluru bunches its conferences —
                  rather than meaning anything is broken.
                </p>
                <Link
                  href="/calendar"
                  className="pressable inline-flex min-h-[44px] items-center rounded-full bg-[#1D1D1F] px-5 text-label-md font-semibold text-white transition-colors hover:bg-black"
                >
                  Look further ahead
                </Link>
              </Card>
            ) : (
              <section>
                <h2 className="t-sub text-[#1D1D1F]">
                  {week.events.length === week.total
                    ? 'Everything on this week'
                    : `The ${week.events.length} best of them`}
                </h2>
                <p className="mt-0.5 mb-3 text-[13px] text-[#6E6E73]">
                  Ordered by how much use the room is to you, not by date — an in-person evening with
                  a company host beats a webinar happening sooner.
                </p>
                <div className="rounded-[18px] bg-white card-shadow overflow-hidden">
                  {week.events.map(event => (
                    <EventRow key={event._id} event={event} showDate />
                  ))}
                </div>
                {week.total > week.events.length && (
                  <p className="mt-3 text-[12.5px] text-[#6E6E73]">
                    {week.total - week.events.length} more this week —{' '}
                    <Link href="/" className="text-[#0071E3] hover:underline">
                      see the whole feed
                    </Link>
                    .
                  </p>
                )}
              </section>
            )}

            <Card>
              <h2 className="t-sub text-[#1D1D1F]">Get this by email</h2>
              <p className="mt-1.5 mb-4 text-[13.5px] leading-relaxed text-[#6E6E73]">
                The same shortlist, five events, sent on Monday morning and ranked for what you told
                us you care about. Weekly is the default; daily is available if you would rather.
                Every email carries a one-tap unsubscribe that needs no sign-in.
              </p>
              {/*
                `/onboarding`, NOT `/settings`. The cadence radio group lives in
                `app/onboarding/OnboardingFlow.tsx` — `/settings` has a "Daily digest" panel that only
                offers a preview link and still describes the old `USER_EMAIL` arrangement. Sending a
                reader to the page that cannot change the thing is the "dead end that 403s on submit"
                shape this codebase already learned to avoid. `/onboarding` is a protected path, so a
                signed-out reader meets the sign-in gate — correct, since a digest needs an account.
              */}
              <Link
                href="/onboarding"
                className="pressable inline-flex min-h-[44px] items-center rounded-full bg-[#1D1D1F] px-5 text-label-md font-semibold text-white transition-colors hover:bg-black"
              >
                Choose a cadence
              </Link>
            </Card>
          </div>
        )}
      </div>
    </AppShell>
  );
}
