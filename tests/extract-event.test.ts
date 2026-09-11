import { describe, it, expect } from 'vitest';
import {
  parseExtraction,
  parseIsoInstant,
  buildExtractionPrompt,
  TEXT_BUDGET,
} from '@/lib/llm/extract-event';
import {
  detectPlatform,
  contentFingerprint,
  parseContentSignal,
  isBengaluruCandidate,
  candidateToRawEvent,
  candidateToExtraction,
  extractionTextIsComplete,
  EXTRACTION_TEXT_KEEP,
  EXTRACTION_RESPONSE_KEEP,
  fingerprintSourceEventId,
  fingerprintFromSourceEventId,
  type MicrositeCandidate,
} from '@/lib/scrapers/adapters/microsite';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * THE REJECTIONS ARE THE FEATURE, SO THEY ARE MOST OF THIS FILE.
 *
 * `lib/llm/extract-event.ts` exists to let a model read a page that no structured path can read,
 * and the only thing standing between that and a fabricated event in a human's review queue is
 * this validator. Every rule it enforces is one a later "make it more forgiving" change would
 * relax, and each relaxation is silent: a coerced date produces an event, not an error.
 *
 * So the suite is deliberately weighted towards inputs that MUST be refused — the same shape as
 * `tests/off-city.test.ts`, which is mostly negative cases for the same reason. The positive
 * cases exist to prove the validator has not simply become a rejection machine, which would pass
 * every negative test and extract nothing.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** A page text every fixture is grounded against. Grounding is checked, so this matters. */
const PAGE_TEXT = [
  'Great International Developer Summit 2026',
  'GIDS 2026 · 12-15 May 2026 · Bengaluru',
  'Venue: Radisson Blu Atria, Palace Road, Bengaluru',
  'Register now. Early bird ₹18000.',
  'Speakers include Venkat Subramaniam and Anjana Vakil.',
  'Agenda: workshops, deep dives, and a hands-on lab track.',
].join('\n');

const NOW = new Date('2026-03-01T00:00:00+05:30');

function parse(rows: unknown, text = PAGE_TEXT) {
  return parseExtraction(JSON.stringify(rows), { sourceText: text, now: NOW });
}

/** A complete, valid row. Every negative case below is this with one field broken. */
function validRow(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Great International Developer Summit 2026',
    description: 'Four days of workshops, deep dives and a hands-on lab track in Bengaluru.',
    startsAt: '2026-05-12T09:00',
    endsAt: '2026-05-15T18:00',
    venue: 'Radisson Blu Atria',
    address: 'Palace Road, Bengaluru',
    city: 'Bengaluru',
    isOnline: false,
    organizer: 'GIDS',
    registrationUrl: 'https://developersummit.com/register',
    priceInr: 18000,
    isFree: false,
    ...overrides,
  };
}

describe('parseExtraction — the happy path exists', () => {
  it('accepts a fully specified event', () => {
    const out = parse([validRow()]);
    expect(out.rejected).toEqual([]);
    expect(out.events).toHaveLength(1);
    const event = out.events[0];
    expect(event.title).toBe('Great International Developer Summit 2026');
    expect(event.venue).toBe('Radisson Blu Atria');
    expect(event.isOnline).toBe(false);
    expect(event.priceInr).toBe(18000);
    expect(event.endsAt?.toISOString()).toBe('2026-05-15T12:30:00.000Z');
  });

  it('reads a naked local time as IST and SAYS SO', () => {
    // 09:00 IST is 03:30 UTC. The flag is what stops a silent assumption about an instant from
    // being indistinguishable from a stated one — an event on the wrong day is the failure.
    const out = parse([validRow({ startsAt: '2026-05-12T09:00' })]);
    expect(out.events[0].startsAt.toISOString()).toBe('2026-05-12T03:30:00.000Z');
    expect(out.events[0].assumedIst).toBe(true);
  });

  it('honours an explicit offset and does not claim it assumed one', () => {
    const out = parse([validRow({ startsAt: '2026-05-12T09:00+00:00' })]);
    expect(out.events[0].startsAt.toISOString()).toBe('2026-05-12T09:00:00.000Z');
    expect(out.events[0].assumedIst).toBe(false);
  });

  it('keeps an online event with no location at all', () => {
    const out = parse([
      validRow({ isOnline: true, venue: null, address: null, city: null }),
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].isOnline).toBe(true);
  });

  it('tolerates a code fence and leading prose, which is transport not content', () => {
    const raw = 'Here is the JSON:\n```json\n' + JSON.stringify([validRow()]) + '\n```';
    const out = parseExtraction(raw, { sourceText: PAGE_TEXT, now: NOW });
    expect(out.transportError).toBeUndefined();
    expect(out.events).toHaveLength(1);
  });

  it('treats an empty array as a correct answer, not a failure', () => {
    const out = parse([]);
    expect(out.events).toEqual([]);
    expect(out.rejected).toEqual([]);
    expect(out.transportError).toBeUndefined();
  });
});

describe('parseExtraction — dates are matched, never coerced', () => {
  // THE CENTRAL CASE. `new Date('Sept 20')` succeeds, silently supplies the CURRENT year, and is
  // exactly how a page about last year's summit becomes an upcoming event.
  it.each([
    ['a human month name', 'Sept 20'],
    ['a human date', '20 September 2026'],
    ['US slashes', '05/12/2026'],
    ['a relative phrase', 'next Tuesday'],
    ['an epoch number as a string', '1778601600000'],
    ['TBA', 'TBA'],
    ['an empty string', ''],
    ['an impossible month', '2026-13-01T09:00'],
    ['an impossible day', '2026-05-45T09:00'],
    ['an impossible hour', '2026-05-12T25:00'],
  ])('refuses %s', (_label, startsAt) => {
    const out = parse([validRow({ startsAt })]);
    expect(out.events).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('start-not-iso');
  });

  it('accepts a DATE with no time and records that the time was assumed', () => {
    /*
     * MEASURED, NOT ANTICIPATED. The first live run against `opensourceindia.in` — a page whose
     * only temporal claim is "7-8 OCT 2026 | BENGALURU" — came back `2026-10-07T00:00`, because
     * the format demanded a time and the model had none to give. Requiring a field the page does
     * not contain forces exactly the invention this module exists to refuse, so the date-only
     * shape is expressible and the assumption is recorded. Midnight IST is 18:30 UTC the day
     * before, which is also why the IST day, not the UTC one, is what `clusterKey` buckets on.
     */
    const out = parse([validRow({ startsAt: '2026-05-12', endsAt: '2026-05-15' })]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].timeAssumed).toBe(true);
    expect(out.events[0].startsAt.toISOString()).toBe('2026-05-11T18:30:00.000Z');
  });

  it('does not claim the time was assumed when one was given', () => {
    expect(parse([validRow()]).events[0].timeAssumed).toBe(false);
  });

  it('refuses a number, not only a bad string', () => {
    const out = parse([validRow({ startsAt: 1778601600000 })]);
    expect(out.rejected[0]?.reason).toBe('start-not-iso');
  });

  it('refuses a hallucinated year in either direction', () => {
    // The two shapes actually seen in this corpus: an evergreen advert dated years out, and a page
    // about a previous edition read as if it were upcoming.
    expect(parse([validRow({ startsAt: '2030-05-12T09:00' })]).rejected[0]?.reason).toBe(
      'start-out-of-window'
    );
    expect(parse([validRow({ startsAt: '2025-05-12T09:00' })]).rejected[0]?.reason).toBe(
      'start-out-of-window'
    );
  });

  it('accepts an event that started yesterday, because in-progress is still attendable', () => {
    const out = parse([validRow({ startsAt: '2026-02-28T09:00', endsAt: null })]);
    expect(out.events).toHaveLength(1);
  });

  it('refuses a range that ends before it starts', () => {
    const out = parse([validRow({ endsAt: '2026-05-11T18:00' })]);
    expect(out.rejected[0]?.reason).toBe('end-before-start');
  });

  it('keeps the event when only the OPTIONAL end date is unreadable', () => {
    // The asymmetry is deliberate: refusing here would apply the no-coercion rule backwards and
    // throw away a fully specified event over a field it does not need.
    const out = parse([validRow({ endsAt: 'three days later' })]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].endsAt).toBeUndefined();
  });
});

describe('parseExtraction — grounding: a field the page does not contain is a hallucination', () => {
  it('refuses a title that is not on the page', () => {
    const out = parse([validRow({ title: 'Bengaluru Kubernetes Community Day 2026' })]);
    expect(out.rejected[0]?.reason).toBe('title-not-on-page');
  });

  it('refuses a venue that is not on the page', () => {
    // The single most damaging invention: a plausible Bengaluru hotel nobody mentioned.
    const out = parse([validRow({ venue: 'Taj MG Road' })]);
    expect(out.rejected[0]?.reason).toBe('venue-not-on-page');
  });

  it('matches on letters and digits only, so punctuation and case do not cause a false refusal', () => {
    const out = parse([
      validRow({ title: 'GIDS 2026 — 12-15 May 2026 · BENGALURU' }),
    ]);
    expect(out.events).toHaveLength(1);
  });

  it('drops a fabricated speaker while keeping the event', () => {
    // `Event.speakers` is read by `speaker-match.ts`, so an invented person is the one extraction
    // error that reaches a real human's record. The event itself is still sound.
    const out = parse([
      validRow({
        speakers: [
          { name: 'Venkat Subramaniam', title: 'Author', company: null },
          { name: 'Someone Who Was Never There', title: null, company: null },
        ],
      }),
    ]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].speakers?.map(s => s.name)).toEqual(['Venkat Subramaniam']);
  });
});

describe('parseExtraction — a physical event with no location is refused, not filled in', () => {
  it('refuses when venue, address and city are all absent', () => {
    const out = parse([validRow({ isOnline: false, venue: null, address: null, city: null })]);
    expect(out.rejected[0]?.reason).toBe('no-location-evidence');
  });

  it('accepts a city alone — that is evidence, not a guess', () => {
    const out = parse([validRow({ venue: null, address: null, city: 'Bengaluru' })]);
    expect(out.events).toHaveLength(1);
  });

  it('treats a missing isOnline as physical, so absence cannot buy a location exemption', () => {
    const row = validRow({ venue: null, address: null, city: null });
    delete (row as Record<string, unknown>).isOnline;
    expect(parse([row]).rejected[0]?.reason).toBe('no-location-evidence');
  });
});

describe('parseExtraction — required text fields', () => {
  it.each([
    ['a missing title', { title: null }, 'title-missing'],
    ['an empty title', { title: '   ' }, 'title-missing'],
    ['a title below the length floor', { title: 'AI' }, 'title-missing'],
    ['a missing description', { description: null }, 'description-missing'],
    ['an empty description', { description: '' }, 'description-missing'],
  ])('refuses %s', (_label, overrides, reason) => {
    const out = parse([validRow(overrides as Record<string, unknown>)]);
    expect(out.events).toEqual([]);
    expect(out.rejected[0]?.reason).toBe(reason);
  });

  it('accepts a four-character acronym title, because real ones exist', () => {
    // The floor is 4, not "looks like a sentence". `GIDS` is the actual name of a Bengaluru
    // flagship, and a stricter floor would refuse the event this watchlist was built for.
    const out = parse([validRow({ title: 'GIDS' })]);
    expect(out.events).toHaveLength(1);
  });

  it('refuses a non-object row rather than skipping it silently', () => {
    const out = parse(['Great International Developer Summit 2026', 42, null, [validRow()]]);
    expect(out.events).toEqual([]);
    expect(out.rejected.map(r => r.reason)).toEqual([
      'not-an-object',
      'not-an-object',
      'not-an-object',
      'not-an-object',
    ]);
  });
});

describe('parseExtraction — the registration link is an href, so it is treated like one', () => {
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['data:', 'data:text/html,<script>fetch("//evil")</script>'],
    ['a relative path', '/register'],
    ['a bare word', 'register'],
  ])('refuses %s', (_label, registrationUrl) => {
    // Refused rather than dropped: the reviewer is the first person who clicks this, and a page
    // whose register link the model turned into a scheme like this is a page it read badly.
    const out = parse([validRow({ registrationUrl })]);
    expect(out.events).toEqual([]);
    expect(out.rejected[0]?.reason).toBe('bad-registration-url');
  });

  it('accepts an absent link', () => {
    const out = parse([validRow({ registrationUrl: null })]);
    expect(out.events).toHaveLength(1);
    expect(out.events[0].registrationUrl).toBeUndefined();
  });
});

describe('parseExtraction — transport failures yield NO events, never a partial one', () => {
  it('reports a non-JSON response', () => {
    const out = parseExtraction('I could not find any events on that page.', {
      sourceText: PAGE_TEXT,
      now: NOW,
    });
    expect(out.events).toEqual([]);
    expect(out.transportError).toMatch(/not JSON/);
  });

  it('refuses a single object where an array was specified', () => {
    const out = parseExtraction(JSON.stringify(validRow()), {
      sourceText: PAGE_TEXT,
      now: NOW,
    });
    expect(out.events).toEqual([]);
    expect(out.transportError).toMatch(/expected a JSON array/);
  });

  it('refuses a truncated response rather than salvaging the readable prefix', () => {
    // A truncated response is indistinguishable from a malformed one, and half an event is a
    // fabricated event with some true fields in it.
    const full = JSON.stringify([validRow(), validRow({ title: 'GIDS 2026 · 12-15 May 2026' })]);
    const out = parseExtraction(full.slice(0, full.length - 40), {
      sourceText: PAGE_TEXT,
      now: NOW,
    });
    expect(out.events).toEqual([]);
    expect(out.transportError).toBeDefined();
  });

  it('caps the number of accepted events', () => {
    const rows = Array.from({ length: 25 }, () => validRow());
    const out = parseExtraction(JSON.stringify(rows), {
      sourceText: PAGE_TEXT,
      now: NOW,
      maxEvents: 3,
    });
    expect(out.events).toHaveLength(3);
  });
});

describe('parseIsoInstant', () => {
  it('accepts seconds, Z, and a space separator', () => {
    expect(parseIsoInstant('2026-05-12T09:00:30Z')?.at.toISOString()).toBe(
      '2026-05-12T09:00:30.000Z'
    );
    expect(parseIsoInstant('2026-05-12 09:00')?.assumedIst).toBe(true);
  });

  it('refuses everything that is not the shape', () => {
    for (const bad of [undefined, null, 42, {}, [], '2026', '2026-05', 'now']) {
      expect(parseIsoInstant(bad)).toBeUndefined();
    }
  });
});

describe('buildExtractionPrompt', () => {
  it('caps the text it sends', () => {
    const prompt = buildExtractionPrompt({ url: 'https://x.test/', text: 'a'.repeat(50_000) });
    expect(prompt.length).toBeLessThan(TEXT_BUDGET + 500);
  });

  it('includes the URL, which is often the only place the year appears', () => {
    const prompt = buildExtractionPrompt({ url: 'https://x.test/summit-2026/', text: 'hello' });
    expect(prompt).toContain('https://x.test/summit-2026/');
  });
});

describe('detectPlatform — prefer the platform over the model', () => {
  it.each([
    ['luma', '<a href="https://lu.ma/razorpay-rize">Register</a>', 'luma-calendar'],
    ['meetup', '<a href="https://www.meetup.com/docker-bangalore/events/">Join</a>', 'meetup-group'],
    ['devfolio', '<iframe src="https://hackblr.devfolio.co/"></iframe>', 'devfolio'],
    ['bevy', '<script src="https://gdg.community.dev/x.js"></script>', 'bevy'],
  ])('finds %s and maps it to a source kind an adapter already scrapes', (platform, html, kind) => {
    const hit = detectPlatform(html, 'https://example.test/events/');
    expect(hit?.platform).toBe(platform);
    expect(hit?.sourceKind).toBe(kind);
    expect(hit?.handleUrl).toBeTruthy();
  });

  it.each([
    ['zoho-backstage', '<form action="https://www.zohobackstage.com/gids2026/tickets">'],
    ['konfhub', '<a href="https://konfhub.com/gids-2026">Tickets</a>'],
    ['airmeet', '<script src="https://www.airmeet.com/e/abc123"></script>'],
    ['hubilo', '<iframe src="https://acme.hubilo.com/summit"></iframe>'],
    ['cvent', '<a href="https://web.cvent.com/event/abc-123/summary">'],
    ['townscript', '<a href="https://www.townscript.com/e/gids-2026">'],
    ['explara', '<a href="https://www.explara.com/e/blr-summit">'],
  ])('recognises %s even with no adapter behind it yet', (platform, html) => {
    // Reporting a platform we cannot scrape is still worth doing: it says the page IS
    // machine-readable by somebody, so the work is an adapter rather than a model.
    const hit = detectPlatform(html, 'https://example.test/events/');
    expect(hit?.platform).toBe(platform);
    expect(hit?.sourceKind).toBeUndefined();
  });

  it('does not fire on a page that merely writes a platform name in prose', () => {
    const html = '<p>We used to run this on Eventbrite and Airmeet. Now we host it ourselves.</p>';
    expect(detectPlatform(html, 'https://example.test/events/')).toBeUndefined();
  });

  it('does not fire on a self-link, so a platform cannot detect itself', () => {
    const html = '<a href="https://lu.ma/discover">Discover</a>';
    expect(detectPlatform(html, 'https://lu.ma/razorpay-rize')).toBeUndefined();
  });

  it('reads the HTML, not the stripped text — the markers live in attributes', () => {
    // The whole reason `scrapeMicrosites` detects before it strips.
    const html = '<iframe src="https://acme.hubilo.com/summit"></iframe>';
    expect(detectPlatform(html, 'https://example.test/')).toBeDefined();
    expect(detectPlatform('acme hubilo com summit', 'https://example.test/')).toBeUndefined();
  });
});

describe('contentFingerprint — change detection', () => {
  it('is stable across whitespace and case, which change on every redeploy', () => {
    expect(contentFingerprint('GIDS 2026\n\n  Bengaluru ')).toBe(
      contentFingerprint('gids 2026 bengaluru')
    );
  });

  it('ignores a countdown, which changes every second without the page changing', () => {
    expect(contentFingerprint('Register now. 3 days left')).toBe(
      contentFingerprint('Register now. 2 days left')
    );
    expect(contentFingerprint('Ends in 14:22:07 remaining')).toBe(
      contentFingerprint('Ends in 02:11:59 remaining')
    );
  });

  it('CHANGES when a date or price changes — that IS the page changing', () => {
    expect(contentFingerprint('GIDS on 12 May 2026')).not.toBe(
      contentFingerprint('GIDS on 19 May 2026')
    );
    expect(contentFingerprint('Early bird 18000')).not.toBe(contentFingerprint('Early bird 22000'));
  });

  it('round-trips through the sourceEventId namespace', () => {
    const fp = contentFingerprint('anything');
    expect(fingerprintFromSourceEventId(fingerprintSourceEventId(fp))).toBe(fp);
  });

  it('does not claim a platform id as its own', () => {
    // The namespace is what stops ingestion's `{source, sourceEventId}` lookup from ever matching
    // one of these rows against a genuinely scraped company event.
    expect(fingerprintFromSourceEventId('evt-12345')).toBeUndefined();
    expect(fingerprintFromSourceEventId(undefined)).toBeUndefined();
  });
});

describe('parseContentSignal — the site term that speaks directly to this feature', () => {
  it('blocks the LLM step on ai-input=no', () => {
    const policy = parseContentSignal('User-agent: *\nContent-Signal: search=yes,ai-input=no\n');
    expect(policy.llmAllowed).toBe(false);
    expect(policy.note).toMatch(/ai-input=no/);
  });

  it('reports ai-train=no without enforcing it — training is not what happens here', () => {
    // indiafoss.net's real signal, measured 2026-09-11. Inventing a restriction the site did not
    // state is as wrong as ignoring one it did.
    const policy = parseContentSignal(
      'User-agent: *\nContent-Signal: search=yes,ai-train=no,use=reference\nAllow: /\n'
    );
    expect(policy.llmAllowed).toBe(true);
    expect(policy.refusesTraining).toBe(true);
    expect(policy.contentSignal).toContain('ai-train=no');
  });

  it('ignores the spec preamble, which is comments naming every signal value', () => {
    // The real files carry ~25 lines of explanatory comments that mention `ai-input` and
    // `content-signal = no`. Matching those would refuse every Cloudflare-fronted site on earth.
    const robots = [
      '# (b)  If a content-signal = no, you may not collect content for the',
      '#      corresponding use.',
      '# ai-input: inputting content into one or more AI models',
      'User-agent: *',
      'Allow: /',
    ].join('\n');
    const policy = parseContentSignal(robots);
    expect(policy.llmAllowed).toBe(true);
    expect(policy.contentSignal).toBeUndefined();
  });

  it('treats no signal at all as neither granted nor restricted, per the standard', () => {
    expect(parseContentSignal('User-agent: *\nDisallow: /admin\n').llmAllowed).toBe(true);
    expect(parseContentSignal('').llmAllowed).toBe(true);
  });
});

describe('isBengaluruCandidate — the review queue has to be about Bengaluru', () => {
  const base = {
    title: 'Data + AI Summit',
    description: 'A summit.',
    startsAt: new Date('2026-05-12T09:00:00+05:30'),
    assumedIst: true,
    timeAssumed: false,
    isOnline: false,
  };
  const global = { url: 'https://x.test/events', organizer: 'Acme' };
  const cityScoped = { ...global, bengaluruOnly: true };

  it('keeps a Bengaluru venue on a global page', () => {
    expect(
      isBengaluruCandidate({ ...base, venue: 'Radisson Blu Atria, Bengaluru' }, global)
    ).toBe(true);
  });

  it('drops an unplaced physical event on a global page', () => {
    // The measured failure this prevents: a company events index whose Bengaluru mention is about
    // a different event on the same page.
    expect(isBengaluruCandidate({ ...base, venue: 'Moscone Center' }, global)).toBe(false);
  });

  it('keeps an unplaced physical event on a city-scoped page', () => {
    expect(isBengaluruCandidate({ ...base, venue: 'The Lalit Ashok' }, cityScoped)).toBe(true);
  });

  it('drops a named other city even on a city-scoped page', () => {
    // `offCityReason` is the hard reject and it outranks the entry's own scoping — a Chennai
    // edition announced on a Bengaluru site is still a Chennai event.
    expect(
      isBengaluruCandidate({ ...base, city: 'Chennai', venue: 'Chennai Trade Centre' }, cityScoped)
    ).toBe(false);
  });

  it('keeps an online event with no location on either kind of page', () => {
    expect(isBengaluruCandidate({ ...base, isOnline: true }, global)).toBe(true);
    expect(isBengaluruCandidate({ ...base, isOnline: true }, cityScoped)).toBe(true);
  });
});

describe('candidateToRawEvent', () => {
  const candidate: MicrositeCandidate = {
    url: 'https://razorpay.com/events/',
    organizer: 'Razorpay',
    fingerprint: 'abc123',
    sourceText: PAGE_TEXT,
    event: {
      title: 'Great International Developer Summit 2026',
      description: 'A summit.',
      startsAt: new Date('2026-05-12T09:00:00+05:30'),
      assumedIst: true,
      timeAssumed: false,
      isOnline: false,
      venue: 'Radisson Blu Atria',
    },
  };

  it('carries NO tags, so the URL cannot become a company attribution', () => {
    // `assemble()` feeds `raw.tags` to `resolveCompanies()`, which scores a tag match at 60 with
    // no `strength` gate — so a marker tag naming this URL would attribute Razorpay to every
    // event on the page, justified by nothing but where it was fetched from.
    expect(candidateToRawEvent(candidate).tags).toBeUndefined();
  });

  it('never sets sourceEventId — that field feeds a lookup these rows must not enter', () => {
    expect(candidateToRawEvent(candidate).sourceEventId).toBeUndefined();
  });

  it('pins the timezone rather than leaving it to the ambient locale', () => {
    expect(candidateToRawEvent(candidate).timezone).toBe('Asia/Kolkata');
  });

  it('falls back to the page URL when no registration link was found', () => {
    const raw = candidateToRawEvent(candidate);
    expect(raw.sourceUrl).toBe('https://razorpay.com/events/');
    expect(raw.applyLink).toBe('https://razorpay.com/events/');
  });

  it('prefers the extracted registration link when there is one', () => {
    const raw = candidateToRawEvent({
      ...candidate,
      event: { ...candidate.event, registrationUrl: 'https://developersummit.com/register' },
    });
    expect(raw.sourceUrl).toBe('https://developersummit.com/register');
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * `candidateToExtraction` — the audit record, and it has exactly one job: be COMPLETE.
 *
 * `Event.extraction`'s subfields are deliberately not `required` in the schema, because a required
 * subfield would turn an incomplete audit record into a ValidationError that deletes the candidate
 * event it exists to document. That moves the "complete or absent" invariant out of mongoose and
 * into this one builder — so it has to be pinned here, or nothing enforces it anywhere.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe('candidateToExtraction — a wrong parse has to be auditable', () => {
  const base: MicrositeCandidate = {
    url: 'https://developersummit.com/',
    organizer: 'GIDS',
    fingerprint: 'deadbeefcafe0123',
    sourceText: PAGE_TEXT,
    rawResponse: '[{"title":"Great International Developer Summit 2026"}]',
    model: 'claude-sonnet-5',
    event: {
      title: 'Great International Developer Summit 2026',
      description: 'A summit.',
      startsAt: new Date('2026-05-12T09:00:00+05:30'),
      assumedIst: true,
      timeAssumed: false,
      isOnline: false,
      venue: 'Radisson Blu Atria',
      registrationUrl: 'https://developersummit.com/register',
    },
  };

  it('carries every field a reviewer needs to judge the parse', () => {
    const at = new Date('2026-03-01T04:05:06.000Z');
    const record = candidateToExtraction(base, at);
    expect(record.text).toBe(PAGE_TEXT);
    expect(record.textLength).toBe(PAGE_TEXT.length);
    expect(record.fingerprint).toBe('deadbeefcafe0123');
    expect(record.response).toBe(base.rawResponse);
    expect(record.model).toBe('claude-sonnet-5');
    expect(record.extractedAt).toBe(at);
  });

  it('records the WATCHLIST page, not the registration link the model found', () => {
    // `candidateToRawEvent` deliberately prefers the registration URL for the event's own
    // `sourceUrl` — that is where a reader should go. The audit trail needs the opposite: the page
    // whose text produced the row, and the only URL that can be re-fetched to reproduce it.
    const record = candidateToExtraction(base);
    expect(record.sourceUrl).toBe('https://developersummit.com/');
    expect(record.sourceUrl).not.toBe(base.event.registrationUrl);
  });

  it('retains MORE than the model was shown, because grounding is checked against more', () => {
    // The gap between the two caps is the whole reason `EXTRACTION_TEXT_KEEP` is not `TEXT_BUDGET`:
    // `buildExtractionPrompt` truncates at `TEXT_BUDGET`, `parseExtraction` grounds against the
    // untruncated string. Retaining only the prompt slice would make a re-grounding check accuse a
    // title quoted from the tail of being a hallucination.
    expect(EXTRACTION_TEXT_KEEP).toBeGreaterThan(TEXT_BUDGET);
  });

  it('caps the retained text, and says how much there was', () => {
    const long = 'Bengaluru Tech Summit 2026. '.repeat(4000);
    expect(long.length).toBeGreaterThan(EXTRACTION_TEXT_KEEP);
    const record = candidateToExtraction({ ...base, sourceText: long });
    expect(record.text).toHaveLength(EXTRACTION_TEXT_KEEP);
    // The pre-cap length is the ONLY way a reader can tell the retained copy is partial.
    expect(record.textLength).toBe(long.length);
    expect(extractionTextIsComplete(record)).toBe(false);
  });

  it('reports a whole page as complete, so the audit can make a finding rather than a guess', () => {
    expect(extractionTextIsComplete(candidateToExtraction(base))).toBe(true);
  });

  it('treats a missing record as not-verifiable rather than as complete', () => {
    // Fails CLOSED. Every row that predates this field has no record at all, and reporting those as
    // "text complete" would let the audit run its grounding check against nothing and pass.
    expect(extractionTextIsComplete(undefined)).toBe(false);
    expect(extractionTextIsComplete({ fingerprint: 'abc' })).toBe(false);
    expect(extractionTextIsComplete({ text: 'short' })).toBe(false);
  });

  it('caps the verbatim reply too', () => {
    const record = candidateToExtraction({ ...base, rawResponse: 'x'.repeat(50000) });
    expect(record.response).toHaveLength(EXTRACTION_RESPONSE_KEEP);
  });

  it('omits response and model rather than storing empty strings for them', () => {
    // A model that answered nothing and a run that recorded nothing must be distinguishable, and
    // `''` reads as the latter. The candidate's own types make both optional.
    const record = candidateToExtraction({
      ...base,
      rawResponse: undefined,
      model: undefined,
    });
    expect(record.response).toBeUndefined();
    expect(record.model).toBeUndefined();
    // The fields that make the row auditable at all are still there.
    expect(record.text).toBe(PAGE_TEXT);
    expect(record.fingerprint).toBe('deadbeefcafe0123');
  });

  it('retains the text the fingerprint was computed over, so drift is detectable', () => {
    // `sourceEventId` is refreshed on a later run; this copy is not, unless the landing path
    // replaces both together. The two agreeing is what says the retained text produced this row.
    const record = candidateToExtraction({
      ...base,
      fingerprint: contentFingerprint(PAGE_TEXT),
    });
    expect(record.fingerprint).toBe(contentFingerprint(record.text!));
  });
});
