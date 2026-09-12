'use client';
import Link from 'next/link';

import { useCallback, useEffect, useState } from 'react';
import { DesktopNav, MobileBottomNav } from '../components/NavBar';
import {
  IST,
  categoryAccent,
  dayKeyIST,
  locationLabel,
  shortDateIST,
  timeIST,
  todayKeyIST,
} from '@/lib/format';

interface Event {
  _id: string;
  title: string;
  startDateTime: string;
  category: string[];
  format: string;
  venue?: string;
  area?: string;
  city?: string;
  hasFood: string;
  isFree: boolean;
  sourceUrl: string;
}

/**
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 * THE GRID IS ADDRESSED BY IST DAY KEY, NOT BY `Date`. That is the correctness fix in this file.
 *
 * The month was built with date-fns (`startOfMonth`, `eachDayOfInterval`, `getDay`) and each square
 * was rendered with `format(day, 'd')` — all of which read the BROWSER's clock. The dots come from
 * `/api/events/calendar`, which buckets with `$dateToString … timezone: 'Asia/Kolkata'`. So the two
 * halves of this page were keyed to two different calendars, and they only agree when the browser
 * happens to be in IST.
 *
 * Concretely, from a browser east of IST (NZ, +13): local midnight on 1 September is 31 August
 * 16:30 IST, so the square drawn as "1" asked for 31 August's events. West of IST the day panel
 * broke instead — `setHours(0,0,0,0)` on a UTC laptop fetched 00:00Z–23:59Z, i.e. IST 05:30 today
 * through 05:29 tomorrow: a half-day-shifted list under a heading naming the right day.
 *
 * Every off-by-one of that shape is structurally impossible now. A day is a `YYYY-MM-DD` string
 * produced by `dayKeyIST` — the same helper the feed groups by — the month is `YYYY-MM`, and the
 * calendar arithmetic (how many days, which weekday the 1st is) runs in UTC where it is pure
 * calendar maths with no zone in it. `Date` objects are built only to hand an instant to the API or
 * to a formatter that is itself pinned to IST.
 *
 * A `Date` is never used as a day identity here. Do not reintroduce one.
 * ───────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Month name / year / "7 September" — all pinned to IST, like everything in lib/format.ts. */
const monthNameFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, month: 'long' });
const yearFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, year: 'numeric' });
const dayMonthFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric', month: 'long' });

/**
 * An instant at IST midday for a `YYYY-MM-DD` key, purely to feed the IST formatters above.
 *
 * Midday rather than midnight so the instant sits a long way from either boundary: nothing here
 * depends on that (IST has no DST and the formatters are pinned), but a midday instant is also the
 * right answer if this value is ever read with the ambient zone by mistake.
 */
const istMidday = (dayKey: string) => new Date(`${dayKey}T12:00:00+05:30`);

/** Days in an IST month, from UTC calendar maths — day 0 of the next month is the last of this one. */
function daysInMonth(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Weekday (0 = Sunday) of the 1st, so the grid pads correctly. Pure calendar maths. */
function firstWeekday(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
}

/** Shift a `YYYY-MM` key by whole months. */
function shiftMonth(monthKey: string, delta: number): string {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/**
 * `CAT_BAR` IS GONE. `categoryAccent()` in lib/format.ts already did this job, for all 22 current
 * categories, and is what every other surface uses.
 *
 * The local map was a stale second palette: two of its seven keys — `Fintech` and
 * `Networking/Meetup` — are RETIRED names from the 32-value taxonomy (see `CATEGORY_MIGRATION` in
 * lib/models/Event.ts), so those colours could never match anything stored. It covered 5 of 22 live
 * categories, so the commonest ones — `Meetup`, `Conference`, `Workshop` — all fell to the same grey
 * default: a colour system the bars implied and did not have.
 */

/** The events API caps a page at 100. Naming it keeps the request and the panel's copy in step. */
const DAY_LIMIT = 100;

export default function CalendarPage() {
  /**
   * The grid needs COUNTS; only the selected day needs event documents.
   *
   * Fetching a page of events and grouping it client-side is what broke this page: the API caps
   * `limit` at 100 and sorts soonest-first, so for a 713-event month it returned 100 rows that all
   * fell on four consecutive days and the grid drew four dots across 31 squares.
   * `/api/events/calendar` aggregates in Mongo and returns ~31 rows however busy the month is.
   */
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [monthTotal, setMonthTotal] = useState(0);
  const [events, setEvents] = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [dayLoading, setDayLoading] = useState(false);
  /**
   * Failures are SHOWN, not swallowed.
   *
   * Both fetches used to `console.error` and fall through to empty state, so a 500 from the counts
   * route rendered "No events this month" — a confident factual claim about Bengaluru standing in
   * for a broken request, and the most alarming failure reading as the most reassuring answer.
   */
  const [monthError, setMonthError] = useState(false);
  const [dayError, setDayError] = useState(false);
  /** Total for the selected day, which can exceed what one page returns. */
  const [dayTotal, setDayTotal] = useState(0);

  /**
   * ONE piece of state, not two. The visible month is DERIVED from the selected day.
   *
   * They used to be independent (`currentDate` and `selectedDate`), which let them disagree — and
   * they did, immediately: paging from September to October left the panel headed "7 September",
   * describing a day with no square on screen, while no square in October was highlighted at all.
   * Two controls for one idea, and nothing kept them in step.
   *
   * Deriving the month means the grid and the panel cannot contradict each other by construction,
   * which is the same argument as sharing `buildEventFilter` between the dots and the day list.
   */
  const [selectedKey, setSelectedKey] = useState(() => todayKeyIST());
  const monthKey = selectedKey.slice(0, 7);

  /**
   * Page a whole month, and land on a day that EXISTS in it — today when that month is the current
   * one (matching the Today button), otherwise the 1st. Never a day the grid is not showing.
   *
   * The updater form is load-bearing, not style. `setSelectedKey(shiftMonth(monthKey, 1))` reads
   * `monthKey` out of the render that drew the button, so React batching collapses fast repeat taps
   * into a single month: four clicks in one tick advanced September to October, once. Measured in
   * the browser, which is the only place it shows — it is invisible at human clicking speed until
   * somebody double-taps the chevron and the calendar appears to ignore them.
   */
  const pageMonth = (delta: number) =>
    setSelectedKey(prev => {
      const target = shiftMonth(prev.slice(0, 7), delta);
      const today = todayKeyIST();
      return target === today.slice(0, 7) ? today : `${target}-01`;
    });

  const fetchCounts = useCallback(async (month: string) => {
    setLoading(true);
    setMonthError(false);
    try {
      // `techOnly` — the route advertised it, implemented it, and the page never sent it, so a
      // tech-only product's calendar counted the whole city (1158 upcoming against 297 tech).
      // A constant, not state: the feed has no tech toggle either, by the owner's direction.
      const res = await fetch(`/api/events/calendar?month=${month}&techOnly=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCounts(data.days || {});
      setMonthTotal(data.total || 0);
    } catch (err) {
      console.error('Calendar counts failed', err);
      setCounts({});
      setMonthTotal(0);
      setMonthError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Events for one IST day.
   *
   * `includePast` because a calendar shows days already gone — without it the shared builder floors
   * the window at `now` and blanks every past square.
   *
   * `spanning` (with `includeOngoing=false`, which the builder needs for that branch to apply) so a
   * multi-day conference appears on its middle days. The counts route expands spans, so without
   * this the grid would draw a dot on day 2 of GIDS and the panel would answer "Nothing scheduled
   * this day" — a dot with an empty panel is worse than the original bug, because it reads as data
   * being hidden. Both sides bound the span by the same `SPAN_FLOOR_DAYS`.
   */
  const fetchDay = useCallback(async (dayKey: string) => {
    setDayLoading(true);
    setDayError(false);
    try {
      const params = new URLSearchParams({
        // An IST day, expressed as the two instants that bound it.
        from: new Date(`${dayKey}T00:00:00.000+05:30`).toISOString(),
        to: new Date(`${dayKey}T23:59:59.999+05:30`).toISOString(),
        limit: String(DAY_LIMIT),
        includePast: 'true',
        includeOngoing: 'false',
        spanning: 'true',
        techOnly: 'true',
        sort: 'soonest',
      });
      const res = await fetch(`/api/events?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const rows: Event[] = data.events || [];
      setEvents(rows);
      // Report the real total, so a busy day says "showing the first 100 of 137" rather than
      // presenting a capped page as the answer.
      setDayTotal(data.pagination?.total ?? rows.length);
    } catch (err) {
      console.error('Calendar day failed', err);
      setEvents([]);
      setDayTotal(0);
      setDayError(true);
    } finally {
      setDayLoading(false);
    }
  }, []);

  /**
   * Both fetches are DEFERRED BY A TICK, and that is required rather than stylistic: they call
   * `setLoading` on their first line, and `react-hooks/set-state-in-effect` (an error here, not a
   * warning) rejects setting state synchronously in an effect body.
   *
   * Re-fetching on every month change is the whole point of the dependency — an earlier version
   * fetched once on mount, so paging to another month showed nothing.
   */
  useEffect(() => {
    const timer = setTimeout(() => { void fetchCounts(monthKey); }, 0);
    return () => clearTimeout(timer);
  }, [monthKey, fetchCounts]);

  useEffect(() => {
    const timer = setTimeout(() => { void fetchDay(selectedKey); }, 0);
    return () => clearTimeout(timer);
  }, [selectedKey, fetchDay]);

  const dayNumbers = Array.from({ length: daysInMonth(monthKey) }, (_, i) => i + 1);
  const startPadding = firstWeekday(monthKey);
  const todayKey = todayKeyIST();
  const monthInstant = istMidday(`${monthKey}-01`);

  const daysWithEvents = Object.keys(counts).length;

  return (
    <div className="min-h-screen bg-[var(--paper)]">
      <DesktopNav />

      {/* Mobile Header */}
      <header className="md:hidden fixed top-0 w-full h-14 bg-[var(--surface)]/96 glass-nav z-50 border-b border-[var(--rule)] flex items-center justify-between px-5">
        <Link href="/" className="text-lg font-bold tracking-tight text-[var(--ink)]">PulseBLR</Link>
        <span className="text-[var(--ink-2)] text-label-md font-semibold">Calendar</span>
      </header>

      <main className="pt-14 pb-24 md:pb-8">

        {/* Month header, in the same voice as every other page. This was a
            full-bleed `bg-black text-white` band — the one surface in the app that
            looked like it came from a different product. */}
        <div className="max-w-[1200px] mx-auto px-4 md:px-8 pt-6">
          {/* A month name is a LABEL the app is printing, not the name of a thing in the world, so it
              takes the sans side of the split — `.t-display` was serif at up to 40px. */}
          <div className="rule-b flex flex-wrap items-end justify-between gap-4 mb-6 pb-[var(--s-4)]">
            <div>
              <p className="ty-meta mb-1">{yearFmt.format(monthInstant)}</p>
              <h1 className="ty-section text-[var(--ink)]">{monthNameFmt.format(monthInstant)}</h1>
              <p className="ty-meta mt-1.5">
                {loading ? (
                  'Counting…'
                ) : monthError ? (
                  <span className="text-[var(--live)]">Could not load this month</span>
                ) : monthTotal === 0 ? (
                  'No tech events this month'
                ) : (
                  <>
                    <span className="tnum font-semibold text-[var(--ink)]">{monthTotal}</span> tech
                    event{monthTotal === 1 ? '' : 's'} across{' '}
                    <span className="tnum font-semibold text-[var(--ink)]">{daysWithEvents}</span>{' '}
                    day{daysWithEvents === 1 ? '' : 's'}
                  </>
                )}
              </p>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => pageMonth(-1)}
                className="pressable grid h-10 w-10 place-items-center rounded-full bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[var(--paper)]"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px]">chevron_left</span>
              </button>
              <button
                type="button"
                onClick={() => setSelectedKey(todayKeyIST())}
                className="pressable h-10 rounded-full bg-[var(--surface)] px-4 text-[12.5px] font-semibold text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[var(--paper)]"
              >
                Today
              </button>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => pageMonth(1)}
                className="pressable grid h-10 w-10 place-items-center rounded-full bg-[var(--surface)] text-[var(--ink)] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[var(--paper)]"
              >
                <span aria-hidden="true" className="material-symbols-outlined text-[20px]">chevron_right</span>
              </button>
            </div>
          </div>

          {monthError && (
            <div className="mb-4 flex items-center justify-between gap-3 rounded-[var(--r-flat)] border-l-2 border-l-[var(--live)] bg-[var(--paper)] px-4 py-3">
              <p className="text-[13px] text-[var(--live)]">
                Could not load this month&rsquo;s counts. Your data is fine — the request failed.
              </p>
              <button
                type="button"
                onClick={() => void fetchCounts(monthKey)}
                className="pressable shrink-0 rounded-full bg-[var(--surface)] px-3 py-1.5 text-[12px] font-semibold text-[var(--live)] shadow-[inset_0_0_0_1px_var(--rule)]"
              >
                Try again
              </button>
            </div>
          )}

          <div className="flex flex-col lg:flex-row gap-6">
            {/* `lg:self-start` so the grid hugs its five or six rows. As a stretched flex item it
                took its height from the day panel beside it, which is the taller of the two on any
                busy day, leaving a tall empty band under the last week. */}
            <div className="flex-1 min-w-0 rounded-[var(--r-flat)] border border-[var(--rule)] p-4 md:p-5 lg:self-start">
              {/* Weekday labels */}
              <div className="grid grid-cols-7 mb-2">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                  <div key={i} className="t-label text-center text-[var(--ink-2)]">
                    {d}
                  </div>
                ))}
              </div>

              {/* Date grid. Dimmed rather than blanked while counting, so the month's shape stays
                  on screen instead of flashing to an empty grid on every page. */}
              <div className={`grid grid-cols-7 gap-y-1 transition-opacity ${loading ? 'opacity-45' : ''}`}>
                {Array.from({ length: startPadding }).map((_, i) => (
                  <div key={`pad-${i}`} />
                ))}

                {dayNumbers.map(dayNumber => {
                  const key = `${monthKey}-${String(dayNumber).padStart(2, '0')}`;
                  const n = counts[key] ?? 0;
                  const isSelected = selectedKey === key;
                  const isCurrentDay = key === todayKey;
                  // Dots encode VOLUME, not category. Category-coloured dots implied a
                  // taxonomy the eye cannot decode at 6px, and spent the palette on
                  // decoration; density is the thing a month view can actually show.
                  const dots = n === 0 ? 0 : n <= 2 ? 1 : n <= 6 ? 2 : 3;

                  return (
                    <button
                      key={key}
                      type="button"
                      aria-label={`${dayMonthFmt.format(istMidday(key))} — ${n} event${n === 1 ? '' : 's'}`}
                      aria-pressed={isSelected}
                      onClick={() => setSelectedKey(key)}
                      className="pressable relative flex flex-col items-center py-1.5"
                    >
                      <span
                        className={`tnum flex h-9 w-9 items-center justify-center rounded-full text-[14.5px] font-semibold transition-colors ${
                          isSelected
                            ? 'bg-[var(--ink)] text-[var(--accent-ink)]'
                            : isCurrentDay
                              ? 'bg-[var(--paper)] text-[var(--accent)]'
                              : n > 0
                                ? 'text-[var(--ink)] hover:bg-[var(--paper)]'
                                : 'text-[var(--ink-3)] hover:bg-[var(--paper)]'
                        }`}
                      >
                        {dayNumber}
                      </span>
                      <span className="mt-1 flex h-1.5 items-center justify-center gap-[3px]">
                        {Array.from({ length: dots }).map((_, i) => (
                          <span
                            key={i}
                            className={`h-1.5 w-1.5 rounded-full ${
                              isSelected ? 'bg-[var(--surface)]/70' : 'bg-[var(--accent)]'
                            }`}
                          />
                        ))}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Day events panel ──
                Width is PINNED on desktop (`lg:w-[360px] shrink-0`). It used to be an unconstrained
                flex item beside `flex-1`, so its width was decided by its own contents: an empty day
                shrank it and the calendar grid grew, so paging through months resized the squares and
                nudged every date under the cursor. */}
            <div className="rounded-[var(--r-flat)] border border-[var(--rule)] p-6 lg:w-[360px] lg:shrink-0">
              {/* A day is ALWAYS selected — the month is derived from it, so there is no state in
                  which one exists without the other and no "Select a date" placeholder to write. */}
              {/* Sans, matching the month name above it. `.text-headline-md` is a legacy alias on
                  `--font-display`, i.e. the serif — so a date, which is the app printing a label,
                  was set in the face reserved for the names of things in the world. The event
                  titles in the list below are the serif side of that split. */}
              <h3 className="ty-section text-[var(--ink)] mb-1">
                {dayMonthFmt.format(istMidday(selectedKey))}
              </h3>
              {!dayLoading && !dayError ? (
                <p className="ty-meta mb-5">
                  {dayTotal} event{dayTotal !== 1 ? 's' : ''}
                  {dayTotal > events.length && ` · showing ${events.length}`}
                </p>
              ) : (
                // Hold the space the count occupies, so the list below does not jump on every load.
                <div className="mb-5 h-[15px]" />
              )}

              {dayLoading ? (
                // Without this the previous day's events stay on screen while the new
                // day loads, which reads as the wrong answer rather than as loading.
                <div className="flex flex-col gap-2">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <div key={i} className="skeleton h-14 rounded-xl bg-[var(--paper)]" />
                  ))}
                </div>
              ) : dayError ? (
                <div className="py-8 text-center">
                  <span aria-hidden="true" className="material-symbols-outlined mb-2 block text-[36px] text-[var(--ink-3)]">
                    cloud_off
                  </span>
                  <p className="mb-3 text-[13.5px] text-[var(--ink-2)]">Could not load this day.</p>
                  <button
                    type="button"
                    onClick={() => void fetchDay(selectedKey)}
                    className="pressable rounded-full bg-[var(--paper)] px-4 py-2 text-[12.5px] font-semibold text-[var(--ink)]"
                  >
                    Try again
                  </button>
                </div>
              ) : events.length === 0 ? (
                <div className="py-10 text-center">
                  <span aria-hidden="true" className="material-symbols-outlined mb-2 block text-[36px] text-[var(--ink-3)]">
                    event_busy
                  </span>
                  <p className="text-[13.5px] text-[var(--ink-2)]">Nothing scheduled this day.</p>
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {events.map(event => {
                    // Did this event START on the day being shown, or is it carried over from an
                    // earlier one? Compared as IST day keys, so it agrees with the grid by construction.
                    const startsToday = dayKeyIST(event.startDateTime) === selectedKey;
                    return (
                    <Link
                      key={event._id}
                      href={`/events/${event._id}`}
                      className="flex items-stretch gap-3 group"
                    >
                      {/* Time column.
                          `timeIST` — a 24-hour IST clock, the same one the feed's time rail uses. It
                          was `format(new Date(…), 'h:mm')` + `'a'`, which reads the browser's zone:
                          a 00:30 IST event showed as 7:00 PM the previous evening on a UTC machine,
                          on a page whose whole job is when things are.

                          A CARRIED-OVER EVENT SHOWS ITS START DATE, NOT A TIME — this is the other
                          half of `spanning`, and without it the fix that made the panel complete
                          made it misleading. On 7 September the panel listed `QUESSATHON` at 19:00
                          and sorted it to the top; that is its start time on 1 September, so the
                          most prominent row on the day claimed an evening slot it does not have.
                          Ranking is unchanged (soonest by true start, so things already running head
                          the list, which is right) — only the label is corrected. */}
                      <div className="flex flex-col items-center w-14 shrink-0 pt-1 pb-1">
                        {startsToday ? (
                          <span className="tnum text-label-md font-bold text-[var(--ink)]">
                            {timeIST(event.startDateTime)}
                          </span>
                        ) : (
                          <>
                            <span className="tnum text-label-md font-bold text-[var(--ink-2)]">
                              {shortDateIST(event.startDateTime)}
                            </span>
                            <span className="text-label-sm text-[var(--ink-2)]">onward</span>
                          </>
                        )}
                        <div className="flex-1 w-px bg-[var(--rule)] mt-1.5" />
                      </div>
                      {/*
                        The row. Flat and ruled rather than a rounded bordered card: the event title
                        is a thing in the world, so it takes the serif `.ty-row-title`, and the
                        category keeps its thin spine, which is the one use of the categorical scale
                        the direction allows (a tint or a spine, never a fill).

                        THE "FREE" PILL IS GONE, and this is a recorded refusal rather than a tidy-up.
                        `Event.isFree` is `{ type: Boolean, default: true }` — true on 88.5% of
                        upcoming tech events — so the pill fired on nearly every row and therefore
                        distinguished nothing; the old green-on-green pair also failed AA at 4.00:1.
                        Absence means free, and a price is marked only where there is one.

                        "Food" survives because it is genuinely sparse and genuinely decides
                        attendance, but it stops being a coloured pill: it is a `.ty-meta` clause on
                        the same line as the location, which is where the reference surface puts the
                        same fact. One accent, rationed — and "there are snacks" is not an action.
                      */}
                      <div className="flex-1 min-w-0 relative overflow-hidden rounded-[var(--r-flat)] rule-y group-hover:bg-[var(--paper)] transition-colors mb-1">
                        <div
                          className="absolute left-0 top-0 bottom-0 w-[3px]"
                          style={{ backgroundColor: categoryAccent(event.category?.[0]) }}
                        />
                        <div className="pl-4 pr-3 py-3">
                          <p className="ty-row-title text-[var(--ink)] line-clamp-2">
                            {event.title}
                          </p>
                          <p className="ty-meta mt-1 truncate">
                            {[locationLabel(event), event.hasFood === 'yes' ? 'Food' : null]
                              .filter(Boolean)
                              .join(' · ')}
                          </p>
                        </div>
                      </div>
                    </Link>
                    );
                  })}
                </div>
              )}
            </div>

          </div>
        </div>
      </main>

      <MobileBottomNav />
    </div>
  );
}
