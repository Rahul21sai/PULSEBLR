'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import AppShell from '../components/AppShell';
import { Banner, Button, ButtonLink, Card, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { dayHeading } from '@/lib/format';
import type { ContactDTO } from '@/lib/contacts/types';

/**
 * EVERYONE YOU HAVE MET — one list across every folder.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS PAGE EXISTS. Capture worked and recall did not. `/folders` answers "who did I meet at
 * this event", which is the wrong question a week later: by then you want "who do I know at
 * Razorpay", "who was that hardware person", "who have I met twice". `GET /api/contacts` has
 * always been able to serve every contact across every folder and NOTHING consumed it — there was
 * no `app/people`, and the nav item labelled "People" pointed at the folder list.
 *
 * TWO KINDS OF TAG, SIDE BY SIDE, AND THEY ARE NOT THE SAME THING. Keeping them separate is the
 * central design decision here:
 *
 *   · COMPANY comes from `Contact.companies[]`, resolved against the 375-employer registry by
 *     `lib/companies/resolve.ts`. It is trustworthy — a name only lands there when the resolver
 *     could justify it, and `strength` governs how freely each name may match.
 *   · TAG comes from `Contact.tags[]`, which the user types. It is for the long tail the registry
 *     cannot cover: Bengaluru has thousands of employers and the registry knows 375.
 *
 * Merging them into one "tags" rail would have been less code and would have destroyed the
 * distinction between "the registry recognised this employer" and "somebody typed this" — and it
 * was worse than cosmetic: contact tags used to be fed into the resolver, so tagging a hardware
 * engineer `embedded, arm` filed them under the company Arm. See the warning in
 * `deriveContactMeta`.
 *
 * FILTERING IS SERVER-SIDE, via `/api/contacts` and `/api/contacts/facets` sharing one filter
 * builder. Filtering in the browser would have capped the feature at one page of rows, so the
 * 2001st person would be invisible and the chip counts would be computed from a truncated set —
 * confidently wrong rather than merely partial.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

interface Bucket {
  value: string;
  count: number;
  isTarget?: boolean;
  label?: string;
}

interface Facets {
  total: number;
  companies: Bucket[];
  tags: Bucket[];
  tagVocabulary: string[];
  folders: Bucket[];
  targetCount: number;
  followUpCount: number;
}

const EMPTY_FACETS: Facets = {
  total: 0,
  companies: [],
  tags: [],
  tagVocabulary: [],
  folders: [],
  targetCount: 0,
  followUpCount: 0,
};

type Sort = 'recent' | 'oldest' | 'name' | 'company';

export default function PeoplePage() {
  const [contacts, setContacts] = useState<ContactDTO[]>([]);
  const [facets, setFacets] = useState<Facets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [company, setCompany] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [folderId, setFolderId] = useState<string | null>(null);
  const [targetOnly, setTargetOnly] = useState(false);
  const [followUpDue, setFollowUpDue] = useState(false);
  const [repeatOnly, setRepeatOnly] = useState(false);
  const [sort, setSort] = useState<Sort>('recent');

  // Bulk tagging
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTag, setBulkTag] = useState('');
  const [tagging, setTagging] = useState(false);

  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextSkip, setNextSkip] = useState(0);

  // Debounced, so typing does not fire a request per keystroke. 250 ms matches the feed's search.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(timer);
  }, [q]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (company) p.set('company', company);
    if (tag) p.set('tag', tag);
    if (folderId) p.set('folderId', folderId);
    if (targetOnly) p.set('targetOnly', 'true');
    if (followUpDue) p.set('followUpDue', 'true');
    if (repeatOnly) p.set('repeatOnly', 'true');
    p.set('sort', sort);
    // Always ask for the count: the "met N times" badge is the signal `contactKey` was built for
    // and it was surfaced nowhere in this feature until now.
    p.set('withMetCount', 'true');
    return p;
  }, [debouncedQ, company, tag, folderId, targetOnly, followUpDue, repeatOnly, sort]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both in one round trip, so the rows and the counts beside them describe the same moment.
      const [listRes, facetRes] = await Promise.all([
        fetch(`/api/contacts?${params}`),
        fetch(`/api/contacts/facets?${params}`),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const list = await listRes.json();
      setContacts(list.contacts ?? []);
      setTotal(list.total ?? 0);
      setHasMore(Boolean(list.hasMore));
      setNextSkip(list.nextSkip ?? 0);
      if (facetRes.ok) setFacets(await facetRes.json());
      setError(null);
    } catch {
      setError('Could not load your people. Nothing has been lost — try again in a moment.');
    } finally {
      setLoading(false);
    }
  }, [params]);

  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const more = new URLSearchParams(params);
      more.set('skip', String(nextSkip));
      const res = await fetch(`/api/contacts?${more}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Deduped by id, because a contact written between page 1 and page 2 shifts the offset and
      // would otherwise appear twice — a real hazard on a page whose data is still being captured.
      setContacts(current => {
        const seen = new Set(current.map(c => c._id));
        return [...current, ...(data.contacts ?? []).filter((c: ContactDTO) => !seen.has(c._id))];
      });
      setHasMore(Boolean(data.hasMore));
      setNextSkip(data.nextSkip ?? nextSkip);
    } catch {
      setError('Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  const activeFilters = Boolean(
    debouncedQ || company || tag || folderId || targetOnly || followUpDue || repeatOnly
  );

  function clearAll() {
    setQ('');
    setCompany(null);
    setTag(null);
    setFolderId(null);
    setTargetOnly(false);
    setFollowUpDue(false);
    setRepeatOnly(false);
  }

  function toggleSelected(id: string) {
    setSelected(current => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /**
   * Apply one tag to everybody selected, in a single request.
   *
   * The affordance that makes tagging usable at all: coming back from a conference with forty scans
   * and tagging them one edit sheet at a time is forty sheets, which is the difference between a
   * feature and a demo.
   */
  async function applyBulkTag() {
    const tagValue = bulkTag.trim();
    if (!tagValue || !selected.size) return;
    setTagging(true);
    try {
      const res = await fetch('/api/contacts/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tags: [tagValue], contactIds: [...selected] }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setNotice(
        `Tagged ${data.tagged} ${data.tagged === 1 ? 'person' : 'people'} “${tagValue.toLowerCase()}”.`
      );
      setSelected(new Set());
      setBulkTag('');
      await load();
    } catch {
      setError('Could not apply that tag.');
    } finally {
      setTagging(false);
      setTimeout(() => setNotice(null), 4000);
    }
  }

  return (
    <AppShell title="People">
      <div className="mx-auto max-w-[1100px] px-4 pt-4 md:px-8">
        <PageHeader
          title="Everyone you've met"
          subtitle="Across every event. Filter by employer, by your own tags, or by who still needs a reply."
          action={
            <div className="flex items-center gap-2">
              <ButtonLink href="/folders" tone="quiet" icon="folder">
                Folders
              </ButtonLink>
              <ButtonLink href="/scan" tone="primary" icon="qr_code_scanner">
                Scan
              </ButtonLink>
            </div>
          }
        />

        {error && (
          <div className="mb-4">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        {notice && (
          <div className="mb-4">
            <Banner tone="ok">{notice}</Banner>
          </div>
        )}

        {/* ── Search + sort ─────────────────────────────────────────────── */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <span
              aria-hidden="true"
              className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[#8E8E93]"
            >
              search
            </span>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Name, company, role, or what you talked about"
              aria-label="Search people"
              className="h-11 w-full rounded-xl bg-white pl-10 pr-3 text-[14.5px] text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
          </div>
          <select
            value={sort}
            onChange={e => setSort(e.target.value as Sort)}
            aria-label="Sort people"
            className="h-11 rounded-xl bg-white px-3 text-[13.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
          >
            <option value="recent">Most recent</option>
            <option value="oldest">Oldest first</option>
            <option value="name">Name</option>
            <option value="company">Company</option>
          </select>
        </div>

        {/* ── Toggles ───────────────────────────────────────────────────── */}
        <div className="mb-3 flex flex-wrap gap-1.5">
          <Toggle
            label="Target companies"
            count={facets.targetCount}
            active={targetOnly}
            onClick={() => setTargetOnly(v => !v)}
          />
          <Toggle
            label="Follow-up due"
            count={facets.followUpCount}
            active={followUpDue}
            onClick={() => setFollowUpDue(v => !v)}
          />
          <Toggle label="Met more than once" active={repeatOnly} onClick={() => setRepeatOnly(v => !v)} />
          {activeFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="h-8 rounded-full px-3 text-[12.5px] font-semibold text-[#0071E3] hover:underline"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* ── Two rails, deliberately not merged ────────────────────────── */}
        <FilterRail
          title="Company"
          hint="Recognised employers, resolved from what people told you."
          buckets={facets.companies}
          selected={company}
          onSelect={setCompany}
        />
        <FilterRail
          title="Your tags"
          hint="Your own labels — for employers we don't recognise, and anything else."
          buckets={facets.tags}
          /* Vocabulary entries with nobody in them still render, at zero, so a tag that was just
             created is visible instead of looking like the create button failed. */
          extra={facets.tagVocabulary
            .filter(t => !facets.tags.some(b => b.value === t))
            .map(t => ({ value: t, count: 0 }))}
          selected={tag}
          onSelect={setTag}
        />
        {facets.folders.length > 1 && (
          <FilterRail
            title="Event"
            buckets={facets.folders}
            selected={folderId}
            onSelect={setFolderId}
          />
        )}

        {/* ── Bulk tag bar ──────────────────────────────────────────────── */}
        {selected.size > 0 && (
          <div className="sticky top-16 z-20 mb-3">
            <Card padding="tight">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-[#1D1D1F]">
                  <span className="tnum">{selected.size}</span> selected
                </span>
                <input
                  value={bulkTag}
                  onChange={e => setBulkTag(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') void applyBulkTag();
                  }}
                  list="people-tag-vocabulary"
                  maxLength={40}
                  placeholder="Tag them all…"
                  aria-label="Tag for the selected people"
                  className="h-9 min-w-[160px] flex-1 rounded-full bg-[#F7F7F9] px-3.5 text-[13.5px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
                />
                {/* Native datalist rather than a bespoke dropdown: it is a one-field type-ahead,
                    and the browser's own affordance is better than a hand-rolled popover here. */}
                <datalist id="people-tag-vocabulary">
                  {facets.tagVocabulary.map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Button
                  size="sm"
                  tone="primary"
                  onClick={() => void applyBulkTag()}
                  disabled={tagging || !bulkTag.trim()}
                >
                  {tagging ? 'Tagging…' : 'Apply tag'}
                </Button>
                <Button size="sm" tone="quiet" onClick={() => setSelected(new Set())}>
                  Cancel
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* ── Results ───────────────────────────────────────────────────── */}
        <div className="mb-2 flex items-center justify-between">
          <p className="text-[12.5px] text-[#6E6E73]">
            {loading ? (
              'Loading…'
            ) : (
              <>
                <strong className="tnum text-[#1D1D1F]">{total}</strong>{' '}
                {total === 1 ? 'person' : 'people'}
                {activeFilters ? ' match' : ''}
              </>
            )}
          </p>
          {contacts.length > 0 && (
            <a
              href={`/api/contacts/export?${params}`}
              className="text-[12.5px] font-semibold text-[#0071E3] hover:underline"
            >
              Export CSV
            </a>
          )}
        </div>

        {loading ? (
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map(i => (
              <Card key={i} padding="tight">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="mt-2 h-3 w-1/2" />
              </Card>
            ))}
          </div>
        ) : contacts.length === 0 ? (
          <EmptyState
            icon="group"
            title={activeFilters ? 'Nobody matches that' : 'No people yet'}
            body={
              activeFilters
                ? 'Try a different filter, or clear them all.'
                : 'Scan somebody’s LinkedIn QR at your next event and they will appear here.'
            }
            action={
              activeFilters ? (
                <Button tone="quiet" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : (
                <ButtonLink href="/scan" tone="primary" icon="qr_code_scanner">
                  Open the scanner
                </ButtonLink>
              )
            }
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {contacts.map(contact => (
                <PersonRow
                  key={contact._id}
                  contact={contact}
                  selected={selected.has(contact._id)}
                  onToggle={() => toggleSelected(contact._id)}
                  onPickTag={setTag}
                  onPickCompany={setCompany}
                />
              ))}
            </div>
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button tone="quiet" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load more (${total - contacts.length} left)`}
                </Button>
              </div>
            )}
          </>
        )}

        <div className="mt-8 mb-4">
          <Card padding="tight">
            <p className="text-[12.5px] leading-relaxed text-[#6E6E73]">
              <strong className="text-[#1D1D1F]">Company vs your tags.</strong> The company rail is
              resolved from a registry of Bengaluru tech employers, so it is only as broad as that
              list. When somebody works somewhere we don&apos;t recognise, tag them — select a few
              people and apply one tag to all of them at once.
            </p>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}

function Toggle({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count?: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`h-8 rounded-full px-3.5 text-[12.5px] font-semibold transition-colors ${
        active
          ? 'bg-[#1D1D1F] text-white'
          : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
      }`}
    >
      {label}
      {typeof count === 'number' && count > 0 && (
        <span className={`tnum ml-1.5 ${active ? 'text-white/70' : 'text-[#8E8E93]'}`}>{count}</span>
      )}
    </button>
  );
}

/**
 * One rail of filter chips with live counts.
 *
 * The counts come from `/api/contacts/facets`, which drops the dimension being counted — so with
 * "Razorpay" selected, every other company still shows how many you would get by switching. Counting
 * with the filter applied would show zero everywhere else and make the rail useless for changing
 * your mind.
 */
function FilterRail({
  title,
  hint,
  buckets,
  extra = [],
  selected,
  onSelect,
}: {
  title: string;
  hint?: string;
  buckets: Bucket[];
  extra?: Bucket[];
  selected: string | null;
  onSelect: (value: string | null) => void;
}) {
  const all = [...buckets, ...extra];
  if (!all.length) return null;

  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="t-label text-[#8E8E93]">{title}</span>
        {hint && <span className="text-[12px] text-[#A1A1A6]">{hint}</span>}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {all.map(bucket => {
          const active = selected === bucket.value;
          return (
            <button
              key={bucket.value}
              type="button"
              aria-pressed={active}
              onClick={() => onSelect(active ? null : bucket.value)}
              className={`h-8 rounded-full px-3 text-[12.5px] font-semibold transition-colors ${
                active
                  ? 'bg-[#0071E3] text-white'
                  : bucket.count === 0
                    ? 'bg-white text-[#A1A1A6] shadow-[inset_0_0_0_1px_var(--hairline)]'
                    : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#F7F7F9]'
              }`}
            >
              {bucket.label ?? bucket.value}
              {bucket.isTarget && !active && (
                <span title="On your target list" aria-hidden="true" className="ml-1 text-[#1D8A44]">
                  ●
                </span>
              )}
              <span className={`tnum ml-1.5 ${active ? 'text-white/70' : 'text-[#8E8E93]'}`}>
                {bucket.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PersonRow({
  contact,
  selected,
  onToggle,
  onPickTag,
  onPickCompany,
}: {
  contact: ContactDTO;
  selected: boolean;
  onToggle: () => void;
  onPickTag: (tag: string) => void;
  onPickCompany: (company: string) => void;
}) {
  const followUpDue =
    contact.followUpAt && !contact.followedUp && new Date(contact.followUpAt) <= new Date();

  return (
    <Card padding="tight" className={selected ? 'shadow-[inset_0_0_0_2px_var(--blue)]' : undefined}>
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${contact.name}`}
          className="mt-1 h-4 w-4 shrink-0 accent-[#0071E3]"
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="t-sub truncate text-[#1D1D1F]">{contact.name}</h2>
            {/* The signal `contactKey` exists for, and which was rendered nowhere until now. */}
            {(contact.metCount ?? 0) > 1 && (
              <span className="rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[10.5px] font-bold text-[#1D8A44]">
                met {contact.metCount}×
              </span>
            )}
            {contact.isTargetCompany && (
              <span className="rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[10.5px] font-bold text-[#1D8A44]">
                target
              </span>
            )}
            {followUpDue && (
              <span className="rounded-full bg-[#FFF4E5] px-2 py-0.5 text-[10.5px] font-bold text-[#A85B00]">
                follow up
              </span>
            )}
          </div>

          <p className="mt-0.5 truncate text-[12.5px] text-[#6E6E73]">
            {[contact.role || contact.headline, contact.company].filter(Boolean).join(' · ') ||
              'No role or company recorded'}
          </p>

          <p className="mt-0.5 text-[12px] text-[#8E8E93]">
            {/* Where you met them — the most valuable column on a combined list, and the reason
                the list route joins folder names rather than emitting a bare folderId. */}
            {contact.folderName ? (
              <Link href={`/folders/${contact.folderId}`} className="hover:underline">
                {contact.folderName}
              </Link>
            ) : (
              <span title="The folder this person was in has been deleted">Folder gone</span>
            )}
            {contact.folderEventDate ? ` · ${dayHeading(contact.folderEventDate)}` : ''}
          </p>

          {(contact.companies.length > 0 || contact.tags.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {/* Registry companies and user tags are visually distinct — blue for resolved,
                  grey for typed — because trusting them equally is the mistake. */}
              {contact.companies.map(name => (
                <button
                  key={`c:${name}`}
                  type="button"
                  onClick={() => onPickCompany(name)}
                  className="rounded-full bg-[#EBF4FE] px-2 py-0.5 text-[10.5px] font-bold text-[#0058B0] hover:bg-[#D6E7FB]"
                >
                  {name}
                </button>
              ))}
              {contact.tags.map(t => (
                <button
                  key={`t:${t}`}
                  type="button"
                  onClick={() => onPickTag(t)}
                  className="rounded-full bg-[#F5F5F7] px-2 py-0.5 text-[10.5px] font-bold text-[#6E6E73] hover:bg-[#EEEEF0]"
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>

        {contact.linkedin && (
          <a
            href={contact.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${contact.name} on LinkedIn`}
            className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#F7F7F9] text-[#0071E3] hover:bg-[#EEEEF0]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
              open_in_new
            </span>
          </a>
        )}
      </div>
    </Card>
  );
}
