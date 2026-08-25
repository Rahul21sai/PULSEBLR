'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { DesktopNav } from '@/app/components/NavBar';
import { relativeTime, dayLabelIST, timeIST } from '@/lib/format';
import EditEventModal from './EditEventModal';
import { SOURCE_TYPES } from '@/lib/sources/admin-validate';

/**
 * The operator console: corpus health, the scraper, source management and event
 * administration.
 *
 * Deliberately NOT in /settings. Settings is a user surface (their digest, their
 * account) and any signed-in user can open it; the scraper and source controls used to
 * live there, which meant every user saw machinery they could not use and must not
 * control. Splitting them is the admin/user boundary made visible.
 */

interface SourceRow {
  id: string;
  kind: string | null;
  handle: string | null;
  name: string;
  url: string | null;
  enabled: boolean;
  lastScrapedAt: string | null;
  lastEventCount: number;
  consecutiveEmptyScrapes: number;
}

interface Stats {
  events: {
    total: number;
    upcoming: number;
    tech: number;
    nonTech: number;
    addedToday: number;
    withoutClusterKey: number;
  };
  categories: Array<{ name: string; count: number }>;
  sources: {
    total: number;
    producing: number;
    quiet: number;
    never: number;
    dead: number;
    lastScrapedAt: string | null;
    bySource: Array<{ name: string; count: number }>;
    rows: SourceRow[];
  };
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

type Tab = 'overview' | 'scraper' | 'sources' | 'events';

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

  // Pure fetch, no setState — so both the mount effect and the Refresh button can share
  // it without either calling setState synchronously inside an effect body (which Next
  // 16's react-hooks/set-state-in-effect rule correctly rejects).
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
        // A 403 here means the allowlist changed under us — say so plainly rather than
        // rendering an empty dashboard that just looks like "no data".
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
    <div className="min-h-screen ambient-above">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        <span className="text-[#86868B] text-label-md font-semibold">Admin</span>
      </header>

      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-6 space-y-5">
          {/* ── Title ─────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-[24px] md:text-[30px] font-bold tracking-[-0.025em] text-[#1D1D1F]">
                  Admin
                </h1>
                <span className="rounded-full bg-[#1D1D1F] px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-wider text-white">
                  Operator
                </span>
              </div>
              <p className="text-[13.5px] text-[#6E6E73] mt-0.5">
                {adminName} · <span className="font-mono text-[12.5px]">{adminEmail}</span> — every
                action here is re-checked on the server against{' '}
                <code className="font-mono text-[12px]">ADMIN_EMAILS</code>.
              </p>
            </div>
            <button
              type="button"
              onClick={load}
              className="shrink-0 flex items-center gap-1.5 rounded-full border border-[#e5e5ea] bg-white px-4 py-2 text-[12.5px] font-semibold text-[#1D1D1F] hover:bg-[#f3f3f5] transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[15px]">refresh</span>
              Refresh
            </button>
          </div>

          {!configured && (
            <Banner tone="warn">
              <code className="font-mono">ADMIN_EMAILS</code> is not set, so admin endpoints
              are refusing requests with 503. Set it in your environment to enable them.
            </Banner>
          )}

          {error && <Banner tone="error">{error}</Banner>}

          {stats && stats.events.withoutClusterKey > 0 && (
            <Banner tone="warn">
              <strong>{stats.events.withoutClusterKey}</strong> event
              {stats.events.withoutClusterKey === 1 ? '' : 's'} stored without a{' '}
              <code className="font-mono">clusterKey</code>. These cannot de-duplicate and
              will show as double cards in the feed. Usually the daily cron running an
              older default branch — run{' '}
              <code className="font-mono">scripts/migrate-events.ts</code> then{' '}
              <code className="font-mono">scripts/cleanup-duplicate-clusters.ts --apply</code>.
            </Banner>
          )}

          {/* ── Tabs ──────────────────────────────────────────────────── */}
          <div className="flex gap-1.5 overflow-x-auto pb-1">
            {(
              [
                ['overview', 'Overview', 'dashboard'],
                ['scraper', 'Scraper', 'sync'],
                ['sources', 'Sources', 'rss_feed'],
                ['events', 'Events', 'event'],
              ] as Array<[Tab, string, string]>
            ).map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                aria-pressed={tab === id}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2 text-[13px] font-semibold border transition-colors ${
                  tab === id
                    ? 'bg-[#1D1D1F] text-white border-[#1D1D1F]'
                    : 'bg-white text-[#1D1D1F] border-[#e5e5ea] hover:bg-[#f3f3f5]'
                }`}
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[16px]">{icon}</span>
                {label}
              </button>
            ))}
          </div>

          {loading && !stats ? (
            <SkeletonGrid />
          ) : (
            <>
              {tab === 'overview' && stats && <Overview stats={stats} />}
              {tab === 'scraper' && <ScraperPanel stats={stats} onDone={load} />}
              {tab === 'sources' && stats && <SourcesPanel stats={stats} onChanged={load} />}
              {tab === 'events' && <EventsPanel onChanged={load} />}
            </>
          )}
        </div>
      </main>
    </div>
  );
}

/* ────────────────────────────── Overview ────────────────────────────── */

function Overview({ stats }: { stats: Stats }) {
  const techShare = stats.events.upcoming
    ? Math.round((stats.events.tech / stats.events.upcoming) * 100)
    : 0;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Upcoming events" value={stats.events.upcoming} sub={`${stats.events.total} all time`} />
        <Stat label="Tech events" value={stats.events.tech} sub={`${techShare}% of upcoming`} accent />
        <Stat label="Added in 24h" value={stats.events.addedToday} sub="by the last scrape" />
        <Stat
          label="Sources producing"
          value={stats.sources.producing}
          sub={`of ${stats.sources.total} tracked`}
        />
      </div>

      <div className="grid lg:grid-cols-2 gap-5">
        <Card title="Tech categories" subtitle="Upcoming, tech only">
          {stats.categories.length === 0 ? (
            <Empty>No categorised tech events yet.</Empty>
          ) : (
            <BarList items={stats.categories} />
          )}
        </Card>

        <Card title="Where events come from" subtitle="Upcoming, by adapter">
          <BarList items={stats.sources.bySource} />
        </Card>
      </div>

      <Card
        title="Next up"
        subtitle="The soonest tech events a user will see"
        action={
          <Link
            href="/?techOnly=true"
            className="text-[12.5px] font-semibold text-[#0071E3] hover:underline"
          >
            Open feed
          </Link>
        }
      >
        {stats.nextUp.length === 0 ? (
          <Empty>Nothing scheduled. Run the scraper.</Empty>
        ) : (
          <ul className="divide-y divide-[#f0f0f2]">
            {stats.nextUp.map(e => (
              <li key={e.id} className="flex items-center gap-3 py-2.5">
                <div className="w-[62px] shrink-0 text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[#86868B]">
                    {dayLabelIST(e.startDateTime)}
                  </p>
                  <p className="tnum text-[12.5px] font-bold text-[#1D1D1F]">
                    {timeIST(e.startDateTime)}
                  </p>
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
                        ? 'bg-green-50 text-green-800'
                        : e.connectionScore >= 50
                          ? 'bg-amber-50 text-amber-800'
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
      </Card>

      <Card title="Who is using it" subtitle="Regular users only track events; they never see this page">
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Signed-up users" value={stats.users.total} plain />
          <Stat label="Tracked events" value={stats.users.trackerEntries} plain />
        </div>
      </Card>
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
      setResult({ ok: false, text: 'The request failed or timed out. A full run can exceed the request limit — use the CLI for that.' });
    } finally {
      setRunning(null);
    }
  }

  return (
    <div className="space-y-5">
      <Card title="Run the scraper" subtitle="Only you can trigger this — the endpoint is admin-gated">
        <div className="flex flex-wrap gap-2.5">
          <button
            type="button"
            onClick={() => run('fast')}
            disabled={running !== null}
            className="flex items-center gap-1.5 rounded-full bg-[#0071E3] px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-blue-600 disabled:opacity-50 transition-colors"
          >
            <span aria-hidden="true" className={`material-symbols-outlined text-[16px] ${running === 'fast' ? 'animate-spin' : ''}`}>
              bolt
            </span>
            {running === 'fast' ? 'Running…' : 'Fast scrape'}
          </button>
          <button
            type="button"
            onClick={() => run('full')}
            disabled={running !== null}
            className="flex items-center gap-1.5 rounded-full bg-[#1D1D1F] px-5 py-2.5 text-[13px] font-semibold text-white hover:bg-black disabled:opacity-50 transition-colors"
          >
            <span aria-hidden="true" className={`material-symbols-outlined text-[16px] ${running === 'full' ? 'animate-spin' : ''}`}>
              sync
            </span>
            {running === 'full' ? 'Running…' : 'Full scrape'}
          </button>
        </div>

        <p className="mt-3 text-[12.5px] leading-relaxed text-[#6E6E73]">
          <strong>Fast</strong> skips Eventbrite and the company-page sweep and shrinks the
          enrichment budgets — about a minute. <strong>Full</strong> fans out to roughly 700
          upstream requests with LLM tagging and takes 15–30 minutes, which is longer than a
          serverless request is allowed to live: run it as{' '}
          <code className="font-mono">npm run scrape</code> instead, or let the daily
          8&nbsp;AM&nbsp;IST GitHub Action do it.
        </p>

        {result && <Banner tone={result.ok ? 'ok' : 'error'}>{result.text}</Banner>}
      </Card>

      <Card title="Last activity" subtitle="From per-source health records">
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Field
            label="Last scrape"
            value={stats?.sources.lastScrapedAt ? relativeTime(stats.sources.lastScrapedAt) : 'never'}
          />
          <Field label="Producing" value={String(stats?.sources.producing ?? '—')} />
          <Field label="Quiet" value={String(stats?.sources.quiet ?? '—')} />
          <Field
            label="Dead (6+ empty)"
            value={String(stats?.sources.dead ?? '—')}
            tone={stats && stats.sources.dead > 0 ? 'warn' : undefined}
          />
        </dl>
        <p className="mt-3 text-[12.5px] text-[#6E6E73]">
          A source counts as dead after six consecutive empty scrapes. Nothing retires them
          automatically yet, so they are still requested every run.
        </p>
      </Card>
    </div>
  );
}

/* ────────────────────────────── Sources ────────────────────────────── */

/**
 * Register a scrape source by hand — the "C" that was missing from the sources CRUD.
 *
 * Most sources arrive through auto-discovery (Luma calendar ids harvested from the city feed,
 * Meetup group slugs from the keyword fan-out), which is the design and should stay that way. This
 * is for the ones discovery cannot reach: a community that publishes only an .ics, or a Bevy tenant
 * verified by hand with `probe-bevy-tenants.ts`.
 *
 * `kind` + `handle` are offered as an explicit PAIR because together they are the dedup identity
 * (`Source.index({ kind, handle }, { unique: true, sparse: true })`), and the API rejects one
 * without the other. Leaving both blank is fine and normal for a one-off URL.
 */
function NewSourceForm({ onCreated }: { onCreated: (name: string) => void }) {
  const [form, setForm] = useState({ name: '', type: 'ical', url: '', kind: '', handle: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function submit() {
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const res = await fetch('/api/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        if (Array.isArray(data?.fields)) {
          const next: Record<string, string> = {};
          for (const f of data.fields as Array<{ field: string; message: string }>) next[f.field] = f.message;
          setFieldErrors(next);
        }
        setError(data?.error || `Could not create (HTTP ${res.status}).`);
        return;
      }
      onCreated(form.name.trim() || 'source');
      setForm({ name: '', type: 'ical', url: '', kind: '', handle: '' });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create source.');
    } finally {
      setSaving(false);
    }
  }

  const input = (key: keyof typeof form, placeholder: string) => (
    <label className="block">
      <span className="sr-only">{placeholder}</span>
      <input
        value={form[key]}
        onChange={e => setForm(prev => ({ ...prev, [key]: e.target.value }))}
        placeholder={placeholder}
        className={`h-10 w-full rounded-xl border bg-white px-3 text-[13px] text-[#1D1D1F] focus:outline-none ${
          fieldErrors[key] ? 'border-[#C7362D]' : 'border-[#e5e5ea] focus:border-[#0071E3]'
        }`}
      />
      {fieldErrors[key] && <span className="mt-1 block text-[12px] text-[#C7362D]">{fieldErrors[key]}</span>}
    </label>
  );

  return (
    <div className="mb-3 rounded-2xl border border-[color:var(--hairline)] bg-[#fbfbfd] p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        {input('name', 'Name, e.g. Bengaluru Python User Group')}
        <label className="block">
          <span className="sr-only">Type</span>
          <select
            value={form.type}
            onChange={e => setForm(prev => ({ ...prev, type: e.target.value }))}
            className={`h-10 w-full rounded-xl border bg-white px-3 text-[13px] text-[#1D1D1F] focus:outline-none ${
              fieldErrors.type ? 'border-[#C7362D]' : 'border-[#e5e5ea] focus:border-[#0071E3]'
            }`}
          >
            {SOURCE_TYPES.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          {fieldErrors.type && <span className="mt-1 block text-[12px] text-[#C7362D]">{fieldErrors.type}</span>}
        </label>
      </div>
      <div className="mt-3">{input('url', 'Feed URL, https://…')}</div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {input('kind', 'Kind (optional), e.g. meetup')}
        {input('handle', 'Handle (optional), e.g. blr-python')}
      </div>
      <p className="mt-2 text-[11.5px] leading-relaxed text-[#86868B]">
        Kind and handle are the dedup identity and must be given together, or not at all. The
        scraper will fetch this URL on its next run, so http(s) only.
      </p>
      {error && (
        <p role="alert" className="mt-2 rounded-xl bg-[#FFF1F0] px-3 py-2 text-[12.5px] text-[#C7362D]">
          {error}
        </p>
      )}
      <button
        type="button"
        onClick={submit}
        disabled={saving}
        className="pressable mt-3 h-10 rounded-full bg-[#1D1D1F] px-5 text-[12.5px] font-semibold text-white hover:bg-black disabled:opacity-50"
      >
        {saving ? 'Registering…' : 'Register source'}
      </button>
    </div>
  );
}

function SourcesPanel({ stats, onChanged }: { stats: Stats; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);

  const rows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return stats.sources.rows.filter(r => {
      if (onlyProblems && r.lastEventCount > 0) return false;
      if (!q) return true;
      return `${r.name} ${r.handle ?? ''} ${r.kind ?? ''}`.toLowerCase().includes(q);
    });
  }, [stats.sources.rows, filter, onlyProblems]);

  async function toggle(row: SourceRow) {
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch(`/api/sources/${row.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !row.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNote({ ok: true, text: `${row.name} ${row.enabled ? 'disabled' : 'enabled'}.` });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not update ${row.name} (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  async function remove(row: SourceRow) {
    // Deleting a Source destroys discovery state that took multiple scrapes to build and
    // does not come back on its own, so this asks first.
    if (
      !window.confirm(
        `Delete "${row.name}" permanently?\n\nThis removes persisted discovery state. Disabling it instead keeps the record and stops it being scraped.`
      )
    ) {
      return;
    }
    setBusy(row.id);
    setNote(null);
    try {
      const res = await fetch(`/api/sources/${row.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setNote({ ok: true, text: `${row.name} deleted.` });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not delete ${row.name} (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title={`Sources (${stats.sources.total})`}
      subtitle={`${stats.sources.producing} producing · ${stats.sources.quiet} quiet · ${stats.sources.never} never scraped · ${stats.sources.dead} dead`}
    >
      <div className="flex flex-wrap items-center gap-2.5 pb-3">
        <label className="relative flex-1 min-w-[180px]">
          <span className="sr-only">Filter sources</span>
          <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[#a1a1a6]">
            search
          </span>
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter by name, handle or kind"
            className="h-10 w-full rounded-full border border-[#e5e5ea] bg-white pl-10 pr-4 text-[13px] text-[#1D1D1F] focus:border-[#0071E3] focus:outline-none"
          />
        </label>
        <button
          type="button"
          onClick={() => setOnlyProblems(v => !v)}
          aria-pressed={onlyProblems}
          className={`h-10 shrink-0 rounded-full border px-4 text-[12.5px] font-semibold transition-colors ${
            onlyProblems
              ? 'bg-[#1D1D1F] text-white border-[#1D1D1F]'
              : 'bg-white text-[#1D1D1F] border-[#e5e5ea] hover:bg-[#f3f3f5]'
          }`}
        >
          Only problems
        </button>
        <button
          type="button"
          onClick={() => setAdding(v => !v)}
          aria-expanded={adding}
          className="h-10 shrink-0 rounded-full bg-[#0071E3] px-4 text-[12.5px] font-semibold text-white hover:bg-blue-600"
        >
          {adding ? 'Cancel' : 'Add source'}
        </button>
      </div>

      {adding && <NewSourceForm onCreated={created => { setAdding(false); setNote({ ok: true, text: `Registered “${created}”.` }); onChanged(); }} />}

      {note && <Banner tone={note.ok ? 'ok' : 'error'}>{note.text}</Banner>}

      {rows.length === 0 ? (
        <Empty>No sources match.</Empty>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <ul className="divide-y divide-[#f0f0f2]">
            {rows.map(row => {
              const dead = row.consecutiveEmptyScrapes >= 6;
              return (
                <li key={row.id} className="flex items-center gap-3 py-2.5">
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      !row.enabled
                        ? 'bg-[#c7c7cc]'
                        : row.lastEventCount > 0
                          ? 'bg-[#30D158]'
                          : dead
                            ? 'bg-[#FF3B30]'
                            : 'bg-[#FF9F0A]'
                    }`}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-[#1D1D1F]">
                      {row.name}
                      {!row.enabled && (
                        <span className="ml-2 rounded bg-[#f3f3f5] px-1.5 py-0.5 text-[10.5px] font-bold uppercase tracking-wide text-[#86868B]">
                          off
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[12px] text-[#6E6E73]">
                      {row.kind ?? 'aggregate'} ·{' '}
                      {row.lastScrapedAt ? `scraped ${relativeTime(row.lastScrapedAt)}` : 'never scraped'}
                      {dead && <span className="text-[#C7362D] font-semibold"> · {row.consecutiveEmptyScrapes} empty runs</span>}
                    </p>
                  </div>
                  <span className="tnum shrink-0 text-[12.5px] font-semibold text-[#1D1D1F]">
                    {row.lastEventCount}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(row)}
                    disabled={busy === row.id}
                    className="shrink-0 rounded-full border border-[#e5e5ea] bg-white px-3 py-1.5 text-[12px] font-semibold text-[#1D1D1F] hover:bg-[#f3f3f5] disabled:opacity-50"
                  >
                    {row.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(row)}
                    disabled={busy === row.id}
                    aria-label={`Delete ${row.name}`}
                    className="shrink-0 rounded-full bg-red-50 px-3 py-1.5 text-[12px] font-semibold text-[#FF3B30] hover:bg-red-100 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
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

function EventsPanel({ onChanged }: { onChanged: () => void }) {
  const [q, setQ] = useState('');
  const [events, setEvents] = useState<AdminEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  /** Which event the edit modal is open for. Null = closed. */
  const [editingId, setEditingId] = useState<string | null>(null);

  const search = useCallback(async (term: string) => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: '40', sort: 'soonest' });
      if (term.trim()) params.set('q', term.trim());
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
    const t = setTimeout(() => search(q), 250);
    return () => clearTimeout(t);
  }, [q, search]);

  async function remove(e: AdminEvent) {
    if (!window.confirm(`Delete "${e.title}"?\n\nIt will come back on the next scrape if the source still lists it.`)) {
      return;
    }
    setBusy(e._id);
    setNote(null);
    try {
      const res = await fetch(`/api/events/${e._id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvents(prev => prev.filter(x => x._id !== e._id));
      setNote({ ok: true, text: `Deleted “${e.title}”.` });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not delete (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  /**
   * Pin or unpin an event to the home page Spotlight.
   *
   * Unpinning sends `spotlightAt: null` rather than deleting the key, because the route does a
   * plain `$set` and cannot express `$unset`. That is fine and deliberate: the feed filters on
   * `spotlightAt: { $type: 'date' }`, so an explicit null is not a date and does not match. Using
   * `$exists` there instead would have made this null read as "pinned".
   *
   * Only upcoming, and only two get shown — the home page requests `spotlight=true` through the
   * same filter builder as every other query, so a pin cannot resurrect a finished event. Pinning
   * a third is allowed here and simply does not display; that is worth knowing before wondering
   * why nothing changed.
   */
  async function toggleSpotlight(e: AdminEvent) {
    const pinned = Boolean(e.spotlightAt);
    setBusy(e._id);
    setNote(null);
    try {
      const nextValue = pinned ? null : new Date().toISOString();
      const res = await fetch(`/api/events/${e._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spotlightAt: nextValue }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvents(prev => prev.map(x => (x._id === e._id ? { ...x, spotlightAt: nextValue } : x)));
      setNote({
        ok: true,
        text: pinned
          ? `“${e.title}” removed from the Spotlight.`
          : `“${e.title}” pinned to the Spotlight. It shows on the home page while it is upcoming.`,
      });
      onChanged();
    } catch (err) {
      setNote({
        ok: false,
        text: `Could not update (${err instanceof Error ? err.message : 'failed'}).`,
      });
    } finally {
      setBusy(null);
    }
  }

  async function toggleTech(e: AdminEvent) {
    setBusy(e._id);
    setNote(null);
    try {
      const res = await fetch(`/api/events/${e._id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTechEvent: !e.isTechEvent }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setEvents(prev => prev.map(x => (x._id === e._id ? { ...x, isTechEvent: !x.isTechEvent } : x)));
      setNote({
        ok: true,
        text: `“${e.title}” ${e.isTechEvent ? 'removed from' : 'marked as'} tech.`,
      });
      onChanged();
    } catch (err) {
      setNote({ ok: false, text: `Could not update (${err instanceof Error ? err.message : 'failed'}).` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card
      title="Events"
      subtitle={`${total} match${total === 1 ? 'es' : ''} · fix a mis-tagged event or remove junk`}
      action={
        <Link href="/add-event" className="text-[12.5px] font-semibold text-[#0071E3] hover:underline">
          Add manually
        </Link>
      }
    >
      <label className="relative block pb-3">
        <span className="sr-only">Search events</span>
        <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-[18px] -translate-y-1/2 text-[18px] text-[#a1a1a6]">
          search
        </span>
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search by title, organiser or venue"
          className="h-10 w-full rounded-full border border-[#e5e5ea] bg-white pl-10 pr-4 text-[13px] text-[#1D1D1F] focus:border-[#0071E3] focus:outline-none"
        />
      </label>

      {note && <Banner tone={note.ok ? 'ok' : 'error'}>{note.text}</Banner>}

      {loading ? (
        <Empty>Loading…</Empty>
      ) : events.length === 0 ? (
        <Empty>No events match “{q}”.</Empty>
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <ul className="divide-y divide-[#f0f0f2]">
            {events.map(e => (
              <li key={e._id} className="flex items-center gap-3 py-2.5">
                <div className="w-[58px] shrink-0 text-center">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-[#86868B]">
                    {dayLabelIST(e.startDateTime)}
                  </p>
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
                {/* Star, not the word "Spotlight": the row already carries a date, a title, a
                    source line and two other controls, and a third word-button turns it into a
                    wall of text. `aria-pressed` is what makes an icon toggle legible to a screen
                    reader — it says the state, which the glyph alone cannot. */}
                <button
                  type="button"
                  onClick={() => toggleSpotlight(e)}
                  disabled={busy === e._id}
                  aria-pressed={Boolean(e.spotlightAt)}
                  aria-label={
                    e.spotlightAt
                      ? `Remove ${e.title} from the Spotlight`
                      : `Pin ${e.title} to the Spotlight`
                  }
                  title={
                    e.spotlightAt
                      ? 'Pinned to the home page Spotlight — click to remove'
                      : 'Pin to the home page Spotlight (shows the two most recently pinned)'
                  }
                  className={`shrink-0 rounded-full px-2.5 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${
                    e.spotlightAt
                      ? 'bg-[#1D1D1F] text-white hover:bg-black'
                      : 'border border-[#e5e5ea] bg-white text-[#86868B] hover:bg-[#f3f3f5]'
                  }`}
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[15px] leading-none align-[-2px]">
                    {e.spotlightAt ? 'star' : 'star_outline'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => toggleTech(e)}
                  disabled={busy === e._id}
                  title="Toggle whether this counts as a software/hardware tech event"
                  className={`shrink-0 rounded-full px-3 py-1.5 text-[12px] font-semibold disabled:opacity-50 ${
                    e.isTechEvent
                      ? 'bg-[#0071E3] text-white hover:bg-blue-600'
                      : 'border border-[#e5e5ea] bg-white text-[#6E6E73] hover:bg-[#f3f3f5]'
                  }`}
                >
                  {e.isTechEvent ? 'Tech' : 'Not tech'}
                </button>
                {/* An icon, for the same reason the Spotlight control is one: the row already
                    carries a date, a title, a source line and two word-buttons. `aria-label`
                    names the event so a screen reader hears which row it belongs to. */}
                <button
                  type="button"
                  onClick={() => setEditingId(e._id)}
                  disabled={busy === e._id}
                  aria-label={`Edit ${e.title}`}
                  title="Edit this event's title, time, venue, categories and cover image"
                  className="shrink-0 rounded-full border border-[#e5e5ea] bg-white px-2.5 py-1.5 text-[12px] font-semibold text-[#6E6E73] hover:bg-[#f3f3f5] disabled:opacity-50"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[15px] leading-none align-[-2px]">
                    edit
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => remove(e)}
                  disabled={busy === e._id}
                  aria-label={`Delete ${e.title}`}
                  className="shrink-0 rounded-full bg-red-50 px-3 py-1.5 text-[12px] font-semibold text-[#FF3B30] hover:bg-red-100 disabled:opacity-50"
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Re-runs the search on save rather than patching the row in place: an edit can change the
          title, the date or the categories, all of which the row displays and the query orders by,
          so a local patch could leave a row under the wrong date heading. `onChanged()` also
          refreshes the corpus stats, since a tech-flag change moves the counts. */}
      {editingId && (
        <EditEventModal
          eventId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={title => {
            setEditingId(null);
            setNote({ ok: true, text: `Saved “${title}”.` });
            search(q);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

/* ────────────────────────────── Primitives ────────────────────────────── */

function Card({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl bg-white card-shadow p-5">
      <div className="flex flex-wrap items-start justify-between gap-2 pb-3">
        <div>
          <h2 className="text-[16px] font-bold text-[#1D1D1F]">{title}</h2>
          {subtitle && <p className="mt-0.5 text-[13px] text-[#6E6E73]">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Stat({
  label,
  value,
  sub,
  accent,
  plain,
}: {
  label: string;
  value: number;
  sub?: string;
  accent?: boolean;
  plain?: boolean;
}) {
  return (
    <div className={plain ? '' : 'rounded-2xl bg-white card-shadow p-4'}>
      <p className="text-[12px] font-semibold uppercase tracking-wide text-[#86868B]">{label}</p>
      <p
        className={`tnum mt-1 text-[26px] font-bold leading-none tracking-[-0.02em] ${
          accent ? 'text-[#0071E3]' : 'text-[#1D1D1F]'
        }`}
      >
        {value.toLocaleString('en-IN')}
      </p>
      {sub && <p className="mt-1 text-[12px] text-[#6E6E73]">{sub}</p>}
    </div>
  );
}

function Field({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div>
      <dt className="text-[12px] font-semibold uppercase tracking-wide text-[#86868B]">{label}</dt>
      <dd className={`mt-0.5 text-[14px] font-semibold ${tone === 'warn' ? 'text-[#C7362D]' : 'text-[#1D1D1F]'}`}>
        {value}
      </dd>
    </div>
  );
}

/** Horizontal bar list. Widths are relative to the largest value, not the total. */
function BarList({ items }: { items: Array<{ name: string; count: number }> }) {
  const max = Math.max(1, ...items.map(i => i.count));
  return (
    <ul className="space-y-1.5">
      {items.map(i => (
        <li key={i.name} className="flex items-center gap-2.5">
          <span className="w-[132px] shrink-0 truncate text-[12.5px] text-[#3a3a3c]">{i.name}</span>
          <span className="h-2 flex-1 overflow-hidden rounded-full bg-[#f0f0f2]">
            <span
              className="block h-full rounded-full bg-[#0071E3]"
              style={{ width: `${(i.count / max) * 100}%` }}
            />
          </span>
          <span className="tnum w-9 shrink-0 text-right text-[12px] font-semibold text-[#1D1D1F]">
            {i.count}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Banner({ tone, children }: { tone: 'ok' | 'warn' | 'error'; children: React.ReactNode }) {
  const cls =
    tone === 'ok'
      ? 'bg-green-50 border-green-200 text-green-800'
      : tone === 'warn'
        ? 'bg-amber-50 border-amber-200 text-amber-900'
        : 'bg-red-50 border-red-200 text-red-700';
  return (
    <div className={`mt-3 rounded-xl border px-4 py-3 text-[12.5px] leading-relaxed ${cls}`} role="status">
      {children}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="py-6 text-center text-[13px] text-[#86868B]">{children}</p>;
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-2xl bg-white card-shadow p-4">
          <div className="h-3 w-20 rounded bg-[#f0f0f2]" />
          <div className="mt-2 h-7 w-16 rounded bg-[#f0f0f2]" />
        </div>
      ))}
    </div>
  );
}
