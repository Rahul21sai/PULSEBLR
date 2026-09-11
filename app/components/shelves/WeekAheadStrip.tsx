'use client';

import SectionHeading from './SectionHeading';
import { IST, dayKeyIST, fullDateIST, todayKeyIST, dayKeyOffsetIST } from '@/lib/format';
import { FeedEvent } from '@/lib/event-types';

/**
 * The seven days ahead: how many events each holds, and the best one on it.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT IT IS FOR. The feed answers "what should I go to", ranked. It cannot answer "what does my
 * week look like" — that question is about SHAPE, and a ranked list deliberately destroys the
 * chronology that would show it. The calendar page answers it a month at a time, which is the
 * wrong grain for deciding about Thursday. So this is the one place the page is chronological on
 * purpose, and it is a NAVIGATOR: tapping a day narrows the feed to it.
 *
 * IT DOES NOT CLAIM ITS EVENTS, unlike every shelf on this page. `precedence.ts` exists because two
 * sections showing the same CARD is confusing — but a day cell is a summary, not a card, and
 * subtracting seven events from the ranked feed so they could be named here would remove precisely
 * this week's best events from the list underneath. The rule is about duplicated cards, not about
 * an event being mentioned twice in two different kinds of object.
 *
 * A DAY IS A `YYYY-MM-DD` IST KEY, NEVER A `Date`. The calendar page records what happens otherwise:
 * `startOfMonth`, `getDay` and `setHours(0,0,0,0)` all read the BROWSER's clock, so from +13 the
 * square drawn "1" fetched the previous day's events, and from UTC the day panel fetched a
 * half-day-shifted window under a heading naming the right day. The keys here come from
 * `dayKeyOffsetIST`, the labels from IST-pinned formatters, and the window from `resolveDayWindow`.
 * Do not reintroduce a `Date` as a day identity.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** How many days the strip shows. Seven, so it is always "the week ahead" and never a partial one. */
export const WEEK_AHEAD_DAYS = 7;

/*
 * Formatters constructed ONCE at module scope, and every one pinned to `IST`.
 *
 * The rule these follow is `lib/format.ts`'s: never format an event time with the ambient locale,
 * because a browser (or a server) outside IST would put a 9 PM event on the wrong day. They live
 * here rather than in that module only because it is not this agent's file to edit — the timezone
 * argument is the part that matters and it is explicit. Fold them in there if the two ever meet.
 */
const weekdayFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, weekday: 'short' });
const dayNumFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, day: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('en-IN', { timeZone: IST, month: 'short' });

/**
 * An instant at IST midday for a day key, purely to feed the IST formatters above.
 *
 * Midday rather than midnight so the instant sits a long way from either day boundary. Nothing here
 * depends on that — the formatters are pinned and IST has no DST — but it means a future change that
 * loses the `timeZone` argument fails visibly on the label rather than silently on one day in
 * fourteen. `app/calendar/page.tsx` builds its IST instants the same way.
 */
const istMidday = (dayKey: string) => new Date(`${dayKey}T12:00:00+05:30`);

export interface WeekDay {
  /** `YYYY-MM-DD`, IST. */
  key: string;
  count: number;
  /** The highest-ranked event on this day, or `null` when the day is empty. */
  top: FeedEvent | null;
}

/**
 * Bucket a soonest-ordered week of events into seven IST days.
 *
 * `events` MUST BE ORDERED BY THE RANKING YOU WANT `top` TO REFLECT — the first event seen for a day
 * becomes that day's headline, so this does no sorting of its own. The caller fetches with
 * `sort=connections`, so `top` is "the best thing on Thursday" rather than "the earliest".
 *
 * ITS COUNTS ARE ONLY AS COMPLETE AS ITS INPUT, and the caller's `limit` is what bounds that. At the
 * measured volume — 281 upcoming tech events in the whole corpus, ~50 in any one week — a limit of
 * 100 covers a week several times over. If the corpus ever outgrows that, the days that lose events
 * are the LAST ones (the request is windowed to exactly these seven days, so a truncated page is
 * truncated at the far end of the week, not scattered), and `truncated` says so rather than letting
 * a wrong count look authoritative.
 */
export function bucketWeek(events: readonly FeedEvent[]): WeekDay[] {
  const byKey = new Map<string, WeekDay>();
  for (let offset = 0; offset < WEEK_AHEAD_DAYS; offset += 1) {
    const key = dayKeyOffsetIST(offset);
    byKey.set(key, { key, count: 0, top: null });
  }
  for (const event of events) {
    const bucket = byKey.get(dayKeyIST(event.startDateTime));
    // Events outside the seven days are dropped rather than clamped into the nearest day. The
    // request is already windowed, so anything here is either a boundary rounding or a caller
    // passing the wrong set — and inventing a bucket for it would misreport a day's count.
    if (!bucket) continue;
    bucket.count += 1;
    if (!bucket.top) bucket.top = event;
  }
  return [...byKey.values()];
}

export default function WeekAheadStrip({
  days,
  selectedDay,
  onSelectDay,
  truncated,
}: {
  days: WeekDay[];
  /** The `YYYY-MM-DD` key currently narrowing the feed, or `''` for none. */
  selectedDay: string;
  /** Called with a day key to narrow, or `''` to widen back. */
  onSelectDay: (dayKey: string) => void;
  /** The week held more events than the request returned, so later counts may be low. */
  truncated?: boolean;
}) {
  const today = todayKeyIST();
  const total = days.reduce((sum, day) => sum + day.count, 0);

  // Nothing in the next seven days is a real state — a quiet week, or a filter that excludes
  // everything — and a strip of seven empty cells would be a large, confident way of saying so.
  // The feed below already reports the count; this simply gets out of the way.
  if (total === 0) return null;

  return (
    /* `pb-6 sm:pb-8` — see the same change in `EventShelf`. Four sections stack above the ranked
       feed on the home page, so the inter-section gap is paid four times on the width that can least
       afford it. Unchanged from `sm` up. */
    <section className="max-w-[1240px] mx-auto px-4 md:px-8 pb-6 sm:pb-8">
      {/* `shelf` tone — the quietest of the three, because this section is NAVIGATION and the seven
          cards below label themselves (Today, Sun, Mon…). The heading is here to hold the readout
          and the way out of a selection, not to announce a week the reader can see.

          The caption says what the numbers mean and offers that way out, in the place a reader is
          already looking. Without the second half, clearing a day means finding the "All upcoming"
          chip in the command bar above — a different control, in different chrome, for undoing what
          was done here. Blue stays on the button because it IS an action (globals.css rule 4). */}
      <SectionHeading
        tone="shelf"
        title="The week ahead"
        caption={
          selectedDay ? (
            <button
              type="button"
              onClick={() => onSelectDay('')}
              className="text-[11.5px] font-semibold text-[#0071E3] hover:underline"
            >
              Show all upcoming
            </button>
          ) : (
            <span className="tnum">
              {total}
              {truncated ? '+' : ''} in 7 days
            </span>
          )
        }
      />

      {/* A snap scroller on a phone and a seven-column grid from `sm` up.
          Seven cards need ~1120px to read comfortably, which a laptop has and a 390px screen does
          not — there it shows about three and a half, which is the honest way to signal that the
          row continues. `overscroll-x-contain` stops a horizontal swipe from turning into a browser
          back-navigation, and `-mx-4 px-4` lets the cards bleed to the screen edge while the first
          one stays aligned with the heading. Same idiom as the date chips and the shelves. */}
      <div
        role="group"
        aria-label="Narrow the feed to one day"
        className="-mx-4 flex snap-x snap-mandatory gap-2 overflow-x-auto overscroll-x-contain px-4 pb-1 no-scrollbar sm:mx-0 sm:grid sm:grid-cols-7 sm:gap-2.5 sm:overflow-visible sm:px-0"
      >
        {days.map(day => {
          const selected = day.key === selectedDay;
          const empty = day.count === 0;
          const instant = istMidday(day.key);
          const weekday = day.key === today ? 'Today' : weekdayFmt.format(instant);

          return (
            <button
              key={day.key}
              type="button"
              // A toggle, so tapping the selected day widens back rather than doing nothing. The
              // only other way out is the header link above, and a control whose second press does
              // nothing reads as broken.
              onClick={() => onSelectDay(selected ? '' : day.key)}
              disabled={empty}
              aria-pressed={selected}
              /* The visible card is a stack of abbreviations, so the accessible name spells the
                 whole thing out — the full date, the count, and what pressing it does. */
              aria-label={`${fullDateIST(instant)} — ${
                empty ? 'no events' : `${day.count} event${day.count === 1 ? '' : 's'}`
              }${selected ? ', showing this day' : ''}`}
              className={`pressable flex w-[108px] shrink-0 snap-start flex-col items-start gap-0.5 rounded-[14px] px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0071E3] sm:w-auto [touch-action:manipulation] ${
                selected
                  ? 'bg-[#1D1D1F] text-white'
                  : empty
                    ? 'cursor-not-allowed bg-[#F0F0F2] text-[#c7c7cc]'
                    : 'bg-white text-[#1D1D1F] shadow-[inset_0_0_0_1px_var(--hairline)] hover:bg-[#FAFAFC]'
              }`}
            >
              {/* Sentence case, not `t-label`. `weekdayFmt` already yields "Sun" and `Today` — the
                  uppercase came from the class, and it turned both into shouted abbreviations for no
                  gain. `#6E6E73` rather than `#8E8E93`: the latter measures 3.26:1 on white at 11px,
                  under the 4.5:1 floor `docs/design-direction.md` asks for at the sizes actually
                  used. Disabled tiles keep `#c7c7cc` — a disabled control is exempt. */}
              <span
                className={`text-[11px] font-semibold leading-[1.15] tracking-[0] ${
                  selected ? 'text-white/70' : empty ? 'text-[#c7c7cc]' : 'text-[#6E6E73]'
                }`}
              >
                {weekday}
              </span>
              {/* The date is the card's anchor, so it gets the size. `tnum` keeps the seven cards
                  from shifting a pixel as the numbers change width — the reason this design system
                  has that class at all. */}
              <span className="tnum text-[19px] font-semibold leading-[1.15] tracking-[-0.02em]">
                {dayNumFmt.format(instant)}
                <span
                  className={`ml-1 text-[11.5px] font-medium ${
                    /* `#a1a1a6` measured 2.58:1 on white — the month is real information, not a
                       decorative flourish, so it has to clear the floor. */
                    selected ? 'text-white/60' : 'text-[#6E6E73]'
                  }`}
                >
                  {monthFmt.format(instant)}
                </span>
              </span>
              {/* ── INK, NOT `--blue`, AND THE RULE IS globals.css's OWN. ────────────────────────
                  Seven blue counts in one row were the loudest colour on the page above the
                  Spotlight, in a design whose fourth settled rule is that `--blue` means "you can
                  act on this" and is never decoration. A count is not an action. The tile IS one, and
                  its affordance is already carried the way every other card on this page carries
                  it — white, hairline ring, `.pressable` — so the accent was buying nothing that the
                  card treatment was not already saying, at the cost of the thing rationing it
                  protects: the covers being the only colour on screen.

                  Ink also reads as data rather than as a link, which is what it is. The date above
                  keeps the tile's emphasis by size; this stays semibold so density is still scannable
                  across seven tiles. */}
              <span
                className={`tnum text-[11.5px] font-semibold ${
                  selected ? 'text-white/80' : empty ? 'text-[#c7c7cc]' : 'text-[#1D1D1F]'
                }`}
              >
                {empty ? 'Nothing yet' : `${day.count} event${day.count === 1 ? '' : 's'}`}
              </span>
              {/* The best event on the day, named rather than counted — the whole reason the strip
                  is more than a bar chart. Two lines, clamped: a title long enough to need a third
                  would make one card taller than its six neighbours and the row would step.

                  ── `hidden sm:block`, AND THE BUDGET IS ONLY HALF THE REASON. ──────────────────
                  Measured: the title costs ~50px of the strip's 184px, and it buys the least
                  precisely where it costs the most. A 108px card fits about four words of a title
                  before the clamp, and four words of "Building AI Agents with Microsoft Foundry…"
                  is not a headline, it is a fragment — while the weekday, the date and the count
                  are all fully legible at that width. From `sm` up the cards are ~160px in a
                  seven-column grid and the title reads properly, so that is where it appears.

                  Nothing is lost by hiding it: the strip claims none of its events (see the header),
                  so every event it names is also a full card in the feed below. That is what makes
                  this safe to hide and what makes hiding a SHELF row unsafe — the documented trap is
                  about sections that subtract, and this one does not. */}
              {day.top && (
                <span
                  className={`mt-0.5 hidden line-clamp-2 text-[11.5px] leading-[1.3] sm:block ${
                    selected ? 'text-white/85' : 'text-[#6E6E73]'
                  }`}
                >
                  {day.top.title}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}
