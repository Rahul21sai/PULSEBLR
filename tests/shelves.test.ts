import { describe, it, expect } from 'vitest';
import {
  claimSection,
  shelfEligible,
  type Claimable,
} from '@/app/components/shelves/precedence';
import { bucketWeek, WEEK_AHEAD_DAYS } from '@/app/components/shelves/WeekAheadStrip';
import {
  buildEventFilter,
  parseEventParams,
  resolveDayWindow,
  FEED_FIELDS,
  type EventQueryParams,
} from '@/lib/events/query';
import { dayKeyIST, dayKeyOffsetIST } from '@/lib/format';
import type { FeedEvent } from '@/lib/event-types';

/**
 * The home page's shelves: precedence, eligibility, the week strip's bucketing, and the query-shape
 * changes the shelves ride on.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY PRECEDENCE IS WORTH A TEST AND NOT JUST A COMMENT. The page renders the same corpus through
 * seven requests, and the sets are NOT disjoint: an event hosted by a followed company can be in
 * progress, be pinned by an admin, have been typed in by hand, and rank onto page 1 on its own
 * merit — so the same `_id` legitimately arrives four times. The failure mode of getting the
 * subtraction wrong is not a crash. It is one event rendered twice in two sections that each look
 * correct in isolation, which is precisely the class of defect that survives code review.
 *
 * WHY THE `followedCompanies: []` CASE IS THE MOST IMPORTANT ASSERTION IN THIS FILE. That parameter
 * is matched on PRESENCE, not length, which is the opposite of every other list parameter in
 * `buildEventFilter`. If it is ever "tidied up" to `if (params.followedCompanies?.length)` to match
 * its neighbours, a signed-out visitor asking for "companies you follow" gets the ENTIRE FEED under
 * a heading claiming every row is a company they follow. The test below fails loudly on that change.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** A row with only the field precedence cares about. */
const row = (id: string): Claimable => ({ _id: id });

/** The `$and` array `buildEventFilter` assembles, for reaching into a built filter. */
const andOf = (filter: Record<string, unknown>): Array<Record<string, unknown>> =>
  (filter.$and as Array<Record<string, unknown>>) ?? [];

describe('claimSection — precedence by subtraction', () => {
  it('claims rows nothing earlier has taken', () => {
    const { rows, claimed } = claimSection([row('a'), row('b')], new Set(), 10);
    expect(rows.map(r => r._id)).toEqual(['a', 'b']);
    expect([...claimed].sort()).toEqual(['a', 'b']);
  });

  it('skips a row an earlier section already claimed', () => {
    const { rows } = claimSection([row('a'), row('b')], new Set(['a']), 10);
    expect(rows.map(r => r._id)).toEqual(['b']);
  });

  it('FILTERS THEN CAPS, never slices blind', () => {
    // A pinned or followed-company event need not be at the top of the ranked page, or on it at
    // all. `slice(0, cap)` before filtering would spend the cap on rows that are about to be
    // removed and render fewer than `cap` for no reason. Here `a` and `b` are already claimed, so
    // a cap of 2 must still yield two rows.
    const { rows } = claimSection(
      [row('a'), row('b'), row('c'), row('d'), row('e')],
      new Set(['a', 'b']),
      2
    );
    expect(rows.map(r => r._id)).toEqual(['c', 'd']);
  });

  it('deduplicates WITHIN its own candidates', () => {
    // Two requests can return the same event — the live set and the ranked page are merged before
    // reaching here. Guarding across sections but not within one would be perverse.
    const { rows } = claimSection([row('a'), row('a'), row('b')], new Set(), 10);
    expect(rows.map(r => r._id)).toEqual(['a', 'b']);
  });

  it('never mutates the set it was given', () => {
    // The chain is computed inside a `useMemo`; mutating the input would let running a later
    // section retroactively change what an earlier one saw.
    const claimed = new Set(['a']);
    claimSection([row('b')], claimed, 10);
    expect([...claimed]).toEqual(['a']);
  });

  it('takes nothing when the cap is zero, and leaves the claimed set IDENTICAL', () => {
    // A disabled or ineligible shelf must not silently consume events that the ranked feed is then
    // missing. Identity, not just equality: an unchanged reference lets a downstream memo skip.
    const claimed = new Set(['a']);
    const result = claimSection([row('b')], claimed, 0);
    expect(result.rows).toEqual([]);
    expect(result.claimed).toBe(claimed);
  });

  it('returns the original set when every candidate was already claimed', () => {
    const claimed = new Set(['a']);
    const result = claimSection([row('a')], claimed, 5);
    expect(result.rows).toEqual([]);
    expect(result.claimed).toBe(claimed);
  });

  it('handles an empty candidate list without widening anything', () => {
    const claimed = new Set(['a']);
    const result = claimSection([], claimed, 5);
    expect(result.rows).toEqual([]);
    expect(result.claimed).toBe(claimed);
  });
});

describe('the whole chain: live > spotlight > curated > following > coming up', () => {
  /**
   * ONE EVENT ARRIVING FROM EVERY REQUEST AT ONCE — the case the chain exists for.
   *
   * `hot` is in progress, pinned by an admin, hand-added, hosted by a followed company, AND on the
   * ranked page. Exactly one section may show it, and it must be the earliest: "happening now" is a
   * more urgent fact than "an admin liked it", which is more specific than "we added this", which is
   * more specific than "you follow them", which is more specific than the ranking.
   */
  const chain = (sets: {
    live: string[];
    spotlight: string[];
    curated: string[];
    following: string[];
    ranked: string[];
  }) => {
    let claimed: ReadonlySet<string> = new Set<string>();
    const take = (ids: string[], cap: number) => {
      const step = claimSection(ids.map(row), claimed, cap);
      claimed = step.claimed;
      return step.rows.map(r => r._id);
    };
    return {
      live: take(sets.live, 99),
      spotlight: take(sets.spotlight, 2),
      curated: take(sets.curated, 6),
      following: take(sets.following, 6),
      comingUp: take(sets.ranked, 99),
    };
  };

  it('gives a single event to exactly ONE section, the earliest that wants it', () => {
    const out = chain({
      live: ['hot'],
      spotlight: ['hot'],
      curated: ['hot'],
      following: ['hot'],
      ranked: ['hot'],
    });
    expect(out.live).toEqual(['hot']);
    expect(out.spotlight).toEqual([]);
    expect(out.curated).toEqual([]);
    expect(out.following).toEqual([]);
    expect(out.comingUp).toEqual([]);

    // The property, stated as arithmetic: every id appears exactly once across all five sections.
    const all = [...out.live, ...out.spotlight, ...out.curated, ...out.following, ...out.comingUp];
    expect(all).toEqual(['hot']);
    expect(new Set(all).size).toBe(all.length);
  });

  it('never renders any id twice across the five sections', () => {
    const out = chain({
      live: ['a'],
      spotlight: ['a', 'b'],
      curated: ['b', 'c'],
      following: ['c', 'd'],
      ranked: ['a', 'b', 'c', 'd', 'e'],
    });
    const all = [...out.live, ...out.spotlight, ...out.curated, ...out.following, ...out.comingUp];
    expect(new Set(all).size).toBe(all.length);
    // And nothing is LOST either — an event dropped from every section would be invisible, which is
    // the opposite failure and just as bad.
    expect([...all].sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('puts following ABOVE the ranked feed and BELOW curated', () => {
    const out = chain({
      live: [],
      spotlight: [],
      curated: ['shared'],
      following: ['shared', 'mine'],
      ranked: ['shared', 'mine', 'other'],
    });
    expect(out.curated).toEqual(['shared']);
    expect(out.following).toEqual(['mine']);
    expect(out.comingUp).toEqual(['other']);
  });

  it('leaves the ranked feed untouched when no shelf claims anything', () => {
    const out = chain({ live: [], spotlight: [], curated: [], following: [], ranked: ['a', 'b'] });
    expect(out.comingUp).toEqual(['a', 'b']);
  });
});

describe('shelfEligible — the rule that withdraws every shelf together', () => {
  it('allows shelves only on the untouched landing view', () => {
    expect(shelfEligible('', 0)).toBe(true);
  });

  it('withdraws them as soon as there is a search term', () => {
    // A reader who has typed a query has said what they want; two promoted rows above it are noise.
    expect(shelfEligible('kubernetes', 0)).toBe(false);
  });

  it('withdraws them on ONE active filter, not two', () => {
    /*
     * The off-by-one this pins: the test was `<= 1`, justified by a comment claiming `techOnly`
     * "counts as one". `countActive` has never counted `techOnly`, so the allowance was spurious and
     * the shelves kept rendering above a feed the reader had already narrowed.
     */
    expect(shelfEligible('', 1)).toBe(false);
    expect(shelfEligible('', 2)).toBe(false);
  });
});

describe('followedCompanies — the fail-closed parameter', () => {
  it('AN EMPTY LIST MATCHES NOTHING, rather than matching everything', () => {
    /*
     * THE MOST IMPORTANT ASSERTION IN THIS FILE. `followedCompanies` is checked on PRESENCE, unlike
     * every other list parameter, which are checked on `.length`. Change it to `?.length` to "match
     * its neighbours" and a signed-out visitor requesting `?followed=true` receives the whole feed
     * under a heading saying every row is hosted by a company they follow.
     */
    const filter = buildEventFilter({ followedCompanies: [] }, null);
    const clause = andOf(filter).find(c => 'companies' in c);
    expect(clause).toEqual({ companies: { $in: [] } });
  });

  it('narrows to the names it was given', () => {
    const filter = buildEventFilter({ followedCompanies: ['Microsoft', 'Google'] }, 'u1');
    const clause = andOf(filter).find(c => 'companies' in c);
    expect(clause).toEqual({ companies: { $in: ['Microsoft', 'Google'] } });
  });

  it('adds no clause at all when the caller did not ask', () => {
    // The ordinary feed must be byte-identical to what it was before this parameter existed.
    const filter = buildEventFilter({}, null);
    expect(andOf(filter).some(c => 'companies' in c)).toBe(false);
    expect(filter.companies).toBeUndefined();
  });

  it('INTERSECTS an explicit company filter instead of clobbering it', () => {
    /*
     * Both write the key `companies`. Assigning this one to `filter.companies` — the obvious
     * implementation — would silently overwrite the reader's own company chip, or be overwritten by
     * it depending on statement order. In `and` the two compose.
     */
    const filter = buildEventFilter(
      { company: ['Razorpay'], followedCompanies: ['Microsoft'] },
      'u1'
    );
    expect(filter.companies).toEqual({ $in: ['Razorpay'] });
    expect(andOf(filter)).toEqual(
      expect.arrayContaining([{ companies: { $in: ['Microsoft'] } }])
    );
  });

  it('CANNOT be set from a querystring', () => {
    /*
     * "Companies you follow" has to mean the session's list. If a client could supply it, the shelf
     * heading would be satisfiable by anyone editing the URL, and a shared link would carry somebody
     * else's follow list. Same discipline as `includeDeleted`.
     */
    const params = parseEventParams(
      new URLSearchParams('followed=true&followedCompanies=Microsoft&company=Google')
    );
    expect(params.followedCompanies).toBeUndefined();
    // The ordinary `company` parameter still parses, so this is a targeted omission and not a
    // wholesale failure to read companies.
    expect(params.company).toEqual(['Google']);
  });

  it('keeps the three visibility arms and the soft-delete clause intact', () => {
    // The shelf must not become a way around either. Both are asserted in full by
    // tests/search-filter.test.ts and tests/soft-delete.test.ts; this pins that adding the
    // parameter did not disturb them.
    const filter = buildEventFilter({ followedCompanies: ['Microsoft'] }, 'u1');
    expect(filter.deletedAt).toBeNull();
    const visibility = andOf(filter).find(c => '$or' in c);
    expect(visibility).toEqual({
      $or: [
        { visibility: 'public' },
        { visibility: { $exists: false } },
        { createdByUserId: 'u1' },
      ],
    });
  });
});

describe('card metadata — audience / perks / tier', () => {
  it('parses each as a comma-separated list', () => {
    const params = parseEventParams(
      new URLSearchParams('audience=students,founders&perks=lunch&tier=flagship')
    );
    expect(params.audience).toEqual(['students', 'founders']);
    expect(params.perks).toEqual(['lunch']);
    expect(params.tier).toEqual(['flagship']);
  });

  it('ORs within a dimension, like every other facet group', () => {
    // `$in`, not `$all`: selecting "lunch" and "swag" means "either", the same as selecting two
    // categories. `$all` would make a second chip narrow to almost nothing and read as broken.
    const filter = buildEventFilter(
      { audience: ['students'], perks: ['lunch', 'swag'], tier: ['flagship', 'community'] },
      null
    );
    expect(filter.audience).toEqual({ $in: ['students'] });
    expect(filter.perks).toEqual({ $in: ['lunch', 'swag'] });
    expect(filter.tier).toEqual({ $in: ['flagship', 'community'] });
  });

  it('adds nothing when unselected, so the ordinary feed is unchanged', () => {
    const filter = buildEventFilter({ audience: [], perks: [], tier: [] }, null);
    expect(filter.audience).toBeUndefined();
    expect(filter.perks).toBeUndefined();
    expect(filter.tier).toBeUndefined();
  });

  it('is carried by the feed projection, so a card can render it once it exists', () => {
    // The fields are populated on no document today. They are projected anyway, because this
    // constant is the single definition both feed paths go through and a card cannot reach around
    // it — omitting them would mean the tagger backfill lands and the cards still show nothing.
    expect(FEED_FIELDS).toContain('audience');
    expect(FEED_FIELDS).toContain('perks');
    expect(FEED_FIELDS).toContain('tier');
  });

  it('does NOT carry agenda or speakers, which belong to the detail page', () => {
    expect(FEED_FIELDS).not.toContain('agenda');
    expect(FEED_FIELDS).not.toContain('speakers');
    // Same rule, and the original reason for it: 6 KB per row for a two-line excerpt.
    expect(FEED_FIELDS).not.toContain('description');
  });
});

describe('resolveDayWindow — a day is an IST key, never a Date', () => {
  it('covers exactly one IST day, midnight to midnight', () => {
    const window = resolveDayWindow('2026-09-12');
    expect(window).not.toBeNull();
    // 00:00 IST is 18:30 UTC the previous day. Asserting the absolute instants is the whole point:
    // a helper that read the browser's clock would produce a different pair on a UTC machine.
    expect(window!.from.toISOString()).toBe('2026-09-11T18:30:00.000Z');
    expect(window!.to.toISOString()).toBe('2026-09-12T18:30:00.000Z');
  });

  it('is exactly 24 hours wide', () => {
    const window = resolveDayWindow('2026-09-12')!;
    expect(window.to.getTime() - window.from.getTime()).toBe(24 * 3600 * 1000);
  });

  it('round-trips through dayKeyIST, so the strip and the feed cannot disagree', () => {
    // The strip labels a card from a key and the feed filters on this window. If the window's start
    // did not map back to the same key, a reader would tap Thursday and get Wednesday — the exact
    // defect CLAUDE.md records on the calendar grid.
    for (const key of ['2026-01-01', '2026-09-12', '2026-12-31', '2027-02-28']) {
      expect(dayKeyIST(resolveDayWindow(key)!.from)).toBe(key);
    }
  });

  it('crosses a month and a year boundary correctly', () => {
    expect(resolveDayWindow('2026-09-30')!.to.toISOString()).toBe('2026-09-30T18:30:00.000Z');
    expect(dayKeyIST(resolveDayWindow('2026-12-31')!.from)).toBe('2026-12-31');
  });

  it('REFUSES anything that is not a well-formed key', () => {
    /*
     * A hand-edited `?day=` must degrade to "no day selected". The dangerous alternative is an
     * `Invalid Date`, which serialises to `null` in a querystring and silently widens the window to
     * the whole corpus while the strip still draws a day as selected.
     */
    for (const bad of ['', 'today', '2026-9-12', '12-09-2026', '2026-09-12T00:00', 'nonsense']) {
      expect(resolveDayWindow(bad)).toBeNull();
    }
  });

  it('refuses an impossible date that still matches the shape', () => {
    // The regex alone would pass these; the NaN check is what rejects them.
    expect(resolveDayWindow('2026-13-01')).toBeNull();
    expect(resolveDayWindow('2026-02-30')).toBeNull();
  });

  it('produces a window buildEventFilter treats as a plain start-time range', () => {
    /*
     * With `from` present, `parseEventParams` does not resolve a `when`, and `buildEventFilter`
     * skips the `includeOngoing` branch — so a selected day means "events STARTING that day". That
     * is the feed's semantics; spanning is the calendar's job and is opt-in.
     */
    const window = resolveDayWindow('2026-09-12')!;
    const filter = buildEventFilter({ from: window.from, to: window.to }, null);
    const and = andOf(filter);
    expect(and).toEqual(
      expect.arrayContaining([
        { startDateTime: { $gte: window.from } },
        { startDateTime: { $lt: window.to } },
      ])
    );
  });
});

describe('bucketWeek — the week-ahead strip', () => {
  /** A feed row with only the fields bucketing reads. */
  const event = (id: string, startDateTime: string, title = id): FeedEvent =>
    ({ _id: id, title, startDateTime, isFree: true } as unknown as FeedEvent);

  /** Noon IST on the day `offset` days from today, so the instant is far from either boundary. */
  const onDay = (offset: number) => `${dayKeyOffsetIST(offset)}T12:00:00+05:30`;

  it('always returns seven days, even with no events', () => {
    // A strip that grew and shrank with the data would reflow the row; the caller hides the whole
    // section when the total is zero rather than rendering a ragged one.
    const days = bucketWeek([]);
    expect(days).toHaveLength(WEEK_AHEAD_DAYS);
    expect(days.every(d => d.count === 0 && d.top === null)).toBe(true);
  });

  it('returns the seven days starting today, in order', () => {
    const days = bucketWeek([]);
    expect(days.map(d => d.key)).toEqual(
      Array.from({ length: WEEK_AHEAD_DAYS }, (_, i) => dayKeyOffsetIST(i))
    );
  });

  it('counts events into their IST day', () => {
    const days = bucketWeek([
      event('a', onDay(0)),
      event('b', onDay(0)),
      event('c', onDay(2)),
    ]);
    expect(days[0].count).toBe(2);
    expect(days[1].count).toBe(0);
    expect(days[2].count).toBe(1);
  });

  it('takes the FIRST event it sees for a day as that day’s headline', () => {
    // The caller fetches with `sort=connections`, so "first" means best. Bucketing does no sorting
    // of its own precisely so the caller's ranking is what decides the headline.
    const days = bucketWeek([event('best', onDay(1), 'Best'), event('other', onDay(1), 'Other')]);
    expect(days[1].top?.title).toBe('Best');
  });

  it('leaves an empty day with a null headline rather than borrowing one', () => {
    const days = bucketWeek([event('a', onDay(3))]);
    expect(days[0].top).toBeNull();
    expect(days[3].top?._id).toBe('a');
  });

  it('DROPS events outside the seven days instead of clamping them into the nearest', () => {
    // Clamping would misreport a day's count. The request is already windowed, so anything out of
    // range is a boundary rounding or a caller passing the wrong set — either way, not this day's.
    const days = bucketWeek([
      event('past', onDay(-3)),
      event('far', onDay(30)),
      event('inside', onDay(1)),
    ]);
    expect(days.reduce((sum, d) => sum + d.count, 0)).toBe(1);
    expect(days[1].top?._id).toBe('inside');
  });

  it('buckets a late-night event on its IST day, not the UTC one', () => {
    /*
     * 00:30 IST is 19:00 UTC the PREVIOUS day. Bucketing on a UTC date would scatter every
     * late-night event onto the wrong card — the reason `clusterKey` and the calendar both key on
     * IST, and the one timezone bug this component is most likely to acquire.
     */
    const key = dayKeyOffsetIST(2);
    const days = bucketWeek([event('midnight', `${key}T00:30:00+05:30`)]);
    expect(days[2].count).toBe(1);
    expect(dayKeyIST(`${key}T00:30:00+05:30`)).toBe(key);
  });
});

describe('techOnly stays unconditional', () => {
  /*
   * Not a shelf assertion — a guard on the shelves. Four new requests now go through `buildParams`,
   * and every one of them inherits `techOnly=true` from it. This pins the parameter's own behaviour
   * so a shelf can never become the route by which a non-tech feed reappears.
   */
  it('is applied when asked for', () => {
    expect(buildEventFilter({ techOnly: true }, null).isTechEvent).toBe(true);
  });

  it('is absent — never `false` — when not asked for, so /admin can still see everything', () => {
    // `techOnly` remains a real parameter: /admin needs the non-tech corpus to correct a mis-tag.
    // What is unrepresentable is a reader-facing `false`, and that is enforced in `FilterState`.
    expect(buildEventFilter({ techOnly: false }, null).isTechEvent).toBeUndefined();
    expect(buildEventFilter({}, null).isTechEvent).toBeUndefined();
  });

  it('parses only the exact string "true"', () => {
    const yes = parseEventParams(new URLSearchParams('techOnly=true'));
    const no = parseEventParams(new URLSearchParams('techOnly=false'));
    expect(yes.techOnly).toBe(true);
    expect(no.techOnly).toBe(false);
  });
});

/**
 * A compile-time check, not a runtime one: `followedCompanies` must stay assignable so the route can
 * set it, and the whole parameter object must remain a plain record. If `EventQueryParams` ever loses
 * the field this file stops compiling, which is the earliest possible warning.
 */
const _typeCheck: EventQueryParams = { followedCompanies: [], audience: [], perks: [], tier: [] };
void _typeCheck;
