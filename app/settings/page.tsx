'use client';

import Link from 'next/link';
import { useEffect, useState, useMemo, useCallback } from 'react';
import { useSession, signOut } from 'next-auth/react';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import { relativeTime } from '@/lib/format';

interface Source {
  _id: string;
  name: string;
  type: 'ical' | 'rss' | 'api' | 'scrape';
  url: string;
  enabled: boolean;
  kind?: string;
  handle?: string;
  lastScrapedAt?: string;
  lastEventCount?: number;
  consecutiveEmptyScrapes?: number;
  lastError?: string;
  lastErrorAt?: string;
  discoveredAt?: string;
}

/**
 * Source groups. The distinction is real and worth surfacing: built-in sources are
 * defined in code, while discovered ones were found at runtime by the Luma and
 * Meetup adapters and grow every run. Users care about that because it explains
 * why the list keeps getting longer.
 */
const GROUPS = [
  { id: 'builtin', label: 'Built-in sources', hint: 'Platform feeds defined in code' },
  { id: 'meetup-group', label: 'Discovered Meetup groups', hint: 'Found automatically from Bengaluru searches' },
  { id: 'luma-calendar', label: 'Discovered Luma calendars', hint: 'Host calendars found from the city feed' },
] as const;

type HealthState = 'ok' | 'quiet' | 'failing' | 'unknown';

function health(source: Source): HealthState {
  if (source.lastError) return 'failing';
  if (source.lastEventCount === undefined) return 'unknown';
  if (source.lastEventCount > 0) return 'ok';
  return (source.consecutiveEmptyScrapes ?? 0) >= 3 ? 'failing' : 'quiet';
}

const HEALTH_STYLE: Record<HealthState, { dot: string; label: string }> = {
  ok: { dot: 'bg-[#34C759]', label: 'Producing events' },
  quiet: { dot: 'bg-[#FF9500]', label: 'Nothing scheduled' },
  failing: { dot: 'bg-[#FF3B30]', label: 'Not working' },
  unknown: { dot: 'bg-[#C7C7CC]', label: 'Not scraped yet' },
};

export default function SettingsPage() {
  const { data: session } = useSession();
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scraping, setScraping] = useState(false);
  const [scrapeResult, setScrapeResult] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [openGroup, setOpenGroup] = useState<string>('builtin');
  const [showOnlyProblems, setShowOnlyProblems] = useState(false);

  const fetchSources = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/sources');
      if (!res.ok) throw new Error('Could not load sources');
      setSources((await res.json()).sources || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred by a tick so the effect doesn't set state synchronously.
  useEffect(() => {
    const timer = setTimeout(() => void fetchSources(), 0);
    return () => clearTimeout(timer);
  }, [fetchSources]);

  const toggleSource = async (sourceId: string, enabled: boolean) => {
    // Optimistic: the switch moves at once and reverts only if the save fails.
    setSources(prev => prev.map(s => (s._id === sourceId ? { ...s, enabled } : s)));
    try {
      const res = await fetch(`/api/sources/${sourceId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) throw new Error('rejected');
    } catch {
      setSources(prev => prev.map(s => (s._id === sourceId ? { ...s, enabled: !enabled } : s)));
      setError('Couldn’t save that change.');
      setTimeout(() => setError(null), 4000);
    }
  };

  const runScraper = async () => {
    setScraping(true);
    setScrapeResult(null);
    try {
      // `fast` skips the Eventbrite crawl and company sweep so a UI-triggered run
      // finishes inside a request. The scheduled workflow runs the full pipeline.
      const res = await fetch('/api/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fast: true }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || 'Scrape failed');
      const s = data.summary;
      setScrapeResult(
        `Done in ${Math.round(s.durationMs / 1000)}s — ${s.inserted} new, ${s.updated} updated, ${s.merged} merged from other sources.`
      );
      await fetchSources();
    } catch (err) {
      setScrapeResult(
        `Scrape failed: ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      setScraping(false);
    }
  };

  const grouped = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result: Record<string, Source[]> = { builtin: [], 'meetup-group': [], 'luma-calendar': [] };
    for (const source of sources) {
      if (query && !`${source.name} ${source.url}`.toLowerCase().includes(query)) continue;
      if (showOnlyProblems && health(source) !== 'failing') continue;
      // Sources with no `kind` are the built-in registry entries; an unrecognised
      // kind also lands there rather than vanishing from the UI.
      const key = source.kind && source.kind in result ? source.kind : 'builtin';
      result[key].push(source);
    }
    for (const key of Object.keys(result)) {
      result[key].sort((a, b) => (b.lastEventCount ?? -1) - (a.lastEventCount ?? -1));
    }
    return result;
  }, [sources, search, showOnlyProblems]);

  const stats = useMemo(() => {
    const failing = sources.filter(s => health(s) === 'failing').length;
    const producing = sources.filter(s => health(s) === 'ok').length;
    const events = sources.reduce((sum, s) => sum + (s.lastEventCount ?? 0), 0);
    return { total: sources.length, failing, producing, events };
  }, [sources]);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        <span className="text-[#86868B] text-label-md font-semibold">Settings</span>
      </header>

      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[820px] mx-auto px-4 md:px-8 pt-6 space-y-5">
          <div>
            <h1 className="text-[24px] md:text-[30px] font-bold tracking-[-0.025em] text-[#1D1D1F]">
              Settings
            </h1>
            <p className="text-[13.5px] text-[#6E6E73] mt-0.5">
              Where events come from, and how they reach you.
            </p>
          </div>

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-[13px] text-red-700">
              {error}
            </div>
          )}

          {/* ── Account ─────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <div className="flex items-center gap-4">
              {session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- Google avatar CDN
                <img
                  src={session.user.image}
                  alt=""
                  className="w-12 h-12 rounded-full object-cover shrink-0"
                />
              ) : (
                <div className="w-12 h-12 rounded-full bg-[#f3f3f5] flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-[#86868B] text-[26px]">person</span>
                </div>
              )}
              <div className="flex-1 min-w-0">
                {session?.user ? (
                  <>
                    <p className="text-[15px] font-semibold text-[#1D1D1F] truncate">
                      {session.user.name || 'Signed in'}
                    </p>
                    <p className="text-[13px] text-[#6E6E73] truncate">{session.user.email}</p>
                  </>
                ) : (
                  <>
                    <p className="text-[15px] font-semibold text-[#1D1D1F]">Not signed in</p>
                    <p className="text-[13px] text-[#6E6E73]">
                      Sign in to use the tracker and save events.
                    </p>
                  </>
                )}
              </div>
              {session?.user ? (
                <button
                  type="button"
                  onClick={() => signOut({ callbackUrl: '/' })}
                  className="shrink-0 px-4 py-2 rounded-full text-[12.5px] font-semibold text-[#FF3B30] bg-red-50 hover:bg-red-100 transition-colors"
                >
                  Sign out
                </button>
              ) : (
                <Link
                  href="/login"
                  className="shrink-0 px-4 py-2 rounded-full text-[12.5px] font-semibold text-white bg-[#0071E3] hover:bg-blue-600 transition-colors"
                >
                  Sign in
                </Link>
              )}
            </div>
          </section>

          {/* ── Sources ─────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow overflow-hidden">
            <div className="p-5 border-b border-[#f0f0f2]">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-[16px] font-bold text-[#1D1D1F]">Event sources</h2>
                  <p className="text-[13px] text-[#6E6E73] mt-0.5">
                    {stats.total} tracked · {stats.producing} producing events ·{' '}
                    {stats.failing > 0 ? (
                      <span className="text-[#C7362D] font-semibold">{stats.failing} not working</span>
                    ) : (
                      'all healthy'
                    )}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={runScraper}
                  disabled={scraping}
                  className="shrink-0 flex items-center gap-1.5 bg-[#1D1D1F] text-white text-[12.5px] font-semibold px-4 py-2 rounded-full hover:bg-black transition-colors disabled:opacity-50"
                >
                  <span className={`material-symbols-outlined text-[15px] ${scraping ? 'animate-spin' : ''}`}>
                    sync
                  </span>
                  {scraping ? 'Scraping…' : 'Scrape now'}
                </button>
              </div>

              {scrapeResult && (
                <p
                  className={`mt-3 text-[12.5px] rounded-lg px-3 py-2 ${
                    scrapeResult.startsWith('Scrape failed')
                      ? 'bg-red-50 text-red-700'
                      : 'bg-green-50 text-green-800'
                  }`}
                >
                  {scrapeResult}
                </p>
              )}

              <div className="flex flex-wrap items-center gap-2 mt-4">
                <div className="relative flex-1 min-w-[180px]">
                  <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[17px] text-[#86868B] pointer-events-none">
                    search
                  </span>
                  <input
                    type="search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Filter sources"
                    aria-label="Filter sources"
                    className="w-full h-9 pl-9 pr-3 rounded-full bg-[#f9f9fb] border border-[#e5e5ea] text-[13px] focus:outline-none focus:border-[#0071E3]"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowOnlyProblems(v => !v)}
                  aria-pressed={showOnlyProblems}
                  className={`h-9 px-3.5 rounded-full text-[12.5px] font-semibold border transition-colors ${
                    showOnlyProblems
                      ? 'bg-[#FF3B30] text-white border-[#FF3B30]'
                      : 'bg-white text-[#1D1D1F] border-[#e5e5ea] hover:bg-[#f3f3f5]'
                  }`}
                >
                  Only problems
                </button>
              </div>
            </div>

            {loading ? (
              <div className="p-5 space-y-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <div key={i} className="skeleton h-10 rounded-lg" />
                ))}
              </div>
            ) : (
              GROUPS.map(group => {
                const rows = grouped[group.id] || [];
                const isOpen = openGroup === group.id;
                return (
                  <div key={group.id} className="border-b border-[#f0f0f2] last:border-b-0">
                    <button
                      type="button"
                      onClick={() => setOpenGroup(isOpen ? '' : group.id)}
                      aria-expanded={isOpen}
                      className="w-full flex items-center gap-3 px-5 py-3.5 hover:bg-[#f9f9fb] transition-colors text-left"
                    >
                      <span
                        className={`material-symbols-outlined text-[20px] text-[#86868B] transition-transform ${
                          isOpen ? 'rotate-90' : ''
                        }`}
                      >
                        chevron_right
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[14px] font-semibold text-[#1D1D1F]">
                          {group.label}
                        </span>
                        <span className="block text-[12px] text-[#86868B]">{group.hint}</span>
                      </span>
                      <span className="tnum text-[12px] font-semibold text-[#86868B] bg-[#f3f3f5] rounded-full px-2.5 py-0.5">
                        {rows.length}
                      </span>
                    </button>

                    {isOpen && rows.length === 0 && (
                      <p className="px-5 pb-4 text-[13px] text-[#86868B]">
                        {search || showOnlyProblems
                          ? 'Nothing matches those filters.'
                          : 'Nothing here yet — run the scraper.'}
                      </p>
                    )}

                    {isOpen &&
                      rows.map(source => {
                        const state = health(source);
                        const style = HEALTH_STYLE[state];
                        return (
                          <div
                            key={source._id}
                            className="flex items-center gap-3 px-5 py-3 border-t border-[#f7f7f9]"
                          >
                            <span
                              className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`}
                              title={style.label}
                              aria-label={style.label}
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-[13.5px] font-medium text-[#1D1D1F] truncate">
                                {source.name}
                              </p>
                              <p className="text-[11.5px] text-[#86868B] truncate">
                                {source.lastEventCount !== undefined
                                  ? `${source.lastEventCount} event${source.lastEventCount === 1 ? '' : 's'} last run`
                                  : style.label}
                                {source.lastScrapedAt && ` · ${relativeTime(source.lastScrapedAt)}`}
                                {(source.consecutiveEmptyScrapes ?? 0) >= 3 &&
                                  ` · empty ${source.consecutiveEmptyScrapes} runs`}
                              </p>
                              {source.lastError && (
                                <p className="text-[11.5px] text-[#C7362D] truncate mt-0.5">
                                  {source.lastError}
                                </p>
                              )}
                            </div>
                            <a
                              href={source.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title="Open source"
                              className="shrink-0 text-[#86868B] hover:text-[#0071E3] transition-colors"
                            >
                              <span className="material-symbols-outlined text-[17px]">open_in_new</span>
                            </a>
                            <label className="relative shrink-0 inline-flex items-center cursor-pointer">
                              <span className="sr-only">
                                {source.enabled ? 'Disable' : 'Enable'} {source.name}
                              </span>
                              <input
                                type="checkbox"
                                checked={source.enabled}
                                onChange={e => toggleSource(source._id, e.target.checked)}
                                className="sr-only peer"
                              />
                              <div className="w-10 h-[22px] bg-[#e5e5ea] rounded-full peer peer-checked:bg-[#34C759] after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-[18px] after:w-[18px] after:transition-all peer-checked:after:translate-x-[18px]" />
                            </label>
                          </div>
                        );
                      })}
                  </div>
                );
              })
            )}
          </section>

          {/* ── Digest ──────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <h2 className="text-[16px] font-bold text-[#1D1D1F]">Daily digest</h2>
            <p className="text-[13px] text-[#6E6E73] mt-1">
              A summary of new events, deadlines and follow-ups goes out at 8 AM IST via a
              scheduled GitHub Action.
            </p>
            {/*
              Honest about where this is configured. The previous version offered an
              email field that only wrote to localStorage, so changing it appeared to
              work while the digest kept using the server's USER_EMAIL.
            */}
            <div className="mt-3 bg-[#f9f9fb] rounded-xl p-4 text-[12.5px] text-[#3a3a3c] space-y-1.5">
              <p>
                Recipient is set by the <code className="font-mono text-[11.5px]">USER_EMAIL</code>{' '}
                environment variable, and sending needs{' '}
                <code className="font-mono text-[11.5px]">RESEND_API_KEY</code>.
              </p>
              <p className="text-[#86868B]">
                Preview what today’s digest would contain:{' '}
                <a
                  href="/api/notifications/send-digest"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-[#0071E3] hover:underline"
                >
                  open preview
                </a>
              </p>
            </div>
          </section>

          {/* ── About ───────────────────────────────────────────────────── */}
          <section className="bg-white rounded-2xl card-shadow p-5">
            <h2 className="text-[16px] font-bold text-[#1D1D1F]">About</h2>
            <dl className="mt-3 text-[13px] text-[#3a3a3c] space-y-2">
              <div className="flex justify-between gap-4">
                <dt className="text-[#86868B]">Events tracked</dt>
                <dd className="tnum font-semibold">{stats.events.toLocaleString('en-IN')} last run</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#86868B]">Sources</dt>
                <dd className="tnum font-semibold">{stats.total}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-[#86868B]">Stack</dt>
                <dd className="font-semibold text-right">Next.js 16 · MongoDB · NVIDIA NIM</dd>
              </div>
            </dl>
          </section>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
