'use client';

import { useEffect, useState } from 'react';
import { Banner, EmptyState } from '../components/ui';
import { BarList, NoRows, Panel, Sparkline, StatCard, StatSkeletons, num } from './AdminUI';
import { relativeTime, shortDateIST } from '@/lib/format';

/**
 * Users & engagement — "did anyone use this yesterday".
 *
 * ── WHY THIS PANEL MATTERS MORE THAN IT LOOKS ───────────────────────────────────────────────
 *
 * Before it, `/admin` reported two integers about people: `users.total` and `trackerEntries`. Neither
 * has time in it, so nothing about the product could be measured — not whether a feed change helped,
 * not whether anybody came back, not whether the scan flow is used at all. Two integers cannot
 * falsify a claim, which means every product decision was being made on impressions. This is the
 * instrument that makes the other panels' decisions checkable, which is why it was built before them.
 *
 * ── IT SAYS WHAT "ACTIVE" MEANS, ON SCREEN ──────────────────────────────────────────────────
 *
 * There is no page-view telemetry in this app and this panel does not pretend otherwise. "Active"
 * counts a WRITE — saving an event, scanning a person, making a folder, adding an event by hand — so
 * it is a higher bar than a visit. The route sends that definition as `activeMeans` and it is printed
 * rather than left to the reader to assume, because a retention number whose definition is unstated
 * is a number that will eventually be quoted wrongly.
 *
 * ── THE PER-USER TABLE IS THE POINT AT THIS SCALE ───────────────────────────────────────────
 *
 * With single-digit accounts, a retention curve is noise and a table is signal: you can see which
 * account did what and when. It is capped so it stays a table if that ever changes.
 */

interface Engagement {
  window: { days: number };
  activeMeans: string;
  users: {
    total: number;
    newThisWeek: number;
    signupSeries: Array<{ day: string; count: number }>;
    weeklyActive: number;
    monthlyActive: number;
    neverActive: number;
    d1: { cohort: number; returned: number; rate: number | null };
  };
  eventsSaved: {
    total: number;
    thisWeek: number;
    series: Array<{ day: string; count: number }>;
    byStatus: Array<{ status: string; count: number }>;
  };
  contacts: {
    total: number;
    thisWeek: number;
    series: Array<{ day: string; count: number }>;
    folders: number;
  };
  userAdded: { events: number };
  perUser: Array<{
    email: string;
    name: string;
    signedUpAt: string;
    lastActiveAt: string | null;
    tracked: number;
    contacts: number;
    folders: number;
    added: number;
  }>;
}

export default function EngagementPanel() {
  const [data, setData] = useState<Engagement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const res = await fetch('/api/admin/engagement');
        if (!active) return;
        if (!res.ok) {
          setError(`Could not load engagement stats (HTTP ${res.status}).`);
          setLoading(false);
          return;
        }
        const json = (await res.json()) as Engagement;
        if (!active) return;
        setData(json);
        setLoading(false);
      } catch {
        if (active) {
          setError('Could not reach the server.');
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  if (loading && !data) return <StatSkeletons count={4} />;
  // A failed fetch must never render as zeros. "0 users this week" is a confident factual claim, and
  // standing it in for a broken request is the calendar's "No events this month" mistake.
  if (error) return <Banner tone="error">{error}</Banner>;
  if (!data) return <Banner tone="error">No engagement data came back.</Banner>;

  const { users, eventsSaved, contacts } = data;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard label="Signed-up users" value={num(users.total)} sub={`${users.newThisWeek} in the last 7 days`} />
        <StatCard
          label="Weekly active"
          value={num(users.weeklyActive)}
          sub={`${num(users.monthlyActive)} in 28 days`}
          tone="accent"
        />
        <StatCard
          label="Came back after day 1"
          value={users.d1.rate === null ? '—' : `${users.d1.rate}%`}
          sub={`${users.d1.returned} of ${users.d1.cohort} who had the chance`}
        />
        <StatCard
          label="Signed up, did nothing"
          value={num(users.neverActive)}
          sub="never wrote anything"
          tone={users.neverActive > 0 ? 'warn' : undefined}
        />
      </div>

      <Banner tone="info">
        <strong>Active</strong> means {data.activeMeans}
      </Banner>

      <div className="grid lg:grid-cols-2 gap-5">
        <Panel title="Signups" subtitle={`Daily, last ${data.window.days} days, IST`}>
          <Sparkline series={users.signupSeries} label="signups per day" />
        </Panel>

        <Panel
          title="Events saved"
          subtitle={`${num(eventsSaved.total)} all time · ${eventsSaved.thisWeek} this week`}
        >
          <Sparkline series={eventsSaved.series} label="events saved per day" />
        </Panel>
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Panel
          title="People captured"
          subtitle={`${num(contacts.total)} contacts in ${num(contacts.folders)} folders · ${contacts.thisWeek} this week`}
        >
          <Sparkline series={contacts.series} label="contacts captured per day" />
        </Panel>

        <Panel title="Where saved events sit" subtitle="Tracker board, by column">
          {eventsSaved.byStatus.length === 0 ? (
            <NoRows>Nobody has saved an event yet.</NoRows>
          ) : (
            <BarList items={eventsSaved.byStatus.map(s => ({ name: s.status, count: s.count }))} />
          )}
        </Panel>
      </div>

      <Panel
        title="Every account"
        subtitle="Most recently active first. At this scale the table is more useful than any curve."
      >
        {data.perUser.length === 0 ? (
          <EmptyState
            icon="person_add"
            title="No accounts yet"
            body="Nobody has signed in. Every number on this page will stay at zero until somebody does."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[620px] text-[12.5px]">
              <thead>
                <tr className="border-b border-[color:var(--hairline)] text-left">
                  {['Account', 'Signed up', 'Last active', 'Saved', 'People', 'Folders', 'Added'].map(h => (
                    <th key={h} className="t-label whitespace-nowrap py-2 pr-3 text-[var(--ink-2)]">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.perUser.map(u => (
                  <tr key={u.email} className="border-b border-[var(--rule)] last:border-0">
                    <td className="max-w-[220px] py-2.5 pr-3">
                      <span className="block truncate font-semibold text-[var(--ink)]">{u.name}</span>
                      <span className="block truncate font-mono text-[11.5px] text-[var(--ink-2)]">{u.email}</span>
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3 text-[var(--ink-2)]">
                      {shortDateIST(u.signedUpAt)}
                    </td>
                    <td className="whitespace-nowrap py-2.5 pr-3">
                      {u.lastActiveAt ? (
                        <span className="text-[var(--ink-2)]">{relativeTime(u.lastActiveAt)}</span>
                      ) : (
                        // Named rather than left blank: an account that signed up and never acted is
                        // the most actionable row on this table.
                        <span className="font-semibold text-[var(--live)]">never</span>
                      )}
                    </td>
                    {[u.tracked, u.contacts, u.folders, u.added].map((n, i) => (
                      <td key={i} className="tnum py-2.5 pr-3 text-[var(--ink)]">
                        {n}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {data.userAdded.events > 0 && (
        <Banner tone="info">
          <strong>{data.userAdded.events}</strong> event
          {data.userAdded.events === 1 ? ' was' : 's were'} added by hand by a user. Those are supply
          the scraper never had — check Submissions for any waiting on a decision.
        </Banner>
      )}
    </div>
  );
}
