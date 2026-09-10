'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import FacetRail, { FacetToggle } from '../components/FacetRail';
import MergeSheet from './MergeSheet';
import { Banner, Button, ButtonLink, Card, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { dayHeading, relativeTime, shortDateIST } from '@/lib/format';
import {
  INTERACTION_ICON,
  INTERACTION_LABEL,
  personSubtitle,
  type InteractionDTO,
  type MergePair,
  type PersonDTO,
  type PersonFacets,
} from '@/lib/person-types';

/**
 * EVERYONE YOU HAVE MET — one card per HUMAN, with their history inside it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED, AND WHY IT IS NOT A RESKIN. This page used to list `Contact` — CAPTURES, not people.
 * The same human met three times was three cards, with three notes and three follow-up dates, and
 * the entire product surface for the duplicate `contactKey` had detected was a `met 3 x` badge.
 *
 * It now lists `Person`. Three consequences, each of which was previously impossible:
 *
 *   · ONE CARD PER HUMAN, with the encounters collapsed INSIDE it. The owner's instruction was
 *     precisely this: "than making 3 card we can add them like history or met before in the card
 *     section that make it clean". So the history is a disclosure in the card, not a second page and
 *     not three cards.
 *   · THE ROW OPENS. `/people/[id]` exists, and the summary block is a link to it. Before this the
 *     only contact editor lived inside `app/folders/[id]/page.tsx`, so correcting a misread name
 *     meant remembering which event you met them at.
 *   · "MET MORE THAN ONCE" IS ONE PREDICATE. On `Contact` it was a two-stage query, and the first
 *     attempt post-filtered the page — so the list narrowed to two rows under a heading that read
 *     "6 people", because `countDocuments` had run against the unfiltered filter.
 *
 * THE FILTER STATE LIVES IN THE URL. It was React state only, which broke three things at once: a
 * filtered view could not be shared, it did not survive a reload, and — now that rows navigate — it
 * was destroyed by pressing Back from a person. `replaceState` rather than `pushState`, following the
 * feed: filtering is exploratory, and an entry per chip means twelve Back presses to leave the page.
 * A URL that is CORRECT when copied matters far more than one that is undoable.
 *
 * SELECTION IS AN EXPLICIT MODE, and that answers a genuine conflict rather than a preference. A card
 * cannot be both a checkbox target and a link target: nesting a control inside an anchor is invalid
 * HTML, and the alternative — an absolutely-positioned link overlay with `pointer-events` juggling —
 * wrecks focus order. So "Select" switches the rows from links to selection targets, reveals the bulk
 * bar, and Escape or Cancel leaves. One mode, one meaning per tap.
 *
 * BULK TAGGING IS PERSON-LEVEL, through `POST /api/people/tags`. The old bar wrote to
 * `/api/contacts/tags` with CAPTURE ids, which this page no longer has. Doing it as a loop of PATCHes
 * from here would be forty requests each running a full recompute, any of which can fail halfway with
 * no way for the user to tell which half landed; the route does the whole batch in three queries.
 *
 * THE CSV EXPORT GOES THROUGH `/api/people/export`, which shares `buildPersonFilter` with the list —
 * so what downloads is what is on screen. It is fetched rather than linked, because a bare `<a>` turns
 * a 500 into a raw error page and loses the filtered view. Both are documented defects it avoids.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

const EMPTY_FACETS: PersonFacets = {
  total: 0,
  companies: [],
  tags: [],
  tagVocabulary: [],
  targetCount: 0,
  followUpCount: 0,
  repeatCount: 0,
};

type Sort = 'recent' | 'oldest' | 'name' | 'company' | 'followUp' | 'met';

const SORT_OPTIONS: Array<{ value: Sort; label: string }> = [
  { value: 'recent', label: 'Last contacted' },
  { value: 'followUp', label: 'Follow-up due' },
  { value: 'met', label: 'Met most often' },
  { value: 'name', label: 'Name' },
  { value: 'company', label: 'Company' },
  { value: 'oldest', label: 'Gone quiet longest' },
];

const DEFAULT_SORT: Sort = 'recent';

export default function PeoplePage() {
  const [people, setPeople] = useState<PersonDTO[]>([]);
  const [facets, setFacets] = useState<PersonFacets>(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Filters — every one of these is mirrored into the URL below.
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [company, setCompany] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [targetOnly, setTargetOnly] = useState(false);
  const [followUpDue, setFollowUpDue] = useState(false);
  const [repeatOnly, setRepeatOnly] = useState(false);
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);

  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextSkip, setNextSkip] = useState(0);

  const [pairs, setPairs] = useState<MergePair[]>([]);
  const [mergeOpen, setMergeOpen] = useState(false);

  /** Which cards have their history open. Per-card, so opening one does not open forty. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  /**
   * SELECTION MODE. Off by default, because the common intent on this page is to open somebody.
   * While it is on, a card is a selection target rather than a link — see the file header for why that
   * has to be a mode and not an overlay.
   */
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkTag, setBulkTag] = useState('');
  const [tagging, setTagging] = useState(false);
  const [exporting, setExporting] = useState(false);

  /**
   * READ THE URL ONCE, BEFORE ANY WRITE.
   *
   * The guard is not ceremony: the writer effect runs on mount too, and without it the first render
   * would overwrite a shared link's parameters with the empty defaults — so opening somebody's
   * filtered link would erase the filter before it was ever applied.
   */
  const hydrated = useRef(false);
  useEffect(() => {
    const timer = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);
      const initialQ = p.get('q') ?? '';
      if (initialQ) {
        setQ(initialQ);
        // Set the debounced value too, or the first fetch runs unfiltered and the results visibly
        // change under the user a quarter of a second after the page opens.
        setDebouncedQ(initialQ);
      }
      if (p.get('company')) setCompany(p.get('company'));
      if (p.get('tag')) setTag(p.get('tag')!.toLowerCase());
      if (p.get('targetOnly') === 'true') setTargetOnly(true);
      if (p.get('followUpDue') === 'true') setFollowUpDue(true);
      if (p.get('repeatOnly') === 'true') setRepeatOnly(true);
      const urlSort = p.get('sort') as Sort | null;
      if (urlSort && SORT_OPTIONS.some(o => o.value === urlSort)) setSort(urlSort);
      hydrated.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Debounced, so typing does not fire a request per keystroke. 250 ms matches the feed's search.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(timer);
  }, [q]);

  /** Mirror the view into the URL. Only non-default values, so a clean view stays a clean `/people`. */
  useEffect(() => {
    if (!hydrated.current) return;
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (company) p.set('company', company);
    if (tag) p.set('tag', tag);
    if (targetOnly) p.set('targetOnly', 'true');
    if (followUpDue) p.set('followUpDue', 'true');
    if (repeatOnly) p.set('repeatOnly', 'true');
    // Tracks the DEFAULT constant rather than a hardcoded string. Inline the literal and a later
    // change to the default silently inverts this: the default gets written and the non-default
    // dropped, which is how `/` once rendered a ranked feed while the URL claimed nothing.
    if (sort !== DEFAULT_SORT) p.set('sort', sort);

    const qs = p.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [debouncedQ, company, tag, targetOnly, followUpDue, repeatOnly, sort]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (debouncedQ) p.set('q', debouncedQ);
    if (company) p.set('company', company);
    if (tag) p.set('tag', tag);
    if (targetOnly) p.set('targetOnly', 'true');
    if (followUpDue) p.set('followUpDue', 'true');
    if (repeatOnly) p.set('repeatOnly', 'true');
    p.set('sort', sort);
    return p;
  }, [debouncedQ, company, tag, targetOnly, followUpDue, repeatOnly, sort]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Both in one round trip, so the rows and the counts beside them describe the same moment.
      const [listRes, facetRes] = await Promise.all([
        fetch(`/api/people?${params}`),
        fetch(`/api/people/facets?${params}`),
      ]);
      if (!listRes.ok) throw new Error(`HTTP ${listRes.status}`);
      const list = await listRes.json();
      setPeople(list.people ?? []);
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

  /**
   * Duplicate suggestions, fetched ONCE rather than on every filter change.
   *
   * "Are two of these the same person" is a property of the whole collection, not of the current
   * filter — a duplicate hidden by a company chip is still a duplicate. Refetching it per keystroke
   * would also mean running the shared-key aggregate on every letter typed into the search box.
   */
  const loadPairs = useCallback(async () => {
    try {
      const res = await fetch('/api/people/merge');
      if (!res.ok) return;
      const data = await res.json();
      setPairs(Array.isArray(data.pairs) ? data.pairs : []);
    } catch {
      /* A missing suggestion banner is not worth an error state. */
    }
  }, []);

  // Deferred with a zero timeout for the same reason the list fetch above is: `react-hooks/
  // set-state-in-effect` refuses a setState reached synchronously from an effect body, and every
  // fetching page in this repo defers instead of disabling the rule.
  useEffect(() => {
    const timer = setTimeout(() => void loadPairs(), 0);
    return () => clearTimeout(timer);
  }, [loadPairs]);

  /**
   * Escape leaves selection mode.
   *
   * Every other dismissible surface here answers Escape — `Sheet` does it by hand, because the pattern
   * it replaced did not until it was fixed — and a mode with no keyboard exit is a trap for anyone not
   * using a mouse. Bound at the document, because the rows do not contain focus.
   */
  useEffect(() => {
    if (!selecting) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setSelecting(false);
      setSelected(new Set());
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selecting]);

  const activeFilters = Boolean(
    debouncedQ || company || tag || targetOnly || followUpDue || repeatOnly
  );

  function clearAll() {
    setQ('');
    setCompany(null);
    setTag(null);
    setTargetOnly(false);
    setFollowUpDue(false);
    setRepeatOnly(false);
  }

  /**
   * Picking the follow-up sort turns the follow-up FILTER on with it.
   *
   * `buildPersonSort('followUp')` is `{ nextActionAt: 1 }`, and ascending Mongo order puts NULLS
   * FIRST — so on its own that sort leads with everybody who has no follow-up at all, the exact
   * opposite of what the label promises. `lib/people/query.ts` deliberately does not fold the filter
   * into the sort (a sort that silently changes the result set is worse), which makes pairing them
   * this UI's job.
   */
  function pickSort(next: Sort) {
    setSort(next);
    if (next === 'followUp') setFollowUpDue(true);
  }

  async function loadMore() {
    setLoadingMore(true);
    try {
      const more = new URLSearchParams(params);
      more.set('skip', String(nextSkip));
      const res = await fetch(`/api/people?${more}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // Deduped by id: a person written between page 1 and page 2 shifts the offset and would
      // otherwise appear twice — a real hazard on a page whose data is still being captured.
      setPeople(current => {
        const seen = new Set(current.map(p => p._id));
        return [...current, ...(data.people ?? []).filter((p: PersonDTO) => !seen.has(p._id))];
      });
      setHasMore(Boolean(data.hasMore));
      setNextSkip(data.nextSkip ?? nextSkip);
    } catch {
      setError('Could not load more.');
    } finally {
      setLoadingMore(false);
    }
  }

  function flash(message: string) {
    setNotice(message);
    setTimeout(() => setNotice(null), 5000);
  }

  function leaveSelection() {
    setSelecting(false);
    setSelected(new Set());
    setBulkTag('');
  }

  /**
   * Apply or remove one tag across everybody selected, in a SINGLE request.
   *
   * The route reports `matched` separately from `requested`, and the gap is worth surfacing: an id that
   * has become a merge tombstone since the page loaded does not match the route's scoped filter, and
   * silently tagging fewer people than were named is how somebody stops trusting the feature.
   */
  async function applyBulkTag(mode: 'add' | 'remove') {
    const value = bulkTag.trim();
    if (!value || !selected.size) return;
    setTagging(true);
    setError(null);
    try {
      const res = await fetch('/api/people/tags', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personIds: [...selected], [mode]: [value] }),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        // The route names the field it refused; showing that beats a generic apology.
        setError(
          typeof data.error === 'string' ? data.error : `Could not apply that (${res.status}).`
        );
        return;
      }
      const tagged = Number(data.tagged ?? 0);
      const matched = Number(data.matched ?? 0);
      const requested = Number(data.requested ?? selected.size);
      flash(
        `${mode === 'add' ? 'Tagged' : 'Untagged'} ${tagged} ${
          tagged === 1 ? 'person' : 'people'
        } "${value.toLowerCase()}".` +
          (matched < requested
            ? ` ${requested - matched} could not be found — they may have been merged.`
            : '')
      );
      leaveSelection();
      await load();
    } catch {
      setError('Could not reach the server. Nothing was changed.');
    } finally {
      setTagging(false);
    }
  }

  /**
   * Download the CSV — as a FETCH, not a bare `<a href>`.
   *
   * The anchor version is a documented defect on the folder export: a 500 navigates the browser to a
   * raw error page and the user loses the filtered view they were looking at. Fetching keeps the
   * failure on this page, gives the button a real pending state, and lets the error be a sentence.
   *
   * The query string is `params` VERBATIM — the same object the list and the facets are fetched with —
   * which is what makes "exactly what is on screen" true by construction rather than by intention.
   */
  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const res = await fetch(`/api/people/export?${params}`);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError(typeof data.error === 'string' ? data.error : `Could not export (${res.status}).`);
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // The server sends a `Content-Disposition` filename, but a blob URL carries no name of its own,
      // so it has to be restated or the browser saves a random id with no extension.
      link.download = 'people.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Revoked on the next tick, not immediately: revoking before the click has been handled cancels
      // the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      flash('Export downloaded.');
    } catch {
      setError('Could not reach the server, so nothing was downloaded.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <AppShell title="People">
      <div className="mx-auto max-w-[1100px] px-4 pt-4 md:px-8">
        <PageHeader
          title="Everyone you've met"
          subtitle="One card per person, with every time you met them inside it. Filter by employer, by your own tags, or by who still needs a reply."
          action={
            <div className="flex flex-wrap items-center gap-2">
              {/*
                THE MODE SWITCH. Only offered when there is something to select — a "Select" button
                over an empty list is a control that cannot do anything, and the empty state already
                says what to do instead.
              */}
              {people.length > 0 && (
                <Button
                  tone="quiet"
                  icon={selecting ? 'close' : 'checklist'}
                  onClick={() => (selecting ? leaveSelection() : setSelecting(true))}
                  aria-pressed={selecting}
                >
                  {selecting ? 'Done selecting' : 'Select'}
                </Button>
              )}
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

        {/*
          THE DUPLICATE BANNER. Detection existed long before this — `contactKey` has always found
          these — and there was no route, no UI and no service call to act on it, so the same human
          stayed three rows. Nothing is merged automatically: a wrong merge destroys the distinction
          between two real people and is hard to unwind, while an un-merged duplicate is untidy.
        */}
        {pairs.length > 0 && (
          <div className="mb-4">
            <Card padding="tight">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[#1D1D1F]">
                    {pairs.length === 1
                      ? 'Two records might be the same person'
                      : `${pairs.length} possible duplicates`}
                  </p>
                  <p className="mt-0.5 text-[12.5px] text-[#6E6E73]">
                    They share an identity key. Nothing was merged — have a look and decide.
                  </p>
                </div>
                <Button size="sm" tone="primary" icon="merge" onClick={() => setMergeOpen(true)}>
                  Review
                </Button>
              </div>
            </Card>
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
              placeholder="Name, company, or role"
              aria-label="Search people"
              className="h-11 w-full rounded-xl bg-white pl-10 pr-3 text-[14.5px] text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
            />
          </div>
          <select
            value={sort}
            onChange={e => pickSort(e.target.value as Sort)}
            aria-label="Sort people"
            className="h-11 rounded-xl bg-white px-3 text-[13.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
          >
            {SORT_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        {/* ── Toggles ───────────────────────────────────────────────────── */}
        <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <FacetToggle
            label="Target companies"
            count={facets.targetCount}
            active={targetOnly}
            onClick={() => setTargetOnly(v => !v)}
          />
          <FacetToggle
            label="Follow-up due"
            count={facets.followUpCount}
            active={followUpDue}
            onClick={() => setFollowUpDue(v => !v)}
          />
          <FacetToggle
            label="Met more than once"
            count={facets.repeatCount}
            active={repeatOnly}
            onClick={() => setRepeatOnly(v => !v)}
          />
          {activeFilters && (
            <button
              type="button"
              onClick={clearAll}
              className="relative h-9 rounded-full px-3 text-[12.5px] font-semibold text-[#0071E3] hover:underline [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
            >
              Clear filters
            </button>
          )}
        </div>

        {/* ── Two rails, deliberately not merged ────────────────────────── */}
        <FacetRail
          title="Company"
          hint="Recognised employers, resolved from what people told you."
          buckets={facets.companies}
          selected={company}
          onSelect={setCompany}
        />
        <FacetRail
          title="Your tags"
          hint="Your own labels — for employers we don't recognise, and anything else."
          buckets={facets.tags}
          extra={facets.tagVocabulary
            .filter(t => !facets.tags.some(b => b.value === t))
            .map(t => ({ value: t, count: 0 }))}
          selected={tag}
          onSelect={setTag}
        />

        {/* ── Bulk bar — only in selection mode, and only with a selection ─ */}
        {selecting && selected.size > 0 && (
          /* Sticky under the mobile header so it stays reachable while scrolling a long list. */
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
                    if (e.key === 'Enter') void applyBulkTag('add');
                  }}
                  list="people-tag-vocabulary"
                  maxLength={40}
                  placeholder="Tag them all…"
                  aria-label="Tag for the selected people"
                  className="h-11 min-w-[160px] flex-1 rounded-full bg-[#F7F7F9] px-3.5 text-[13.5px] text-[#1D1D1F] outline-none focus:shadow-[inset_0_0_0_2px_var(--blue)]"
                />
                {/* Native datalist rather than a bespoke popover: it is a one-field type-ahead, and
                    the browser's own affordance beats a hand-rolled one. */}
                <datalist id="people-tag-vocabulary">
                  {facets.tagVocabulary.map(t => (
                    <option key={t} value={t} />
                  ))}
                </datalist>
                <Button
                  size="sm"
                  tone="primary"
                  onClick={() => void applyBulkTag('add')}
                  disabled={tagging || !bulkTag.trim()}
                >
                  {tagging ? 'Working…' : 'Apply tag'}
                </Button>
                {/* Remove sits beside Apply because the two are the same gesture with the same input,
                    and a bulk tag applied by mistake to forty people needs an equally cheap undo. */}
                <Button
                  size="sm"
                  tone="quiet"
                  onClick={() => void applyBulkTag('remove')}
                  disabled={tagging || !bulkTag.trim()}
                >
                  Remove tag
                </Button>
                <Button size="sm" tone="quiet" onClick={leaveSelection} disabled={tagging}>
                  Cancel
                </Button>
              </div>
            </Card>
          </div>
        )}

        {/* ── Results ───────────────────────────────────────────────────── */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-[12.5px] text-[#6E6E73]">
            {loading ? (
              'Loading…'
            ) : selecting ? (
              <>
                <strong className="tnum text-[#1D1D1F]">{selected.size}</strong> of{' '}
                <span className="tnum">{people.length}</span> selected — tap a card to pick it,
                Escape to stop
              </>
            ) : (
              <>
                <strong className="tnum text-[#1D1D1F]">{total}</strong>{' '}
                {total === 1 ? 'person' : 'people'}
                {activeFilters ? ' match' : ''}
              </>
            )}
          </p>
          {/*
            EXPORTS WHAT IS ON SCREEN, because `/api/people/export` is driven by the same `params`
            object and the same `buildPersonFilter` as the list above it. The old link pointed at
            `/api/contacts/export`, which filters CAPTURES — a different result set, one row per scan
            rather than per human, handed over with every appearance of having worked.
          */}
          {people.length > 0 && (
            <Button
              size="sm"
              tone="quiet"
              icon="download"
              onClick={() => void exportCsv()}
              disabled={exporting}
            >
              {exporting ? 'Preparing…' : 'Export CSV'}
            </Button>
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
        ) : people.length === 0 ? (
          <EmptyState
            icon="group"
            title={activeFilters ? 'Nobody matches that' : 'No people yet'}
            body={
              activeFilters
                ? 'Try a different filter, or clear them all.'
                : 'Confirm an event in the tracker to get a folder, then scan somebody’s LinkedIn QR into it. Everyone you capture lands here as one card, however many times you meet them.'
            }
            action={
              activeFilters ? (
                <Button tone="quiet" onClick={clearAll}>
                  Clear filters
                </Button>
              ) : (
                <div className="flex flex-wrap justify-center gap-2">
                  <ButtonLink href="/scan" tone="primary" icon="qr_code_scanner">
                    Open the scanner
                  </ButtonLink>
                  <ButtonLink href="/folders" tone="quiet" icon="folder">
                    See your folders
                  </ButtonLink>
                </div>
              )
            }
          />
        ) : (
          <>
            <div className="flex flex-col gap-2">
              {people.map(person => (
                <PersonCard
                  key={person._id}
                  person={person}
                  selecting={selecting}
                  selected={selected.has(person._id)}
                  onSelect={() =>
                    setSelected(current => {
                      const next = new Set(current);
                      if (next.has(person._id)) next.delete(person._id);
                      else next.add(person._id);
                      return next;
                    })
                  }
                  open={expanded.has(person._id)}
                  onToggle={() =>
                    setExpanded(current => {
                      const next = new Set(current);
                      if (next.has(person._id)) next.delete(person._id);
                      else next.add(person._id);
                      return next;
                    })
                  }
                  onPickCompany={setCompany}
                  onPickTag={setTag}
                />
              ))}
            </div>
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button tone="quiet" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load more (${total - people.length} left)`}
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
              list. When somebody works somewhere we don&apos;t recognise, tag them on their own page
              — or select several and tag them all at once. Those tags stay yours and are never fed
              back into the employer registry.
            </p>
          </Card>
        </div>
      </div>

      <MergeSheet
        open={mergeOpen}
        pairs={pairs}
        onClose={() => {
          setMergeOpen(false);
          void loadPairs();
        }}
        onMerged={message => {
          flash(message);
          void load();
          void loadPairs();
        }}
        onDismissed={message => {
          flash(message);
          void loadPairs();
        }}
      />
    </AppShell>
  );
}

/**
 * ONE HUMAN, WITH THEIR HISTORY INSIDE.
 *
 * The summary block is ONE target and the disclosure is a sibling button, rather than the whole card
 * being a link with an interactive control nested in it. Nesting a button inside an anchor is invalid
 * HTML and behaves differently in every browser; the alternative — an absolutely-positioned link
 * overlay with `pointer-events` juggling — wrecks focus order. Two sibling targets, each comfortably
 * past 44px, is the boring correct answer.
 *
 * WHAT THAT SUMMARY TARGET *IS* DEPENDS ON THE MODE, which is the same constraint read from the other
 * end. Normally it is a `Link` to the person. In selection mode it is a checkbox-shaped `button`, and
 * the LinkedIn shortcut is withdrawn — a second, competing target inside a row whose whole job has
 * just become "pick me" is how somebody selecting forty people ends up on linkedin.com instead.
 */
function PersonCard({
  person,
  selecting,
  selected,
  onSelect,
  open,
  onToggle,
  onPickCompany,
  onPickTag,
}: {
  person: PersonDTO;
  selecting: boolean;
  selected: boolean;
  onSelect: () => void;
  open: boolean;
  onToggle: () => void;
  onPickCompany: (value: string) => void;
  onPickTag: (value: string) => void;
}) {
  const followUpDue = Boolean(person.nextActionAt);
  const overdue = followUpDue && new Date(person.nextActionAt as string) <= new Date();
  const history = person.recent ?? [];
  const subtitle = personSubtitle(person);

  // Extracted so the two wrappers below render the IDENTICAL summary. Two copies would drift, and the
  // one that drifts is always the mode you look at less often.
  const summary = (
    <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h2 className="t-sub truncate text-[#1D1D1F]">{person.displayName}</h2>
            {/*
              `met N x` MEANS N DISTINCT EVENTS — not N captures and not N folders.
              `detectRepeatConnections` carries that bug's scar: it keyed on the folder, so two
              folders for one event counted as two events. A badge that flatters is worse than none.
            */}
            {person.eventCount > 1 && (
              <span className="rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[10.5px] font-bold text-[#1D8A44]">
                met {person.eventCount}×
              </span>
            )}
            {person.isTargetCompany && (
              <span className="rounded-full bg-[#EBF7EF] px-2 py-0.5 text-[10.5px] font-bold text-[#1D8A44]">
                target
              </span>
            )}
            {followUpDue && (
              <span
                className={`rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                  overdue ? 'bg-[#FFF1F0] text-[#C7362D]' : 'bg-[#FFF4E5] text-[#A85B00]'
                }`}
              >
                {overdue ? 'follow up now' : `follow up ${shortDateIST(person.nextActionAt as string)}`}
              </span>
            )}
          </div>

          <p className="mt-0.5 truncate text-[12.5px] text-[#6E6E73]">
            {subtitle || 'No role or company recorded'}
          </p>

          <p className="mt-0.5 text-[12px] text-[#8E8E93]">
            {person.lastInteractionAt ? (
              // The date NO COMPETITOR SHOWS AT ANY PRICE, and which did not exist in this schema
              // until the spine: `max(Interaction.at)`, not capture time. A note or a completed
              // follow-up is contact too.
              <span title={dayHeading(person.lastInteractionAt)}>
                Last contact {relativeTime(person.lastInteractionAt)}
              </span>
            ) : (
              <span>No contact recorded yet</span>
            )}
          </p>
    </>
  );

  return (
    <Card
      padding="tight"
      className={selected ? 'shadow-[inset_0_0_0_2px_var(--blue)]' : undefined}
    >
      <div className="flex items-start gap-3">
        {selecting ? (
          <button
            type="button"
            // `aria-pressed`, not a hidden `<input type="checkbox">`: the row IS the control, and a
            // real checkbox would be a second focus stop inside it saying the same thing.
            aria-pressed={selected}
            onClick={onSelect}
            className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left outline-none [touch-action:manipulation] focus-visible:shadow-[0_0_0_2px_var(--blue)]"
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-[6px] ${
                selected
                  ? 'bg-[#0071E3] text-white'
                  : 'bg-white shadow-[inset_0_0_0_1.5px_var(--hairline-strong)]'
              }`}
            >
              {selected && (
                <span className="material-symbols-outlined text-[15px] leading-none">check</span>
              )}
            </span>
            <span className="min-w-0 flex-1">{summary}</span>
          </button>
        ) : (
          // The whole summary is the link, so the tap target is the card's full width.
          <Link
            href={`/people/${person._id}`}
            className="min-w-0 flex-1 rounded-lg outline-none focus-visible:shadow-[0_0_0_2px_var(--blue)]"
          >
            {summary}
          </Link>
        )}

        {person.linkedin && !selecting && (
          <a
            href={person.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${person.displayName} on LinkedIn`}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-[#F7F7F9] text-[#0071E3] hover:bg-[#EEEEF0] [touch-action:manipulation]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
              open_in_new
            </span>
          </a>
        )}
      </div>

      {(person.companies.length > 0 || person.tags.length > 0) && (
        <div className="mt-2 flex flex-wrap gap-x-1.5 gap-y-2">
          {/* Registry companies and user tags stay visually distinct — blue for resolved, grey for
              typed — because trusting them equally is the mistake this feature was built to avoid. */}
          {person.companies.map(name => (
            <button
              key={`c:${name}`}
              type="button"
              onClick={() => onPickCompany(name)}
              className="relative rounded-full bg-[#EBF4FE] px-2 py-1 text-[10.5px] font-bold text-[#0058B0] hover:bg-[#D6E7FB] [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
            >
              {name}
            </button>
          ))}
          {person.tags.map(t => (
            <button
              key={`t:${t}`}
              type="button"
              onClick={() => onPickTag(t)}
              className="relative rounded-full bg-[#F5F5F7] px-2 py-1 text-[10.5px] font-bold text-[#6E6E73] hover:bg-[#EEEEF0] [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {/*
        THE HISTORY, COLLAPSED IN PLACE — a disclosure, NOT a navigation.
        Three cards for one human is the defect the spine removes; sending the reader to another page
        to find out they met somebody twice would move the problem rather than solve it.
      */}
      {history.length > 0 && (
        <div className="mt-2 border-t border-[color:var(--hairline)] pt-2">
          <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="relative flex h-9 w-full items-center gap-1.5 rounded-lg text-left text-[12px] font-semibold text-[#0071E3] [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
          >
            <span
              aria-hidden="true"
              className={`material-symbols-outlined text-[16px] transition-transform ${
                open ? 'rotate-180' : ''
              }`}
            >
              expand_more
            </span>
            {open ? 'Hide history' : summarise(person, history)}
          </button>

          {open && (
            <ul className="mt-1 flex flex-col gap-1.5">
              {history.map(item => (
                <li key={item._id} className="flex items-start gap-2 text-[12px] text-[#6E6E73]">
                  <span
                    aria-hidden="true"
                    className="material-symbols-outlined mt-[1px] text-[14px] text-[#A1A1A6]"
                  >
                    {INTERACTION_ICON[item.kind]}
                  </span>
                  <span className="min-w-0">
                    <span className="font-semibold text-[#1D1D1F]">
                      {INTERACTION_LABEL[item.kind]}
                    </span>
                    {item.eventId && (
                      // Nullable on purpose: `pruneStale()` deletes events 7 days past without
                      // touching their references, so a dangling id is normal rather than corruption.
                      <> at {item.eventTitle ?? 'an event we no longer have'}</>
                    )}
                    {item.note && <> — {item.note}</>}
                    <span className="text-[#A1A1A6]"> · {shortDateIST(item.at)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/** The collapsed line: what the history says without opening it. */
function summarise(person: PersonDTO, history: InteractionDTO[]): string {
  const events = history.filter(i => i.eventId).length;
  if (person.eventCount > 1) return `History — met at ${person.eventCount} events`;
  if (events > 0) return 'History — where you met';
  return `History — ${person.interactionCount} ${person.interactionCount === 1 ? 'entry' : 'entries'}`;
}
