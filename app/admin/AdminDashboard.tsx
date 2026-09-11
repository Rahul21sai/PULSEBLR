'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import SubmissionsPanel from './SubmissionsPanel';
import EngagementPanel from './EngagementPanel';
import FeedQualityPanel from './FeedQualityPanel';
import AuditPanel from './AuditPanel';
import SourcesPanel, { type SourcesData } from './SourcesPanel';
import ImpactDialog from './ImpactDialog';
import EditEventModal from './EditEventModal';
import { DesktopNav } from '@/app/components/NavBar';
import { Banner, Button, Card, EmptyState, Field } from '@/app/components/ui';
import { BarList, NoRows, Panel, StatCard, StatSkeletons, num } from './AdminUI';
import { relativeTime, dayLabelIST, timeIST } from '@/lib/format';

/**
 * The operator console: corpus health, engagement, feed quality, sources, the scraper, event
 * administration, submissions, and the change log.
 *
 * Deliberately NOT in /settings. Settings is a user surface (their digest, their account) and any
 * signed-in user can open it; the scraper and source controls used to live there, which meant every
 * user saw machinery they could not use and must not control.
 *
 * ── THE PRIMITIVES COME FROM `app/components/ui.tsx` ─────────────────────────────────────────
 *
 * This file used to hand-roll its own `Card`, `Stat`, `Banner`, `Empty` and `Field` while `ui.tsx`
 * exported all five, and they had already drifted: the local `Stat` grew `accent`/`plain` props where
 * `ui.tsx` has `tone`, and the local `Banner` baked in a `mt-3` so spacing depended on which copy you
 * imported. Two sets of primitives is precisely why the console did not feel like the same product as
 * the feed. All five are now imported; `AdminUI.tsx` holds COMPOSITIONS of them (`Panel` = Card +
 * SectionTitle, `StatCard` = Card + Stat) plus the two data-display components `ui.tsx` has no
 * opinion about.
 *
 * ── WHY THERE ARE EIGHT TABS ────────────────────────────────────────────────────────────────
 *
 * Because the control plane it replaces is ~60 scripts. The tabs are grouped by the QUESTION being
 * asked, not by the collection being read: is it healthy (Overview), is anyone using it (Users), is
 * the feed good (Feed quality), is supply working (Sources, Scraper), is a specific row wrong
 * (Events), is somebody waiting on me (Submissions), what did I change (Audit).
 */

interface Stats {
  events: {
    total: number;
    upcoming: number;
    tech: number;
    nonTech: number;
    addedToday: number;
    withoutClusterKey: number;
    spotlit: number;
  };
  categories: Array<{ name: string; count: number }>;
  sources: SourcesData & { bySource: Array<{ name: string; count: number }> };
  users: { total: number; trackerEntries: number };
  nextUp: Array<{
    id: string;
    title: string;
    startDateTime: string;
    venue: string | null;
    organizer: string | null;
    connectionScore: number | null;
    category: string[];
  }>;
  admin: { email: string };
}

type Tab = 'overview' | 'users' | 'quality' | 'sources' | 'scraper' | 'events' | 'submissions' | 'audit';

const TABS: Array<[Tab, string, string]> = [
  ['overview', 'Overview', 'dashboard'],
  ['users', 'Users', 'group'],
  ['quality', 'Feed quality', 'rule'],
  ['sources', 'Sources', 'rss_feed'],
  ['scraper', 'Scraper', 'sync'],
  ['events', 'Events', 'event'],
  ['submissions', 'Submissions', 'how_to_reg'],
  ['audit', 'Audit log', 'history'],
];

export default function AdminDashboard({
  adminEmail,
  adminName,
  configured,
}: {
  adminEmail: string;
  adminName: string;
  configured: boolean;
}) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');

  // Pure fetch, no setState — so both the mount effect and the Refresh button can share it without
  // either calling setState synchronously inside an effect body (which Next 16's
  // react-hooks/set-state-in-effect rule correctly rejects).
  const load = useCallback(async () => {
    const apply = (next: { stats?: Stats; error?: string }) => {
      if (next.error) setError(next.error);
      if (next.stats) setStats(next.stats);
      setLoading(false);
    };
    setError(null);
    try {
      const res = await fetch('/api/admin/stats');
      if (!res.ok) {
        // A 403 here means the allowlist changed under us — say so plainly rather than rendering an
        // empty dashboard that just looks like "no data".
        apply({
          error:
            res.status === 403
              ? 'Your account is no longer in ADMIN_EMAILS.'
              : `Could not load admin stats (HTTP ${res.status}).`,
        });
        return;
      }
      apply({ stats: (await res.json()) as Stats });
    } catch {
      apply({ error: 'Could not reach the server.' });
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      const res = await fetch('/api/admin/stats').catch(() => null);
      if (!active) return;
      if (!res || !res.ok) {
        setError(
          res?.status === 403
            ? 'Your account is no longer in ADMIN_EMAILS.'
            : res
              ? `Could not load admin stats (HTTP ${res.status}).`
              : 'Could not reach the server.'
        );
        setLoading(false);
        return;
      }
      const data = (await res.json()) as Stats;
      if (!active) return;
      setStats(data);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        <span className="text-[#86868B] text-label-md font-semibold">Admin</span>
      </header>

      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-6 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="t-title text-[#1D1D1F]">Admin</h1>
                <span className="rounded-full bg-[#1D1D1F] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-white">
                  Operator
                </span>
              </div>
              <p className="text-[13.5px] text-[#6E6E73] mt-0.5">
                {adminName} · <span className="font-mono text-[12.5px]">{adminEmail}</span> — every
                action here is re-checked on the server against{' '}
                <code className="font-mono text-[12px]">ADMIN_EMAILS</code>, and every change is
                recorded in the audit log.
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              {/*
                The companies directory, which used to be a top-level public tab. It shows companies
                with nothing scheduled and hosts the registry does not recognise — a coverage-gap
                view, which is an operator's question rather than a reader's. A LINK, not a tab: it is
                a separate page, and the tabs below switch panels within this one.
              */}
              <Link
                href="/companies"
                className="pressable inline-flex items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[12.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[15px]">
                  domain
                </span>
                Companies
              </Link>
              <Button tone="quiet" icon="refresh" onClick={load}>
                Refresh
              </Button>
            </div>
          </div>

          {!configured && (
            <Banner tone="warn">
              <code className="font-mono">ADMIN_EMAILS</code> is not set, so admin endpoints are
              refusing requests with 503. Set it in your environment to enable them.
            </Banner>
          )}

          {error && <Banner tone="error">{error}</Banner>}

          {stats && stats.events.withoutClusterKey > 0 && (
            <Banner tone="warn">
              <strong>{stats.events.withoutClusterKey}</strong> event
              {stats.events.withoutClusterKey === 1 ? '' : 's'} stored without a{' '}
              <code className="font-mono">clusterKey</code>. These cannot de-duplicate and will show
              as double cards in the feed. Usually the daily cron running an older default branch —
              run <code className="font-mono">scripts/migrate-events.ts</code> then{' '}
              <code className="font-mono">scripts/cleanup-duplicate-clusters.ts --apply</code>.
            </Banner>
          )}

          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {TABS.map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-pressed={tab === id}
                className={`pressable flex shrink-0 items-center gap-1.5 rounded-full px-4 h-9 text-[13px] font-semibold transition-colors ${
                  tab === id
                    ? 'bg-[#1D1D1F] text-white'
                    : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
                }`}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[16px]">
                  {icon}
                </span>
                {label}
              </button>
            ))}
          </div>

          {loading && !stats ? (
            <StatSkeletons />
          ) : (
            <>
              {tab === 'overview' && stats && <Overview stats={stats} onGo={setTab} />}
              {tab === 'users' && <EngagementPanel />}
              {tab === 'quality' && <FeedQualityPanel onChanged={load} />}
              {tab === 'sources' && stats && <SourcesPanel sources={stats.sources} onChanged={load} />}
              {tab === 'scraper' && <ScraperPanel stats={stats} onDone={load} />}
              {tab === 'events' && <EventsPanel onChanged={load} />}
              {tab === 'submissions' && <SubmissionsPanel />}
              {tab === 'audit' && <AuditPanel onChanged={load} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/* ────────────────────────────── Overview ────────────────────────────── */

function Overview({ stats, onGo }: { stats: Stats; onGo: (tab: Tab) => void }) {
  const techShare = stats.events.upcoming
    ? Math.round((stats.events.tech / stats.events.upcoming) * 100)
    : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          label="Upcoming events"
          value={num(stats.events.upcoming)}
          sub={`${num(stats.events.total)} all time`}
        />
        <StatCard label="Tech events" value={num(stats.events.tech)} sub={`${techShare}% of upcoming`} tone="accent" />
        <StatCard label="Added in 24h" value={num(stats.events.addedToday)} sub="by the last scrape" />
        <StatCard
          label="Sources producing"
          value={num(stats.sources.producing)}
          sub={`of ${num(stats.sources.total)} tracked`}
          tone={stats.sources.dead > 0 ? 'warn' : undefined}
        />
      </div>

      {/*
        The overview's job is to route, not to restate. Each of these is a real problem with a tab
        that can act on it — so the count is a link rather than a number the operator then has to go
        looking for.
      */}
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ['Dead sources', stats.sources.dead, 'sources' as Tab, 'still fetched every run'],
          ['Spotlight pins', stats.events.spotlit, 'quality' as Tab, 'two render on the home page'],
          ['Could be backed off', stats.sources.backoffCandidates, 'sources' as Tab, '5+ empty runs'],
        ].map(([label, count, target, sub]) => (
          <Card key={String(label)} padding="tight">
            <button type="button" onClick={() => onGo(target as Tab)} className="w-full text-left">
              <p className="t-label text-[#8E8E93]">{String(label)}</p>
              <p className="tnum mt-1 text-[22px] font-bold leading-none text-[#1D1D1F]">
                {num(Number(count))}
              </p>
              <p className="mt-1 text-[12px] text-[#0071E3]">{String(sub)} →</p>
            </button>
          </Card>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Panel title="Tech categories" subtitle="Upcoming, tech only">
          {stats.categories.length === 0 ? (
            <NoRows>No categorised tech events yet.</NoRows>
          ) : (
            <BarList items={stats.categories} />
          )}
        </Panel>

        <Panel title="Where events come from" subtitle="Upcoming, by adapter">
          <BarList items={stats.sources.bySource} />
        </Panel>
      </div>

      <Panel
        title="Next up"
        subtitle="The soonest tech events a user will see"
        action={
          <Link href="/" className="text-[12.5px] font-semibold text-[#0071E3] hover:underline">
            Open feed
          </Link>
        }
      >
        {stats.nextUp.length === 0 ? (
          <EmptyState
            icon="event_busy"
            title="Nothing scheduled"
            body="The corpus has no upcoming tech events. Run the scraper, or check whether the sources went quiet."
          />
        ) : (
          <ul className="divide-y divide-[#f0f0f2]">
            {stats.nextUp.map(e => (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <div className="w-[62px] shrink-0 text-center">
                  <p className="t-label text-[#8E8E93]">{dayLabelIST(e.startDateTime)}</p>
                  <p className="tnum text-[12.5px] font-bold text-[#1D1D1F]">{timeIST(e.startDateTime)}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/events/${e.id}`}
                    className="block truncate text-[13.5px] font-semibold text-[#1D1D1F] hover:text-[#0071E3]"
                  >
                    {e.title}
                  </Link>
                  <p className="truncate text-[12px] text-[#6E6E73]">
                    {[e.organizer, e.venue].filter(Boolean).join(' · ') || 'Venue not set'}
                  </p>
                </div>
                {typeof e.connectionScore === 'number' && (
                  <span
                    title="Connection score — how likely you are to leave with useful contacts"
                    className={`tnum shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${
                      e.connectionScore >= 70
                        ? 'bg-[#EBF7EF] text-[#166B35]'
                        : e.connectionScore >= 50
                          ? 'bg-amber-50 text-amber-900'
                          : 'bg-[#f3f3f5] text-[#6E6E73]'
                    }`}
                  >
                    {e.connectionScore}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel
        title="Who is using it"
        subtitle="Headline only — the Users tab has signups over time, weekly actives and day-1 return"
        action={
          <button
            type="button"
            onClick={() => onGo('users')}
            className="text-[12.5px] font-semibold text-[#0071E3] hover:underline"
          >
            Open Users
          </button>
        }
      >
        <dl className="grid grid-cols-2 gap-3">
          <Field label="Signed-up users">{num(stats.users.total)}</Field>
          <Field label="Tracked events">{num(stats.users.trackerEntries)}</Field>
        </dl>
      </Panel>
    </div>
  );
}

/* ────────────────────────────── Scraper ────────────────────────────── */

function ScraperPanel({ stats, onDone }: { stats: Stats | null; onDone: () => void }) {
  const [running, setRunning] = useState<'fast' | 'full' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function run(mode: 'fast' | 'full') {
    setRunning(mode);
    setResult(null);
    try {
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fast: mode === 'fast' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setResult({
          ok: false,
          text:
            res.status === 503
              ? 'Refused: ADMIN_EMAILS is not configured on the server.'
              : res.status === 401 || res.status === 403
                ? 'Refused: your session is not an admin.'
                : (data as { error?: string }).error || `Scrape failed (HTTP ${res.status}).`,
        });
        return;
      }
      const r = (data as { result?: Record<string, number> }).result;
      setResult({
        ok: true,
        text: r
          ? `Done — ${r.inserted ?? 0} inserted, ${r.updated ?? 0} updated, ${r.duplicates ?? 0} duplicates, ${r.errors ?? 0} errors.`
          : 'Scrape finished.',
      });
      onDone();
    } catch {
      setResult({
        ok: false,
        text: 'The request failed or timed out. A full run can exceed the request limit — use the CLI for that.',
      });
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-5">
      <Panel title="Run the scraper" subtitle="Only you can trigger this — the endpoint is admin-gated">
        <div className="flex flex-wrap gap-2.5">
          <Button tone="secondary" icon="bolt" disabled={running !== null} onClick={() => run('fast')}>
            {running === 'fast' ? 'Running…' : 'Fast scrape'}
          </Button>
          <Button tone="primary" icon="sync" disabled={running !== null} onClick={() => run('full')}>
            {running === 'full' ? 'Running…' : 'Full scrape'}
          </Button>
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-[#6E6E73]">
          <strong>Fast</strong> skips Eventbrite and the company-page sweep and shrinks the enrichment
          budgets — about a minute. <strong>Full</strong> fans out to roughly 700 upstream requests
          with LLM tagging and takes 15–30 minutes, which is longer than a serverless request is
          allowed to live: run it as <code className="font-mono">npm run scrape</code> instead, or let
          the daily 8&nbsp;AM&nbsp;IST GitHub Action do it.
        </p>

        {result && (
          <div className="mt-3">
            <Banner tone={result.ok ? 'ok' : 'error'}>{result.text}</Banner>
          </div>
        )}
      </Panel>

      <Panel title="Last activity" subtitle="From per-source health records">
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Field label="Last scrape">
            {stats?.sources.lastScrapedAt ? relativeTime(stats.sources.lastScrapedAt) : 'never'}
          </Field>
          <Field label="Producing">{num(stats?.sources.producing)}</Field>
          <Field label="Quiet">{num(stats?.sources.quiet)}</Field>
          <Field label="Dead (6+ empty)">
            <span className={stats && stats.sources.dead > 0 ? 'text-[#C7362D]' : undefined}>
              {num(stats?.sources.dead)}
            </span>
          </Field>
        </dl>
        <p className="mt-3 text-[12.5px] text-[#6E6E73]">
          A source counts as dead after six consecutive empty scrapes. Nothing retires them
          automatically yet, so they are still requested every run — the Sources tab can disable them
          in bulk, and that is reversible.
        </p>
      </Panel>
    </div>
  );
}

/* ────────────────────────────── Events ────────────────────────────── */

interface AdminEvent {
  _id: string;
  title: string;
  startDateTime: string;
  venue?: string;
  organizer?: string;
  source: string;
  isTechEvent?: boolean;
  category?: string[];
  connectionScore?: number;
  /** ISO string when this was pinned to the home page Spotlight. Absent/null = not pinned. */
  spotlightAt?: string | null;
}

/**
 * What the events panel is currently listing.
 *
 * DEFAULTS TO 'tech'. The panel listed everything, and "everything" is ~1200 rows of which roughly
 * 80% is concerts, treks, comedy and book clubs — so the first screen was Karigar Bazaar and TELUGU
 * TASHAN NIGHT FRIDAY, and finding a real tech event to correct meant scrolling past all of it.
 *
 * 'other' is kept and is not an afterthought: this panel's other stated job is "remove junk", and
 * non-tech IS where the junk lives. 'all' stays available because a mis-tag is invisible from either
 * side alone.
 */
type EventScope = 'tech' | 'other' | 'all';

function EventsPanel({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState<EventScope>('tech');
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string; auditId?: string | null } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<AdminEvent | null>(null);

  const search = useCallback(async (term: string, view: EventScope) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '40', sort: 'soonest' });
      if (term.trim()) params.set('q', term.trim());
      /**
       * `techOnly` is the feed's own parameter, so this panel narrows exactly the way the feed does
       * rather than by a second definition of "tech". There is no `techOnly=false` inverse — the flag
       * only ever ADDS `isTechEvent: true` — so 'other' is filtered client-side on the page that
       * comes back.
       *
       * The honest consequence, stated rather than hidden: 'other' filters ONE PAGE of 40, so its
       * count is "how many of the 40 fetched are non-tech", not how many exist.
       */
      if (view === 'tech') params.set('techOnly', 'true');
      const res = await fetch(`/api/events?${params}`);
      const data = await res.json();
      setEvents(data.events || []);
      setTotal(data.pagination?.total ?? 0);
    } catch {
      setNote({ ok: false, text: 'Could not load events.' });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => search(q, scope), 250);
    return () => clearTimeout(t);
  }, [q, scope, search]);

  /** Every write goes to the AUDITED admin route, so nothing changes without a log entry. */
  async function patch(e: AdminEvent, body: Record<string, unknown>, what: string, local: Partial<AdminEvent>) {
    setBusy(e._id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/events/${e._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setEvents(prev => prev.map(x => (x._id === e._id ? { ...x, ...local } : x)));
      setNote({ ok: true, text: `${what} — “${e.title}”.`, auditId: (json as { auditId?: string }).auditId });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not update (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function destroy(e: AdminEvent, force: boolean) {
    setConfirming(null);
    setBusy(e._id);
    setNote(null);
    try {
      const res = await fetch(`/api/admin/events/${e._id}${force ? '?force=true' : ''}`, { method: 'DELETE' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setEvents(prev => prev.filter(x => x._id !== e._id));
      setNote({
        ok: true,
        text: `Deleted “${e.title}”. Restorable from the audit log.`,
        auditId: (json as { auditId?: string }).auditId,
      });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not delete (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function undo(auditId: string) {
    setBusy(auditId);
    try {
      const res = await fetch('/api/admin/audit/undo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: auditId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      setNote({ ok: true, text: 'Undone.' });
      search(q, scope);
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not undo (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  const visible = scope === 'other' ? events.filter(e => !e.isTechEvent) : events;

  return (
    <Panel
      title="Events"
      subtitle={
        scope === 'tech'
          ? `${total} tech event${total === 1 ? '' : 's'} · fix a mis-tagged event or remove junk`
          : scope === 'other'
            ? `${visible.length} non-tech of the ${events.length} fetched · this is where junk lives`
            : `${total} matches · fix a mis-tagged event or remove junk`
      }
      action={
        <Link href="/add-event" className="text-[12.5px] font-semibold text-[#0071E3] hover:underline">
          Add manually
        </Link>
      }
    >
      <div className="flex flex-wrap gap-1.5 pb-3">
        {(
          [
            ['tech', 'Tech only'],
            ['other', 'Non-tech'],
            ['all', 'All'],
          ] as Array<[EventScope, string]>
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setScope(id)}
            aria-pressed={scope === id}
            className={`pressable h-8 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors ${
              scope === id
                ? 'bg-[#1D1D1F] text-white'
                : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <label className="relative block pb-3">
        <span className="sr-only">Search events</span>
        <span
          aria-hidden="true"
          className="material-symbols-outlined absolute left-3 top-[18px] -translate-y-1/2 text-[18px] text-[#a1a1a6]"
        >
          search
        </span>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search by title, organiser or venue"
          className="h-10 w-full rounded-full bg-white pl-10 pr-4 text-[13px] text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:outline-none focus:shadow-[inset_0_0_0_2px_#0071E3]"
        />
      </label>

      {note && (
        <Banner tone={note.ok ? 'ok' : 'error'}>
          <span className="flex flex-wrap items-center gap-2">
            {note.text}
            {note.ok && note.auditId && (
              <Button size="sm" tone="quiet" disabled={busy === note.auditId} onClick={() => undo(note.auditId!)}>
                Undo
              </Button>
            )}
          </span>
        </Banner>
      )}

      {loading ? (
        <NoRows>Loading…</NoRows>
      ) : visible.length === 0 ? (
        <NoRows>
          {/* Distinguish "your search found nothing" from "this filter found nothing", or a full page
              of tech events reads as a broken search box. */}
          {q.trim()
            ? `No ${scope === 'tech' ? 'tech ' : scope === 'other' ? 'non-tech ' : ''}events match “${q}”.`
            : scope === 'other'
              ? 'None of the events on this page are non-tech. Search, or switch to All.'
              : 'No events found.'}
        </NoRows>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <ul className="divide-y divide-[#f0f0f2]">
            {visible.map(e => (
              <li key={e._id} className="flex items-center gap-3 py-2.5">
                <div className="w-[58px] shrink-0 text-center">
                  <p className="t-label text-[#8E8E93]">{dayLabelIST(e.startDateTime)}</p>
                </div>
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/events/${e._id}`}
                    className="block truncate text-[13.5px] font-semibold text-[#1D1D1F] hover:text-[#0071E3]"
                  >
                    {e.title}
                  </Link>
                  <p className="truncate text-[12px] text-[#6E6E73]">
                    {[e.source, e.organizer, (e.category || []).join(', ')].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {/* Star, not the word "Spotlight": the row already carries a date, a title, a source
                    line and three other controls. `aria-pressed` is what makes an icon toggle legible
                    to a screen reader — it says the state, which the glyph alone cannot. */}
                <button
                  type="button"
                  onClick={() =>
                    patch(
                      e,
                      // An explicit null when unpinning: `$set` cannot express `$unset`, and the home
                      // page matches `{ $type: 'date' }` so a stored null reads correctly as unpinned.
                      { spotlightAt: e.spotlightAt ? null : new Date().toISOString() },
                      e.spotlightAt ? 'Removed from the Spotlight' : 'Pinned to the Spotlight',
                      { spotlightAt: e.spotlightAt ? null : new Date().toISOString() }
                    )
                  }
                  disabled={busy === e._id}
                  aria-pressed={Boolean(e.spotlightAt)}
                  aria-label={
                    e.spotlightAt ? `Remove ${e.title} from the Spotlight` : `Pin ${e.title} to the Spotlight`
                  }
                  title={
                    e.spotlightAt
                      ? 'Pinned to the home page Spotlight — click to remove'
                      : 'Pin to the home page Spotlight (shows the two most recently pinned)'
                  }
                  className={`pressable shrink-0 rounded-full px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-45 ${
                    e.spotlightAt
                      ? 'bg-[#1D1D1F] text-white hover:bg-black'
                      : 'bg-white text-[#8E8E93] shadow-[inset_0_0_0_1px_var(--hairline-strong)] hover:bg-[#F7F7F9]'
                  }`}
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[15px] leading-none align-[-2px]">
                    {e.spotlightAt ? 'star' : 'star_outline'}
                  </span>
                </button>
                <Button
                  size="sm"
                  tone={e.isTechEvent ? 'secondary' : 'quiet'}
                  disabled={busy === e._id}
                  title="Toggle whether this counts as a software/hardware tech event"
                  onClick={() =>
                    patch(
                      e,
                      { isTechEvent: !e.isTechEvent },
                      e.isTechEvent ? 'Removed from tech' : 'Marked as tech',
                      { isTechEvent: !e.isTechEvent }
                    )
                  }
                >
                  {e.isTechEvent ? 'Tech' : 'Not tech'}
                </Button>
                <Button
                  size="sm"
                  tone="quiet"
                  disabled={busy === e._id}
                  aria-label={`Edit ${e.title}`}
                  title="Edit this event's title, time, venue, categories and cover image"
                  icon="edit"
                  onClick={() => setEditingId(e._id)}
                >
                  <span className="sr-only">Edit</span>
                </Button>
                <Button
                  size="sm"
                  tone="danger"
                  disabled={busy === e._id}
                  aria-label={`Delete ${e.title}`}
                  onClick={() => setConfirming(e)}
                >
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Re-runs the search on save rather than patching the row in place: an edit can change the
          title, the date or the categories, all of which the row displays and the query orders by, so
          a local patch could leave a row under the wrong date heading. */}
      {editingId && (
        <EditEventModal
          eventId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={title => {
            setEditingId(null);
            setNote({ ok: true, text: `Saved “${title}”.` });
            // Re-search in the CURRENT scope. Passing only `q` would silently reset the panel and drop
            // the operator's filter after every save.
            search(q, scope);
            onChanged();
          }}
        />
      )}

      {confirming && (
        <ImpactDialog
          open
          type="event"
          ids={[confirming._id]}
          title={`Delete “${confirming.title}”?`}
          actionLabel="Delete event"
          onCancel={() => setConfirming(null)}
          onConfirm={force => destroy(confirming, force)}
        />
      )}
    </Panel>
  );
}
