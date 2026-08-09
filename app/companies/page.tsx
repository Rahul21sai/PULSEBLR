'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import { COMPANY_SECTORS } from '@/lib/companies/registry';
import { relativeTime, dayLabelIST } from '@/lib/format';

interface CompanyRow {
  name: string;
  slug: string;
  sector: string;
  website?: string;
  upcoming: number;
  techEvents: number;
  nextEventAt: string | null;
  imageUrl: string | null;
}

interface CompaniesResponse {
  companies: CompanyRow[];
  totals: { withEvents: number; inRegistry: number; attributedEvents: number };
  unmatchedHosts: Array<{ name: string; events: number }>;
}

/**
 * Browse the companies running events in Bengaluru.
 *
 * The page deliberately shows two things most directories hide:
 *  1. Companies we track that have NOTHING scheduled — absence is information, and
 *     silently omitting them makes the list look arbitrary.
 *  2. Hosts carrying events that the registry doesn't recognise yet, so the gap in
 *     coverage is visible instead of invisible.
 */
export default function CompaniesPage() {
  const [data, setData] = useState<CompaniesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [sector, setSector] = useState('');
  const [showEmpty, setShowEmpty] = useState(false);

  useEffect(() => {
    let active = true;
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch('/api/companies?includeEmpty=true');
        if (!res.ok) throw new Error('Could not load companies');
        const json = (await res.json()) as CompaniesResponse;
        if (active) setData(json);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : 'Something went wrong');
      } finally {
        if (active) setLoading(false);
      }
    }, 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, []);

  const visible = useMemo(() => {
    if (!data) return [];
    const query = search.trim().toLowerCase();
    return data.companies.filter(company => {
      if (query && !company.name.toLowerCase().includes(query)) return false;
      if (sector && company.sector !== sector) return false;
      if (!showEmpty && company.upcoming === 0) return false;
      return true;
    });
  }, [data, search, sector, showEmpty]);

  const active = data?.companies.filter(c => c.upcoming > 0).length ?? 0;
  const quiet = (data?.companies.length ?? 0) - active;

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/70 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[#1D1D1F]">
          PulseBLR
        </Link>
        <span className="text-[#86868B] text-label-md font-semibold">Companies</span>
      </header>

      <main className="pt-14 pb-24 md:pb-10">
        <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-6">
          <div className="mb-5">
            <h1 className="text-[24px] md:text-[30px] font-bold tracking-[-0.025em] text-[#1D1D1F]">
              Companies
            </h1>
            <p className="text-[13.5px] text-[#6E6E73] mt-0.5">
              {loading
                ? 'Loading…'
                : `${active} companies have events coming up · ${data?.totals.attributedEvents ?? 0} events attributed`}
            </p>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-2 mb-5">
            <div className="relative flex-1 min-w-[200px]">
              <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[#86868B] pointer-events-none">
                search
              </span>
              <input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search companies"
                aria-label="Search companies"
                className="w-full h-10 pl-10 pr-3 rounded-full bg-white border border-[#e5e5ea] text-[14px] focus:outline-none focus:border-[#0071E3]"
              />
            </div>
            <label className="shrink-0">
              <span className="sr-only">Filter by sector</span>
              <select
                value={sector}
                onChange={e => setSector(e.target.value)}
                className="h-10 px-4 rounded-full bg-white border border-[#e5e5ea] text-[13px] font-semibold text-[#1D1D1F] focus:outline-none focus:border-[#0071E3] cursor-pointer"
              >
                <option value="">All sectors</option>
                {COMPANY_SECTORS.map(s => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              onClick={() => setShowEmpty(v => !v)}
              aria-pressed={showEmpty}
              className={`h-10 px-4 rounded-full text-[13px] font-semibold border transition-colors ${
                showEmpty
                  ? 'bg-[#1D1D1F] text-white border-[#1D1D1F]'
                  : 'bg-white text-[#1D1D1F] border-[#e5e5ea] hover:bg-[#f3f3f5]'
              }`}
            >
              {showEmpty ? 'Hiding nothing' : `Show ${quiet} with no events`}
            </button>
          </div>

          {loading ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {Array.from({ length: 9 }, (_, i) => (
                <div key={i} className="skeleton h-[92px] rounded-2xl" />
              ))}
            </div>
          ) : error ? (
            <div className="bg-white rounded-2xl card-shadow py-14 text-center">
              <span className="material-symbols-outlined text-[40px] text-[#d5d5da] block mb-2">
                cloud_off
              </span>
              <p className="text-[15px] font-semibold text-[#1D1D1F]">{error}</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="bg-white rounded-2xl card-shadow py-14 text-center px-6">
              <span className="material-symbols-outlined text-[40px] text-[#d5d5da] block mb-2">
                domain_disabled
              </span>
              <p className="text-[15px] font-semibold text-[#1D1D1F]">No companies match</p>
              <p className="text-[13px] text-[#6E6E73] mt-1">
                Try clearing the sector filter or searching a different name.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {visible.map(company => {
                const hasEvents = company.upcoming > 0;
                return (
                  <Link
                    key={company.slug}
                    href={hasEvents ? `/?company=${encodeURIComponent(company.name)}` : '/companies'}
                    aria-disabled={!hasEvents}
                    className={`group bg-white rounded-2xl card-shadow p-4 flex flex-col gap-2 transition-[transform,box-shadow] ${
                      hasEvents
                        ? 'hover:shadow-[0_8px_28px_rgba(0,0,0,0.08)] hover:-translate-y-px'
                        : 'opacity-55 pointer-events-none'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[15px] font-semibold text-[#1D1D1F] truncate group-hover:text-[#0071E3] transition-colors">
                          {company.name}
                        </p>
                        <p className="text-[11.5px] uppercase tracking-widest text-[#a1a1a6] mt-0.5">
                          {company.sector}
                        </p>
                      </div>
                      <span
                        className={`tnum shrink-0 text-[13px] font-bold rounded-full px-2.5 py-1 ${
                          hasEvents ? 'bg-[#0071E3]/10 text-[#0060C0]' : 'bg-[#f3f3f5] text-[#a1a1a6]'
                        }`}
                      >
                        {company.upcoming}
                      </span>
                    </div>

                    <p className="text-[12.5px] text-[#6E6E73] mt-auto">
                      {hasEvents && company.nextEventAt ? (
                        <>
                          Next {dayLabelIST(company.nextEventAt)} ·{' '}
                          <span className="text-[#0071E3] font-semibold">
                            {relativeTime(company.nextEventAt)}
                          </span>
                        </>
                      ) : (
                        'Nothing scheduled right now'
                      )}
                    </p>
                  </Link>
                );
              })}
            </div>
          )}

          {/* Coverage gap — shown on purpose. */}
          {!loading && data && data.unmatchedHosts.length > 0 && (
            <section className="mt-10">
              <h2 className="text-[15px] font-bold text-[#1D1D1F]">
                Hosts we haven’t matched to a company yet
              </h2>
              <p className="text-[12.5px] text-[#6E6E73] mt-1 mb-3">
                These organisers have events in the feed but aren’t in the company registry.
                They’re listed so the gap is visible rather than hidden.
              </p>
              <div className="flex flex-wrap gap-2">
                {data.unmatchedHosts.map(host => (
                  <span
                    key={host.name}
                    className="pill pill-quiet"
                    title={`${host.events} event${host.events === 1 ? '' : 's'}`}
                  >
                    {host.name.slice(0, 40)}
                    <span className="tnum text-[#a1a1a6] ml-1">{host.events}</span>
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
