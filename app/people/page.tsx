'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import AppShell from '../components/AppShell';
import FacetRail, { FacetToggle } from '../components/FacetRail';
import MergeSheet, { sharedKeyEvidence } from './MergeSheet';
import { Banner, Button, ButtonLink, Skeleton } from '../components/ui';
import { dayHeading, monogram, relativeTime, shortDateIST } from '@/lib/format';
import {
  INTERACTION_ICON,
  INTERACTION_LABEL,
  personIdentityLine,
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
   * While it is on, a row is a selection target rather than a link — see the file header for why that
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
        {/*
          THE HEADING IS SANS, AND THAT IS THE SEMANTIC RULE RATHER THAN A PREFERENCE. "Everyone
          you've met" is the PRODUCT naming one of its own surfaces, so it takes `.ty-section`;
          the serif is reserved for things that exist in the city, which on this page means the
          people's names in the rows below. A serif page title would put the app's voice and the
          city's content in the same face and spend the distinction the whole system rests on.
        */}
        <div className="mb-[var(--s-6)] flex flex-wrap items-start justify-between gap-[var(--s-4)]">
          {/* `max-w-[62ch]` on the text and NO `shrink-0` on the actions, measured rather than
              guessed: with `shrink-0` the three buttons in selection mode kept their max-content
              width and pushed the document to 419px in a 390px viewport — a sideways scroll on the
              page's own header. Without it the group shrinks, its inner row wraps, and the cap keeps
              the two halves on one line from 768 up so the actions still sit top-right. */}
          <div className="min-w-0 basis-full md:max-w-[62ch] md:basis-auto">
            <h1 className="ty-section text-[var(--ink)]">Everyone you&apos;ve met</h1>
            {/* Names the three things a ROW now actually carries. It said "card" while the rows were
                cards; they are hairline-ruled rows now, and copy that describes the old shape is the
                cheapest kind of drift. */}
            <p className="mt-[var(--s-2)] ty-body text-[color:var(--ink-2)] max-w-[62ch]">
              One row per person — where you met them, what you wrote down, and who still needs a
              reply.
            </p>
          </div>
          <div className="min-w-0">
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
          </div>
        </div>

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

          A TONE IS THE INK PLUS A LEFT RULE ON THE PAPER GROUND — `Banner` in `ui.tsx`, copied
          rather than approximated, because there is no tint layer in nine values. It cannot BE a
          `Banner`: this one carries an action, and `Banner` takes only text children.
        */}
        {pairs.length > 0 && (
          <div className="mb-[var(--s-4)] border-l-2 border-[var(--accent)] bg-[var(--paper)] px-[var(--s-4)] py-[var(--s-3)]">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-[color:var(--ink)]">
                    {pairs.length === 1
                      ? 'Are two of these the same person?'
                      : `Are ${pairs.length} of these the same people?`}
                  </p>
                  {/*
                    A QUESTION, AND IT NAMES WHAT MATCHED. The spine deliberately refuses to auto-join,
                    so the only honest framing is a question — and "they share an identity key" is
                    evidence a reader cannot weigh, which is the whole decision being asked of them. A
                    shared LinkedIn slug is near-proof; a shared NAME is the exact failure `contactKey`
                    was invented to stop (two people called Rahul at one event), so the banner leads with
                    the strongest match it has and `sharedKeyEvidence` grades it in the sheet.
                  */}
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-[color:var(--ink-2)]">
                    {pairs.length === 1
                      ? `Two records carry ${sharedKeyEvidence(pairs[0].contactKey).what}.`
                      : 'Some records point at the same person.'}{' '}
                    Nothing was merged — a wrong merge is far harder to undo than a duplicate.
                  </p>
                </div>
                <Button size="sm" tone="primary" icon="merge" onClick={() => setMergeOpen(true)}>
                  Have a look
                </Button>
              </div>
          </div>
        )}

        {/* ── Search + sort ─────────────────────────────────────────────── */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[220px] flex-1">
            <span
              aria-hidden="true"
              className="material-symbols-outlined pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[18px] text-[color:var(--ink-3)]"
            >
              search
            </span>
            <input
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Name, company, or role"
              aria-label="Search people"
              className="h-11 w-full r-touch bg-[var(--surface)] pl-10 pr-3 text-[14.5px] text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]"
            />
          </div>
          <select
            value={sort}
            onChange={e => pickSort(e.target.value as Sort)}
            aria-label="Sort people"
            className="h-11 r-touch bg-[var(--surface)] px-3 text-[13.5px] font-semibold text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]"
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
              className="relative h-9 r-touch px-3 ty-meta font-semibold text-[color:var(--accent)] hover:underline [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
            >
              Clear filters
            </button>
          )}
        </div>

        {/*
          TWO RAILS, DELIBERATELY NOT MERGED — and now visually distinguishable without reading the
          titles. `kind` picks the chip treatment: a registry employer is BOUNDED (an edge, because it
          came from a defined list), a tag the user typed is FILLED and prefixed with `#`. One rail would
          be less code and would destroy exactly the distinction this feature was built to keep.
        */}
        <FacetRail
          title="Company"
          hint="Employers we recognised from what people told you"
          buckets={facets.companies}
          selected={company}
          onSelect={setCompany}
        />
        <FacetRail
          title="Your tags"
          kind="own"
          hint="Your own labels, for everything the registry can't know"
          buckets={facets.tags}
          extra={facets.tagVocabulary
            .filter(t => !facets.tags.some(b => b.value === t))
            .map(t => ({ value: t, count: 0 }))}
          selected={tag}
          onSelect={setTag}
        />

        {/* ── Bulk bar — only in selection mode, and only with a selection ─ */}
        {selecting && selected.size > 0 && (
          /* Sticky under the mobile header (`--topbar-h`), so it stays reachable while scrolling a
             long list. It does NOT take `.sticky-bar`: that class carries `--shadow-sticky`, whose
             blur is thrown UPWARD for a bottom bar, so on a top-sticky element it is invisible and
             still spends the codebase's one shadow. A hairline underneath does the same job. */
          <div className="sticky top-[var(--topbar-h)] z-20 mb-[var(--s-3)] rule-b bg-[var(--surface)] px-[var(--s-4)] py-[var(--s-3)]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[13px] font-semibold text-[color:var(--ink)]">
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
                  className="h-11 min-w-[160px] flex-1 r-touch bg-[var(--paper)] px-3.5 text-[13.5px] text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)] outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]"
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
          </div>
        )}

        {/* ── Results ───────────────────────────────────────────────────── */}
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <p className="ty-meta">
            {loading ? (
              'Loading…'
            ) : selecting ? (
              <>
                <strong className="tnum text-[color:var(--ink)]">{selected.size}</strong> of{' '}
                <span className="tnum">{people.length}</span> selected — tap a row to pick it,
                Escape to stop
              </>
            ) : (
              <>
                <strong className="tnum text-[color:var(--ink)]">{total}</strong>{' '}
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
          /* Skeletons, never a spinner — and shaped like the real card (identity tile, name, meta)
             so the list does not reflow the moment the rows land. */
          <div className="rule-t">
            {[0, 1, 2, 3, 4].map(i => (
              <div key={i} className="rule-b py-[var(--s-4)]">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-10 w-10 rounded-none" />
                  <div className="min-w-0 flex-1">
                    <Skeleton className="h-5 w-1/3" />
                    <Skeleton className="mt-2 h-3 w-1/2" />
                    <Skeleton className="mt-3 h-3 w-2/3" />
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : people.length === 0 ? (
          activeFilters ? (
            /* Flat and ruled rather than a centred card: a radius here would be the only rounded
               container on a page of hairline rows, and the icon-over-two-lines centred block is the
               generated default this system replaces. */
            <div className="rule-y py-[var(--s-8)]">
              <h2 className="ty-row-title text-[var(--ink)]">Nobody matches that</h2>
              <p className="mt-[var(--s-2)] ty-body max-w-[52ch] text-[color:var(--ink-2)]">
                Everyone you have met is still here — this combination of filters just has nobody in
                it.
              </p>
              <div className="mt-[var(--s-4)]">
                <Button tone="quiet" onClick={clearAll}>
                  Clear filters
                </Button>
              </div>
            </div>
          ) : (
            <NoPeopleYet />
          )
        ) : (
          <>
            {/*
              A REAL LIST, so a screen reader announces "40 items" and arrow-key navigation works. It
              used to be a stack of divs each containing an `<h2>` INSIDE a `<button>` — invalid HTML
              (a button takes phrasing content only), which is also why the card below is built out of
              spans rather than headings.
            */}
            {/* THE RULED LIST. `rule-t` on the container plus `rule-b` on each row draws one
                hairline between neighbours and closes the list at both ends; a gap and a card per row
                is what this replaces. */}
            <ul className="rule-t">
              {people.map(person => (
                <li key={person._id} className="rule-b">
                  <PersonRow
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
                </li>
              ))}
            </ul>
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button tone="quiet" onClick={() => void loadMore()} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Load more (${total - people.length} left)`}
                </Button>
              </div>
            )}
          </>
        )}

        {/*
          THE EXPLAINER IS CONDITIONAL NOW, and the condition is the point. It used to sit at the foot
          of the page on every visit, explaining a distinction the two rails above it already make —
          decoration, by the fourth visit. It earns its place only while the user has no tags at all,
          which is exactly when the "why are there two of these" question is live and the tag rail is
          absent (`FacetRail` renders nothing for an empty dimension, so there is nothing else on
          screen to answer it).
        */}
        {!loading && people.length > 0 && facets.tags.length === 0 && facets.tagVocabulary.length === 0 && (
          <div className="mt-[var(--s-12)] mb-[var(--s-4)] rule-t pt-[var(--s-4)]">
              <p className="ty-body max-w-[68ch] text-[13px] leading-relaxed text-[color:var(--ink-2)]">
                <strong className="text-[color:var(--ink)]">You can add your own tags.</strong> The company rail
                only knows the 375 Bengaluru employers in our registry. When somebody works somewhere it
                has never heard of — or you want to find &ldquo;the hardware people&rdquo; later — tag
                them on their own page, or select several here and tag them together. Your tags stay
                yours: they are never read back as employer evidence.
              </p>
          </div>
        )}
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

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   THE ROW, AND THE ONE QUESTION IT IS DESIGNED TO ANSWER
   ══════════════════════════════════════════════════════════════════════════════════════════════

   Not "display a contact record" — the question is: WHAT DOES A READER NEED TO RECALL SOMEBODY THEY
   MET ONCE, SIX WEEKS AGO, AT AN EVENT THEY HALF-REMEMBER? Three things, in this order:

     1. WHERE AND WHEN YOU MET THEM. This is the memory hook. It used to be hidden behind a disclosure
        labelled "History — met at 2 events", so the single most recall-bearing fact on the row cost a
        tap and the visible line was a label describing content nobody could see.

   IT IS A HAIRLINE-RULED ROW, NOT A CARD, and that is the Phase 3 change. Forty rounded surfaces
   floating on the page ground made the list read as forty objects; one hairline between neighbours
   reads as one list. The radius went with the shell: `--r-touch` (4px) now means "this responds",
   which is a claim a whole row-shaped container was making forty times over falsely.
     2. WHAT YOU WROTE DOWN. `person.recent` has carried the notes all along and the card rendered none
        of them. This is also the thing no competitor has at any price: aggregated Luma and Meetup
        listings are free, and nobody else holds your note about the person you met at them.
     3. WHO THEY ARE — name, role, employer. Necessary, and third, because a name alone does not place
        a stranger.

   Everything else recedes to a quiet tier. `docs/design-direction.md`: two levels of emphasis per
   card, not four. Level 1 is the name; level 2 is the encounter and the note; the rest is 12px grey.

   TWO STRUCTURAL TARGETS, NOT AN OVERLAY. The summary is one target and the disclosure is a sibling,
   because nesting a control inside an anchor is invalid HTML and the alternative — an absolutely
   positioned link with `pointer-events` juggling — wrecks focus order.

   WHAT THE SUMMARY TARGET *IS* DEPENDS ON THE MODE. Normally a `Link` to the person; in selection mode
   a checkbox-shaped `button`, with the LinkedIn shortcut withdrawn, because a second competing target
   in a row whose whole job has become "pick me" is how somebody selecting forty people lands on
   linkedin.com. Built out of `<span>`s throughout: a `<button>` takes phrasing content only, so the
   `<h2>` and `<p>` this used to nest inside one were invalid in the mode nobody inspects.
*/

/**
 * The identity tile: initials, in the display face, on the well grey.
 *
 * WHY A MONOGRAM IS INFORMATION HERE AND IS NOT ON AN EVENT CARD. `docs/design-direction.md` replaces
 * the event cover's monogram with the DATE, on the reasoning that "a letter carries no information" —
 * true of "R" for "React Meetup". A person's initials are not a letter standing in for a fact, they
 * ARE the fact: they are how a forty-row list becomes scannable by first letter, which is why every
 * address book ever built uses them. Flat wash, never a gradient, same discipline as `EventCover`.
 *
 * IN SELECTION MODE IT BECOMES THE CHECKBOX, and keeps the initials while unselected. Adding a
 * checkbox column beside it would put three columns in a 390px row; more importantly, a list of
 * anonymous checkboxes is a list you cannot check accurately.
 */
function IdentityTile({
  name,
  selecting,
  selected,
}: {
  name: string;
  selecting: boolean;
  selected: boolean;
}) {
  if (selecting && selected) {
    return (
      <span
        aria-hidden="true"
        className="grid h-10 w-10 shrink-0 place-items-center bg-[var(--accent)] text-[var(--accent-ink)]"
      >
        <span className="material-symbols-outlined text-[20px] leading-none">check</span>
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      /* FLAT, because radius is the signal that says "this responds" and the tile is not the
         target — the whole row is. `--font-serif` rather than the retired `--font-display` alias:
         initials are a person's name, which is the serif's own side of the split. */
      className={`grid h-10 w-10 shrink-0 place-items-center text-[15px] font-medium tracking-[-0.01em] ${
        selecting
          ? 'bg-[var(--surface)] text-[color:var(--ink-2)] shadow-[inset_0_0_0_1px_var(--rule)]'
          : 'bg-[var(--paper)] text-[color:var(--ink-2)]'
      }`}
      style={{ fontFamily: 'var(--font-serif)' }}
    >
      {monogram(name)}
    </span>
  );
}

/**
 * The pill vocabulary, and the rule behind it: A FILL MEANS ACT NOW, AN OUTLINE MEANS A FACT.
 *
 * The card used to draw `met 3×` and `target` as two IDENTICAL green pills — the same loud treatment
 * for a count and for a state — plus an amber pill for a scheduled follow-up, which is a fourth hue
 * the token set does not have. `globals.css` already records why that fails: "five tinted blocks under
 * every title turned each card into a swatch board and made the title compete with its own metadata."
 *
 * EXACTLY ONE FILL IS POSSIBLE ON A CARD NOW, and it is the overdue follow-up. `target` started this
 * pass as a green fill and lost it for two reasons, one measured and one structural:
 *
 *   · MEASURED. `--good` on `--good-wash` is **4.00:1** in the harness, which fails WCAG AA at 11px.
 *     Both are `globals.css` tokens owned by another surface, so forking the pair here would put a
 *     fifth green in the app; removing the failing pair from this card does not.
 *   · STRUCTURAL. `--live` already means "happening now" and `--good` already means "free" on an event
 *     pill. A third meaning for green spends a rationed hue on a fact that is simply true.
 *
 * So target is bounded and carries the SAME `●` marker in `--good` that `FacetRail` already puts on a
 * target-company chip — one glyph, one colour, one meaning, in the rail and on the card. `--good` on
 * white measures **4.40:1**, which is under the 4.5:1 text threshold and comfortably over the 3:1 one
 * for a non-text graphic (WCAG 1.4.11) — which is what the dot is: `aria-hidden`, carrying no meaning
 * of its own, with the word "target" beside it in `--ink-2` at 6.65:1 doing the actual telling.
 */
/*
 * PHASE 3: these are `globals.css`'s OWN pill classes now, not a third local definition of them.
 * `.pill` + `.pill-quiet` is the bounded fact (transparent, one hairline, secondary ink) and
 * `.pill-live` is the single alarm state (transparent, a `--live` ring, `--live` text). The local
 * pair reimplemented both a shade off, which is how a product ends up with four greys for one idea.
 * `shrink-0` is kept because `.pill` does not set it and these sit in a wrapping flex row.
 */
const PILL_BOUND = 'pill pill-quiet shrink-0';
const PILL_URGENT = 'pill pill-live shrink-0';

function PersonRow({
  person,
  selecting,
  selected,
  onSelect,
  open,
  onToggle,
  onPickCompany,
  onPickTag,
  preview = false,
}: {
  person: PersonDTO;
  selecting: boolean;
  selected: boolean;
  onSelect: () => void;
  open: boolean;
  onToggle: () => void;
  onPickCompany: (value: string) => void;
  onPickTag: (value: string) => void;
  /**
   * Render as an inert EXAMPLE — no link, no chip buttons, no disclosure.
   *
   * Used by the empty state, and reusing this component rather than hand-building a mock-up is the
   * whole point: a preview of the real thing that has drifted from the real thing is worse than no
   * preview, because it promises something the product does not do. Built this way it cannot drift.
   */
  preview?: boolean;
}) {
  const followUpAt = person.nextActionAt;
  const overdue = Boolean(followUpAt) && new Date(followUpAt as string) <= new Date();
  const history = person.recent ?? [];
  // The employer is dropped from the prose when a registry chip below already carries it — see
  // `personIdentityLine`. Two instances of "Razorpay" in one card is the same word twice, not detail.
  const identity = personIdentityLine(person, person.companies);
  const encounter = encounterLine(person);
  const note = latestNote(history);

  /* Extracted so all three wrappers render the IDENTICAL summary. Copies drift, and the copy that
     drifts is always the mode you look at least often. */
  const summary = (
    <>
      <IdentityTile name={person.displayName} selecting={selecting} selected={selected} />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {/* SERIF. A person is a thing in the world — the same class the event page gives a venue
              name. Everything else in this row is the app talking, and stays sans. */}
          <span className="ty-row-title truncate text-[var(--ink)]">{person.displayName}</span>
          {/* Bounded, with the rail's own target marker. See `PILL_BOUND` for why it is not a fill. */}
          {person.isTargetCompany && (
            <span className={PILL_BOUND}>
              <span aria-hidden="true" className="text-[color:var(--good)]">
                ●
              </span>
              target
            </span>
          )}
          {followUpAt && (
            <span
              className={
                overdue
                  ? /* The app's single alarm state, and the only place this row spends `--live`. An
                       amber "scheduled" pill used to sit here too — a fourth hue the token set does
                       not have, for a fact that is not urgent. */
                    PILL_URGENT
                  : PILL_BOUND
              }
            >
              {overdue ? 'follow up now' : `follow up ${shortDateIST(followUpAt)}`}
            </span>
          )}
        </span>
        {identity && (
          <span className="ty-meta mt-[var(--s-1)] block truncate">{identity}</span>
        )}
      </span>
    </>
  );

  /**
   * `min-h-11` IS THE 44px FLOOR, PAINTED RATHER THAN OVERLAID, and the hit test is why it is here.
   *
   * A thin row — a LinkedIn QR with no role and no employer, which is the COMMON capture — collapses to
   * the 40px tile, and 40 is under the floor. An `::after` band would be the wrong instrument: this
   * element is 100% of the card's width, so a 44px overlay would overhang into the encounter row above
   * and below and contest whatever sits there. Painting the height instead costs 4px on the thinnest
   * card, cannot overhang anything, and the only neighbour is the LinkedIn button beside it —
   * horizontally adjacent, itself painted 44, so there is no band to contest.
   */
  const summaryClass =
    'flex min-h-11 min-w-0 flex-1 items-start gap-3 r-touch text-left outline-none [touch-action:manipulation] focus-visible:shadow-[0_0_0_2px_var(--accent)]';

  return (
    /*
      SELECTION IS A LEFT RULE, RESERVED AT ALL TIMES. It was a 2px inset ring on a rounded card;
      with the shell gone there is nothing to ring, and the tone treatment this system already uses
      for emphasis is `Banner`'s left rule on the paper ground. The border is present but
      TRANSPARENT when unselected, so selecting a row cannot shift its text sideways — a 2px reflow
      per tap is exactly the jitter a 40-row selection pass would show.
    */
    <div
      className={`border-l-2 py-[var(--s-4)] pl-[var(--s-3)] ${
        selected ? 'border-[var(--accent)]' : 'border-transparent'
      }${preview ? ' opacity-70' : ''}`}
    >
      <div className="flex items-start gap-3">
        {preview ? (
          <span className={summaryClass}>{summary}</span>
        ) : selecting ? (
          <button
            type="button"
            // `aria-pressed`, not a hidden `<input type="checkbox">`: the row IS the control, and a
            // real checkbox would be a second focus stop inside it saying the same thing.
            aria-pressed={selected}
            onClick={onSelect}
            className={summaryClass}
          >
            {summary}
          </button>
        ) : (
          // The whole summary is the link, so the tap target is the card's full width.
          <Link href={`/people/${person._id}`} className={summaryClass}>
            {summary}
          </Link>
        )}

        {person.linkedin && !selecting && !preview && (
          <a
            href={person.linkedin}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${person.displayName} on LinkedIn`}
            className="grid h-11 w-11 shrink-0 place-items-center r-touch bg-[var(--paper)] text-[color:var(--accent)] shadow-[inset_0_0_0_1px_var(--rule)] hover:bg-[var(--surface)] [touch-action:manipulation]"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
              open_in_new
            </span>
          </a>
        )}
      </div>

      {/*
        THE ENCOUNTER — the card's one middle-dot string, and it earns the exception because place and
        date are two facts of the same rank about the same event. Set in full ink at 13px, one step ABOVE
        the role-and-employer line, which is a deliberate inversion: "where we met" places a stranger and
        "what they do" does not.

        LEFT-GROUPED, NOT `justify-between`. On a 1036px desktop card, pushing the `met N×` pill to the far
        edge left roughly 800px of white between two facts about the same encounter — a table row rather
        than a sentence. Measured in the harness at 1440; at 390 the two treatments look identical, which
        is exactly why it only shows up when you look at the wide case.
      */}
      <div className="mt-2.5 flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <p className="ty-meta min-w-0 truncate text-[var(--ink)]">
          {encounter.lead}
          {/*
            THE TOKEN, NOT A HEX — and the reason is a measurement that went stale inside this comment
            while it was being written. It first named a light grey the harness put at **3.26:1** on
            white: a WCAG AA failure at 12–13px. The fix was a darker grey at 5.07:1. Then the owner of
            `globals.css` darkened the whole ramp underneath, so BOTH hexes were suddenly lighter than
            the app around them. The ramp has since moved a THIRD time, and this comment's original
            figures had gone stale again by then — including its claim that `--ink-3` passes, which the
            current palette explicitly denies (3.15:1, decorative only). Naming the token is what makes
            this line track the ramp instead of freezing one moment of it. Re-measure rather than
            trusting any figure written here.
          */}
          {encounter.when && <span className="text-[color:var(--ink-2)]"> · {encounter.when}</span>}
        </p>
        {/*
          `met N×` MEANS N DISTINCT EVENTS — not N captures and not N folders.
          `detectRepeatConnections` carries that bug's scar: it keyed on the folder, so two folders for
          one event counted as two events. A badge that flatters is worse than none. Bounded rather than
          filled, and beside the encounter rather than beside the name, because it is a count of
          encounters — not a state needing attention.
        */}
        {person.eventCount > 1 && (
          /* ONE span, so `PILL_BASE`'s `gap-1` cannot land between the word, the figure and the ×.
             As three flex children it rendered "met 2 ×" — again caught in the harness, not in review. */
          <span className={PILL_BOUND}>
            <span>
              met <span className="tnum">{person.eventCount}</span>×
            </span>
          </span>
        )}
      </div>

      {/*
        WHAT YOU WROTE DOWN. The list has always had this on hand — `person.recent` carries `note` —
        and rendered none of it, so the one thing on this screen no competitor can show was invisible.
        A left rule rather than quote marks: it survives the two-line clamp, where a closing curly
        quote cut mid-sentence would just look broken.
      */}
      {/* `max-w-[72ch]` is the measure, not decoration: at 1036px this ran to roughly 160 characters a
          line, twice the under-80 limit `docs/design-direction.md` sets. It changes nothing at 390. */}
      {note && (
        <p className="mt-[var(--s-2)] line-clamp-2 max-w-[72ch] border-l-2 border-[color:var(--rule)] pl-2.5 text-[13px] leading-[1.5] text-[color:var(--ink-2)]">
          {note}
        </p>
      )}

      {(person.companies.length > 0 || person.tags.length > 0) && (
        /* `gap-y-3` is measured against the chips' 44px tap band — see `CHIP_BASE_STYLE`. */
        <div className="mt-2.5 flex flex-wrap gap-x-1.5 gap-y-3">
          {/*
            TWO KINDS OF FACT, DISTINGUISHED BY STRUCTURE RATHER THAN HUE.
            · Company — BOUNDED, full ink. The registry recognised this employer, `strength`-gated, so
              it has an edge: a defined thing from a defined list.
            · Tag — FILLED grey, secondary ink, prefixed `#`. Free text the user typed.
            These were previously blue-washed vs grey-filled. The distinction was right and the axis was
            wrong: `--blue` means "you can act on this" and is rationed, so six blue chips per card spent
            the app's only accent on the word "employer". The filled-grey tag also now matches how
            own-tags are already drawn in the person edit sheet and in the tag rail, so three surfaces
            agree instead of offering three looks.
          */}
          {person.companies.map(name =>
            preview ? (
              <span key={`c:${name}`} className={`${CHIP_COMPANY} pointer-events-none`}>
                {name}
              </span>
            ) : (
              <button
                key={`c:${name}`}
                type="button"
                onClick={() => onPickCompany(name)}
                aria-label={`Show everyone at ${name}`}
                className={`${CHIP_COMPANY} ${CHIP_TAP} hover:bg-[var(--paper)]`}
              >
                {name}
              </button>
            )
          )}
          {person.tags.map(t =>
            preview ? (
              <span key={`t:${t}`} className={`${CHIP_TAG} pointer-events-none`}>
                <span aria-hidden="true" className="text-[color:var(--ink-3)]">
                  #
                </span>
                {t}
              </span>
            ) : (
              <button
                key={`t:${t}`}
                type="button"
                onClick={() => onPickTag(t)}
                aria-label={`Show everyone you tagged ${t}`}
                className={`${CHIP_TAG} ${CHIP_TAP} hover:bg-[var(--paper)]`}
              >
                <span aria-hidden="true" className="text-[color:var(--ink-3)]">
                  #
                </span>
                {t}
              </button>
            )
          )}
        </div>
      )}

      {/*
        THE FOOTER CARRIES RECENCY AND OPENS THE HISTORY.
        It used to read "History — met at 2 events", which is a label describing content the reader
        cannot see, and it left the default sort ("Last contacted") unexplained on every row. Recency
        now sits here in words, and the disclosure names what is behind it instead of summarising it.
        Collapsed IN PLACE, never a navigation: three cards for one human is the defect the spine
        removed, and sending somebody to another page to learn they met a person twice would move that
        problem rather than solve it.
      */}
      {/* Left-grouped for the same measured reason as the encounter row: "Last spoke 5d ago" and the
          disclosure are two halves of one thought, and `justify-between` put a screen's width between
          them on desktop. */}
      <div className="rule-t mt-[var(--s-3)] flex flex-wrap items-center gap-x-3 gap-y-1 pt-1.5">
        <span
          /* `--ink-2` for the reason spelled out on the encounter date above — and because this line is
             what explains the default "Last contacted" ordering on every row, so it is a fact, not a
             caption. Currently 6.65:1; re-measure rather than trusting that. */
          className="min-w-0 truncate text-[12px] text-[color:var(--ink-2)]"
          title={person.lastInteractionAt ? dayHeading(person.lastInteractionAt) : undefined}
        >
          {person.lastInteractionAt
            ? // `max(Interaction.at)`, not capture time — a note or a completed follow-up is contact
              // too. This field did not exist in the schema before the spine.
              `Last spoke ${relativeTime(person.lastInteractionAt)}`
            : 'No contact recorded yet'}
        </span>
        {history.length > 0 && !preview && (
          <button
            type="button"
            aria-expanded={open}
            aria-label={`${open ? 'Hide' : 'Show'} the history with ${person.displayName}`}
            onClick={onToggle}
            className="relative flex h-9 shrink-0 items-center gap-1 r-touch pl-2 text-[12px] font-semibold text-[color:var(--accent)] [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']"
          >
            {open ? 'Hide' : 'History'}
            <span
              aria-hidden="true"
              className={`material-symbols-outlined text-[16px] transition-transform ${
                open ? 'rotate-180' : ''
              }`}
            >
              expand_more
            </span>
          </button>
        )}
      </div>

      {open && !preview && history.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1.5">
          {history.map(item => (
            <li key={item._id} className="flex items-start gap-2 text-[12px] text-[color:var(--ink-2)]">
              <span
                aria-hidden="true"
                className="material-symbols-outlined mt-[1px] text-[14px] text-[color:var(--ink-3)]"
              >
                {INTERACTION_ICON[item.kind]}
              </span>
              <span className="min-w-0">
                <span className="font-semibold text-[color:var(--ink)]">{INTERACTION_LABEL[item.kind]}</span>
                {item.eventId && (
                  // Nullable on purpose: `pruneStale()` deletes events 7 days past without touching
                  // their references, so a dangling id is normal rather than corruption.
                  <> at {item.eventTitle ?? 'an event we no longer have'}</>
                )}
                {item.note && <> — {item.note}</>}
                <span> · {shortDateIST(item.at)}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Bounded = a fact from a defined list. Filled = a label somebody typed. See the card's chip note.
 *
 * `h-8` IS MEASURED AGAINST `gap-y-3`, AND THAT PAIR IS THE WHOLE POINT — change one, change the other.
 * A 44px `::after` band on a shorter control overhangs `(44 − h) / 2` per side, so two chip ROWS need
 * `44 − h` between them or the later row in the DOM wins taps aimed at the earlier one. Hit-tested in a
 * static harness, not calculated: these chips were `py-1` with no height, which measured **25.3px** —
 * 9.4px of overhang per side against `gap-y-2`'s 8px, so the two rows genuinely contested the band. At
 * 32px the overhang is 6px per side and `gap-y-3` gives 12px, which clears it exactly, the same
 * arithmetic `FacetRail`'s 36 + 8 = 44 records for the rails.
 */
/* NO `gap` HERE. The tag chip's `#` is a sibling flex child of its word, so any gap renders it as
   "# hiring" — a stray glyph rather than a tag. Caught in the harness screenshot, not in review. */
const CHIP_BASE_STYLE =
  'inline-flex h-8 items-center r-touch px-2.5 text-[11.5px] font-semibold';
const CHIP_COMPANY = `${CHIP_BASE_STYLE} bg-[var(--surface)] text-[color:var(--ink)] shadow-[inset_0_0_0_1px_var(--rule)]`;
const CHIP_TAG = `${CHIP_BASE_STYLE} bg-[var(--paper)] text-[color:var(--ink-2)]`;
/** The 44px band, grown with `::after` so the painted chip stays small. `gap-y-3` above matches it. */
const CHIP_TAP =
  "relative [touch-action:manipulation] after:absolute after:inset-x-0 after:top-1/2 after:h-11 after:-translate-y-1/2 after:content-['']";

/**
 * WHERE AND WHEN YOU MET THEM — the card's headline fact, and the reason it is a function.
 *
 * It has to degrade honestly through four states, each of which really happens:
 *
 *   · The event is known           → "Met at IndiaFOSS 2026" + its date.
 *   · The event id DANGLES         → `pruneStale()` deletes events 7 days past without touching their
 *                                    references, so this is normal rather than corruption. Say so.
 *   · There is no event on any of the three most recent interactions, but `eventCount` says there were
 *                                    events → name the COUNT. `recent` is capped server-side at
 *                                    `RECENT_INTERACTIONS`, so an older `met` row is simply not on hand;
 *                                    claiming "not at an event" there would be a confident falsehood.
 *   · Nothing at all               → a Contact captured before the spine has no `met` row until the
 *                                    backfill runs. "No encounter recorded yet" is the truth.
 */
function encounterLine(person: PersonDTO): { lead: string; when: string | null } {
  const history = person.recent ?? [];
  const met = history.find(item => item.eventId) ?? history.find(item => item.kind === 'met');

  if (met?.eventId) {
    return {
      lead: `Met at ${met.eventTitle ?? 'an event we no longer have'}`,
      when: shortDateIST(met.eventStartAt ?? met.at),
    };
  }
  if (met) return { lead: 'Met in person', when: shortDateIST(met.at) };

  const intake = history.find(item => item.kind === 'intake');
  if (intake) return { lead: 'Added themselves', when: shortDateIST(intake.at) };

  if (person.eventCount > 0) {
    return {
      lead: `Met at ${person.eventCount} ${person.eventCount === 1 ? 'event' : 'events'}`,
      when: null,
    };
  }
  return { lead: 'No encounter recorded yet', when: null };
}

/** The most recent thing the user actually wrote. Undefined is the common case, and renders nothing. */
function latestNote(history: InteractionDTO[]): string | undefined {
  for (const item of history) {
    const note = (item.note ?? '').trim();
    if (note) return note;
  }
  return undefined;
}

/**
 * THE EMPTY STATE IS THE FIRST IMPRESSION OF THE DIFFERENTIATOR, so it shows the thing rather than
 * describing it.
 *
 * A brand-new account lands here. Aggregated Luma and Meetup listings are given away free by the
 * competition; "who did I meet there" is the half nobody else has — so an apologetic grey circle
 * reading "No people yet" spends the one screen that could explain that on a shrug.
 *
 * Three deliberate choices:
 *
 *   · LEFT-ALIGNED, not centred. A centred icon-over-two-lines block is the generated default for
 *     every empty state in every app; this reads as a screen with something to say.
 *   · IT RENDERS A REAL `PersonRow` in `preview` mode. Describing a row in prose and drawing one are
 *     not the same promise, and a hand-built mock-up would drift from the component the moment either
 *     changed. This cannot: it IS the component.
 *   · THE EXAMPLE IS LABELLED AND INERT — dimmed, `aria-hidden`, no links, and captioned as an example
 *     above it. A plausible fabricated person in a list of real people would be indefensible; the point
 *     is to show the shape, and the caption is what keeps it honest.
 */
function NoPeopleYet() {
  return (
    <div className="rule-y py-[var(--s-8)]">
      <h2 className="ty-section text-[var(--ink)]">Nobody here yet</h2>
      <p className="mt-[var(--s-3)] ty-body max-w-[52ch] text-[color:var(--ink-2)]">
        Scan somebody&apos;s LinkedIn QR at your next event and they land here — one row, with the
        event, the date and whatever you wrote down about them. Run into them again six months later and
        it is the same row, not a second one.
      </p>
      <div className="mt-5 flex flex-wrap gap-2">
        <ButtonLink href="/scan" tone="primary" icon="qr_code_scanner">
          Open the scanner
        </ButtonLink>
        <ButtonLink href="/folders" tone="quiet" icon="folder">
          See your folders
        </ButtonLink>
      </div>

      {/* WHAT A ROW HOLDS, IN WORDS. This used to render a real `PersonRow` for a fabricated
          "Asha Rao · Razorpay". It was dimmed and `aria-hidden`, and it still read as the first row
          of somebody's actual list — a fabricated person at a real company is the one kind of
          invented content that cannot be told apart from data. Saying it instead costs one sentence
          and invents nobody. */}
      <p className="rule-t mt-[var(--s-8)] pt-[var(--s-4)] ty-meta max-w-[62ch]">
        Each person becomes one row: their name, where they work, every event you met them at, and
        whatever you typed at the time.
      </p>
    </div>
  );
}
