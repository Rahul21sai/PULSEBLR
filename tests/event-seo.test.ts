import { describe, it, expect } from 'vitest';
import {
  isIndexableEvent,
  buildEventJsonLd,
  serializeJsonLd,
  eventSeoDescription,
  type SeoEvent,
} from '@/lib/events/seo';

/**
 * Structured data and share metadata for `/events/[id]`.
 *
 * Two of these assertions are load-bearing and the rest are shape checks.
 *
 *   1. A NON-PUBLIC EVENT MUST NEVER PRODUCE JSON-LD. `visibility: 'private'` and `'pending'` events
 *      are reachable at their own URL by their owner (and pending ones by an admin). Emitting
 *      structured data for them would publish another user's private event into Google's index —
 *      strictly worse than the in-app disclosure the September audit fixed, because a search index
 *      is not something you can retract.
 *
 *   2. THE SERIALISER MUST NEUTRALISE `<`. Next's own JSON-LD guide says plainly that
 *      `JSON.stringify` "does not sanitize malicious strings used in XSS injection". Every field
 *      here — title, description, organizer, venue — is SCRAPED from a third-party page, so this is
 *      attacker-influenced content by construction, not a hypothetical. A title carrying
 *      `</script><script>…` would otherwise be stored XSS on our own domain.
 */

const PUBLIC_EVENT: SeoEvent = {
  _id: '6a9d6e5c4a1ac3c7329ad146',
  title: 'vLLM Inference Meetup Bengaluru',
  description: 'A deep dive into the engine room of vLLM and llm-d AI inferencing.',
  format: 'offline',
  isFree: true,
  venue: 'Red Hat India Pvt. Ltd.',
  address: 'Doddanekkundi',
  area: 'Doddanekkundi',
  city: 'Bengaluru',
  organizer: 'Red Hat',
  imageUrl: 'https://example.com/cover.jpg',
  startDateTime: '2026-09-19T07:30:00.000Z',
  endDateTime: '2026-09-19T13:00:00.000Z',
};

const CANONICAL = 'https://pulseblr.app/events/6a9d6e5c4a1ac3c7329ad146';

describe('isIndexableEvent', () => {
  it.each([
    [undefined, true, 'absent visibility is the ~1500 scraped documents — the common case, not a fallback'],
    [null, true, 'an explicit null is what PUT writes when unpinning; it must read as public'],
    ['public', true, 'explicitly public'],
    ['private', false, 'owner-only'],
    ['pending', false, 'awaiting review — visible to owner and admin, indexable by nobody'],
  ])('visibility %s → indexable %s (%s)', (visibility, expected, why) => {
    // The reason rides into the assertion message, so a failure says WHY this row exists.
    expect(isIndexableEvent({ ...PUBLIC_EVENT, visibility: visibility as never }), why).toBe(expected);
  });
});

describe('buildEventJsonLd — the private-event gate', () => {
  it.each([['private'], ['pending']])('returns null for a %s event', visibility => {
    expect(buildEventJsonLd({ ...PUBLIC_EVENT, visibility }, CANONICAL)).toBeNull();
  });

  it('returns structured data for a public event', () => {
    const ld = buildEventJsonLd(PUBLIC_EVENT, CANONICAL);
    expect(ld).not.toBeNull();
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'Event',
      name: 'vLLM Inference Meetup Bengaluru',
      url: CANONICAL,
    });
  });
});

describe('serializeJsonLd — XSS', () => {
  it('escapes every `<` so a scraped title cannot break out of the script tag', () => {
    const hostile = {
      ...PUBLIC_EVENT,
      title: 'Totally Normal Meetup</script><script>alert(document.cookie)</script>',
    };
    const out = serializeJsonLd(buildEventJsonLd(hostile, CANONICAL));

    expect(out).not.toContain('</script>');
    expect(out).not.toContain('<script');
    expect(out).toContain('\\u003c');
  });

  it('escapes `<` in the description too, not just the title', () => {
    const hostile = { ...PUBLIC_EVENT, description: 'Great event <img src=x onerror=alert(1)>' };
    expect(serializeJsonLd(buildEventJsonLd(hostile, CANONICAL))).not.toContain('<img');
  });

  it('still produces valid JSON after escaping', () => {
    const hostile = { ...PUBLIC_EVENT, title: 'a</script>b', description: '<b>c</b>' };
    const out = serializeJsonLd(buildEventJsonLd(hostile, CANONICAL));
    expect(() => JSON.parse(out)).not.toThrow();
    // The escape must survive a round trip as the ORIGINAL character, not a literal <.
    expect(JSON.parse(out).name).toBe('a</script>b');
  });

  it('returns an empty string for null, so a caller cannot render "null" into the page', () => {
    expect(serializeJsonLd(null)).toBe('');
  });
});

describe('buildEventJsonLd — attendance mode and location', () => {
  it('maps an in-person event to OfflineEventAttendanceMode with a Place', () => {
    const ld = buildEventJsonLd(PUBLIC_EVENT, CANONICAL)!;
    expect(ld.eventAttendanceMode).toBe('https://schema.org/OfflineEventAttendanceMode');
    expect(ld.location).toMatchObject({
      '@type': 'Place',
      name: 'Red Hat India Pvt. Ltd.',
      address: { '@type': 'PostalAddress', addressLocality: 'Bengaluru' },
    });
  });

  it('maps an online event to OnlineEventAttendanceMode with a VirtualLocation', () => {
    const ld = buildEventJsonLd(
      { ...PUBLIC_EVENT, format: 'online', venue: undefined, onlineLink: 'https://meet.example/x' },
      CANONICAL
    )!;
    expect(ld.eventAttendanceMode).toBe('https://schema.org/OnlineEventAttendanceMode');
    expect(ld.location).toMatchObject({ '@type': 'VirtualLocation', url: 'https://meet.example/x' });
  });

  it('maps hybrid to MixedEventAttendanceMode', () => {
    const ld = buildEventJsonLd({ ...PUBLIC_EVENT, format: 'hybrid' }, CANONICAL)!;
    expect(ld.eventAttendanceMode).toBe('https://schema.org/MixedEventAttendanceMode');
  });

  it('prefers the area over the city when there is no venue — it is the more useful answer', () => {
    const ld = buildEventJsonLd({ ...PUBLIC_EVENT, venue: undefined, address: undefined }, CANONICAL)!;
    expect(ld.location).toMatchObject({ '@type': 'Place', name: 'Doddanekkundi' });
  });

  it('falls back to the city when there is neither venue nor area — Event wants a location', () => {
    const ld = buildEventJsonLd(
      { ...PUBLIC_EVENT, venue: undefined, address: undefined, area: undefined },
      CANONICAL
    )!;
    expect(ld.location).toMatchObject({ '@type': 'Place', name: 'Bengaluru' });
  });

  it('does not emit a VirtualLocation with no url — an empty url is worse than no location', () => {
    const ld = buildEventJsonLd(
      { ...PUBLIC_EVENT, format: 'online', onlineLink: undefined, venue: undefined },
      CANONICAL
    )!;
    expect(JSON.stringify(ld)).not.toContain('"url":""');
  });
});

describe('buildEventJsonLd — offers and dates', () => {
  it('describes a free event as a zero-price offer', () => {
    const ld = buildEventJsonLd(PUBLIC_EVENT, CANONICAL)!;
    expect(ld.offers).toMatchObject({
      '@type': 'Offer',
      price: '0',
      priceCurrency: 'INR',
      availability: 'https://schema.org/InStock',
    });
  });

  it('carries a real price and currency for a paid event', () => {
    const ld = buildEventJsonLd(
      { ...PUBLIC_EVENT, isFree: false, price: 1500, currency: 'INR' },
      CANONICAL
    )!;
    expect(ld.offers).toMatchObject({ price: '1500', priceCurrency: 'INR' });
  });

  it('marks a sold-out event SoldOut', () => {
    const ld = buildEventJsonLd({ ...PUBLIC_EVENT, soldOut: true }, CANONICAL)!;
    expect(ld.offers).toMatchObject({ availability: 'https://schema.org/SoldOut' });
  });

  it('emits ISO dates and omits endDate when there is none', () => {
    const ld = buildEventJsonLd({ ...PUBLIC_EVENT, endDateTime: undefined }, CANONICAL)!;
    expect(ld.startDate).toBe('2026-09-19T07:30:00.000Z');
    expect('endDate' in ld).toBe(false);
  });

  it('omits an unparseable date rather than emitting Invalid Date', () => {
    const ld = buildEventJsonLd({ ...PUBLIC_EVENT, endDateTime: 'not-a-date' }, CANONICAL)!;
    expect('endDate' in ld).toBe(false);
  });
});

describe('eventSeoDescription', () => {
  it('uses the event description, stripped and trimmed', () => {
    expect(eventSeoDescription(PUBLIC_EVENT)).toContain('deep dive into the engine room');
  });

  /**
   * Asterisks and backticks go; UNDERSCORES DELIBERATELY STAY.
   *
   * `stripMarkdown` handles `*em*` but not `_em_`, and for this corpus that omission is correct
   * rather than a gap: underscores carry meaning in technical strings, so stripping them would turn
   * `llm_d` into `llmd` and `snake_case` into `snakecase` on exactly the events this product is for.
   * An expectation of "no underscores" would force behaviour that corrupts real titles.
   */
  it('strips the markdown that hurts a share preview, and leaves technical underscores alone', () => {
    const d = eventSeoDescription({ ...PUBLIC_EVENT, description: '**Bold** and `code` and llm_d' });
    expect(d).not.toMatch(/[*`]/);
    expect(d).toContain('llm_d');
  });

  it('caps length for a share card', () => {
    const long = 'x'.repeat(600);
    expect(eventSeoDescription({ ...PUBLIC_EVENT, description: long }).length).toBeLessThanOrEqual(200);
  });

  it('generates a sentence from the facts when there is no description', () => {
    const d = eventSeoDescription({ ...PUBLIC_EVENT, description: undefined });
    expect(d).toMatch(/Bengaluru/);
    expect(d.length).toBeGreaterThan(20);
  });

  it('never returns an empty string, because an empty og:description is worse than none', () => {
    const bare: SeoEvent = {
      _id: 'x',
      title: 'Untitled',
      format: 'online',
      isFree: true,
      startDateTime: '2026-09-19T07:30:00.000Z',
    };
    expect(eventSeoDescription(bare).length).toBeGreaterThan(0);
  });
});
