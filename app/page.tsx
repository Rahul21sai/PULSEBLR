'use client';
import Link from 'next/link';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { DesktopNav, MobileBottomNav } from './components/NavBar';
import EventRow from './components/EventRow';
import EventGridCard from './components/EventGridCard';
import FilterRail, { FilterState, EMPTY_FILTERS, countActive } from './components/FilterRail';
import { FeedEvent, Facets, Pagination } from '@/lib/event-types';
import { MIN_SEARCH_CHARS } from '@/lib/events/query';
import { dayKeyIST, dayHeading, fullDateIST, isHappeningNow, NOW_GROUP_KEY } from '@/lib/format';

const WHEN_TABS = [
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'weekend', label: 'This weekend' },
  { id: 'week', label: 'Next 7 days' },
  { id: '', label: 'All upcoming' },
] as const;

/**
 * "Best for connections" is FIRST because it is the default (see the `sort` state below).
 * A select whose first option is not its current value reads as though the default were
 * arbitrary, which is exactly the impression this app's ranking should not give.
 */
const SORTS = [
  { id: 'connections', label: 'Best for connections' },
  { id: 'soonest', label: 'Soonest' },
  { id: 'popular', label: 'Most popular' },
  { id: 'newest', label: 'Just added' },
] as const;

type ViewMode = 'rail' | 'grid';

/**
 * How many events the spotlight promotes. Two, because they sit side by side at 16:9 on desktop
 * and a third would either shrink the covers below the point of having them or push the first
 * ranked row off a laptop screen. The cover image is the only colour this design system allows,
 * so the spotlight earns its space by showing two of them large.
 */
const SPOTLIGHT_COUNT = 2;

/** Same members in the same order. Used to keep `filters` identity stable — see below. */
function sameList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export default function Home() {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  /**
   * Events in progress right now, fetched SEPARATELY from the ranked page — see the note in
   * `load()`. Kept apart from `events` so the ranked list is never reordered or de-duplicated
   * against it; the two are rendered as two sections.
   */
  const [liveEvents, setLiveEvents] = useState<FeedEvent[]>([]);
  /**
   * Events an admin pinned to the Spotlight (`Event.spotlightAt`). Empty is the normal case and
   * is not a failure — it means nobody has pinned anything, and the Spotlight falls back to the
   * top of the ranking. Kept separate from `events` so a pin can never reorder the ranked list.
   */
  const [pinnedEvents, setPinnedEvents] = useState<FeedEvent[]>([]);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [when, setWhen] = useState<string>('');
  /**
   * DEFAULT SORT IS THE RANKING, NOT THE CALENDAR — and the measurement is why.
   *
   * `connectionScore` is the one signal this app has that Luma and Meetup do not, it is computed
   * for every event, and it is rendered as the three-bar meter on every card. It was then ignored
   * by the view every user lands on, which made the meter decorative.
   *
   * Measured on the live corpus 2026-08-24, first 20 rows of the tech feed:
   *
   *   sort=soonest      median score 20, avg 28   15 of 20 ONLINE
   *   format=offline    median score 69, avg 68
   *   sort=connections  median score 88, avg 91    0 of 20 online
   *
   * The tech corpus is near-evenly split (163 in-person, 174 online), so that gap is not a supply
   * problem. Online events are posted more often and at shorter notice, so a chronological sort
   * systematically favours them — the default page was "25% OFF: 2 Hours to Freedom…" and
   * "Free Gen AI & Agentic AI Demo at eMexo" at score 15, while a 100-scoring in-person mixer sat
   * out of sight. Soonest-first does not merely fail to rank; it actively selects the worst
   * quartile of what we hold.
   *
   * The cost, stated plainly: the feed no longer opens as "what's on tonight". That is why the
   * when-chips (Today / Tomorrow / This weekend) stay in the command bar and why `soonest` remains
   * one click away — a user asking "what's on tonight" is asking a DIFFERENT question from "where
   * should I go", and only the second one is what this product is for.
   */
  const [sort, setSort] = useState<string>('connections');
  // Tech-only is the DEFAULT view, not an option you have to find. This app exists
  // to surface Bengaluru SOFTWARE and HARDWARE events worth attending for the
  // connections; the other ~70% of the corpus (concerts, treks, book clubs) is
  // noise for that purpose and is one toggle away in the filter rail.
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS, techOnly: true });
  const [view, setView] = useState<ViewMode>('rail');
  const [sheetOpen, setSheetOpen] = useState(false);

  // Deep links from the companies page arrive as ?company=Google. Read once on
  // mount rather than holding the URL as state, so the filter model stays
  // single-source while company pages remain linkable and shareable.
  //
  // Deferred by a tick for the same two reasons as the load effect below: React's
  // compiler rules reject a synchronous setState inside an effect, and reading the
  // URL after hydration avoids a server/client mismatch on the checkbox state.
  //
  // Reads the FULL state, not just ?company=. Previously a search could not be shared,
  // bookmarked, or survive a refresh — type a query, reload, and it was gone — and the
  // browser's back button did nothing after ten filter changes. The Web Interface
  // Guidelines call for stateful UI to live in query params for exactly this reason.
  /**
   * Has the initial URL been read yet?
   *
   * The write effect below depends on the filter state, so on mount it runs with the
   * DEFAULTS and would replaceState to a bare "/" — wiping the query string before the
   * read effect ever parses it. Opening a shared link restored nothing at all, which the
   * round-trip check caught. The write is gated on this until hydration finishes.
   */
  const hydratedFromUrl = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const p = new URLSearchParams(window.location.search);

      const q = p.get('q');
      if (q) {
        setSearchInput(q);
        setQuery(q);
      }
      const w = p.get('when');
      if (w !== null && WHEN_TABS.some(t => t.id === w)) setWhen(w);
      const s = p.get('sort');
      if (s && SORTS.some(o => o.id === s)) setSort(s);
      const v = p.get('view');
      if (v === 'grid' || v === 'rail') setView(v);

      const company = p.get('company');
      const category = p.get('category');
      const area = p.get('area');
      const format = p.get('format');
      // techOnly defaults to TRUE, so only an explicit "false" turns it off — otherwise a
      // link without the param would silently flip the default.
      const techOnly = p.get('techOnly');

      /*
       * RETURN `prev` UNCHANGED WHEN NOTHING CAME FROM THE URL. This spread used to run
       * unconditionally, which produced a NEW object every time even on a bare "/" where no
       * param exists — and object identity is load-bearing here: `buildParams` depends on
       * `filters`, `load` depends on `buildParams`, and the fetching effect depends on `load`.
       * So a fresh-but-identical `filters` re-ran the whole chain and fired the feed query a
       * SECOND time with byte-identical params.
       *
       * Measured on a production build (so not StrictMode's double-invoke): 6 API requests per
       * page load where 3 would do — `/api/events` twice and `/api/events/facets` twice. Both
       * are the expensive ones: the feed query and the facet aggregation. Every visitor paid
       * double, and it was invisible because the second response is identical to the first.
       */
      setFilters(prev => {
        const next = {
          ...prev,
          companies: company ? company.split(',').filter(Boolean) : prev.companies,
          categories: category ? category.split(',').filter(Boolean) : prev.categories,
          areas: area ? area.split(',').filter(Boolean) : prev.areas,
          format: format ?? prev.format,
          freeOnly: p.get('isFree') === 'true' ? true : prev.freeOnly,
          foodOnly: p.get('hasFood') === 'yes' ? true : prev.foodOnly,
          techOnly: techOnly === null ? prev.techOnly : techOnly !== 'false',
        };
        const unchanged =
          next.format === prev.format &&
          next.freeOnly === prev.freeOnly &&
          next.foodOnly === prev.foodOnly &&
          next.techOnly === prev.techOnly &&
          sameList(next.companies, prev.companies) &&
          sameList(next.categories, prev.categories) &&
          sameList(next.areas, prev.areas);
        return unchanged ? prev : next;
      });

      // Only now may the URL be written back.
      hydratedFromUrl.current = true;
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  // Debounce the search box so typing doesn't fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), 280);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /**
   * Mirror the current view into the URL so it can be shared, bookmarked and restored.
   *
   * `replaceState`, not `pushState`: filtering is exploratory, and pushing an entry per
   * toggle would mean twelve Back presses to leave the page. The trade-off is that Back
   * does not step through filter history — the right call, because a URL that is CORRECT
   * when copied matters far more than one that is undoable.
   *
   * Only non-default values are written, so a clean view stays a clean "/" rather than a
   * wall of redundant params. techOnly is the exception: it defaults to true, so turning it
   * OFF is what has to be recorded.
   */
  useEffect(() => {
    // Never write before the initial read has landed, or a shared link erases itself.
    if (!hydratedFromUrl.current) return;

    const p = new URLSearchParams();
    if (query) p.set('q', query);
    if (when) p.set('when', when);
    // Must track the DEFAULT above, not a hardcoded 'soonest'. This writer omits default values so
    // a clean view stays a clean "/" — so if it omitted the wrong one, opening "/" would render
    // ranked while the URL said nothing, and "?sort=soonest" would be written for the default and
    // dropped for the non-default. Exactly inverted.
    if (sort !== 'connections') p.set('sort', sort);
    if (view !== 'rail') p.set('view', view);
    if (filters.categories.length) p.set('category', filters.categories.join(','));
    if (filters.areas.length) p.set('area', filters.areas.join(','));
    if (filters.companies.length) p.set('company', filters.companies.join(','));
    if (filters.format) p.set('format', filters.format);
    if (filters.freeOnly) p.set('isFree', 'true');
    if (filters.foodOnly) p.set('hasFood', 'yes');
    if (!filters.techOnly) p.set('techOnly', 'false');

    const qs = p.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [query, when, sort, view, filters]);

  /**
   * One character is not a query. The API ignores a term this short — before
   * prefix-anchoring it matched 815 of 815 events — so the UI has to SAY that rather
   * than render the entire corpus and let the user believe it was a result set.
   */
  const needsMoreChars =
    searchInput.trim().length > 0 && searchInput.trim().length < MIN_SEARCH_CHARS;

  const buildParams = useCallback(
    (page: number) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      if (when) params.set('when', when);
      if (filters.categories.length) params.set('category', filters.categories.join(','));
      if (filters.areas.length) params.set('area', filters.areas.join(','));
      if (filters.companies.length) params.set('company', filters.companies.join(','));
      if (filters.format) params.set('format', filters.format);
      if (filters.freeOnly) params.set('isFree', 'true');
      if (filters.foodOnly) params.set('hasFood', 'yes');
      if (filters.techOnly) params.set('techOnly', 'true');
      params.set('sort', sort);
      params.set('page', String(page));
      params.set('limit', '30');
      return params;
    },
    [query, when, filters, sort]
  );

  /**
   * Monotonic token identifying the current filter generation.
   *
   * Bumped whenever a fresh load starts, so any request still in flight for a
   * PREVIOUS filter set can detect that its response is stale and discard it.
   * Without this the feed had two observable races:
   *
   *  1. Switching filters while scrolled down fired loadMore() with the page
   *     number from the OLD result set. Live network log showed
   *     `?when=tomorrow&page=1` immediately followed by `?when=tomorrow&page=3`,
   *     so page 2 of the new filter was silently skipped and those events never
   *     appeared.
   *  2. A slow response for filter A could resolve after a fast one for filter B
   *     and overwrite B's events, leaving the list disagreeing with the controls.
   */
  const requestGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++requestGeneration.current;
    setLoading(true);
    setError(null);
    // Clear pagination up front so the infinite-scroll sentinel cannot fire
    // loadMore() with a page number belonging to the previous filter set.
    setPagination(null);
    try {
      const params = buildParams(1);

      /*
       * A THIRD REQUEST, ON PURPOSE — the live set cannot be derived from the ranked page.
       *
       * "Happening now" first shipped as a client-side partition of the events already loaded,
       * which was wrong in a way that only showed up under measurement: the default sort is
       * `connections`, so a live event appears on page 1 only if it happens to SCORE highly.
       * Measured with techOnly off, when the city genuinely had events in progress: zero of the
       * top 30 were live, so the section never rendered. It surfaced what is on now by luck.
       *
       * So ask for it directly. `sort=soonest` orders by start time across everything still
       * upcoming, and `lib/events/query.ts` counts an in-progress event as upcoming — so
       * anything currently running started earliest and sorts to the front. 20 is far more
       * headroom than one city needs at one moment.
       *
       * Same filters as the main list (`buildParams`), so "Happening now" always agrees with the
       * controls rather than showing rows the active filters exclude.
       */
      const liveParams = buildParams(1);
      liveParams.set('sort', 'soonest');
      liveParams.set('limit', '20');

      /*
       * The pinned Spotlight, asked for ONLY when the Spotlight would actually render — the
       * untouched landing view under a ranked sort. Requesting it while someone is searching
       * would spend a round trip on markup that is not going to be drawn. `spotlight=true` runs
       * through the same filter builder as everything else, so a pin still respects `techOnly`
       * and the upcoming window: an event pinned in August cannot resurface in October.
       */
      const wantsSpotlight = !query && countActive(filters) <= 1 && sort !== 'soonest';
      const pinnedParams = buildParams(1);
      pinnedParams.set('spotlight', 'true');
      pinnedParams.set('limit', String(SPOTLIGHT_COUNT));

      const [listRes, facetRes, liveRes, pinnedRes] = await Promise.all([
        fetch(`/api/events?${params.toString()}`),
        fetch(`/api/events/facets?${params.toString()}`),
        fetch(`/api/events?${liveParams.toString()}`),
        wantsSpotlight ? fetch(`/api/events?${pinnedParams.toString()}`) : Promise.resolve(null),
      ]);
      if (!listRes.ok) throw new Error('Could not load events');

      const list = await listRes.json();
      // Superseded by a newer filter set — drop this response entirely.
      if (generation !== requestGeneration.current) return;

      setEvents(list.events || []);
      setPagination(list.pagination || null);

      // Also an enhancement: if the pinned request fails or was skipped, the Spotlight simply
      // falls back to the top of the ranking rather than disappearing.
      if (pinnedRes?.ok) {
        const pinned = await pinnedRes.json();
        if (generation === requestGeneration.current) {
          setPinnedEvents((pinned.events || []) as FeedEvent[]);
        }
      } else if (!wantsSpotlight && generation === requestGeneration.current) {
        // Clear on a filtered/searched view so a stale pin cannot reappear when filters relax.
        setPinnedEvents([]);
      }

      // Live set is an enhancement, not content: a failure here must leave the feed intact.
      if (liveRes.ok) {
        const soonest = await liveRes.json();
        if (generation === requestGeneration.current) {
          setLiveEvents(
            ((soonest.events || []) as FeedEvent[]).filter(e =>
              isHappeningNow(e.startDateTime, e.endDateTime)
            )
          );
        }
      }

      // Facets are decoration, not content — a facet failure must not blank the feed.
      if (facetRes.ok) {
        const nextFacets = await facetRes.json();
        if (generation === requestGeneration.current) setFacets(nextFacets);
      }
    } catch (err) {
      if (generation !== requestGeneration.current) return;
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setEvents([]);
    } finally {
      if (generation === requestGeneration.current) setLoading(false);
    }
    // `query`, `filters` and `sort` are listed even though `buildParams` already closes over all
    // three, so `load` would change anyway. Naming them is not redundant: `wantsSpotlight` reads
    // them DIRECTLY now, and depending on that only transitively means the day someone narrows
    // `buildParams`'s own deps, this callback goes stale with no warning. The lint rule was right.
  }, [buildParams, query, filters, sort]);

  // Deferred by a tick rather than called synchronously. Two reasons: React's
  // compiler rules (correctly) reject a synchronous setState inside an effect, and
  // deferring naturally coalesces rapid filter toggling into one request instead of
  // firing a fetch per click.
  useEffect(() => {
    const timer = setTimeout(load, 0);
    return () => clearTimeout(timer);
  }, [load]);

  const loadMore = useCallback(async () => {
    // `loading` is part of the guard on purpose: while a fresh filter set is being
    // fetched there is no valid page number to continue from.
    if (loading || loadingMore || !pagination?.hasMore) return;

    const generation = requestGeneration.current;
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/events?${buildParams(pagination.page + 1).toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      // The filters changed while this page was in flight; appending it now would
      // mix results from two different queries.
      if (generation !== requestGeneration.current) return;

      // Guard against a duplicate page if the user scrolls fast.
      setEvents(prev => {
        const seen = new Set(prev.map(e => e._id));
        return [...prev, ...(data.events || []).filter((e: FeedEvent) => !seen.has(e._id))];
      });
      setPagination(data.pagination || null);
    } finally {
      setLoadingMore(false);
    }
  }, [loading, loadingMore, pagination, buildParams]);

  // Infinite scroll via a sentinel element.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      entries => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { rootMargin: '600px' }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore]);

  /**
   * Group events into IST calendar days for the rail, with one exception:
   * anything in progress goes into a "Happening now" bucket pinned to the top.
   *
   * Why: a multi-day trek that started two days ago is still attendable, but
   * grouping it under its START date meant the feed opened on a heading dated in
   * the past ("Fri, 7 Aug" when today is the 9th), which reads as a bug.
   */
  const days = useMemo(() => {
    const groups = new Map<string, FeedEvent[]>();
    const push = (key: string, event: FeedEvent) => {
      const bucket = groups.get(key);
      if (bucket) bucket.push(event);
      else groups.set(key, [event]);
    };

    for (const event of events) {
      const live = isHappeningNow(event.startDateTime, event.endDateTime);
      push(live ? NOW_GROUP_KEY : dayKeyIST(event.startDateTime), event);
    }

    // The sentinel key sorts first lexicographically, which is exactly the intent.
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [events]);

  const activeCount = countActive(filters);
  const total = pagination?.total ?? 0;

  /**
   * Is the current sort CHRONOLOGICAL? Only `soonest` is.
   *
   * This decides whether the rail may group by IST day, and getting it wrong silently discards
   * the ordering the user asked for. `days` buckets events by calendar day and then orders the
   * buckets by date — so under any RANKED sort the API returns the right events in the right
   * order and the rail immediately re-sorts them by date, throwing the ranking away.
   *
   * Measured in the browser at /?sort=connections before this fix: the API returned
   * `Women In Tech Mixer` (connectionScore 100) first, and the page rendered it THIRD — below
   * `Umbraco India Festival` on Fri 28 Aug and `Snowflake Bangalore User Group` (88) on
   * Sat 29 Aug, purely because those dates come sooner. Day headings were still drawn under a
   * ranked sort, which was the visible tell.
   *
   * So the app's flagship sort — the one signal Luma and Meetup cannot show — did not visibly
   * rank anything. CLAUDE.md records that the connection meter was added because "that sort
   * looked arbitrary"; as rendered, it was.
   *
   * `newest` and `popular` have the same problem, and `relevance` too when there is a query:
   * all of them answer "in what ORDER", and a day grouping overrides the answer.
   */
  const chronological = sort === 'soonest';

  /**
   * Split the ranked list into what is ON NOW and what is coming.
   *
   * The day-grouped view has always pinned a "Happening now" bucket above the days, because
   * "can I still get to this tonight" is a different question from "what is worth going to".
   * Making `connections` the default sort quietly lost that: a flat ranked list has no buckets,
   * so a live event sat wherever its score put it and read as just another row.
   *
   * So the ranked view gets the same two-part shape — on now, then the ranking — using the
   * existing `day-heading` device rather than a new one. Within each part the API's order is
   * preserved, so the ranking still decides what comes first; this groups by state, it does not
   * re-sort. That is the distinction the earlier bug got wrong.
   *
   * Only computed for the ranked view. Under `soonest` the day grouping already does this, and
   * running it there would put the same events in two places.
   */
  const [liveNow, spotlight, comingUp] = useMemo(() => {
    if (chronological) return [[] as FeedEvent[], [] as FeedEvent[], events];
    // `liveEvents` comes from its own soonest-ordered request, so it is authoritative for what
    // is on now. Live rows that ALSO happen to rank onto the page are folded in and de-duplicated
    // by id, then removed from "coming up" so nothing is listed twice.
    const seen = new Set<string>();
    const live: FeedEvent[] = [];
    for (const event of [...liveEvents, ...events]) {
      if (!isHappeningNow(event.startDateTime, event.endDateTime)) continue;
      if (seen.has(event._id)) continue;
      seen.add(event._id);
      live.push(event);
    }
    const ranked = events.filter(event => !seen.has(event._id));

    /*
     * SPOTLIGHT: the highest-scoring events, given the room to be seen.
     *
     * Only on the untouched landing view. Once someone searches or narrows the filters they have
     * said what they want, and promoting two rows above their own query is noise, not curation.
     * `countActive(filters) <= 1` is the test because `techOnly` is on by default and counts as
     * one — so this means "nothing beyond the default".
     *
     * The events are the top of the SAME ranking the list below uses, not a separate hand-picked
     * set. That is the difference from the site this was compared against, where the spotlight is
     * editorial and paid ("FLAGSHIP", "INVITE ONLY", "GET TICKETS"): ours is just the ranking
     * being honest about its own top result, so it cannot disagree with the list underneath it.
     */
    const eligible = !query && countActive(filters) <= 1;
    /*
     * AN ADMIN PIN WINS OVER THE RANKING, and the fallback is the ranking rather than nothing.
     *
     * Two states, one component. With pins, the Spotlight is editorial — an admin decided.
     * Without any, it is the top of the same ranking the list below uses. Falling back rather
     * than hiding matters: an empty pin set is the NORMAL state, not a misconfiguration, so the
     * feature has to look finished on a database where nobody has ever opened /admin.
     *
     * Pinned rows already in the live set are dropped instead of shown twice — "happening now"
     * is the more urgent fact about an event than "an admin liked it".
     */
    const featured = !eligible
      ? []
      : pinnedEvents.length
        ? pinnedEvents.filter(event => !seen.has(event._id)).slice(0, SPOTLIGHT_COUNT)
        : ranked.slice(0, SPOTLIGHT_COUNT);

    // Filter by id rather than slicing: a pinned event need not be at the top of the ranked page,
    // or on it at all, so `slice` would remove the wrong rows.
    const featuredIds = new Set(featured.map(event => event._id));
    return [live, featured, ranked.filter(event => !featuredIds.has(event._id))];
  }, [chronological, events, liveEvents, pinnedEvents, query, filters]);

  return (
    <div className="min-h-screen bg-[#F5F5F7]">
      <DesktopNav />

      <header className="md:hidden fixed top-0 w-full h-14 bg-white/96 glass-nav z-50 border-b border-black/5 flex items-center justify-between px-5">
        <span className="text-lg font-bold tracking-tight text-[#1D1D1F]">PulseBLR</span>
        <Link
          href="/tracker"
          aria-label="Open your tracker"
          className="text-[#86868B] hover:text-[#0071E3] transition-colors"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[24px]">bookmarks</span>
        </Link>
      </header>

      {/* ── Command bar: search, time window, sort, view ─────────────────── */}
      {/* Height is pinned to --commandbar-h rather than left to content, so the
          measured offset the rest of the layout depends on stays true. */}
      <div
        className="fixed top-14 left-0 right-0 z-40 bg-[#F5F5F7]/97 glass-nav border-b border-black/5 overflow-hidden"
        style={{ height: 'var(--commandbar-h)' }}
      >
        <div className="max-w-[1240px] mx-auto px-4 md:px-8">
          <div className="flex items-center gap-2 py-2.5">
            <div className="relative flex-1 min-w-0">
              <span aria-hidden="true" className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-[19px] text-[#86868B] pointer-events-none">
                search
              </span>
              <input
                id="event-search"
                name="q"
                type="search"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                placeholder="Kubernetes, Razorpay, Koramangala…"
                aria-label="Search events by name, host or venue"
                aria-describedby="search-hint"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="search"
                className="w-full h-10 pl-10 pr-9 rounded-full bg-white text-[14px] text-[#1D1D1F] placeholder:text-[#a1a1a6] shadow-[inset_0_0_0_1px_var(--hairline-strong)] transition-[box-shadow,background-color] focus:outline-none focus-visible:shadow-[inset_0_0_0_2px_#0071E3] [touch-action:manipulation]"
              />
              {searchInput && (
                <button
                  type="button"
                  onClick={() => setSearchInput('')}
                  aria-label="Clear search"
                  className="absolute right-2.5 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center rounded-full text-[#86868B] hover:bg-[#F0F0F2] hover:text-[#1D1D1F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] [touch-action:manipulation]"
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
                </button>
              )}
            </div>

            {/* Filters: a sheet on mobile, always-on rail on desktop */}
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="lg:hidden shrink-0 h-10 px-4 rounded-full bg-white border border-[#e5e5ea] text-[13px] font-semibold text-[#1D1D1F] flex items-center gap-1.5 hover:bg-[#f3f3f5] transition-colors"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[18px]">tune</span>
              Filters
              {activeCount > 0 && (
                <span className="bg-[#0071E3] text-white text-[10px] font-bold rounded-full min-w-4 h-4 px-1 flex items-center justify-center tnum">
                  {activeCount}
                </span>
              )}
            </button>

            <div className="hidden sm:flex shrink-0 items-center gap-1 bg-white border border-[#e5e5ea] rounded-full p-0.5">
              {(['rail', 'grid'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  aria-label={mode === 'rail' ? 'Schedule view' : 'Grid view'}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    view === mode ? 'bg-[#f3f3f5] text-[#1D1D1F]' : 'text-[#86868B] hover:text-[#1D1D1F]'
                  }`}
                >
                  <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                    {mode === 'rail' ? 'view_agenda' : 'grid_view'}
                  </span>
                </button>
              ))}
            </div>
          </div>

          {/* Time window tabs + sort */}
          <div className="flex items-center justify-between gap-4 pb-1">
            <div className="flex gap-1 overflow-x-auto no-scrollbar -mx-1 px-1">
              {WHEN_TABS.map(tab => (
                <button
                  key={tab.id || 'all'}
                  type="button"
                  onClick={() => setWhen(tab.id)}
                  aria-pressed={when === tab.id}
                  className={`shrink-0 rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] [touch-action:manipulation] ${
                    when === tab.id
                      ? 'bg-[#1D1D1F] text-white'
                      : 'text-[#6E6E73] hover:bg-white hover:text-[#1D1D1F]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Available on EVERY width. This was `hidden md:flex`, which left phones
                with no sort control — and "Best for connections" is the one ranking this
                product has that Luma and Meetup do not. */}
            <label
              htmlFor="event-sort"
              className="flex shrink-0 items-center gap-1.5 text-[12.5px] text-[#8E8E93]"
            >
              <span className="hidden sm:inline">Sort</span>
              <span className="material-symbols-outlined sm:hidden text-[17px]" aria-hidden="true">
                swap_vert
              </span>
              <span className="sr-only sm:hidden">Sort events by</span>
              <select
                id="event-sort"
                name="sort"
                value={sort}
                onChange={e => setSort(e.target.value)}
                className="cursor-pointer rounded-md bg-transparent py-0.5 pr-1 font-semibold text-[#1D1D1F] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] [touch-action:manipulation]"
              >
                {SORTS.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>
      </div>

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {/* `feed-main` supplies padding-top from --feed-offset, the same variable the
          sticky day headings use, so content can never sit under the fixed bars. */}
      <main className="feed-main pb-24 md:pb-16">
        {/* ── Hero ───────────────────────────────────────────────────────────
            WHY THIS EXISTS. The page used to open on a search box, a filter button, five date
            chips and a sort dropdown, then a title and a list. A first-time visitor got the
            controls before they got an explanation, and the one thing that makes this app
            different from Luma or Meetup — that it ranks by who you will meet rather than by
            what is soonest — appeared only as a six-word aside under the heading.

            So the H1 states the proposition, and the numbers under it are LIVE rather than
            marketing copy: a real count is evidence, a paragraph is a claim. The competitor this
            was compared against spends a static paragraph here; we have the figures, so we use
            them.

            It sits above the flex row on purpose, which also puts the H1 first in the document —
            before the filter rail — so the heading outline finally starts where it should.

            No card, no gradient, no new elevation: globals.css keeps one accent and one live
            state, and a hero is not a reason to spend either. The only colour is the live dot,
            and only when something is actually on. */}
        <div className="max-w-[1240px] mx-auto px-4 md:px-8 pt-2 pb-7 md:pb-9">
          {/* Eyebrow: a short rule then letterspaced caps. `.t-label` is +0.055em because the
              type scale sets POSITIVE tracking for small caps — tight small caps are unreadable,
              which is the same rule that gives the headline below its negative tracking. */}
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="h-px w-8 bg-[color:var(--hairline-strong)]" />
            <p className="t-label text-[#8E8E93]">
              Meetups · Conferences · Hackathons · Workshops
            </p>
          </div>

          <h1 className="t-hero mt-3.5 max-w-[22ch] text-[#1D1D1F]">
            Bengaluru tech events, ranked by who you’ll meet
          </h1>

          <p className="mt-4 max-w-[64ch] text-[15px] leading-[1.55] text-[#3a3a3c]">
            Every{' '}
            <strong className="font-semibold text-[#1D1D1F]">
              developer meetup, conference, hackathon and workshop
            </strong>{' '}
            in the city, in one place — sorted by whether you’ll leave with useful contacts, not
            just by what’s on soonest. Scan a badge and keep the people you met.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12.5px] text-[#6E6E73]">
            <span>
              <span className="tnum font-semibold text-[#1D1D1F]">
                {total.toLocaleString('en-IN')}
              </span>{' '}
              upcoming
            </span>
            {liveNow.length > 0 && (
              <span className="inline-flex items-center gap-1.5 font-semibold text-[#FF3B30]">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-[#FF3B30]" />
                <span className="tnum">{liveNow.length}</span> happening now
              </span>
            )}
            <Link href="/folders" className="font-semibold text-[#0071E3] hover:underline">
              Keep the people you meet →
            </Link>
          </div>
        </div>

        {/* ── Spotlight ──────────────────────────────────────────────────────
            Full width, above the filters, so two covers get room to be seen. It uses the SAME
            `EventGridCard` as grid view rather than a bespoke feature card: the cover image is
            the only colour this design system permits, so a card that leads with the cover is
            already the strongest treatment available — and reusing it means the spotlight cannot
            drift from the rest of the feed.

            Deliberately NOT the gradient panel the compared site uses. globals.css removed eight
            category gradients on purpose, so that the covers are the only colourful thing on
            screen; a magenta-to-orange hero card would spend exactly the attention those covers
            are supposed to get. */}
        {spotlight.length > 0 && (
          <section className="max-w-[1240px] mx-auto px-4 md:px-8 pb-8">
            <div className="day-heading pb-2 mb-3.5">
              <div className="flex items-center gap-2.5">
                <h2 className="t-label shrink-0 text-[#1D1D1F]">Spotlight</h2>
                <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
                {/* Says which of the two modes produced this. Not decoration: "hand-picked" and
                    "top of the ranking" are different claims, and a reader who cannot tell which
                    one they are looking at has no way to judge it. */}
                <span className="shrink-0 text-[11.5px] text-[#8E8E93]">
                  {pinnedEvents.length > 0 ? 'Hand-picked' : 'Best for connections right now'}
                </span>
              </div>
            </div>
            {/* TWO PRESENTATIONS OF THE SAME TWO EVENTS, chosen by width — not two different
                sets, and the section is never hidden. It cannot be: the memo REMOVES these from
                "Coming up" so nothing is listed twice, so CSS-hiding the section would delete the
                two best events from a phone entirely. That is the trap here, and it is why this
                switches the treatment rather than the visibility.

                Cover cards use HORIZONTAL room, which is the whole reason they earn their space —
                two 16:9 covers side by side. A 375px screen has none, so there they stack at 391px
                each and pushed the first ranked row to y=1511, nearly two full screens of scroll
                before the feed. Measured. So phones get the compact rail rows instead: same events,
                same heading above them, ~192px each. */}
            <div className="hidden gap-5 sm:grid sm:grid-cols-2">
              {spotlight.map(event => (
                <EventGridCard key={event._id} event={event} />
              ))}
            </div>
            <div className="rail sm:hidden">
              {spotlight.map(event => (
                <EventRow key={event._id} event={event} showDate />
              ))}
            </div>
          </section>
        )}

        <div className="max-w-[1240px] mx-auto px-4 md:px-8 flex gap-8">
          {/* Desktop filter rail */}
          <aside className="hidden lg:block w-[248px] shrink-0">
            <div className="sticky top-[152px] max-h-[calc(100vh-176px)] overflow-y-auto pr-1 pb-8">
              <FilterRail
                facets={facets}
                filters={filters}
                onChange={setFilters}
                loading={loading}
              />
            </div>
          </aside>

          <div className="flex-1 min-w-0">
            {/* Large title, in the SCROLL area rather than the fixed chrome.
                The events are still the hero — this does not become a banner — but the
                page had no title at all: its h1 was a 19px result count, so the top of
                the document opened on a statistic. An iOS-style large title that scrolls
                away gives the page a voice for the first screenful and then gets out of
                the way, and keeping it out of the fixed bars leaves --feed-offset (and
                the sticky day-heading maths that depends on it) untouched.

                The title states the ACTIVE VIEW, so it doubles as a readout of the
                filters — which is why it earns the space. */}
            {/* An H2, not the H1 — the hero above owns the page's subject. This one names the
                ACTIVE VIEW and updates as filters change, which is why it keeps `aria-live`: it is
                a readout, not a title. Demoting it is also what closes the heading outline, since
                the page now runs H1 (hero) -> H2 (this) -> H2 (section) -> H3 (card) with nothing
                skipped. Visual weight is unchanged: `.t-display` does the sizing, not the tag. */}
            <div className="mb-5" aria-live="polite" aria-atomic="true">
              <h2 className="t-display text-[#1D1D1F]">
                {query
                  ? `“${query}”`
                  : filters.techOnly
                    ? 'Tech events in Bengaluru'
                    : 'Events in Bengaluru'}
              </h2>
              <p id="search-hint" className="mt-1.5 text-[13px] text-[#6E6E73] tracking-[0]">
                {loading ? (
                  'Searching…'
                ) : needsMoreChars ? (
                  <>Keep typing — {MIN_SEARCH_CHARS} characters minimum.</>
                ) : total === 0 ? (
                  query ? (
                    <>
                      No match for{' '}
                      <span className="font-semibold text-[#1D1D1F]">“{query}”</span>
                    </>
                  ) : (
                    'No events match these filters.'
                  )
                ) : (
                  <>
                    <span className="tnum font-semibold text-[#1D1D1F]">
                      {total.toLocaleString('en-IN')}
                    </span>{' '}
                    {query ? (
                      <>
                        match{total === 1 ? '' : 'es'} for{' '}
                        <span className="font-semibold text-[#1D1D1F]">“{query}”</span>
                      </>
                    ) : (
                      'upcoming'
                    )}
                    {sort === 'connections' && ' · ranked by who you’ll meet there'}
                    {sort === 'soonest' && !query && ' · soonest first'}
                  </>
                )}
              </p>
            </div>

            {loading ? (
              <FeedSkeleton view={view} />
            ) : error ? (
              <EmptyState
                icon="cloud_off"
                title="Couldn’t load events"
                body={error}
                action={{ label: 'Try again', onClick: load }}
              />
            ) : events.length === 0 ? (
              <EmptyState
                icon="event_busy"
                title="Nothing here yet"
                body={
                  activeCount > 0 || query
                    ? 'Try widening the time window or clearing a filter.'
                    : 'Run the scraper to pull in this week’s Bengaluru events.'
                }
                action={
                  activeCount > 0 || query
                    ? {
                        label: 'Clear filters',
                        onClick: () => {
                          setFilters(EMPTY_FILTERS);
                          setSearchInput('');
                          setWhen('');
                        },
                      }
                    : { label: 'Add an event', href: '/add-event' }
                }
              />
            ) : view === 'grid' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
                {events.map(event => (
                  <EventGridCard key={event._id} event={event} />
                ))}
              </div>
            ) : !chronological ? (
              /* Ranked sort: TWO sections — on now, then the ranking — and inside each the API's
                 order is untouched. Grouping by DAY here would re-sort chronologically and discard
                 the ranking, which is the bug the `chronological` note above describes; grouping by
                 STATE does not, because neither bucket is reordered.

                 Headings are the same `day-heading` device the grouped view uses, so this reads as
                 one component with two modes rather than two designs. They are also the page's only
                 <h2>s, which is what gives the feed a real H1 -> H2 -> H3 outline. */
              <div className="rail">
                {liveNow.length > 0 && (
                  <section className="mb-2">
                    <div className="day-heading pt-2.5 pb-2 mb-1.5">
                      <div className="flex items-center gap-2.5">
                        <h2 className="t-label flex shrink-0 items-center gap-1.5 text-[#FF3B30]">
                          <span className="live-dot w-1.5 h-1.5 rounded-full bg-[#FF3B30]" />
                          Happening now
                        </h2>
                        <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
                        <span className="tnum shrink-0 text-[11.5px] text-[#8E8E93]">
                          {liveNow.length}
                        </span>
                      </div>
                    </div>
                    {liveNow.map(event => (
                      <EventRow key={event._id} event={event} showDate />
                    ))}
                  </section>
                )}

                {comingUp.length > 0 && (
                  <section className="mb-2">
                    {/* Rendered even when nothing is live. Two reasons, and the first was learned
                        the hard way: suppressing it made the whole two-part structure vanish
                        whenever the city happened to be quiet, which is most of a working day —
                        so the change was invisible exactly when someone would check it. And it is
                        the page's only <h2> in that state, so dropping it leaves the outline at
                        H1 -> H3 with the level skipped. A section label that is always there is
                        also just easier to scan against than one that appears and disappears. */}
                    <div className="day-heading pt-2.5 pb-2 mb-1.5">
                      <div className="flex items-center gap-2.5">
                        <h2 className="t-label flex shrink-0 items-center gap-1.5 text-[#1D1D1F]">
                          {liveNow.length > 0 ? 'Coming up' : 'Top events'}
                        </h2>
                        <span
                          aria-hidden="true"
                          className="h-px flex-1 bg-[color:var(--hairline)]"
                        />
                        <span className="tnum shrink-0 text-[11.5px] text-[#8E8E93]">
                          {comingUp.length}
                        </span>
                      </div>
                    </div>
                    {comingUp.map(event => (
                      /* showDate is REQUIRED here. Neither section carries day headings, so without
                         it the rail shows a bare "18:30" and the date appears nowhere on the row —
                         measured at 375px, a reader could not tell tonight from three weeks away. */
                      <EventRow key={event._id} event={event} showDate />
                    ))}
                  </section>
                )}
              </div>
            ) : (
              <div className="rail">
                {days.map(([dayKey, dayEvents]) => (
                  <section key={dayKey} className="mb-2">
                    {/* Grouped-list header, Apple's sectioned-table treatment: a small
                        tracked label with a hairline that runs to the edge. The day
                        boundary is real structure — it is the one thing the reader
                        navigates by — so it gets a device, while the label itself stays
                        quiet enough that the event titles remain the loudest text. */}
                    <div className="day-heading pt-2.5 pb-2 mb-1.5">
                      <div className="flex items-center gap-2.5">
                        <h2
                          className={`t-label flex shrink-0 items-center gap-1.5 ${
                            dayKey === NOW_GROUP_KEY ? 'text-[#FF3B30]' : 'text-[#1D1D1F]'
                          }`}
                        >
                          {dayKey === NOW_GROUP_KEY ? (
                            <>
                              <span className="live-dot w-1.5 h-1.5 rounded-full bg-[#FF3B30]" />
                              Happening now
                            </>
                          ) : (
                            dayHeading(dayEvents[0].startDateTime)
                          )}
                        </h2>
                        {dayKey !== NOW_GROUP_KEY && (
                          <span className="shrink-0 text-[11.5px] text-[#8E8E93] tracking-[0]">
                            {fullDateIST(dayEvents[0].startDateTime)}
                          </span>
                        )}
                        {/* Hairline fills whatever space is left, so the rule always
                            reaches the column edge without a fixed width. */}
                        <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
                        <span className="tnum shrink-0 text-[11.5px] text-[#8E8E93]">
                          {dayEvents.length}
                        </span>
                      </div>
                    </div>
                    {dayEvents.map(event => (
                      <EventRow key={event._id} event={event} />
                    ))}
                  </section>
                ))}
              </div>
            )}

            {/* Infinite-scroll sentinel */}
            {pagination?.hasMore && (
              <div ref={sentinelRef} className="py-8 flex justify-center">
                {loadingMore ? (
                  <div className="spinner" />
                ) : (
                  <button
                    type="button"
                    onClick={loadMore}
                    className="px-6 py-2.5 rounded-full bg-white border border-[#e5e5ea] text-label-md font-semibold text-[#1D1D1F] hover:bg-[#f3f3f5] transition-colors"
                  >
                    Load more
                  </button>
                )}
              </div>
            )}

            {!loading && events.length > 0 && !pagination?.hasMore && (
              <p className="py-8 text-center text-[12.5px] text-[#a1a1a6]">
                That’s everything we have for now.
              </p>
            )}
          </div>
        </div>
      </main>

      {/* ── Mobile filter sheet ──────────────────────────────────────────── */}
      {sheetOpen && (
        <div className="lg:hidden fixed inset-0 z-[60] flex items-end">
          <button
            type="button"
            aria-label="Close filters"
            onClick={() => setSheetOpen(false)}
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          />
          {/* Three-row flex column, and ONLY the middle row scrolls.
              The header and footer used to be `sticky` inside a single scrolling
              box, which meant the "Show N events" button permanently overlaid the
              bottom of the filter list — measured with a clip-aware overlap probe,
              the "Event type" group heading sat 100% underneath it. A sticky
              element still occupies its place in flow, so no amount of bottom
              padding fixes that; the footer has to leave the scrollport. */}
          <div className="relative flex w-full max-h-[85vh] flex-col rounded-t-3xl bg-[#F5F5F7]">
            <div className="shrink-0 bg-[#F5F5F7]/97 glass-nav px-5 pt-3 pb-3 flex items-center justify-between border-b border-black/5 rounded-t-3xl">
              <span className="text-[17px] font-bold text-[#1D1D1F]">Filters</span>
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="w-8 h-8 rounded-full bg-white flex items-center justify-center"
                aria-label="Close filters"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[18px]">close</span>
              </button>
            </div>
            {/* min-h-0 is required: without it a flex child refuses to shrink below
                its content height and the panel grows past max-h instead of
                scrolling. */}
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <FilterRail facets={facets} filters={filters} onChange={setFilters} loading={loading} />
            </div>
            <div className="shrink-0 bg-[#F5F5F7]/97 glass-nav p-4 border-t border-black/5">
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="w-full py-3 rounded-full bg-[#1D1D1F] text-white text-label-md font-semibold"
              >
                Show {total.toLocaleString('en-IN')} event{total === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}

      <MobileBottomNav />
    </div>
  );
}

function FeedSkeleton({ view }: { view: ViewMode }) {
  if (view === 'grid') {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="bg-white rounded-2xl overflow-hidden card-shadow">
            <div className="skeleton aspect-[16/9]" />
            <div className="p-4 flex flex-col gap-2">
              <div className="skeleton h-3 w-24 rounded" />
              <div className="skeleton h-4 w-full rounded" />
              <div className="skeleton h-4 w-2/3 rounded" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="rail">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-stretch gap-3 md:gap-4">
          <div className="w-[42px] md:w-[58px] shrink-0 pt-4 flex justify-end">
            <div className="skeleton h-3.5 w-9 rounded" />
          </div>
          <div className="w-[9px] shrink-0 flex justify-center pt-[22px]">
            <span className="rail-node" />
          </div>
          <div className="flex-1 mb-3 bg-white rounded-2xl card-shadow p-3 md:p-4 flex gap-4">
            <div className="skeleton w-[76px] h-[76px] md:w-[104px] md:h-[104px] rounded-xl shrink-0" />
            <div className="flex-1 flex flex-col gap-2 py-1">
              <div className="skeleton h-4 w-3/4 rounded" />
              <div className="skeleton h-3 w-1/2 rounded" />
              <div className="skeleton h-5 w-40 rounded-full mt-auto" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon: string;
  title: string;
  body: string;
  action?: { label: string; onClick?: () => void; href?: string };
}) {
  return (
    <div className="bg-white rounded-2xl card-shadow py-16 px-6 text-center">
      <span aria-hidden="true" className="material-symbols-outlined text-[44px] text-[#d5d5da] block mb-3">{icon}</span>
      <p className="text-[17px] font-semibold text-[#1D1D1F]">{title}</p>
      <p className="text-[14px] text-[#6E6E73] mt-1.5 max-w-sm mx-auto">{body}</p>
      {action &&
        (action.href ? (
          <Link
            href={action.href}
            className="inline-block mt-6 px-6 py-2.5 rounded-full bg-[#1D1D1F] text-white text-label-md font-semibold hover:bg-black transition-colors"
          >
            {action.label}
          </Link>
        ) : (
          <button
            type="button"
            onClick={action.onClick}
            className="mt-6 px-6 py-2.5 rounded-full bg-[#0071E3] text-white text-label-md font-semibold hover:bg-blue-600 transition-colors"
          >
            {action.label}
          </button>
        ))}
    </div>
  );
}
