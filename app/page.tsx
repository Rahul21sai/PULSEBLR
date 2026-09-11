'use client';
import Link from 'next/link';

import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useSession } from 'next-auth/react';
import { DesktopNav, MobileBottomNav } from './components/NavBar';
import EventRow from './components/EventRow';
import EventGridCard from './components/EventGridCard';
import FilterRail, {
  FilterState,
  EMPTY_FILTERS,
  countActive,
  type FacetsWithCardMeta,
} from './components/FilterRail';
import EventShelf from './components/shelves/EventShelf';
import WeekAheadStrip, {
  bucketWeek,
  WEEK_AHEAD_DAYS,
  type WeekDay,
} from './components/shelves/WeekAheadStrip';
import { claimSection, shelfEligible, splitForPreview } from './components/shelves/precedence';
import { FeedEvent, Pagination } from '@/lib/event-types';
import { MIN_SEARCH_CHARS, resolveDayWindow } from '@/lib/events/query';
import { preferenceSummary, type UserPreferences } from '@/lib/events/relevance';
import {
  dayKeyIST,
  dayKeyOffsetIST,
  dayHeading,
  fullDateIST,
  isHappeningNow,
  NOW_GROUP_KEY,
} from '@/lib/format';

/**
 * The time window chips, BROADEST FIRST — and the order is a fix, not a preference.
 *
 * `All upcoming` (`id: ''`) is the DEFAULT state, so it is the chip that renders active on a cold
 * load. It used to be last in a 518px-wide row inside a 390px viewport, which meant a phone opened
 * on `Today | Tomorrow | …` with **no visible chip highlighted** — the reader could not tell what
 * the feed was showing, and the scroll needed to find out was unsignalled. Putting the default
 * first means the active chip is always at x=0 on a cold load, and the sequence then reads as a
 * narrowing: everything → today → tomorrow → this weekend → this week.
 *
 * Order is not load-bearing anywhere else: the URL reader matches by `id` with `.some()`.
 */
const WHEN_TABS = [
  { id: '', label: 'All upcoming' },
  { id: 'today', label: 'Today' },
  { id: 'tomorrow', label: 'Tomorrow' },
  { id: 'weekend', label: 'This weekend' },
  { id: 'week', label: 'Next 7 days' },
] as const;

/**
 * "Best for connections" is FIRST because it is the default (see the `sort` state below).
 * A select whose first option is not its current value reads as though the default were
 * arbitrary, which is exactly the impression this app's ranking should not give.
 */
/*
 * ── "MOST POPULAR" IS GONE FROM THE CONTROL, AND `popular` STAYS IN THE API ──────────────────
 *
 * `attendeeCount` exists on **4.4% of events** — only Luma supplies it — so the sort ranked about
 * 49 rows and then silently fell through to its `startDateTime` tiebreak for everything else.
 * Measured on the first 20 rows it returned: 11 online, and TWO organisers owned 12 of the 20.
 * That is not a popularity ranking, it is one platform's subscriber list followed by date order,
 * presented to the reader as a judgement about the city.
 *
 * The same reasoning removed the "Filling up fast" shelf (§15) and the "show all events" toggle
 * (§Architecture): a control whose output cannot mean what its label claims is worse than an
 * absent one, because a reader has no way to tell. `diag-demo-readiness.ts` measured this.
 *
 * REMOVED FROM THE UI ONLY. `SortKey`, `buildSort('popular')` and `?sort=popular` all still work
 * — exactly as `techOnly` remained a real parameter after its toggle went, and for the same
 * reason: expressing a UI decision by deleting a query parameter would be the wrong layer, and
 * the sort becomes honest the moment attendee coverage does.
 */
const SORTS = [
  { id: 'connections', label: 'Best for connections' },
  { id: 'soonest', label: 'Soonest' },
  { id: 'newest', label: 'Just added' },
] as const;

type ViewMode = 'rail' | 'grid';

/**
 * The two feeds, and the reason there are exactly two.
 *
 * ── A RECOMMENDER THAT SILENTLY HIDES EVENTS IS WORSE THAN NO RECOMMENDER. ───────────────────
 * A personalised ranking is a claim about the reader, and it is sometimes wrong. When it is, the
 * reader has to be able to see that — otherwise "there is nothing on this week" and "we decided
 * not to show you" are the same screen, and nothing on it tells them which. So the switch is a
 * visible pair of tabs, and it lives in the URL.
 *
 * `Everything` IS TODAY'S FEED, byte for byte. It sends the same params to the same endpoint with
 * the same default sort; the only difference is the tab that is drawn as active. That is what makes
 * the pair honest rather than decorative: whatever the personalised half does, there is a control
 * on screen that undoes all of it, and the thing it returns to is not a degraded fallback.
 *
 * `For you` re-ranks and NOTHING else. It sends `sort=foryou`, which
 * `lib/events/query.ts#buildForYouPipeline` answers with the same `buildEventFilter` output and an
 * `$addFields`/`$sort` — no extra `$match`, no threshold. Both tabs therefore report the same
 * total, which is the arithmetic form of the same promise.
 */
const FEED_TABS = [
  { id: 'for-you', label: 'For you' },
  { id: 'everything', label: 'Everything' },
] as const;

type FeedMode = (typeof FEED_TABS)[number]['id'];

/**
 * `Everything` IS THE DEFAULT, not `For you`.
 *
 * Most visitors are signed out or have never answered the three cards, and for them the two tabs
 * return the identical list — so opening on `For you` would advertise personalisation that had not
 * happened. Landing on `Everything` and being INVITED to personalise is the honest order, and
 * onboarding pushes `/?feed=for-you` itself once there is something to show.
 */
const DEFAULT_FEED: FeedMode = 'everything';

/** What `GET /api/me/preferences` returns. `personalised` is computed server-side — see the route. */
type PreferencesDTO = UserPreferences & { onboarded: boolean; personalised: boolean };

/**
 * How many events the spotlight promotes. Two, because they sit side by side at 16:9 on desktop
 * and a third would either shrink the covers below the point of having them or push the first
 * ranked row off a laptop screen. The cover image is the only colour this design system allows,
 * so the spotlight earns its space by showing two of them large.
 */
const SPOTLIGHT_COUNT = 2;

/**
 * How many hand-added events the "Curated by us" shelf shows.
 *
 * Six against the 5 that currently exist, so the shelf has room to grow without a code change,
 * and a ceiling so that a burst of manual adds cannot push the ranked feed off the screen —
 * which is the failure mode of an uncapped curated section.
 */
const CURATED_COUNT = 6;

/**
 * How many events the "Hosted by a company you follow" shelf shows.
 *
 * Six, matching the curated shelf, because they are the same treatment and a reader should not have
 * to work out why one rail is longer. It is also comfortably above the measured supply: 12 upcoming
 * tech events intersect the default follow list, so the shelf has room to grow before the cap bites,
 * and a cap exists at all so a reader who follows thirty companies cannot push the ranked feed off
 * the screen.
 */
const FOLLOWING_COUNT = 6;

/**
 * How many "Happening now" rows a PHONE draws before the rest go behind an expander.
 *
 * Two, and the number is the whole design. One would make the section read as "there is a live event"
 * when the honest statement is "there are several"; three is the case that was measured at 809px,
 * which is most of a phone screen spent before the ranked feed begins on a fact that is true for a
 * couple of hours.
 *
 * It bounds the RENDER, never the data: `splitForPreview` hands back both halves and both are in the
 * DOM (see the section itself). Live rows are subtracted from "Coming up", so a genuine cap here would
 * delete the third live event from a phone outright — the trap this whole page is arranged around.
 * From `sm` up nothing is deferred at all.
 */
const LIVE_PREVIEW = 2;

/**
 * How many events the week-ahead strip asks for.
 *
 * 100 is the route's own ceiling, and it is deliberately far above the supply rather than tuned to
 * it: the strip reports COUNTS, and a count computed from a truncated page is wrong in the one way
 * a reader cannot detect. Measured 2026-09-10 — 281 upcoming tech events in the entire corpus and
 * ~50 in any one week — so this covers a week several times over. `bucketWeek`'s header records what
 * happens if that ever stops being true, and the strip renders a `+` rather than a false total.
 */
const WEEK_STRIP_LIMIT = 100;

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
  /**
   * Events an admin added BY HAND rather than scraped — `source: 'manual'`, which is what
   * `POST /api/events` writes when a body names no source.
   *
   * A separate concern from `pinnedEvents`, which is why it is a separate piece of state: a pin
   * promotes something the scraper already found, while this is supply the scraper never had.
   * Hand-added events are the ones platform coverage misses (an invite-only company evening, a
   * college fest, anything announced only on WhatsApp), so they are worth their own shelf rather
   * than being left to compete for a ranked slot against 1200 scraped rows.
   */
  const [curatedEvents, setCuratedEvents] = useState<FeedEvent[]>([]);
  /**
   * Events hosted by a company the signed-in reader follows (`User.targetCompanies`).
   *
   * Empty for a signed-out visitor and for anyone following nobody, and empty is the correct,
   * ordinary state rather than a failure — the shelf simply does not render. The list is resolved
   * SERVER-SIDE from the session (`?followed=true`); this page never sends the company names,
   * because a shelf headed "a company you follow" must not be satisfiable by a URL.
   */
  const [followingEvents, setFollowingEvents] = useState<FeedEvent[]>([]);
  /**
   * The reader's own follow list, as the server resolved it — echoed back by `?followed=true`.
   *
   * Needed for the shelf's CAPTION, not for the query: an event can name three companies while the
   * reader follows only one of them, so naming a row's companies without this would put a company
   * they do not follow under a heading saying they do.
   */
  const [followedList, setFollowedList] = useState<string[]>([]);
  /** The next seven IST days, for the week-ahead strip. Its own request — see `load`. */
  const [weekDays, setWeekDays] = useState<WeekDay[]>([]);
  /** The week held more events than one page returned, so the strip's later counts may be low. */
  const [weekTruncated, setWeekTruncated] = useState(false);
  const [facets, setFacets] = useState<FacetsWithCardMeta | null>(null);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [when, setWhen] = useState<string>('');
  /**
   * One IST `YYYY-MM-DD` day the feed is narrowed to, from the week-ahead strip, or `''`.
   *
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * `day` AND `when` ARE MUTUALLY EXCLUSIVE, AND ONE RULE ENFORCES IT IN BOTH DIRECTIONS:
   * selecting a day clears `when`, selecting a `when` chip clears `day`. They are two controls for
   * the same thing — the window the feed covers — and letting both hold a value would produce a
   * highlighted chip reading "This weekend" above a strip highlighting Thursday, with the feed
   * obeying whichever `buildParams` happened to check first. This is the defect CLAUDE.md records
   * on the calendar, where an independent `currentDate` and `selectedDate` left the day panel headed
   * "7 September" describing a day with no square on screen.
   *
   * It is a KEY, never a `Date` — `resolveDayWindow` turns it into the request window, in IST, so a
   * reader outside IST gets the day they tapped rather than the browser's idea of it.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  const [day, setDay] = useState<string>('');
  /**
   * Set the day, clearing the other window control. Every day-selection path goes through this.
   *
   * A function rather than two `setState` calls at each call site, because "and clear the other one"
   * is the invariant above and a call site that forgets half of it produces exactly the
   * two-controls-disagreeing bug the comment describes.
   */
  const selectDay = useCallback((dayKey: string) => {
    setDay(dayKey);
    if (dayKey) setWhen('');
  }, []);
  /** Set the time window, clearing any selected day. The other half of the same invariant. */
  const selectWhen = useCallback((id: string) => {
    setWhen(id);
    setDay('');
  }, []);
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
  /**
   * Which of the two feeds is showing. See `FEED_TABS`.
   *
   * SEPARATE STATE FROM `sort`, not a value of it, and the distinction is load-bearing. A sort is
   * "in what order, among these events"; the feed is "by what standard". Folding `foryou` into the
   * `sort` select would have made the personalisation a dropdown option a reader has to go looking
   * for, and would have let the two be inconsistent — "For you, sorted by soonest" is a view that
   * ranks by nothing personal while a tab claims otherwise.
   */
  const [feed, setFeed] = useState<FeedMode>(DEFAULT_FEED);
  /**
   * The signed-in user's stored preferences, or `null` while unknown / signed out.
   *
   * STAMPED WITH THE USER ID IT WAS FETCHED FOR, and read back through `activePreferences` below,
   * which only hands it over when that id still matches the live session. Two reasons, and the
   * second is the real one:
   *
   *   · Clearing it on sign-out would mean a `setPreferences(null)` in an effect body, which
   *     React's compiler rules (correctly) reject — the same constraint that makes the URL reader
   *     and the feed loader in this file defer by a tick.
   *   · Sign out, sign in as a different Google account, and there is a window between the session
   *     settling and this fetch landing. Without the stamp, the PREVIOUS account's summary renders
   *     in the readout during it. Small, but it is the same class of cross-account bleed that made
   *     `sw.js` v3 necessary, and it costs one field to make structurally impossible.
   *
   * Only ever used to decide what to DRAW — which tab explanation to show, whether to offer the
   * onboarding prompt, and what to print in the readout. The ranking itself is computed server-side
   * from the same row, so a stale copy here can make the caption briefly wrong but can never make
   * the list wrong.
   */
  const [preferences, setPreferences] = useState<{ userId: string; value: PreferencesDTO } | null>(
    null
  );
  /** Locally dismissed onboarding prompt, so the banner goes away before the PUT lands. */
  const [promptDismissed, setPromptDismissed] = useState(false);
  // Tech-only is the DEFAULT view, not an option you have to find. This app exists
  // to surface Bengaluru SOFTWARE and HARDWARE events worth attending for the
  // connections; the other ~70% of the corpus (concerts, treks, book clubs) is
  // noise for that purpose and is one toggle away in the filter rail.
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [view, setView] = useState<ViewMode>('rail');
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * Has the reader asked to see every live event, rather than the first `LIVE_PREVIEW`?
   *
   * One-way on purpose (see the button): this reveals and then removes itself. It is deliberately NOT
   * reset by `load()` — a reader who expanded the section and then tapped a time-window chip has said
   * what they want to see, and re-collapsing it under them would be the page arguing back.
   */
  const [liveExpanded, setLiveExpanded] = useState(false);

  /**
   * The time-window chip scroller, so the ACTIVE chip can be brought into view.
   *
   * Needed because the row is wider than a phone: `?when=week` arriving from a shared link, or the
   * default landing on `All upcoming`, must not leave the highlighted chip off the right edge —   * which is precisely the state that made the row look like it had only two options.
   *
   * `scrollLeft` is assigned directly rather than calling `scrollIntoView()`, for two reasons.
   * `scrollIntoView` walks every scrollable ancestor, so it can scroll the PAGE as well as the row;
   * and its `behavior` default is `auto`, which defers to CSS `scroll-behavior` — globals.css
   * forces that to `auto` under `prefers-reduced-motion`, and an explicit `'smooth'` here would
   * override the user's setting. A direct assignment is instant and honours it by construction.
   */
  const chipRowRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const row = chipRowRef.current;
    if (!row) return;
    const active = row.querySelector<HTMLElement>('[data-active="true"]');
    if (!active) return;
    const centred = active.offsetLeft - (row.clientWidth - active.offsetWidth) / 2;
    row.scrollLeft = Math.max(0, Math.min(centred, row.scrollWidth - row.clientWidth));
    // `day` is a dependency because it decides whether ANY chip is active (see the chip row): with a
    // day selected the query below finds nothing and the row is left where it was, which is correct
    // — but it has to re-run on the transition back, or the chip that just became active is off
    // screen with nothing to scroll it into view.
  }, [when, day]);

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
      /*
       * VALIDATED THROUGH `resolveDayWindow`, not by a regex here. That function is what
       * `buildParams` will use, so validating with anything else means a value could pass this
       * check and then fail there — the strip would draw a day as selected while the feed showed
       * every upcoming event, which is the "the URL asserts something the feed does not do" failure
       * the `techOnly` note below is about.
       *
       * `setDay` directly rather than `selectDay`: `when` was set from the URL two lines up, and a
       * link carrying both is malformed. Clearing `when` here would silently pick a winner; letting
       * `buildParams`' documented precedence decide keeps one rule instead of two.
       */
      const d = p.get('day');
      if (d && resolveDayWindow(d)) setDay(d);
      const s = p.get('sort');
      if (s && SORTS.some(o => o.id === s)) setSort(s);
      const v = p.get('view');
      if (v === 'grid' || v === 'rail') setView(v);
      /*
       * The active feed comes out of the URL like everything else, so a personalised view is
       * shareable and survives a reload. Note what a SHARED `?feed=for-you` link does for the
       * recipient: the server sees no preferences for them and `buildSort('foryou')` degrades to the
       * corpus-wide ranking, so they get a sensible feed with the tab explaining that it is not
       * theirs yet — rather than somebody else's taste applied to them silently.
       */
      const f = p.get('feed');
      if (f !== null && FEED_TABS.some(t => t.id === f)) setFeed(f as FeedMode);

      const company = p.get('company');
      const category = p.get('category');
      const area = p.get('area');
      const format = p.get('format');
      /**
       * `techOnly` IS NO LONGER READ FROM THE URL, and that is the point of removing the toggle.
       *
       * It used to accept an explicit `?techOnly=false`. With the control gone from the rail, still
       * honouring the parameter would leave the escape hatch fully working for anyone who typed the
       * URL or followed an old link — the feed would quietly become 74% concerts and treks again,
       * with nothing on screen to explain why or to turn it back off. A UI decision that a query
       * string can override is not a decision.
       *
       * The parameter still exists on `/api/events` and in `buildEventFilter`, where /admin uses
       * it. This is the reader's feed choosing not to expose it.
       */

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
        };
        const unchanged =
          next.format === prev.format &&
          next.freeOnly === prev.freeOnly &&
          next.foodOnly === prev.foodOnly &&
          sameList(next.companies, prev.companies) &&
          sameList(next.categories, prev.categories) &&
          sameList(next.areas, prev.areas);
        return unchanged ? prev : next;
      });

      // Only now may the URL be written back.
      hydratedFromUrl.current = true;

      /**
       * STRIP A LEGACY `techOnly` FROM THE ADDRESS BAR.
       *
       * Done here rather than left to the URL writer below, because that effect cannot reach this
       * case: its deps are `[query, when, sort, view, filters]`, and hydration does not change any
       * of them — `techOnly` is pinned true in the initial state, so the read above computes an
       * identical object and returns `prev`. The writer therefore runs once BEFORE hydration
       * (returning early at the guard) and never again, leaving the param sitting there.
       *
       * It has to go rather than merely be ignored: an old bookmark or shared link reading
       * `?techOnly=false` would show a tech-only feed while the URL claimed otherwise, and that
       * URL then propagates every time it is copied.
       */
      if (p.has('techOnly')) {
        const cleaned = new URLSearchParams(window.location.search);
        cleaned.delete('techOnly');
        const qs = cleaned.toString();
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}${qs ? `?${qs}` : ''}`
        );
      }
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
   * wall of redundant params. `techOnly` used to be the exception — it defaulted to true, so
   * turning it OFF had to be recorded — and it is no longer written at all, because it can no
   * longer be turned off.
   */
  useEffect(() => {
    // Never write before the initial read has landed, or a shared link erases itself.
    if (!hydratedFromUrl.current) return;

    const p = new URLSearchParams();
    if (query) p.set('q', query);
    if (when) p.set('when', when);
    // Written alongside `when` rather than instead of it. They cannot both be set (see `selectDay`),
    // so this is not an either/or in practice — and writing it unconditionally means a shared link
    // round-trips whatever the state actually holds instead of what this effect assumes it holds.
    if (day) p.set('day', day);
    // Must track the DEFAULT above, not a hardcoded 'soonest'. This writer omits default values so
    // a clean view stays a clean "/" — so if it omitted the wrong one, opening "/" would render
    // ranked while the URL said nothing, and "?sort=soonest" would be written for the default and
    // dropped for the non-default. Exactly inverted.
    if (sort !== 'connections') p.set('sort', sort);
    if (view !== 'rail') p.set('view', view);
    if (feed !== DEFAULT_FEED) p.set('feed', feed);
    if (filters.categories.length) p.set('category', filters.categories.join(','));
    if (filters.areas.length) p.set('area', filters.areas.join(','));
    if (filters.companies.length) p.set('company', filters.companies.join(','));
    if (filters.format) p.set('format', filters.format);
    if (filters.freeOnly) p.set('isFree', 'true');
    if (filters.foodOnly) p.set('hasFood', 'yes');
    // Never serialised. It is unconditional now, so writing it would only produce a parameter
    // that looks like a choice and is not one — and a shared link carrying `techOnly=false`
    // would be a promise the feed no longer keeps.


    const qs = p.toString();
    const next = `${window.location.pathname}${qs ? `?${qs}` : ''}`;
    if (next !== window.location.pathname + window.location.search) {
      window.history.replaceState(null, '', next);
    }
  }, [query, when, day, sort, view, feed, filters]);

  /**
   * The signed-in user's preferences, for DRAWING only.
   *
   * Fetched separately from the feed rather than folded into `/api/events`, because the two have
   * different lifetimes: the feed re-fetches on every filter change and this changes when the user
   * edits it, which is roughly never. `status` is the dependency, so it runs once the session
   * settles and again on sign-in or sign-out.
   *
   * A FAILURE HERE IS SILENT ON PURPOSE. It decides a caption, a banner and a readout — the
   * ranking is computed server-side from the same stored row, so an unreadable copy here degrades
   * the explanation and never the list. Blanking the feed over it would be absurd.
   */
  const { data: session, status } = useSession();
  const sessionUserId = session?.user?.id ?? null;
  useEffect(() => {
    if (!sessionUserId) return;
    let live = true;
    (async () => {
      try {
        const res = await fetch('/api/me/preferences');
        if (!res.ok) return;
        const data = await res.json();
        if (live && data.preferences) {
          setPreferences({ userId: sessionUserId, value: data.preferences as PreferencesDTO });
        }
      } catch {
        // See above: an enhancement, not content.
      }
    })();
    return () => {
      live = false;
    };
  }, [sessionUserId]);

  /**
   * The preferences that belong to the CURRENT session, or null.
   *
   * Derived rather than stored, so signing out needs no write and a mid-flight account switch cannot
   * show one person's summary to another. Everything below reads this, never `preferences`.
   */
  const activePreferences =
    preferences && sessionUserId && preferences.userId === sessionUserId ? preferences.value : null;

  /**
   * Dismiss the onboarding invitation.
   *
   * Sends the SAME empty-body PUT the onboarding flow's Skip button sends, which stamps
   * `onboardedAt` server-side without touching a single preference. Reusing the skip rather than
   * adding a "dismiss" endpoint means there is one definition of "this user has been asked" — and
   * the alternative, a purely local dismissal, would bring the banner back on every visit until the
   * user gave in, which is nagging dressed as a choice.
   *
   * Optimistic: the banner goes immediately and the request is not awaited for the UI. A failure
   * leaves `onboardedAt` unset, so the invitation returns next visit — the correct degradation,
   * since it means the server never recorded the answer.
   */
  const dismissPrompt = useCallback(async () => {
    setPromptDismissed(true);
    try {
      await fetch('/api/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      setPreferences(prev => (prev ? { ...prev, value: { ...prev.value, onboarded: true } } : prev));
    } catch {
      // Nothing to report: the banner is already gone for this visit.
    }
  }, []);

  /**
   * One character is not a query. The API ignores a term this short — before
   * prefix-anchoring it matched 815 of 815 events — so the UI has to SAY that rather
   * than render the entire corpus and let the user believe it was a result set.
   */
  const needsMoreChars =
    searchInput.trim().length > 0 && searchInput.trim().length < MIN_SEARCH_CHARS;

  /**
   * The sort the API is actually asked for — ONE derivation, used by every request, by the day
   * grouping and by the readout.
   *
   * `For you` overrides the select rather than coexisting with it. Without a single source for this,
   * the sort the list was fetched with and the sort the page believes it is showing can differ, and
   * that is not a cosmetic bug: `chronological` below decides whether the rail may group by day, and
   * grouping by day under a ranked sort re-sorts the page chronologically and throws the ranking
   * away. That exact defect shipped once — a connectionScore-100 event rendered third.
   */
  const effectiveSort = feed === 'for-you' ? 'foryou' : sort;

  const buildParams = useCallback(
    (page: number) => {
      const params = new URLSearchParams();
      if (query) params.set('q', query);
      /*
       * ONE WINDOW, AND `day` OUTRANKS `when` — though the state invariant means they can never
       * both be set (see `selectDay`/`selectWhen`). The precedence is written down anyway because
       * this is the one place where a future third window control would silently produce two
       * `startDateTime` bounds, and `parseEventParams` resolves `when` only `if (!params.from)` —
       * so a `from` sent alongside a `when` wins on the server too. Matching that here keeps the
       * client's idea of the window and the server's identical.
       *
       * `resolveDayWindow` returning null (a hand-edited `?day=nonsense`) falls through to `when`,
       * i.e. to the whole upcoming window. That is the safe direction: the alternative is sending
       * `from=Invalid Date`, which serialises to `null` and widens the window while the strip still
       * draws a day as selected.
       */
      const dayWindow = day ? resolveDayWindow(day) : null;
      if (dayWindow) {
        params.set('from', dayWindow.from.toISOString());
        params.set('to', dayWindow.to.toISOString());
      } else if (when) {
        params.set('when', when);
      }
      if (filters.categories.length) params.set('category', filters.categories.join(','));
      if (filters.areas.length) params.set('area', filters.areas.join(','));
      if (filters.companies.length) params.set('company', filters.companies.join(','));
      if (filters.format) params.set('format', filters.format);
      if (filters.freeOnly) params.set('isFree', 'true');
      if (filters.foodOnly) params.set('hasFood', 'yes');
      /*
       * UNCONDITIONAL, and this is the single place that decides it. It used to read
       * `filters.techOnly`, which meant any state path that produced `false` — notably the two
       * resets passing `EMPTY_FILTERS` — silently reopened the 74%-non-tech feed. `techOnly` is
       * no longer in `FilterState` at all, so `false` is now unrepresentable rather than merely
       * unreachable. See the note above `FilterState` in FilterRail.tsx.
       */
      params.set('techOnly', 'true');
      params.set('sort', effectiveSort);
      params.set('page', String(page));
      params.set('limit', '30');
      return params;
    },
    [query, when, day, filters, effectiveSort]
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
      const wantsSpotlight = !query && countActive(filters) <= 1 && effectiveSort !== 'soonest';
      const pinnedParams = buildParams(1);
      pinnedParams.set('spotlight', 'true');
      pinnedParams.set('limit', String(SPOTLIGHT_COUNT));

      /*
       * The hand-added shelf. Same eligibility as the Spotlight — the untouched landing view —
       * so it costs nothing on a searched or filtered page.
       *
       * `sort=soonest`, NOT the default `connections`, and that is a deliberate exception to this
       * app's own thesis. Everywhere else the ranking is the product. Here a human already made
       * the quality judgement by typing the event in, so re-ranking the shelf by
       * `connectionScore` would second-guess the curation with a heuristic and could bury the
       * event the admin most wanted seen. What a reader still needs to know is WHEN, so the shelf
       * is chronological.
       *
       * It goes through `buildParams` like everything else, so a hand-added event still has to
       * be upcoming and still respects `techOnly` — being typed in by an admin does not exempt
       * a row from the filters the user can see.
       */
      const curatedParams = buildParams(1);
      curatedParams.set('source', 'manual');
      curatedParams.set('sort', 'soonest');
      curatedParams.set('limit', String(CURATED_COUNT));

      /*
       * "Hosted by a company you follow" — `Event.companies` x `User.targetCompanies`.
       *
       * `followed=true` AND NOTHING ELSE ABOUT COMPANIES. The list is read server-side from the
       * caller's own `User` row; this page does not know it and must not send it, because a shelf
       * whose heading says "a company you follow" would otherwise be satisfiable by anyone editing
       * the URL. An anonymous visitor gets an empty set, not an unfiltered one — the route's
       * `loadFollowedCompanies` returns `[]` and `buildEventFilter` turns that into a clause that
       * matches nothing.
       *
       * Same eligibility as the Spotlight, so a searched or filtered page spends nothing on it.
       */
      const followedParams = buildParams(1);
      followedParams.set('followed', 'true');
      followedParams.set('limit', String(FOLLOWING_COUNT));

      /*
       * THE WEEK-AHEAD STRIP, AND IT DELIBERATELY IGNORES THE WINDOW THE READER HAS CHOSEN.
       *
       * Every other request here goes through `buildParams` unchanged, so it obeys `when`/`day`.
       * This one overrides the window to the next seven days, because the strip is the control that
       * CHANGES the window: scoping it to the current selection would leave a reader who tapped
       * Thursday looking at a one-day strip with no way back to the rest of the week. It still
       * honours every other filter, so its counts agree with the feed on everything except the axis
       * it exists to move.
       *
       * `from`/`to` rather than `when=week`: `buildParams` may have set `from`/`to` for a selected
       * day, and `parseEventParams` resolves `when` only when `from` is absent — so sending
       * `when=week` would be silently ignored and the strip would show one day seven times.
       *
       * `sort=connections`, not `soonest`. `bucketWeek` takes the FIRST event it sees for a day as
       * that day's headline, so the sort decides what "the best thing on Thursday" means. Soonest
       * would make it "whatever starts earliest", i.e. a 9 AM webinar over an evening meetup with a
       * company host — the exact inversion CLAUDE.md measured when the whole feed sorted that way
       * (median score 20 against 88, 15 of 20 online).
       */
      const weekWindow = {
        from: resolveDayWindow(dayKeyIST(new Date())),
        to: resolveDayWindow(dayKeyOffsetIST(WEEK_AHEAD_DAYS - 1)),
      };
      const weekParams = buildParams(1);
      weekParams.delete('when');
      if (weekWindow.from && weekWindow.to) {
        weekParams.set('from', weekWindow.from.from.toISOString());
        weekParams.set('to', weekWindow.to.to.toISOString());
      }
      weekParams.set('sort', 'connections');
      weekParams.set('limit', String(WEEK_STRIP_LIMIT));
      // The strip is a time navigator, so it is drawn whenever the page is about browsing rather
      // than about a search. It stays up under active filters — that is what makes its counts a
      // readout of the filters — and only a query retires it, because then the page is about results.
      const wantsWeek = !query;

      const [listRes, facetRes, liveRes, pinnedRes, curatedRes, followedRes, weekRes] =
        await Promise.all([
          fetch(`/api/events?${params.toString()}`),
          fetch(`/api/events/facets?${params.toString()}`),
          fetch(`/api/events?${liveParams.toString()}`),
          wantsSpotlight ? fetch(`/api/events?${pinnedParams.toString()}`) : Promise.resolve(null),
          wantsSpotlight ? fetch(`/api/events?${curatedParams.toString()}`) : Promise.resolve(null),
          wantsSpotlight ? fetch(`/api/events?${followedParams.toString()}`) : Promise.resolve(null),
          wantsWeek ? fetch(`/api/events?${weekParams.toString()}`) : Promise.resolve(null),
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

      // Same shape as the pins, and for the same reason: an enhancement, cleared rather than
      // left stale when the view stops being eligible for it.
      if (curatedRes?.ok) {
        const curated = await curatedRes.json();
        if (generation === requestGeneration.current) {
          setCuratedEvents((curated.events || []) as FeedEvent[]);
        }
      } else if (!wantsSpotlight && generation === requestGeneration.current) {
        setCuratedEvents([]);
      }

      /*
       * Same contract as the pins and the curated shelf: an enhancement, CLEARED rather than left
       * stale when the view stops being eligible for it. A stale following shelf is worse than a
       * missing one — it would sit above a searched page claiming those results are hosted by
       * companies the reader follows.
       */
      if (followedRes?.ok) {
        const followed = await followedRes.json();
        if (generation === requestGeneration.current) {
          setFollowingEvents((followed.events || []) as FeedEvent[]);
          setFollowedList((followed.followed || []) as string[]);
        }
      } else if (!wantsSpotlight && generation === requestGeneration.current) {
        setFollowingEvents([]);
        setFollowedList([]);
      }

      /*
       * The week strip. Bucketed here rather than in the component so the component stays a pure
       * render of a `WeekDay[]` and `bucketWeek` stays testable without a DOM.
       *
       * `total > limit` is the truncation signal, and it comes from the SERVER's count rather than
       * from `events.length === limit` — the latter cannot tell a week that holds exactly 100 events
       * from one that holds 400, and the strip would report the first as approximate and the second
       * as exact.
       */
      if (weekRes?.ok) {
        const week = await weekRes.json();
        if (generation === requestGeneration.current) {
          const rows = (week.events || []) as FeedEvent[];
          setWeekDays(bucketWeek(rows));
          setWeekTruncated((week.pagination?.total ?? 0) > rows.length);
        }
      } else if (!wantsWeek && generation === requestGeneration.current) {
        setWeekDays([]);
        setWeekTruncated(false);
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
  }, [buildParams, query, filters, effectiveSort]);

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
   * Is the personalised tab actually personalised for THIS reader?
   *
   * `personalised` is computed by the server (`hasRankingPreferences`) rather than re-derived here,
   * because the rule is not obvious — all seven evenings says exactly what no evenings says, and the
   * two notification preferences say nothing about the feed at all. Two implementations of that
   * would drift, and the symptom would be a tab promising a ranking the server cannot produce.
   */
  const personalised = Boolean(activePreferences?.personalised);
  /**
   * Offer the three cards to a signed-in user who has never been asked.
   *
   * A BANNER, NOT AN INTERSTITIAL. An interstitial after first sign-in would block the thing the
   * user actually came for, and this app's entire value on a first visit is the feed itself. It is
   * also gated on a settled `activePreferences` so it cannot flash before the session and the fetch
   * land.
   */
  const showFeedSetupPrompt =
    status === 'authenticated' &&
    activePreferences !== null &&
    !activePreferences.onboarded &&
    !promptDismissed;

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
  const chronological = effectiveSort === 'soonest';

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
  const [liveNow, spotlight, curated, following, comingUp] = useMemo(() => {
    if (chronological)
      return [
        [] as FeedEvent[],
        [] as FeedEvent[],
        [] as FeedEvent[],
        [] as FeedEvent[],
        events,
      ];
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
     *
     * The test is `countActive(filters) === 0`. It was `<= 1`, justified by a comment saying
     * `techOnly` "is on by default and counts as one" — but `countActive` has never counted
     * `techOnly`, so the allowance was spurious and the Spotlight kept rendering above a feed the
     * user had already narrowed with one real filter. `techOnly` is not in `FilterState` at all
     * now, which makes the off-by-one unambiguous.
     *
     * The events are the top of the SAME ranking the list below uses, not a separate hand-picked
     * set. That is the difference from the site this was compared against, where the spotlight is
     * editorial and paid ("FLAGSHIP", "INVITE ONLY", "GET TICKETS"): ours is just the ranking
     * being honest about its own top result, so it cannot disagree with the list underneath it.
     */
    const eligible = shelfEligible(query, countActive(filters));
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

    /*
     * CURATED: hand-added events, after the two sections that outrank them.
     *
     * The precedence is live > spotlight > curated > coming up, and it is enforced by SUBTRACTION
     * at each step rather than by hoping the sets are disjoint — they are not. A hand-added event
     * can be in progress, and an admin can pin one, and it can also rank onto page 1 on its own
     * merit, so the same `_id` can legitimately arrive from three requests. Whichever section
     * claims it first wins, because "happening now" is a more urgent fact than "we added this",
     * which is in turn more specific than the ranking.
     */
    const hand = !eligible
      ? []
      : curatedEvents
          .filter(event => !seen.has(event._id) && !featuredIds.has(event._id))
          .slice(0, CURATED_COUNT);
    const handIds = new Set(hand.map(event => event._id));

    /*
     * FOLLOWING: events hosted by a company the reader follows, after the three that outrank it.
     *
     * ORDER: live > spotlight > curated > following > coming up. It sits below "curated" because a
     * hand-added event is the rarer and more specific claim — somebody typed it in — while following
     * is a standing preference that can match many events; and above "coming up" because it is a
     * fact about the reader rather than about the ranking.
     *
     * Done with `claimSection` rather than a fourth `!seen.has(id) && !featuredIds.has(id) &&
     * !handIds.has(id)` chain. The three sections above still spell theirs out (they predate this)
     * and adding a fourth in the same style is where the pattern breaks: the clause list grows with
     * every shelf, and forgetting one term does not crash — it renders one event twice in two
     * sections that each look right on their own. Threading the claimed set through makes that
     * impossible instead of merely unlikely. See `components/shelves/precedence.ts`.
     */
    const followed = claimSection(
      eligible ? followingEvents : [],
      new Set([...seen, ...featuredIds, ...handIds]),
      FOLLOWING_COUNT
    );
    const followedIds = new Set(followed.rows.map(event => event._id));

    return [
      live,
      featured,
      hand,
      followed.rows,
      ranked.filter(
        event =>
          !featuredIds.has(event._id) &&
          !handIds.has(event._id) &&
          !followedIds.has(event._id)
      ),
    ];
  }, [
    chronological,
    events,
    liveEvents,
    pinnedEvents,
    curatedEvents,
    followingEvents,
    query,
    filters,
  ]);

  /**
   * The live section, split into what a phone draws and what sits behind the expander.
   *
   * Both halves render — see the section and `splitForPreview`'s own header. Computed here rather than
   * inline so the section body reads as two lists rather than as two slices, and so the split is one
   * expression instead of one per call site.
   */
  const livePreview = useMemo(() => splitForPreview(liveNow, LIVE_PREVIEW), [liveNow]);

  /**
   * The following shelf's caption: the companies it actually matched on, named.
   *
   * IT MUST SIT BELOW THE PRECEDENCE MEMO ABOVE, and that is not a style preference. It reads
   * `following`, which that memo declares — `const [liveNow, spotlight, curated, following,
   * comingUp] = useMemo(...)`. Written above it, this is a `const` in its own temporal dead zone:
   * `error TS2448: Block-scoped variable 'following' used before its declaration`, and at runtime a
   * ReferenceError on first render rather than `undefined`, so the whole feed would blank rather
   * than lose a caption. Do not "group the memos together" by moving it back up.
   *
   * ONLY COMPANIES IN BOTH SETS. Intersecting the shelf's rows with the reader's own follow list is
   * what makes the caption true — a row can carry several company names and only one of them need be
   * followed, so naming every company on the shelf would put companies the reader does not follow
   * under a heading saying they do. `followedList` exists for this and nothing else.
   *
   * Three names then a count, because the caption sits on one line beside the heading and a fourth
   * would wrap it. Order follows the shelf's own ranking rather than the alphabet, so the company
   * behind the top row is named first.
   */
  const followingCaption = useMemo(() => {
    const followed = new Set(followedList);
    const named: string[] = [];
    for (const event of following) {
      for (const company of event.companies ?? []) {
        if (followed.has(company) && !named.includes(company)) named.push(company);
      }
    }
    if (named.length === 0) return `You follow ${followedList.length}`;
    const shown = named.slice(0, 3).join(', ');
    return named.length > 3 ? `${shown} +${named.length - 3}` : shown;
  }, [following, followedList]);

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
          {/* `py-1.5` below `md`, and the 4px a side it gives up is spent deliberately.
              `--commandbar-h` is 98px and lives in globals.css, which this change does not touch,
              so both rows have to fit inside it. Row 1 at `py-2.5` was 60px, leaving 34px for the
              chip row — not enough for the 44px touch target the chips were measured below. At
              `py-1.5` row 1 is 52px and the chip band is 46px, so a 44px overlay fits with 1px of
              slack top and bottom.

              `sm:` and not `md:`, because `sm` is exactly where the sort control stops collapsing to
              an icon and row 2 stops needing 44px. Restoring the original spacing only at `md`
              would leave 12px of dead space at the bottom of the bar between 640px and 767px. */}
          <div className="flex items-center gap-2 py-1.5 sm:py-2.5">
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

            {/* `gap-0`, not `gap-1`: with a 44px-tall `::after` overlay on each half, a 4px gap is
                a 4px dead strip between two adjacent targets — and the two halves of a segmented
                control should be contiguous anyway. Height reaches the 44px floor; WIDTH STAYS
                32px, because widening the painted pill would push it past row 1's 40px content
                height and out of the fixed command bar. */}
            <div className="hidden sm:flex shrink-0 items-center gap-0 bg-white border border-[#e5e5ea] rounded-full p-0.5">
              {(['rail', 'grid'] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setView(mode)}
                  aria-pressed={view === mode}
                  aria-label={mode === 'rail' ? 'Schedule view' : 'Grid view'}
                  className={`relative w-8 h-8 rounded-full flex items-center justify-center transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] ${
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

          {/* ── Time window chips + sort ------------------------------------
              THREE OF FIVE CHIPS WERE UNREACHABLE ON A PHONE. Measured at 390x844: the chip row
              lays out 518px wide, and the sort control — a native `<select>` sized by its longest
              option, "Best for connections" — took 174px of the 358px available, leaving the
              scroller ~168px. It scrolled, but with `no-scrollbar` and nothing cut off mid-chip
              there was no signal that it did, and the active chip (`All upcoming`) sat off the
              right edge entirely. Two changes, and BOTH are needed:

                1. The sort control collapses to a 44px icon below `sm` (see below), which returns
                   roughly 130px to the row.
                2. `WHEN_TABS` now leads with the DEFAULT window, so the active chip is at x=0 on a
                   cold load instead of off-screen.

              The row keeps `overflow-x-auto` and gains `snap-x snap-mandatory` — the same idiom as
              the "Curated by us" shelf — so a partially visible chip settles cleanly rather than
              being left cut mid-word. `gap-2 sm:gap-4`, because the 16px gutter to the sort control
              was itself 10% of the row on a phone. */}
          <div className="flex items-center justify-between gap-2 pb-0 sm:gap-4 sm:pb-1">
            <div
              ref={chipRowRef}
              className="flex snap-x snap-mandatory gap-1 overflow-x-auto overscroll-x-contain no-scrollbar -mx-1 px-1"
            >
              {/* `!day` IS PART OF "ACTIVE", AND IT IS NOT COSMETIC. With a day selected from the
                  week strip, `when` is `''` — so without this the "All upcoming" chip would render
                  highlighted above a feed showing one Thursday, and the reader would have two
                  controls on screen making contradictory claims about the same window. With a day
                  selected NO chip is active, which is the honest reading: the window came from the
                  strip, and the strip is where it is shown and cleared. */}
              {WHEN_TABS.map(tab => (
                <button
                  key={tab.id || 'all'}
                  type="button"
                  data-active={!day && when === tab.id}
                  onClick={() => selectWhen(tab.id)}
                  aria-pressed={!day && when === tab.id}
                  /* The PAINTED pill stays 32px: its height is part of the command bar's density
                     and of the type scale the design system pins (CLAUDE.md section 7, rule 1).
                     The TOUCH TARGET grows to 44px with an `::after` overlay instead — the WCAG
                     2.5.5 floor, and it matters here more than most places, since this is the
                     primary filter on a product used one-handed while standing at an event.

                     `-inset-y-1.5` is exactly 6px a side (32 -> 44) and no more, because the
                     command bar is a fixed `--commandbar-h` with `overflow-hidden`: an overlay
                     taller than the row's band would be clipped, and a clipped overlay is a dead
                     strip that MEASURES as a hit area without being one. */
                  className={`relative shrink-0 snap-start rounded-full px-3.5 py-1.5 text-[13px] font-semibold transition-colors after:absolute after:inset-x-0 after:-inset-y-1.5 after:content-[''] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] [touch-action:manipulation] ${
                    !day && when === tab.id
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
                product has that Luma and Meetup do not.

                BELOW `sm` IT IS A 44px ICON WITH THE NATIVE SELECT LAID TRANSPARENTLY OVER IT.
                The `<select>` is still the interactive element — native picker, keyboard, screen
                reader and form semantics all unchanged — it is simply `opacity-0` and stretched to
                fill the target, with a `swap_vert` glyph painted behind it. That is what buys the
                chip row its width back: a select sized by "Best for connections" spends 150px of a
                358px row on a control reached far less often than the time window.

                The focus ring moves to the WRAPPER, because a ring drawn on an invisible element is
                an invisible ring. `focus-within` rather than `has-[:focus-visible]` so it also
                fires on the keyboard path in browsers that do not match `:focus-visible` on a
                select. */}
            {/*
              IN `For you` THE SORT SELECT IS REPLACED BY A READOUT, NOT DISABLED AND NOT HIDDEN.
              ─────────────────────────────────────────────────────────────────────────────────────
              The personalised feed IS a ranking, so a second ranking control beside it would be
              two answers to one question: "For you, sorted by soonest" ranks by nothing personal
              while the tab claims otherwise. A disabled `<select>` would be worse — a dead control
              that says the feature is broken rather than that it does not apply.

              So the slot keeps its size and states what the order is instead. Nothing is lost: the
              `Everything` tab is one tap away with the full sort list, and the time-window chips
              beside this (Today / Tomorrow / This weekend) still answer "what is on tonight", which
              is the only question `soonest` was ever really for.
            */}
            {feed === 'for-you' ? (
              <span className="flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 text-[12.5px] font-semibold text-[#1D1D1F] sm:h-auto sm:w-auto">
                <span aria-hidden="true" className="material-symbols-outlined text-[19px] text-[#0071E3]">
                  auto_awesome
                </span>
                <span className="hidden sm:inline">Ranked for you</span>
              </span>
            ) : (
            <label
              htmlFor="event-sort"
              className="relative flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 rounded-full text-[12.5px] text-[#8E8E93] focus-within:ring-2 focus-within:ring-[#0071E3] sm:h-auto sm:w-auto sm:justify-start sm:rounded-none sm:focus-within:ring-0"
            >
              <span className="hidden sm:inline">Sort</span>
              <span className="material-symbols-outlined sm:hidden text-[19px]" aria-hidden="true">
                swap_vert
              </span>
              <select
                id="event-sort"
                name="sort"
                aria-label="Sort events by"
                value={sort}
                onChange={e => setSort(e.target.value)}
                className="absolute inset-0 h-full w-full cursor-pointer opacity-0 [touch-action:manipulation] sm:static sm:h-auto sm:w-auto sm:rounded-md sm:bg-transparent sm:py-0.5 sm:pr-1 sm:font-semibold sm:text-[#1D1D1F] sm:opacity-100 sm:focus:outline-none sm:focus-visible:ring-2 sm:focus-visible:ring-[#0071E3]"
              >
                {SORTS.map(option => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            )}
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
        {/* `pb-5` below `sm` only, was `pb-7` everywhere below `md`. See the paragraph below for the
            measurement this is part of: the hero was 367px on a 390px screen and every pixel of it is
            copy, so it is the one block above the feed that can be tightened without touching an
            event. `sm:pb-7` rather than letting `pb-5` run to `md`, so every width the phone budget is
            not about stays exactly as it was. */}
        <div className="max-w-[1240px] mx-auto px-4 md:px-8 pt-2 pb-5 sm:pb-7 md:pb-9">
          {/* Eyebrow: a short rule then letterspaced caps. `.t-label` is +0.055em because the
              type scale sets POSITIVE tracking for small caps — tight small caps are unreadable,
              which is the same rule that gives the headline below its negative tracking. */}
          {/* ── `hidden sm:flex`, AND THE WRAP IS THE REASON, NOT THE BUDGET. ────────────────────
              Screenshotted at 390px: the string is ~324px of tracked 11px caps against ~314px of
              room once the 32px rule and its 12px gap are taken, so it wrapped — leaving a hairline
              followed by two lines of capitals with "WORKSHOPS" alone on the second. A tracked label
              is a device for a single line; two lines of it is just noise at the very top of the
              page.

              Nothing is lost at this width, which is the other half of the argument: the sentence
              directly below names all four kinds in prose ("developer meetup, conference, hackathon
              and workshop"), so the eyebrow was restating it in a form that did not fit. Dropping it
              opens a phone on the headline, which is the strongest thing the hero has. The rule-plus-
              caps device still appears on every section heading down the page.

              `mt-0` on the H1 to match — leaving `mt-3.5` behind a hidden sibling is 14px of nothing
              at the top of the scroll area. 38px in total. */}
          <div className="hidden items-center gap-3 sm:flex">
            <span aria-hidden="true" className="h-px w-8 bg-[color:var(--hairline-strong)]" />
            <p className="t-label text-[#8E8E93]">
              Meetups · Conferences · Hackathons · Workshops
            </p>
          </div>

          <h1 className="t-hero max-w-[22ch] text-[#1D1D1F] sm:mt-3.5">
            Bengaluru tech events, ranked by who you’ll meet
          </h1>

          {/* ── THE TAIL OF THIS SENTENCE IS DESKTOP-ONLY, AND IT IS A MEASURED CUT. ────────────
              Measured in a static harness at 390×844: the paragraph wraps to FIVE lines of 15px
              (116px), inside a hero that is 367px in total — 43% of a phone screen spent on copy
              before the reader reaches a control, let alone an event. The two lines that survive
              carry the one fact the headline above does not state (what counts as an event here);
              the tail restates the headline's own claim — "ranked by who you'll meet" — and points
              at the scanner, which the stats line below already links to and the bottom nav already
              carries. Two lines instead of five is 70px back.

              ONE SENTENCE, NOT TWO COPIES OF IT. The mobile text is a PREFIX of the desktop text, so
              there is nothing to keep in step: a `hidden sm:inline` span holds the tail and a
              `sm:hidden` span holds the full stop that would otherwise be inside it. Two `<p>`s with
              two hand-written versions is the shape that drifts, and prose drifting is worse than
              markup drifting because nobody diffs it.

              THIS IS COPY, NOT A CARD. Every section below subtracts its events from "Coming up", so
              a card a phone does not draw is gone from the phone — that rule is why the shelves are
              scrollers rather than shorter lists. It does not reach a sentence: nothing is
              subtracted, nothing becomes unreachable, and the full text is one breakpoint away. */}
          <p className="mt-4 max-w-[64ch] text-[15px] leading-[1.55] text-[#3a3a3c]">
            Every{' '}
            <strong className="font-semibold text-[#1D1D1F]">
              developer meetup, conference, hackathon and workshop
            </strong>{' '}
            in the city, in one place
            <span className="sm:hidden">.</span>
            <span className="hidden sm:inline">
              {' '}
              — sorted by whether you’ll leave with useful contacts, not just by what’s on soonest.
              Scan a badge and keep the people you met.
            </span>
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

        {/* ── The two feeds ──────────────────────────────────────────────────
            Placed here, between the hero and everything the ranking touches, because its scope IS
            everything below it — the Spotlight's fallback, the curated shelf's ordering and the
            list. Not in the command bar above: that bar is a fixed `--commandbar-h` with
            `overflow-hidden` and two full rows, so a third row would be clipped, and a clipped
            control measures as a hit area without being one.

            Both tabs are shown to everybody, including signed-out visitors. Hiding `For you` from
            them would make a shared `?feed=for-you` link land on a page with no explanation for why
            it is not personalised — the tab plus one line of copy is a better answer than a missing
            control. */}
        <div className="max-w-[1240px] mx-auto px-4 md:px-8 pb-6">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5">
            <div
              role="group"
              aria-label="Choose how the feed is ranked"
              className="inline-flex shrink-0 items-center gap-0.5 rounded-full bg-white p-1 shadow-[inset_0_0_0_1px_var(--hairline-strong)]"
            >
              {FEED_TABS.map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  aria-pressed={feed === tab.id}
                  onClick={() => setFeed(tab.id)}
                  /* 36px painted inside a 44px row (`p-1` on the container plus this height), so the
                     WCAG 2.5.5 floor is met without an `::after` overlay — unlike the chips in the
                     command bar, nothing clips here. */
                  className={`pressable relative h-9 rounded-full px-4 text-[13px] font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] [touch-action:manipulation] ${
                    feed === tab.id
                      ? 'bg-[#1D1D1F] text-white'
                      : 'text-[#6E6E73] hover:bg-[#F0F0F2] hover:text-[#1D1D1F]'
                  }`}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* WHAT THE PERSONALISED TAB IS ACTUALLY DOING, in one line.
                Four states, and the two "not yet" ones both say that the ORDINARY ranking is what
                is showing. Without that sentence a reader on `For you` with no preferences would
                believe they were looking at a tailored list, which is the quiet dishonesty the whole
                two-tab arrangement exists to avoid. Nothing is drawn while the session or the fetch
                is still settling, so no state flashes the wrong claim. */}
            {feed === 'for-you' && (
              <p className="min-w-0 text-[12.5px] leading-relaxed text-[#6E6E73]">
                {status === 'unauthenticated' ? (
                  <>
                    Showing the usual ranking —{' '}
                    <Link
                      href="/login?callbackUrl=%2Fonboarding"
                      className="font-semibold text-[#0071E3] hover:underline"
                    >
                      sign in
                    </Link>{' '}
                    to rank it around your topics, areas and evenings.
                  </>
                ) : activePreferences === null ? null : personalised ? (
                  <>
                    Ranked by who you’ll meet <span className="text-[#a1a1a6]">×</span> what fits you
                    {preferenceSummary(activePreferences) && (
                      <>
                        {' · '}
                        <span className="font-semibold text-[#1D1D1F]">
                          {preferenceSummary(activePreferences)}
                        </span>
                      </>
                    )}
                    {' · '}
                    <Link
                      href="/onboarding?from=settings"
                      className="font-semibold text-[#0071E3] hover:underline"
                    >
                      Edit
                    </Link>
                  </>
                ) : (
                  <>
                    Showing the usual ranking —{' '}
                    <Link href="/onboarding" className="font-semibold text-[#0071E3] hover:underline">
                      tell us what you’re into
                    </Link>{' '}
                    and this becomes yours.
                  </>
                )}
              </p>
            )}
          </div>

          {/* THE INVITATION, for a signed-in user who has never been asked.
              Deliberately not an interstitial after first sign-in: that would block the feed, which
              is the entire reason they are here. Dismissing it records the answer server-side (see
              `dismissPrompt`) so it is asked once, not every visit. */}
          {/* ── `min-w-0` MADE THIS 251px TALL ON A PHONE, AND THE FIX IS A FLOOR, NOT LESS COPY. ──
              Measured in a static harness at 390×844: this banner was **251px** — taller than the
              week-ahead strip and the following shelf combined — for a prompt with one sentence in
              it. The cause is the flex arithmetic, not the words. `flex-wrap` with a `flex-1 min-w-0`
              paragraph lets that paragraph shrink to nothing rather than push a sibling onto the next
              row, so the 20px icon and the ~150px button pair both stayed on row one and the
              paragraph got the ~140px left over — wrapping to four lines in a column half the width
              of the card it sits in.

              `min-w-[11rem]` gives it a floor, so the buttons wrap to their own row and the copy gets
              the full width of row one. Same elements, same order, same wrap rules — 251px → 110px.

              The tail of the sentence is desktop-only for the same reason as the hero paragraph: it
              enumerates the three questions that the page it links to asks anyway. "Nothing gets
              hidden either way" is the sentence worth keeping and it is kept, because it is the
              answer to the objection a reader actually has. */}
          {showFeedSetupPrompt && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2.5 sm:gap-x-4 sm:gap-y-2 rounded-[14px] bg-white px-4 py-3 shadow-[inset_0_0_0_1px_var(--hairline)]">
              <span aria-hidden="true" className="material-symbols-outlined shrink-0 text-[20px] text-[#0071E3]">
                tune
              </span>
              <p className="min-w-[11rem] flex-1 text-[13px] leading-relaxed text-[#3a3a3c]">
                <span className="font-semibold text-[#1D1D1F]">Make this feed yours.</span> Three
                questions
                <span className="hidden sm:inline">
                  {' '}
                  — what you’re into, which areas you can reach, and which evenings work
                </span>
                . Nothing gets hidden either way.
              </p>
              <div className="flex shrink-0 items-center gap-2">
                <Link
                  href="/onboarding"
                  className="pressable inline-flex h-9 items-center rounded-full bg-[#1D1D1F] px-4 text-[12.5px] font-semibold text-white hover:bg-black"
                >
                  Set it up
                </Link>
                <button
                  type="button"
                  onClick={dismissPrompt}
                  className="h-9 rounded-full px-3 text-[12.5px] font-semibold text-[#8E8E93] hover:text-[#1D1D1F]"
                >
                  Not now
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── The week ahead ─────────────────────────────────────────────────
            FIRST OF THE SECTIONS, above every shelf, because it is the only one that is NAVIGATION
            rather than content: it answers "what does my week look like" and then lets a reader
            narrow to a day. Putting it below the shelves would mean scrolling past curated content
            to reach the control that decides what the page is showing.

            It is NOT in the `useMemo` chain and claims none of its events — see the component
            header. A day cell names an event; it does not render its card, and subtracting seven
            events from the feed so they could be named here would remove this week's best events
            from the list underneath.

            Rendered under a chronological sort too, unlike the shelves below: the strip is about
            time, so `soonest` is the view it makes the most sense in, not the one it should vanish
            from. */}
        <WeekAheadStrip
          days={weekDays}
          selectedDay={day}
          onSelectDay={selectDay}
          truncated={weekTruncated}
        />

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
          <section className="max-w-[1240px] mx-auto px-4 md:px-8 pb-6 sm:pb-8">
            <div className="day-heading pb-2 mb-3.5">
              <div className="flex items-center gap-2.5">
                <h2 className="t-label shrink-0 text-[#1D1D1F]">Spotlight</h2>
                <span aria-hidden="true" className="h-px flex-1 bg-[color:var(--hairline)]" />
                {/* Says which of the two modes produced this. Not decoration: "hand-picked" and
                    "top of the ranking" are different claims, and a reader who cannot tell which
                    one they are looking at has no way to judge it. */}
                {/* THREE modes now, not two. The unpinned fallback is the top of whichever ranking
                    is active, so on `For you` it is the personalised one — and saying "Best for
                    connections" there would name a ranking that is not the one that chose these two
                    events. The caption's whole job is to let a reader judge the claim. */}
                <span className="shrink-0 text-[11.5px] text-[#8E8E93]">
                  {pinnedEvents.length > 0
                    ? 'Hand-picked'
                    : feed === 'for-you' && personalised
                      ? 'Best for you right now'
                      : 'Best for connections right now'}
                </span>
              </div>
            </div>
            {/* TWO PRESENTATIONS OF THE SAME TWO EVENTS, chosen by width — not two different
                sets, and the section is never hidden. It cannot be: the memo REMOVES these from
                "Coming up" so nothing is listed twice, so CSS-hiding the section would delete the
                two best events from a phone entirely. That is the trap here, and it is why this
                switches the treatment rather than the visibility.

                ── THE MOBILE HALF IS A SCROLLER NOW, NOT TWO STACKED RAIL ROWS. ──────────────────
                What this comment used to say, and it was true of what it was comparing: two cover
                cards STACKED are 391px each and pushed the first ranked row to y=1511, so phones got
                compact rail rows instead at ~192px each. The option it did not consider is the one
                the curated shelf below settled on afterwards — a horizontal snap scroller, which
                costs ONE card height however many cards it holds.

                Measured in a static harness at 390×844, worst-case content, same two events:

                  two stacked rail rows      520px
                  two-card cover scroller    441px

                So the scroller is 79px cheaper AND it is the treatment that actually delivers what
                this section is for. The rail row gives a cover a 76px thumbnail; the scroller gives
                it 262×147. globals.css rations one accent colour precisely so covers are the only
                colourful thing on screen, and on the two events the page is promoting hardest, a
                phone had been seeing thumbnails.

                The cost, stated plainly: with two cards, one is fully visible and about 40% of the
                second is, where two rows showed both. That is what snap scrolling is for, and it is
                the same bargain the curated shelf makes with six. Nothing is dropped — both cards
                are in the DOM, reachable by swipe and by Tab, which scrolls a focused link into
                view. `-mx-4 px-4` bleeds the cards to the screen edge so the row reads as continuing
                past it while the first stays aligned with the heading. */}
            <div className="hidden gap-5 sm:grid sm:grid-cols-2">
              {spotlight.map(event => (
                <EventGridCard key={event._id} event={event} />
              ))}
            </div>
            <div className="-mx-4 flex snap-x snap-mandatory gap-3.5 overflow-x-auto overscroll-x-contain px-4 pb-1 no-scrollbar sm:hidden">
              {spotlight.map(event => (
                <div key={event._id} className="w-[262px] shrink-0 snap-start">
                  <EventGridCard event={event} />
                </div>
              ))}
            </div>
          </section>
        )}

        {/* CURATED BY US — the events a human typed in.

            WHY IT IS A SECTION AND NOT JUST A BADGE. `source: 'manual'` marks the one part of the
            corpus that did not come from a platform, which means it is exactly the supply the
            scrapers cannot reach: an invite-only company evening, a college fest, something
            announced only in a WhatsApp group. Left to the ranking those rows compete against
            ~1200 scraped ones and are seen only if `connectionScore` happens to favour them.

            Rendered only when non-empty, and empty is the ordinary state on a database where
            nobody has used /add-event — same contract as the Spotlight's pin set.

            ── IT IS `EventShelf` NOW, NOT A HAND-ROLLED COPY OF IT. ────────────────────────────────
            This section used to spell out its own heading row and both width treatments, which were
            character-for-character what `EventShelf`'s `cover` variant already renders. Two copies of
            a layout decision drift, and the drift is invisible: each looks right on its own. The swap
            is exact — same heading device, same caption slot, same `sm:hidden` scroller and
            `hidden rail sm:block` fallback.

            ── `compactOnMobile`: THE BIGGEST SINGLE SAVING ON THE PHONE. ───────────────────────────
            Measured in a static harness at 390×844, worst-case content, the same six events:

              cover cards in a scroller     449px
              compact cards in a scroller   164px

            285px — a third of a phone screen. The shelf's own prop comment carries the argument for
            why the cover is the wrong thing to spend it on at this width; the short version is that a
            262px cover in a scroller shows one and a half of six, while when/where/who are text and
            legible at 248px. Every one of the six still renders, in order, reachable by swipe and by
            Tab. That is the line this stays on the right side of: it changes the CARD, never the
            number of cards, because the memo above subtracts these ids from "Coming up" and a row a
            phone does not draw would be gone from the phone entirely.

            From `sm` up nothing changes: the cover rail is still what a laptop gets. */}
        {/* No `curated.length > 0 &&` guard, matching the following shelf below: `EventShelf` returns
            null on an empty list precisely so no caller repeats the condition, and an empty curated
            shelf is the ORDINARY state on a database where nobody has used /add-event. */}
        <EventShelf
          heading="Curated by us"
          /* States the PROVENANCE, which is the entire claim the section makes — and on mobile it is
             now the ONLY place that claim appears, since the compact card has no pill row and it was
             `EventPills` that drew the "Curated" pill. The count sits in the caption rather than the
             heading so the heading stays a stable landmark for a screen reader instead of changing
             every time the shelf does. */
          caption={`Added by hand · ${curated.length}`}
          events={curated}
          compactOnMobile
        />

        {/* HOSTED BY A COMPANY YOU FOLLOW — `Event.companies` x `User.targetCompanies`.

            WHY THIS SHELF AND NOT A POPULARITY ONE. The competitor's strongest shelf is "filling up
            fast", and copying it was rejected on measurement: `attendeeCount` is a number on 75 of
            1146 upcoming events and non-zero on 45, because only Luma supplies it — so the shelf
            would render nearly empty and read as broken. This uses two fields that are already
            populated, and it asks a better question. "500 people are going" is a fact about a room;
            "Microsoft is hosting this and you follow Microsoft" is a fact about the reader.

            THE CAPTION NAMES THE COMPANIES, and that is the honest form of the claim. A bare
            "because you follow them" is unfalsifiable — the reader cannot tell whether the shelf
            worked or whether it is showing them anything at all. Naming Microsoft and Google lets
            them judge it, and lets them notice when a company they care about is missing.

            It renders for nobody who is signed out and for nobody following anything, and both of
            those are ordinary states rather than failures — `EventShelf` returns null on an empty
            list. Worth knowing before wondering why it is not there. */}
        <EventShelf
          heading="Hosted by a company you follow"
          caption={followingCaption}
          events={following}
          /* COMPACT, not the cover rail the curated shelf uses, and `EventShelf`'s own header carries
             the argument: this shelf sits directly beneath a 441px cover rail and would read as the
             same block, its justifying fact (the company) is not on a cover at all, and measured on a
             390px screen it is ~180px against 441px on a page that had already spent 2008px above the
             feed. All three point the same way. */
          variant="compact"
          highlight={followedList}
        />

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
            {/* `mb-4 sm:mb-5` — the same 8px-a-section argument as the shelves above, applied to the
                last gap before the first ranked row. */}
            <div className="mb-4 sm:mb-5" aria-live="polite" aria-atomic="true">
              <h2 className="t-display text-[#1D1D1F]">
                {/* Always the tech heading: the feed is unconditionally tech-only, so the old
                    `filters.techOnly` ternary had a branch that could only ever render if the
                    feed had silently stopped being what it says it is. */}
                {query ? `“${query}”` : 'Tech events in Bengaluru'}
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
                    {/* Reads `effectiveSort`, not `sort`. In `For you` the select is not what
                        decides the order, so switching on `sort` here would print "ranked by who
                        you'll meet there" beside a list that was ranked by something else — a
                        readout that is confidently wrong is worse than no readout. */}
                    {effectiveSort === 'foryou' &&
                      (personalised
                        ? ' · ranked for you'
                        : ' · ranked by who you’ll meet there')}
                    {effectiveSort === 'connections' && ' · ranked by who you’ll meet there'}
                    {effectiveSort === 'soonest' && !query && ' · soonest first'}
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
                          // Through `selectWhen`, so clearing the filters also clears a selected
                          // day. Calling `setWhen('')` alone would leave the feed narrowed to one
                          // day by a control the user had just asked to reset.
                          selectWhen('');
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
                    {/* ── "HAPPENING NOW" HAD NO CAP, AND IT IS THE ONLY SECTION WHOSE HEIGHT IS
                        DECIDED BY THE CITY RATHER THAN BY THIS FILE. ─────────────────────────────
                        Measured in a static harness at 390×844: three live events are 809px of rows
                        before the ranked feed even starts. Nothing bounds it — `liveEvents` is its
                        own `sort=soonest` request with `limit=20`, so a festival Saturday could put
                        twenty rows here. A quiet Tuesday and a busy Saturday therefore produce very
                        different pages, and only one of them was ever measured.

                        DEFERRED, NOT DROPPED, AND ONLY ON A PHONE. `splitForPreview` returns both
                        halves and both are rendered; the deferred rows carry `hidden sm:block`, so a
                        laptop — which has the room and never had the problem — is byte-identical to
                        before, and a phone shows two rows plus a control that NAMES how many it is
                        holding. The count in the heading beside it is `liveNow.length`, the true
                        total, so the section never under-reports what is on.

                        This is the one place on the page where a cap would have been fatal rather
                        than merely rude: live rows are subtracted from "Coming up", so `slice(0, 2)`
                        would delete the third live event from the phone with nothing anywhere to
                        reach it. `splitForPreview` exists so that guarantee is a tested property
                        rather than a promise — see tests/shelves.test.ts. */}
                    {livePreview.shown.map(event => (
                      <EventRow key={event._id} event={event} showDate />
                    ))}
                    {livePreview.deferred.map(event => (
                      <div key={event._id} className={liveExpanded ? undefined : 'hidden sm:block'}>
                        <EventRow event={event} showDate />
                      </div>
                    ))}
                    {livePreview.deferred.length > 0 && !liveExpanded && (
                      /* `pl-[75px]` lines the control up with the CARDS rather than the section
                         edge, so it reads as belonging to the list instead of to the rail: 42px time
                         column + 12px gap + 9px node column + 12px gap. No `md:` variant is needed —
                         the whole control is `sm:hidden`.

                         A plain action button with no `aria-expanded`, matching "Load more" further
                         down this file. `aria-expanded` would be a lie here: the control does not
                         toggle, it reveals and then goes, because collapsing what is on RIGHT NOW
                         back out of view is not something a reader wants twice.

                         `min-h-11` for the 44px floor. It stands alone with 12px of clearance either
                         side, so it needs no `::after` overlay and contests no neighbour's band —
                         which is the failure the scan-sheet note warns about when two overhangs meet. */
                      <div className="mb-3 pl-[75px] sm:hidden">
                        <button
                          type="button"
                          onClick={() => setLiveExpanded(true)}
                          className="pressable inline-flex min-h-11 items-center gap-1.5 rounded-full bg-white px-4 text-[12.5px] font-semibold text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline-strong)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] [touch-action:manipulation]"
                        >
                          <span className="tnum">{livePreview.deferred.length}</span> more happening
                          now
                          <span aria-hidden="true" className="material-symbols-outlined text-[18px]">
                            expand_more
                          </span>
                        </button>
                      </div>
                    )}
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
