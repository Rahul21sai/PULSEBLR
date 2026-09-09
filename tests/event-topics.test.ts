import { describe, it, expect } from 'vitest';
import {
  TOPICS,
  MIN_TOPIC_EVENTS,
  findTopic,
  topicForDimension,
  slugify,
  topicQueryParams,
  topicPageTitle,
  topicMetaDescription,
  topicStaticParams,
  istWeekdayName,
  describeRhythm,
  type RhythmInput,
} from '@/lib/events/topics';
import { OTHER_CATEGORY_NAMES, EVENT_CATEGORIES } from '@/lib/event-types';
import { BENGALURU_AREAS } from '@/lib/scrapers/core/geo';

/**
 * Topic landing pages — `/topics/[slug]`.
 *
 * The assertions worth understanding are the ones about what must NOT exist. Google treats thin
 * templated pages with a swapped noun as doorway pages and penalises the site, so the risk here is
 * not a broken page — it is a page count that quietly grows into the full category × area matrix.
 * Three properties defend against that and all three are pinned below:
 *
 *   1. EVERY TOPIC CARRIES HAND-WRITTEN COPY. `blurb` is required, so the only way to add a page is
 *      to write prose for it. A test that merely checked "blurb is a non-empty string" would pass
 *      against a template, so these also assert the blurbs are all DISTINCT and long enough to be
 *      real sentences.
 *   2. NO PAGE FOR A DIMENSION THE PRODUCT DOES NOT PRESENT. The public feed is `techOnly`
 *      unconditionally, so a landing page for Arts/Culture would advertise supply the reader cannot
 *      then browse — an orphan page about events that appear nowhere else in the app.
 *   3. CATEGORY AND AREA SLUGS CANNOT COLLIDE. 'Other' is both a category and an area, which is the
 *      concrete collision the `in-` prefix exists to prevent.
 *
 * The rhythm sentence gets its own group because it is the half of a topic page a template cannot
 * fake, and because its interesting behaviour is refusal: it must decline to describe a pattern it
 * does not have enough rows to see.
 */

describe('slugify', () => {
  it.each([
    ['AI/ML', 'ai-ml'],
    ['Cloud/DevOps', 'cloud-devops'],
    ['Open Source', 'open-source'],
    ['Blockchain/Web3', 'blockchain-web3'],
    ['HSR Layout', 'hsr-layout'],
    ['MG Road', 'mg-road'],
    ['Career/Hiring', 'career-hiring'],
  ])('%s → %s', (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it('never leaves a leading or trailing hyphen', () => {
    // A stored value could gain punctuation at either end; '/foo-' is a different URL from '/foo'.
    expect(slugify('/AI/')).toBe('ai');
    expect(slugify('  Open Source  ')).toBe('open-source');
  });
});

describe('the published topic set', () => {
  it('is small and deliberate, not a matrix', () => {
    // 22 categories × 28 areas is 616 combinations. This set is roughly 28 hand-written pages, and
    // the point of the assertion is that the number cannot drift into the hundreds unnoticed.
    expect(TOPICS.length).toBeGreaterThan(10);
    expect(TOPICS.length).toBeLessThan(60);
  });

  it('gives every topic hand-written copy of a real length', () => {
    for (const topic of TOPICS) {
      expect(topic.blurb.length, `${topic.slug} blurb`).toBeGreaterThan(180);
      expect(topic.heading.length, `${topic.slug} heading`).toBeGreaterThan(10);
    }
  });

  it('gives every topic DISTINCT copy — a template would fail here, a blurb check would not', () => {
    const blurbs = new Set(TOPICS.map(t => t.blurb));
    const headings = new Set(TOPICS.map(t => t.heading));
    expect(blurbs.size).toBe(TOPICS.length);
    expect(headings.size).toBe(TOPICS.length);
  });

  it('has unique slugs — the collision the `in-` prefix exists to prevent', () => {
    const slugs = TOPICS.map(t => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);

    // 'Other' is the concrete case: it is a valid category AND a valid area.
    expect(EVENT_CATEGORIES).toContain('Other');
    expect(BENGALURU_AREAS).toContain('Other');
  });

  it('prefixes every area slug with `in-` and no category slug', () => {
    for (const topic of TOPICS) {
      if (topic.kind === 'area') expect(topic.slug.startsWith('in-'), topic.slug).toBe(true);
      else expect(topic.slug.startsWith('in-'), topic.slug).toBe(false);
    }
  });

  it('publishes NO page for the non-tech categories', () => {
    // The feed is techOnly unconditionally. A page for these would be an orphan: linked from
    // nothing, about events the reader cannot browse anywhere else in the app.
    const names = TOPICS.filter(t => t.kind === 'category').map(t => t.name);
    for (const other of OTHER_CATEGORY_NAMES) {
      expect(names, `${other} must not have a landing page`).not.toContain(other);
    }
  });

  it('publishes NO page for the `Other` area', () => {
    // A large share of the corpus resolves to area 'Other'. "Tech events in Other" is not a place.
    expect(TOPICS.map(t => t.name)).not.toContain('Other');
    expect(findTopic('in-other')).toBeNull();
  });

  it('names only real stored values, so a page cannot filter on a typo', () => {
    for (const topic of TOPICS) {
      if (topic.kind === 'category') expect(EVENT_CATEGORIES, topic.slug).toContain(topic.name);
      else expect(BENGALURU_AREAS, topic.slug).toContain(topic.name);
    }
  });

  it('offers every topic to generateStaticParams exactly once', () => {
    const params = topicStaticParams();
    expect(params).toHaveLength(TOPICS.length);
    expect(new Set(params.map(p => p.slug)).size).toBe(TOPICS.length);
  });
});

describe('findTopic', () => {
  it('resolves a category slug to its stored category name', () => {
    expect(findTopic('ai-ml')).toMatchObject({ kind: 'category', name: 'AI/ML' });
    expect(findTopic('cloud-devops')).toMatchObject({ kind: 'category', name: 'Cloud/DevOps' });
  });

  it('resolves an area slug to its stored area name', () => {
    expect(findTopic('in-koramangala')).toMatchObject({ kind: 'area', name: 'Koramangala' });
    expect(findTopic('in-hsr-layout')).toMatchObject({ kind: 'area', name: 'HSR Layout' });
  });

  it('is case-insensitive, because a shared link may arrive capitalised', () => {
    expect(findTopic('AI-ML')?.name).toBe('AI/ML');
  });

  it.each([
    ['', 'empty segment'],
    ['koramangala', 'an area WITHOUT the in- prefix is not a URL this app publishes'],
    ['arts-culture', 'a non-tech category has no page'],
    ['ai-ml/../admin', 'path traversal in a slug is simply not a topic'],
    ['in-basavanagudi', 'a real gazetteer area with no written copy — floor 1 refuses it'],
  ])('returns null for %s (%s)', slug => {
    expect(findTopic(slug)).toBeNull();
  });

  it.each([[null], [undefined]])('returns null for %s', value => {
    expect(findTopic(value)).toBeNull();
  });
});

describe('topicForDimension — the link guard', () => {
  it('finds the page for a category that has one', () => {
    expect(topicForDimension('category', 'AI/ML')?.slug).toBe('ai-ml');
    expect(topicForDimension('area', 'Koramangala')?.slug).toBe('in-koramangala');
  });

  it('returns null for a real stored value with NO page — the whole reason it exists', () => {
    // An event page links each of its categories to a topic page. Slugifying the name instead of
    // looking it up would emit `/topics/arts-culture` and `/topics/other`, which are 404s.
    expect(topicForDimension('category', 'Arts/Culture')).toBeNull();
    expect(topicForDimension('category', 'Other')).toBeNull();
    expect(topicForDimension('area', 'Other')).toBeNull();
    expect(topicForDimension('area', 'Basavanagudi')).toBeNull();
  });

  it('does not cross the two dimensions', () => {
    // A category name must not resolve through the area table, or vice versa.
    expect(topicForDimension('area', 'AI/ML')).toBeNull();
    expect(topicForDimension('category', 'Koramangala')).toBeNull();
  });

  it.each([[null], [undefined], ['']])('returns null for %s', value => {
    expect(topicForDimension('category', value)).toBeNull();
  });

  it('agrees with findTopic for every published topic', () => {
    for (const topic of TOPICS) {
      expect(topicForDimension(topic.kind, topic.name)?.slug, topic.slug).toBe(topic.slug);
      expect(findTopic(topic.slug)?.name, topic.slug).toBe(topic.name);
    }
  });
});

describe('topicQueryParams', () => {
  it('filters a category topic on category, tech-only', () => {
    expect(topicQueryParams(findTopic('ai-ml')!)).toEqual({
      techOnly: true,
      includeOngoing: true,
      category: ['AI/ML'],
    });
  });

  it('filters an area topic on area, tech-only', () => {
    expect(topicQueryParams(findTopic('in-whitefield')!)).toEqual({
      techOnly: true,
      includeOngoing: true,
      area: ['Whitefield'],
    });
  });

  it('sets techOnly on EVERY topic — one disagreement with the feed is one too many', () => {
    for (const topic of TOPICS) {
      expect(topicQueryParams(topic).techOnly, topic.slug).toBe(true);
    }
  });

  it('never sets both dimensions, which would silently intersect them', () => {
    for (const topic of TOPICS) {
      const params = topicQueryParams(topic);
      expect(Boolean(params.category) && Boolean(params.area), topic.slug).toBe(false);
    }
  });
});

describe('titles and descriptions', () => {
  it('brands the title without restating the heading', () => {
    const topic = findTopic('open-source')!;
    expect(topicPageTitle(topic)).toBe(`${topic.heading} · PulseBLR`);
  });

  it('keeps every meta description inside the length search results will show', () => {
    for (const topic of TOPICS) {
      const description = topicMetaDescription(topic);
      expect(description.length, `${topic.slug} (${description.length})`).toBeLessThanOrEqual(160);
      expect(description.length, topic.slug).toBeGreaterThan(40);
    }
  });

  it('cuts on a sentence boundary rather than mid-clause where it can', () => {
    for (const topic of TOPICS) {
      const description = topicMetaDescription(topic);
      // Either it ends a sentence, or it is explicitly elided — never a bare truncated word.
      expect(/[.!?]$|…$/.test(description), `${topic.slug}: ${description}`).toBe(true);
    }
  });

  it('never ends mid-word when it has to elide', () => {
    // A search result ending "…so a 6pm talk an attende…" reads as a rendering fault, not an
    // elision. Every elided description must break where the prose does.
    for (const topic of TOPICS) {
      const description = topicMetaDescription(topic);
      if (!description.endsWith('…')) continue;
      const body = description.slice(0, -1);
      expect(
        topic.blurb.replace(/\s+/g, ' ').startsWith(`${body} `),
        `${topic.slug} cut mid-word: …${body.slice(-24)}|`
      ).toBe(true);
    }
  });

  it('takes the description from the page’s own prose', () => {
    const topic = findTopic('cybersecurity')!;
    expect(topic.blurb.startsWith(topicMetaDescription(topic).replace(/…$/, ''))).toBe(true);
  });
});

describe('istWeekdayName', () => {
  it.each([
    // 2026-09-19T07:30:00Z is 13:00 IST on Saturday — same day either way.
    ['2026-09-19T07:30:00.000Z', 'Saturday'],
    // 20:30 UTC on Friday is 02:00 IST on SATURDAY. A UTC weekday would say Friday.
    ['2026-09-18T20:30:00.000Z', 'Saturday'],
    // 18:45 UTC on Sunday is 00:15 IST on Monday — the same trap in the other direction.
    ['2026-09-20T18:45:00.000Z', 'Monday'],
  ])('%s → %s in IST', (iso, expected) => {
    expect(istWeekdayName(iso)).toBe(expected);
  });

  it('returns an empty string rather than throwing on an unparseable date', () => {
    expect(istWeekdayName('not a date')).toBe('');
  });
});

describe('describeRhythm', () => {
  const at = (iso: string, over: Partial<RhythmInput> = {}): RhythmInput => ({
    startDateTime: iso,
    format: 'offline',
    isFree: true,
    ...over,
  });

  it('declines to describe a pattern below the event floor', () => {
    // Two events is not a rhythm. Saying "these usually happen on a Tuesday" from one Tuesday is
    // exactly the confident nonsense that makes a generated paragraph read as generated.
    expect(describeRhythm([at('2026-09-15T13:00:00.000Z')])).toBeNull();
    expect(describeRhythm([])).toBeNull();
    expect(
      describeRhythm([at('2026-09-15T13:00:00.000Z'), at('2026-09-22T13:00:00.000Z')])
    ).toBeNull();
    expect(MIN_TOPIC_EVENTS).toBe(3);
  });

  it('names the busiest day and a start hour in IST', () => {
    // 13:00 UTC = 18:30 IST. Four Saturdays out of five events.
    const sentence = describeRhythm([
      at('2026-09-19T13:00:00.000Z'),
      at('2026-09-26T13:00:00.000Z'),
      at('2026-10-03T13:00:00.000Z'),
      at('2026-10-10T13:00:00.000Z'),
      at('2026-09-23T13:00:00.000Z'),
    ])!;
    expect(sentence).toContain('Saturday is the busiest day');
    expect(sentence).toContain('18:00');
    expect(sentence).toContain('5 of the 5 upcoming are in person');
    expect(sentence).toContain('5 are free');
  });

  it('says "spread across the week" rather than inventing a busiest day', () => {
    // One event on each of five different days: the top day holds 1/5, below the concentration bar.
    const sentence = describeRhythm([
      at('2026-09-21T05:30:00.000Z'),
      at('2026-09-22T05:30:00.000Z'),
      at('2026-09-23T05:30:00.000Z'),
      at('2026-09-24T05:30:00.000Z'),
      at('2026-09-25T05:30:00.000Z'),
    ])!;
    expect(sentence).toContain('spread across the week');
    expect(sentence).not.toContain('busiest day');
  });

  it('counts online events as not in person, and omits the free clause when nothing is free', () => {
    const sentence = describeRhythm([
      at('2026-09-19T13:00:00.000Z', { format: 'online', isFree: false }),
      at('2026-09-19T13:00:00.000Z', { format: 'online', isFree: false }),
      at('2026-09-19T13:00:00.000Z', { format: 'hybrid', isFree: false }),
    ])!;
    expect(sentence).toContain('1 of the 3 upcoming are in person');
    expect(sentence).not.toContain('free');
  });
});
