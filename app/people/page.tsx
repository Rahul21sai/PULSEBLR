'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import { PageHeader, EmptyState, Skeleton } from '../components/ui';
import type { ContactDTO, FolderDTO } from '@/lib/contacts/types';

/**
 * Everyone you have met, across every event — the surface that answers "who do I know at X".
 *
 * WHY THIS EXISTS AND WHY IT IS NOT A DUPLICATE OF /folders. The nav has had an entry labelled
 * "People" since the scan feature shipped, and it pointed at `/folders`, which lists FOLDERS —
 * one per event. So the label promised people and delivered containers, and the question this app
 * is actually for ("I need an intro at Razorpay; who do I already know there?") was unanswerable
 * in the product even though `GET /api/contacts` has served the data all along and nothing
 * consumed it.
 *
 * The two views are different axes on the same data and both are worth having: /folders is BY
 * EVENT, which is how you capture; /people is BY PERSON, which is how you recall. The nav's
 * "People" now points here, because that is what the word means, and each page links to the other.
 *
 * GROUPED BY COMPANY BY DEFAULT, and that is the whole design. A flat alphabetical list of names
 * answers "did I meet Priya", which you can also do with search. Grouping by company answers the
 * question you cannot otherwise ask, and it makes the shape of your network legible: the companies
 * where you know three people look different from the ones where you know one.
 *
 * REPEAT CONNECTIONS COME FROM THE EXISTING ENDPOINT, not from a second implementation.
 * `detectRepeatConnections()` groups by `Contact.contactKey` — so a scanned LinkedIn slug matches
 * exactly rather than by a lowercased-name guess — AND it unions the legacy
 * `TrackerEntry.connections[]` store while suppressing the overlap with migrated rows. Re-deriving
 * repeats here from `contacts` alone would have been three lines and would silently miss everyone
 * recorded before the migration. It reports `matchedOn` so the UI can be more confident about a
 * LinkedIn match than a name match, which is why the badge says which.
 */

interface RepeatConnection {
  name: string;
  contactKey: string;
  eventCount: number;
  matchedOn: string;
  places: string[];
}

type Filter = 'all' | 'target' | 'repeat' | 'followup';

const FILTERS: { id: Filter; label: string; hint: string }[] = [
  { id: 'all', label: 'Everyone', hint: 'Every person you have captured' },
  { id: 'target', label: 'Target companies', hint: 'People at companies on your target list' },
  { id: 'repeat', label: 'Met more than once', hint: 'The same person at two or more events' },
  { id: 'followup', label: 'Follow-up due', hint: 'You set a follow-up and have not marked it done' },
];

export default function PeoplePage() {
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [folders, setFolders] = useState<FolderDTO[]>([]);
  const [repeats, setRepeats] = useState<RepeatConnection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        /*
         * Three requests in parallel, and the repeat set is ALLOWED TO FAIL. Contacts are the
         * page; repeats are an enhancement on top. Making the whole surface depend on the
         * heavier aggregate would mean one slow query hides everyone you know.
         */
        const [contactsRes, foldersRes, repeatsRes] = await Promise.all([
          fetch('/api/contacts'),
          fetch('/api/folders'),
          fetch('/api/phase6/repeat-connections').catch(() => null),
        ]);
        if (!active) return;

        if (contactsRes.status === 401) {
          setError('signed-out');
          return;
        }
        if (!contactsRes.ok) throw new Error('contacts');

        const contactsData = await contactsRes.json();
        setContacts((contactsData.contacts ?? []) as ContactDTO[]);

        if (foldersRes?.ok) {
          const f = await foldersRes.json();
          setFolders((f.folders ?? []) as FolderDTO[]);
        }
        if (repeatsRes?.ok) {
          const r = await repeatsRes.json();
          setRepeats((r.repeatConnections ?? []) as RepeatConnection[]);
        }
      } catch {
        if (active) setError('Could not load your people. Nothing has been lost — try again in a moment.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const folderName = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of folders) map.set(f._id, f.name);
    return map;
  }, [folders]);

  const repeatByKey = useMemo(() => {
    const map = new Map<string, RepeatConnection>();
    for (const r of repeats) map.set(r.contactKey, r);
    return map;
  }, [repeats]);

  /*
   * People, deduplicated by `contactKey`.
   *
   * The same person scanned at two events is two Contact ROWS — one per folder, which is correct
   * storage — but showing them as two entries here would be the bug this page exists to fix. They
   * collapse into one person carrying every folder they appeared in, and gaps are filled from later
   * sightings without overwriting what was already known (the same merge-never-blank rule event
   * ingestion uses).
   *
   * Rows with no contactKey fall back to their own id, so a malformed row appears once rather than
   * merging with every other malformed row.
   */
  const people = useMemo(() => {
    const map = new Map<
      string,
      {
        key: string;
        name: string;
        role: string | null;
        company: string | null;
        linkedin: string | null;
        email: string | null;
        companies: string[];
        isTargetCompany: boolean;
        folderIds: string[];
        followUpDue: boolean;
        latest: string;
      }
    >();

    for (const c of contacts) {
      const key = c.contactKey || `id:${c._id}`;
      const existing = map.get(key);
      const followUpDue = Boolean(c.followUpAt) && !c.followedUp;

      if (!existing) {
        map.set(key, {
          key,
          name: c.name,
          role: c.role ?? null,
          company: c.company ?? null,
          linkedin: c.linkedin ?? null,
          email: c.email ?? null,
          companies: c.companies ?? [],
          isTargetCompany: Boolean(c.isTargetCompany),
          folderIds: [c.folderId],
          followUpDue,
          latest: c.scannedAt,
        });
        continue;
      }
      existing.role = existing.role ?? c.role ?? null;
      existing.company = existing.company ?? c.company ?? null;
      existing.linkedin = existing.linkedin ?? c.linkedin ?? null;
      existing.email = existing.email ?? c.email ?? null;
      if (c.companies?.length && !existing.companies.length) existing.companies = c.companies;
      existing.isTargetCompany = existing.isTargetCompany || Boolean(c.isTargetCompany);
      if (!existing.folderIds.includes(c.folderId)) existing.folderIds.push(c.folderId);
      existing.followUpDue = existing.followUpDue || followUpDue;
      if (c.scannedAt > existing.latest) existing.latest = c.scannedAt;
    }

    return Array.from(map.values());
  }, [contacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter(p => {
      if (filter === 'target' && !p.isTargetCompany) return false;
      if (filter === 'repeat' && !repeatByKey.has(p.key)) return false;
      if (filter === 'followup' && !p.followUpDue) return false;
      if (!q) return true;
      // Searches every field someone would plausibly remember them by, including the resolved
      // company list — so "razorpay" finds a person whose typed company is "Razorpay Rize".
      return [p.name, p.role, p.company, p.email, ...p.companies]
        .filter(Boolean)
        .some(v => String(v).toLowerCase().includes(q));
    });
  }, [people, query, filter, repeatByKey]);

  /*
   * Grouped by company, biggest group first, "no company recorded" always last.
   *
   * `company` is what the person's card or vCard said; `companies[]` is what the registry resolved
   * it to. Grouping prefers the RESOLVED name so "Razorpay Rize" and "Razorpay" land together —
   * that consolidation is the entire point of grouping.
   */
  const groups = useMemo(() => {
    const map = new Map<string, typeof filtered>();
    for (const p of filtered) {
      const label = p.companies[0] || p.company || '';
      const bucket = map.get(label) ?? [];
      bucket.push(p);
      map.set(label, bucket);
    }
    return Array.from(map.entries())
      .map(([label, list]) => ({
        label,
        list: list.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => {
        if (!a.label) return 1;
        if (!b.label) return -1;
        if (b.list.length !== a.list.length) return b.list.length - a.list.length;
        return a.label.localeCompare(b.label);
      });
  }, [filtered]);

  const companyCount = useMemo(
    () => new Set(people.map(p => p.companies[0] || p.company).filter(Boolean)).size,
    [people],
  );
  const repeatCount = useMemo(() => people.filter(p => repeatByKey.has(p.key)).length, [people, repeatByKey]);
  const followUpCount = useMemo(() => people.filter(p => p.followUpDue).length, [people]);

  return (
    <div className="min-h-screen ambient-above">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center px-5">
        <span className="text-lg font-bold tracking-tight text-[#1D1D1F]">People</span>
      </header>

      <main className="pt-14 md:pt-0 pb-24 md:pb-16">
        <div className="max-w-[1100px] mx-auto px-4 md:px-8 pt-4 md:pt-8">
          <PageHeader
            title="People"
            subtitle={
              loading
                ? 'Loading everyone you have met…'
                : people.length === 0
                  ? 'Scan a badge at an event and the people you meet collect here.'
                  : `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${companyCount} ${companyCount === 1 ? 'company' : 'companies'}${repeatCount > 0 ? ` · ${repeatCount} met more than once` : ''}`
            }
          />

          {/* The counterpart view. Stated as a link rather than a tab, because these are two axes
              on the same data rather than two modes of one screen. */}
          <p className="mt-1 text-[13px] text-[#6E6E73]">
            Grouped by company.{' '}
            <Link href="/folders" className="font-semibold text-[#0071E3] hover:underline">
              See them by event instead →
            </Link>
          </p>

          {error === 'signed-out' ? (
            <div className="mt-8 glass-card card-shadow rounded-[18px] p-8 text-center">
              <h2 className="t-sub text-[#1D1D1F]">Sign in to see your people</h2>
              <p className="mt-2 text-[14px] text-[#6E6E73]">
                The people you scan are private to your account.
              </p>
              <Link
                href="/login?callbackUrl=%2Fpeople"
                className="pressable mt-5 inline-flex h-11 items-center rounded-full bg-[#1D1D1F] px-6 text-[14px] font-semibold text-white hover:bg-black"
              >
                Sign in
              </Link>
            </div>
          ) : error ? (
            <div className="mt-8 glass-card card-shadow rounded-[18px] p-6">
              <p className="text-[14px] text-[#1D1D1F]">{error}</p>
            </div>
          ) : (
            <>
              {/* Controls. Rendered even while loading so the layout does not jump when data
                  arrives — and hidden entirely when there is genuinely nobody, because filters
                  over an empty set are furniture. */}
              {(loading || people.length > 0) && (
                <div className="mt-6 flex flex-col gap-3">
                  <label className="relative block">
                    <span className="sr-only">Search people</span>
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[20px] text-[#8E8E93]"
                    >
                      search
                    </span>
                    <input
                      type="search"
                      value={query}
                      onChange={e => setQuery(e.target.value)}
                      placeholder="Name, company, role or email…"
                      className="glass-card h-12 w-full rounded-full pl-12 pr-4 text-[15px] text-[#1D1D1F] card-shadow outline-none placeholder:text-[#8E8E93] focus-visible:shadow-[var(--lift-1),inset_0_0_0_2px_var(--blue)]"
                    />
                  </label>

                  <div className="no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 md:mx-0 md:px-0">
                    {FILTERS.map(f => {
                      const count =
                        f.id === 'all'
                          ? people.length
                          : f.id === 'target'
                            ? people.filter(p => p.isTargetCompany).length
                            : f.id === 'repeat'
                              ? repeatCount
                              : followUpCount;
                      // A filter that can only ever return nothing is not offered. It is not a
                      // useful control, it is a dead end that looks like one.
                      if (f.id !== 'all' && count === 0) return null;
                      const active = filter === f.id;
                      return (
                        <button
                          key={f.id}
                          type="button"
                          onClick={() => setFilter(f.id)}
                          title={f.hint}
                          aria-pressed={active}
                          className={`pressable shrink-0 rounded-full px-4 py-2 text-[13px] font-semibold transition-colors ${
                            active
                              ? 'bg-[#1D1D1F] text-white'
                              : 'glass-card text-[#3a3a3c] card-shadow hover:text-[#1D1D1F]'
                          }`}
                        >
                          {f.label}
                          <span className={`tnum ml-1.5 ${active ? 'text-white/60' : 'text-[#8E8E93]'}`}>
                            {count}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {loading ? (
                <div className="mt-6 flex flex-col gap-3">
                  {[0, 1, 2, 3, 4].map(i => (
                    <Skeleton key={i} className="h-[76px] rounded-[18px]" />
                  ))}
                </div>
              ) : people.length === 0 ? (
                <div className="mt-6">
                  <EmptyState
                    icon="groups"
                    title="No people yet"
                    body="Open the scanner at an event and point it at someone's LinkedIn QR. They will appear here, grouped by where they work."
                    action={
                      <Link
                        href="/scan"
                        className="pressable inline-flex h-11 items-center rounded-full bg-[#1D1D1F] px-6 text-[14px] font-semibold text-white hover:bg-black"
                      >
                        Open the scanner
                      </Link>
                    }
                  />
                </div>
              ) : filtered.length === 0 ? (
                <div className="mt-6 glass-card card-shadow rounded-[18px] p-8 text-center">
                  <p className="t-sub text-[#1D1D1F]">Nobody matches that</p>
                  <p className="mt-1.5 text-[13.5px] text-[#6E6E73]">
                    {query ? `No one matching “${query.trim()}”.` : 'No one in this filter.'}
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setQuery('');
                      setFilter('all');
                    }}
                    className="pressable mt-4 text-[13.5px] font-semibold text-[#0071E3] hover:underline"
                  >
                    Clear search and filters
                  </button>
                </div>
              ) : (
                <div className="mt-7 flex flex-col gap-7">
                  {groups.map(group => (
                    <section key={group.label || '__none__'}>
                      <div className="day-heading pb-2 mb-3">
                        <div className="flex items-center gap-2.5">
                          <h2 className="t-label shrink-0 text-[#1D1D1F]">
                            {group.label || 'No company recorded'}
                          </h2>
                          <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
                          <span className="tnum shrink-0 text-[11.5px] text-[#8E8E93]">
                            {group.list.length}
                          </span>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2.5">
                        {group.list.map(person => (
                          <PersonRow
                            key={person.key}
                            person={person}
                            repeat={repeatByKey.get(person.key)}
                            folderName={folderName}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}

/** Initials for the monogram. Two letters, same rule as the event cover fallback. */
function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
}

function PersonRow({
  person,
  repeat,
  folderName,
}: {
  person: {
    key: string;
    name: string;
    role: string | null;
    company: string | null;
    linkedin: string | null;
    folderIds: string[];
    isTargetCompany: boolean;
    followUpDue: boolean;
  };
  repeat?: RepeatConnection;
  folderName: Map<string, string>;
}) {
  const places = person.folderIds.map(id => folderName.get(id)).filter(Boolean) as string[];

  return (
    <article className="glass-card card-shadow raise pressable spatial-settle rounded-[18px] p-3.5 md:p-4">
      <div className="flex items-start gap-3.5">
        {/* Monogram on its own plane — the transform-free contact shadow, because this list can be
            long and a translateZ per row would promote a compositing layer per row. */}
        <span
          aria-hidden="true"
          className="contact-shadow grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[color:var(--blue-wash)] text-[13.5px] font-bold tracking-[-0.02em] text-[color:var(--blue)]"
        >
          {initials(person.name)}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-[15.5px] font-semibold leading-[1.3] tracking-[-0.015em] text-[#1D1D1F]">
              {person.name}
            </h3>
            {person.isTargetCompany && (
              <span className="pill pill-quiet text-[10.5px]">Target company</span>
            )}
            {repeat && (
              /* The signal this page was built to surface. It says the COUNT and how the match was
                 made, because a LinkedIn-slug match is a fact and a name match is a guess — and
                 conflating them is exactly what the old name-keyed detection got wrong. */
              <span
                className="pill text-[10.5px] font-semibold"
                style={{ background: 'var(--blue-wash)', color: 'var(--blue)' }}
                title={
                  `Met at ${repeat.eventCount} events` +
                  (repeat.places.length ? `: ${repeat.places.join(', ')}` : '') +
                  ` · matched on ${repeat.matchedOn}`
                }
              >
                Met {repeat.eventCount}×
              </span>
            )}
            {person.followUpDue && <span className="pill pill-live text-[10.5px]">Follow-up due</span>}
          </div>

          {(person.role || person.company) && (
            <p className="mt-0.5 truncate text-[13px] text-[#6E6E73]">
              {[person.role, person.company].filter(Boolean).join(' · ')}
            </p>
          )}

          {places.length > 0 && (
            <p className="mt-1 flex items-center gap-1.5 text-[12.5px] text-[#8E8E93]">
              <span aria-hidden="true" className="material-symbols-outlined text-[14px]">
                place
              </span>
              <span className="truncate">
                {/* Naming the events is the useful part: "met at api days" is how people actually
                    remember someone. Two are shown and the rest counted, because a person met at
                    six events would otherwise push the row to three lines. */}
                {places.slice(0, 2).join(' · ')}
                {places.length > 2 ? ` +${places.length - 2} more` : ''}
              </span>
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {person.linkedin && (
            <a
              href={person.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${person.name} on LinkedIn`}
              className="pressable grid h-9 w-9 place-items-center rounded-full text-[#6E6E73] hover:bg-[color:var(--blue-wash)] hover:text-[color:var(--blue)]"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[19px]">
                open_in_new
              </span>
              <span className="sr-only">Open on LinkedIn</span>
            </a>
          )}
          {person.folderIds[0] && (
            <Link
              href={`/folders/${person.folderIds[0]}`}
              title="Open the folder they were scanned into"
              className="pressable grid h-9 w-9 place-items-center rounded-full text-[#6E6E73] hover:bg-[color:var(--blue-wash)] hover:text-[color:var(--blue)]"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[19px]">
                folder_open
              </span>
              <span className="sr-only">Open their folder</span>
            </Link>
          )}
        </div>
      </div>
    </article>
  );
}
