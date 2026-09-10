/**
 * Meetup's 10-event ICS cap, and the second pass that recovers what it hides.
 *
 * WHAT IS PINNED HERE AND WHY IT IS A UNIT TEST AT ALL. `meetupEventsFromGroupPage` is pure —
 * HTML string in, RawEvents out, with `now` as a parameter — which is the whole reason it belongs
 * in this suite rather than in `scripts/diag-meetup-cap.ts` (which measures the live corpus and
 * needs both the network and the database).
 *
 * THE FIXTURE IS THE REAL SHAPE, trimmed. It is an Apollo cache exactly as Meetup serves it in
 * `__NEXT_DATA__.props.pageProps.__APOLLO_STATE__`: normalized `Event:`/`Venue:`/`PhotoInfo:`
 * entries, `__ref` pointers between them, and a `Group:` node whose `events({...})` field keys
 * carry the query ARGUMENTS — which is how the upcoming connection (`afterDateTime`) is told apart
 * from the past tab (`beforeDateTime`). Reproducing that key encoding matters: it is the one thing
 * a "tidy-up" of the parser would most plausibly break, and breaking it imports ten expired events
 * per group.
 *
 * THE NEGATIVE CASES ARE THE IMPORTANT ONES, for the same reason `tests/off-city.test.ts` is
 * mostly negative: this path adds ~550 rows to the corpus, and each of the three assertions below
 * about what must NOT be copied guards a mechanism that would silently disarm the city gate.
 *
 *   · the group's lat/lon must never reach an event — `hasBengaluruEvidence` treats an in-city
 *     coordinate as an unconditional VETO of rejection, so copying it would make every event of
 *     every Bengaluru group unrejectable, including its Chennai edition
 *   · the group's `city` must never reach an event either — one step weaker, same veto
 *   · `sourceEventId` must keep the ICS's `event_<id>@meetup.com` form, or the second pass
 *     re-inserts the ten events already stored as new documents
 */
import { describe, it, expect } from 'vitest';
import {
  MEETUP_ICS_CAP,
  MEETUP_PAGE_CAP,
  meetupEventsFromGroupPage,
} from '@/lib/scrapers/adapters/meetup';

/** 2026-09-10T00:00:00 IST — the clock every case below is judged against. */
const NOW = new Date('2026-09-09T18:30:00.000Z');

interface FixtureEvent {
  id: string;
  title: string;
  dateTime: string;
  endTime?: string;
  status?: string;
  eventType?: string;
  isOnline?: boolean;
  description?: string;
  venue?: string;
  going?: number;
  photo?: string;
}

interface FixtureVenue {
  id: string;
  name: string;
  address?: string;
  city?: string;
  state?: string;
  country?: string;
}

/**
 * Build a page that looks like Meetup's.
 *
 * `upcoming`/`past` become two separate `events({...})` keys on the group node, encoded the way
 * Apollo encodes them, so the parser has to read the arguments to pick the right one.
 */
function buildPage(opts: {
  slug: string;
  upcoming: FixtureEvent[];
  past?: FixtureEvent[];
  venues?: FixtureVenue[];
  /** Set on the GROUP node — the fields that must never reach an event. */
  groupCity?: string;
  groupLat?: number;
  groupLon?: number;
  upstreamTotal?: number;
  hasNextPage?: boolean;
  omitConnection?: boolean;
}): string {
  const state: Record<string, unknown> = {};

  const put = (event: FixtureEvent) => {
    state[`Event:${event.id}`] = {
      __typename: 'Event',
      id: event.id,
      title: event.title,
      eventUrl: `https://www.meetup.com/${opts.slug}/events/${event.id}/`,
      description: event.description ?? `About ${event.title}`,
      dateTime: event.dateTime,
      endTime: event.endTime,
      status: event.status ?? 'ACTIVE',
      eventType: event.eventType ?? 'PHYSICAL',
      isOnline: event.isOnline ?? false,
      venue: event.venue ? { __ref: `Venue:${event.venue}` } : null,
      going: { __typename: 'GoingRsvpConnection', totalCount: event.going ?? 0 },
      featuredEventPhoto: event.photo ? { __ref: `PhotoInfo:${event.photo}` } : null,
    };
  };
  opts.upcoming.forEach(put);
  (opts.past ?? []).forEach(put);

  for (const venue of opts.venues ?? []) {
    state[`Venue:${venue.id}`] = {
      __typename: 'Venue',
      id: venue.id,
      name: venue.name,
      address: venue.address ?? '',
      city: venue.city ?? '',
      state: venue.state ?? '',
      country: venue.country ?? '',
    };
  }
  state['PhotoInfo:900'] = {
    __typename: 'PhotoInfo',
    id: '900',
    highResUrl: 'https://secure.meetupstatic.com/photos/event/highres_900.jpeg',
  };

  const group: Record<string, unknown> = {
    __typename: 'Group',
    id: '18654391',
    name: 'A Bengaluru Community',
    urlname: opts.slug,
    timezone: 'Asia/Kolkata',
    city: opts.groupCity ?? 'Bangalore',
    state: '',
    country: 'in',
    lat: opts.groupLat ?? 12.97,
    lon: opts.groupLon ?? 77.56,
  };

  const edges = (list: FixtureEvent[]) =>
    list.map(e => ({ __typename: 'EventEdge', node: { __ref: `Event:${e.id}` } }));

  if (!opts.omitConnection) {
    group[
      'events({"filter":{"afterDateTime":"2026-09-09T18:30:00.000Z","status":["ACTIVE","PAST","CANCELLED"]},"first":30,"sort":"ASC"})'
    ] = {
      __typename: 'GroupEventConnection',
      totalCount: opts.upstreamTotal ?? opts.upcoming.length,
      pageInfo: { __typename: 'PageInfo', hasNextPage: opts.hasNextPage ?? false },
      edges: edges(opts.upcoming),
    };
  }
  group[
    'events({"filter":{"beforeDateTime":"2026-09-09T18:30:00.000Z","status":["ACTIVE","PAST","CANCELLED"]},"first":10,"sort":"DESC"})'
  ] = {
    __typename: 'GroupEventConnection',
    totalCount: 191,
    pageInfo: { __typename: 'PageInfo', hasNextPage: true },
    edges: edges(opts.past ?? []),
  };

  state[`Group:${group.id}`] = group;
  state.ROOT_QUERY = { __typename: 'Query', [`groupByUrlname:{"urlname":"${opts.slug}"}`]: { __ref: 'Group:18654391' } };

  const payload = { props: { pageProps: { __APOLLO_STATE__: state } } };
  return `<!DOCTYPE html><html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(
    payload
  )}</script></body></html>`;
}

const BLR_VENUE: FixtureVenue = {
  id: '1',
  name: 'Rippling',
  address: 'Embassy Tech Village',
  city: 'Bangalore',
  state: 'KA',
  country: 'in',
};

describe('the cap constants', () => {
  it('records the upstream ceiling that the whole second pass exists for', () => {
    // If this ever legitimately changes, `truncated` uses `>=` so detection survives the change —
    // but the number is measured, so a silent edit should have to break a test.
    expect(MEETUP_ICS_CAP).toBe(10);
    expect(MEETUP_PAGE_CAP).toBeGreaterThan(MEETUP_ICS_CAP);
  });
});

describe('meetupEventsFromGroupPage — reading past the cap', () => {
  it('returns every upcoming event on the page, not just the ICS ceiling', () => {
    const upcoming = Array.from({ length: 17 }, (_, i) => ({
      id: `31600${String(i).padStart(2, '0')}`,
      title: `Meetup #${i + 1}`,
      dateTime: `2026-09-${String(12 + i).padStart(2, '0')}T18:00:00+05:30`,
      venue: '1',
    }));
    const parsed = meetupEventsFromGroupPage(
      buildPage({ slug: 'ai-blr', upcoming, venues: [BLR_VENUE] }),
      { slug: 'ai-blr', now: NOW }
    );

    // The measured shape of the finding: ICS would have returned 10 of these 17.
    expect(parsed.events).toHaveLength(17);
    expect(parsed.events.length).toBeGreaterThan(MEETUP_ICS_CAP);
    expect(parsed.upstreamTotal).toBe(17);
    expect(parsed.hasMore).toBe(false);
  });

  it('reads the upstream total and the "there are even more" flag', () => {
    // `active-adventure-travel-junkies`: 148 upcoming, 30 reachable on the page. The page has its
    // OWN ceiling, and a run that cannot say so would look like it had solved the problem.
    const upcoming = Array.from({ length: 30 }, (_, i) => ({
      id: `4000${i}`,
      title: `Trip ${i}`,
      dateTime: '2026-10-01T09:00:00+05:30',
      venue: '1',
    }));
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'travel',
        upcoming,
        venues: [BLR_VENUE],
        upstreamTotal: 148,
        hasNextPage: true,
      }),
      { slug: 'travel', now: NOW }
    );
    expect(parsed.events).toHaveLength(30);
    expect(parsed.upstreamTotal).toBe(148);
    expect(parsed.hasMore).toBe(true);
  });

  it('maps the fields the ICS feed cannot supply at all', () => {
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'bangpypers',
        upcoming: [
          {
            id: '316056579',
            title: 'BangPypers September Meetup',
            dateTime: '2026-09-20T10:30:00+05:30',
            endTime: '2026-09-20T13:30:00+05:30',
            description: '<p>Talks on <b>asyncio</b></p>',
            venue: '1',
            going: 42,
            photo: '900',
          },
        ],
        venues: [BLR_VENUE],
      }),
      { slug: 'bangpypers', now: NOW }
    );

    const [event] = parsed.events;
    expect(event.title).toBe('BangPypers September Meetup');
    expect(event.sourceUrl).toBe('https://www.meetup.com/bangpypers/events/316056579/');
    expect(event.source).toBe('meetup');
    expect(event.startDateTime.toISOString()).toBe('2026-09-20T05:00:00.000Z');
    expect(event.endDateTime?.toISOString()).toBe('2026-09-20T08:00:00.000Z');
    // Venue, city and cover image are the three fields Meetup's ICS omits entirely — the reason
    // `enrichMeetupEvents` has to fetch an event page per row today.
    expect(event.venue).toBe('Rippling');
    expect(event.city).toBe('Bangalore');
    expect(event.address).toContain('Embassy Tech Village');
    expect(event.imageUrl).toBe(
      'https://secure.meetupstatic.com/photos/event/highres_900.jpeg'
    );
    expect(event.attendeeCount).toBe(42);
    expect(event.rawFormat).toBe('offline');
    // HTML is stripped, as everywhere else in the scrapers.
    expect(event.description).toBe('Talks on asyncio');
  });

  it('keeps the ICS sourceEventId form, so a page row and an ICS row are ONE document', () => {
    // `ingestion.ts` re-matches on `sourceEventId`. The ICS UID is `event_<id>@meetup.com`; if
    // this path invented `<id>` instead, every group's existing ten events would be re-inserted.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [{ id: '316028889', title: 'X', dateTime: '2026-09-16T17:00:00+05:30' }],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events[0].sourceEventId).toBe('event_316028889@meetup.com');
  });

  it('marks an online event online and gives it no venue', () => {
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [
          {
            id: '1',
            title: 'Virtual mixer',
            dateTime: '2026-09-16T17:00:00+05:30',
            eventType: 'ONLINE',
            isOnline: true,
            venue: '2',
          },
        ],
        // Meetup files online events against a placeholder venue literally named "Online event".
        venues: [{ id: '2', name: 'Online event', country: '' }],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    const [event] = parsed.events;
    expect(event.rawFormat).toBe('online');
    expect(event.venue).toBeUndefined();
    expect(event.city).toBeUndefined();
    expect(event.onlineLink).toBe('https://www.meetup.com/ai-blr/events/1/');
  });
});

describe('meetupEventsFromGroupPage — what must NOT reach an event', () => {
  it('never copies the GROUP coordinates onto an event', () => {
    // The severe one. `offCityReason` → `hasBengaluruEvidence` checks lat/lng FIRST and an
    // in-city coordinate vetoes rejection outright, so a group coordinate on every row would
    // make the city gate unable to reject anything this source produces.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'travel',
        groupLat: 12.97,
        groupLon: 77.56,
        upcoming: [{ id: '1', title: 'Chiang Mai trek', dateTime: '2026-10-01T09:00:00+05:30', venue: '3' }],
        venues: [{ id: '3', name: 'Chiang Mai', city: 'Chiang Mai', country: '' }],
      }),
      { slug: 'travel', now: NOW }
    );
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].lat).toBeUndefined();
    expect(parsed.events[0].lng).toBeUndefined();
  });

  it('never copies the GROUP city onto an event', () => {
    // Same veto, one step weaker: `city: 'Bangalore'` is Bengaluru evidence. The group node in
    // this fixture says Bangalore and the venue says Chennai; only the venue may be believed,
    // because a Bengaluru group running a Chennai edition is the documented shape of this leak.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        groupCity: 'Bangalore',
        upcoming: [{ id: '1', title: 'Chennai edition', dateTime: '2026-10-01T09:00:00+05:30', venue: '4' }],
        venues: [{ id: '4', name: 'IIT Madras', city: 'Chennai', country: 'in' }],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events[0].city).toBe('Chennai');
    // …and the shared stage-5c gate is then the thing that rejects it, on that city string.
    expect(parsed.events[0].city).not.toBe('Bangalore');
  });

  it('reads the UPCOMING connection and not the past tab', () => {
    // Both connections are on the group node and differ only by their argument JSON. Reading the
    // wrong one imports ten expired events per group, on every run, for 74 groups.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [{ id: '1', title: 'Next week', dateTime: '2026-09-16T17:00:00+05:30' }],
        past: [
          { id: '2', title: 'Last month', dateTime: '2026-08-12T17:00:00+05:30', status: 'PAST' },
          { id: '3', title: 'July', dateTime: '2026-07-15T17:00:00+05:30', status: 'PAST' },
        ],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events.map(e => e.title)).toEqual(['Next week']);
  });

  it('drops cancelled and draft events', () => {
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [
          { id: '1', title: 'Real', dateTime: '2026-09-16T17:00:00+05:30' },
          { id: '2', title: 'Called off', dateTime: '2026-09-17T17:00:00+05:30', status: 'CANCELLED' },
          { id: '3', title: 'Unpublished', dateTime: '2026-09-18T17:00:00+05:30', status: 'DRAFT' },
        ],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events.map(e => e.title)).toEqual(['Real']);
  });

  it('KEEPS an event whose status it does not recognise', () => {
    // Fails in the safe direction on purpose. An allowlist (`status === 'ACTIVE'`) would zero this
    // source out the day Meetup renames a value — which is precisely the class of silent
    // regression this whole change exists because of.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [
          { id: '1', title: 'Newly named status', dateTime: '2026-09-16T17:00:00+05:30', status: 'SCHEDULED' },
        ],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events).toHaveLength(1);
  });
});

describe('the venue-country guard', () => {
  it('drops an event whose venue names a country other than India, and counts it', () => {
    // `active-adventure-travel-junkies` publishes 148 upcoming trips to Chiang Mai, Bali and Pisa.
    // The shared city gate is a gazetteer of INDIAN cities with no country input at all, so it
    // cannot judge these; a two-letter ISO code from the upstream's own structured Venue field
    // can, and it is not a text heuristic.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'travel',
        upcoming: [
          { id: '1', title: 'Chiang Mai', dateTime: '2026-10-01T09:00:00+05:30', venue: '10' },
          { id: '2', title: 'Bali', dateTime: '2026-10-02T09:00:00+05:30', venue: '11' },
          { id: '3', title: 'Bengaluru walk', dateTime: '2026-10-03T09:00:00+05:30', venue: '1' },
        ],
        venues: [
          BLR_VENUE,
          { id: '10', name: 'Chiang Mai', city: 'Chiang Mai', country: 'th' },
          { id: '11', name: 'Kuta', city: 'Bali', country: 'id' },
        ],
      }),
      { slug: 'travel', now: NOW }
    );
    expect(parsed.events.map(e => e.title)).toEqual(['Bengaluru walk']);
    expect(parsed.offCountry).toBe(2);
  });

  it('FAILS OPEN on an absent or empty country', () => {
    // The important negative. An empty country is the normal case for an online event and for a
    // venue Meetup has not fully filled in; refusing those would delete real Bengaluru events,
    // which is the same asymmetry `tests/off-city.test.ts` exists to protect.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [
          { id: '1', title: 'No country', dateTime: '2026-09-16T17:00:00+05:30', venue: '20' },
          { id: '2', title: 'No venue at all', dateTime: '2026-09-17T17:00:00+05:30' },
        ],
        venues: [{ id: '20', name: 'To Be Announced', city: '', country: '' }],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events).toHaveLength(2);
    expect(parsed.offCountry).toBe(0);
  });

  it('accepts a country in any case, since it is compared case-insensitively', () => {
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        upcoming: [{ id: '1', title: 'Kept', dateTime: '2026-09-16T17:00:00+05:30', venue: '30' }],
        venues: [{ id: '30', name: 'Somewhere', city: 'Bengaluru', country: 'IN' }],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events).toHaveLength(1);
  });
});

describe('meetupEventsFromGroupPage — degrading rather than throwing', () => {
  it('returns nothing for a page with no data island', () => {
    const parsed = meetupEventsFromGroupPage('<html><body>Just a page</body></html>', {
      slug: 'ai-blr',
      now: NOW,
    });
    expect(parsed.events).toEqual([]);
    expect(parsed.upstreamTotal).toBeUndefined();
  });

  it('returns nothing for a data island with no Apollo cache', () => {
    const html =
      '<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{}}}</script>';
    expect(meetupEventsFromGroupPage(html, { slug: 'ai-blr', now: NOW }).events).toEqual([]);
  });

  it('survives malformed JSON in the data island', () => {
    const html = '<script id="__NEXT_DATA__" type="application/json">{not json</script>';
    expect(() => meetupEventsFromGroupPage(html, { slug: 'ai-blr', now: NOW })).not.toThrow();
  });

  it('falls back to every Event node when the connection key is gone, and still sheds the past', () => {
    // The shape-change path. If Apollo's key encoding changes, the parser must still find events
    // rather than reporting zero — but the date floor has to do the past tab's filtering alone,
    // because there is then no `afterDateTime` connection to trust.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        omitConnection: true,
        upcoming: [
          { id: '1', title: 'Future A', dateTime: '2026-09-16T17:00:00+05:30' },
          { id: '2', title: 'Future B', dateTime: '2026-09-24T17:00:00+05:30' },
        ],
        past: [{ id: '3', title: 'Long gone', dateTime: '2026-07-15T17:00:00+05:30', status: 'PAST' }],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events.map(e => e.title).sort()).toEqual(['Future A', 'Future B']);
    // No connection means no total and no next-page flag — the caller must not be told otherwise.
    expect(parsed.upstreamTotal).toBeUndefined();
    expect(parsed.hasMore).toBe(false);
  });

  it('keeps an event that started within the pipeline\'s own past tolerance', () => {
    // Aligned with stage 5b's MAX_PAST_START_DAYS = 2, so an in-progress event is not thrown away
    // here only to be counted as a gate rejection against the group's health.
    const parsed = meetupEventsFromGroupPage(
      buildPage({
        slug: 'ai-blr',
        omitConnection: true,
        upcoming: [
          { id: '1', title: 'Started yesterday', dateTime: '2026-09-09T10:00:00+05:30' },
          { id: '2', title: 'Started last week', dateTime: '2026-09-01T10:00:00+05:30' },
        ],
      }),
      { slug: 'ai-blr', now: NOW }
    );
    expect(parsed.events.map(e => e.title)).toEqual(['Started yesterday']);
  });
});
