import { describe, expect, it } from 'vitest';

import { isTechFromCategories, TECH_FLAG_CATEGORIES } from '@/lib/event-types';
import { validateManualEvent } from '@/lib/events/manual-input';
import { keywordTagging } from '@/lib/llm/tagger';

/**
 * THE BUG THIS PINS: a hand-added event was stored with a category nobody chose, and that invented
 * category decided whether the event existed.
 *
 * `validateManualEvent` used to end with `if (!category.length) category.push('Meetup')`, and
 * `app/add-event/page.tsx` substituted the same value in the browser before the POST. `'Meetup'` is
 * deliberately absent from `TECH_FLAG_CATEGORIES`, so `isTechEvent` derived `false`, and the home
 * feed — unconditionally `techOnly` — hid the row. Measured: 12 of 12 hand-added events owned by a
 * real user were stored `["Meetup"]` / `isTechEvent: false`, and 0 of the 5 future-dated ones matched
 * the feed.
 *
 * Every assertion below would have PASSED before the fix except the first one, which is the point:
 * the others are the invariants that must not drift back.
 */

const MINIMAL = {
  title: 'Something happening',
  description: 'A description long enough to be plausible.',
  startDateTime: '2026-12-01T10:00',
};

describe('validateManualEvent — an empty category stays empty', () => {
  it('does NOT invent a category when the caller supplied none', () => {
    // THE REGRESSION GUARD. A validator that fabricates a classification is asserting something
    // about the world on the user's behalf, and this particular fabrication is the one that made
    // every hand-added event invisible.
    const { fields } = validateManualEvent({ ...MINIMAL });
    expect(fields?.category).toEqual([]);
  });

  it('keeps a category the caller did choose, including a non-tech one', () => {
    // The fix must not become a tech-only gate on the corpus: an explicit non-tech category is a
    // legitimate thing to store, it simply does not appear in a techOnly feed.
    const { fields } = validateManualEvent({ ...MINIMAL, category: ['Community/Social'] });
    expect(fields?.category).toEqual(['Community/Social']);
    expect(isTechFromCategories(fields?.category)).toBe(false);
  });

  it('still refuses a category outside the taxonomy rather than silently dropping it', () => {
    const { fields, issues } = validateManualEvent({ ...MINIMAL, category: ['Underwater Basketry'] });
    expect(fields).toBeUndefined();
    expect(issues.some(i => i.field === 'category')).toBe(true);
  });
});

describe('isTechFromCategories — the one derivation', () => {
  it('is false for an EMPTY array, which is why the create path must refuse to store one', () => {
    // Arithmetically right, operationally a trap: storing an uncategorised event would assert
    // "not tech" about something nobody classified. The route blocks instead.
    expect(isTechFromCategories([])).toBe(false);
    expect(isTechFromCategories(undefined)).toBe(false);
    expect(isTechFromCategories(null)).toBe(false);
  });

  it("is false for 'Meetup' — the value that used to be injected", () => {
    expect(TECH_FLAG_CATEGORIES.has('Meetup')).toBe(false);
    expect(isTechFromCategories(['Meetup'])).toBe(false);
  });

  it('is true when any one member is a tech topic', () => {
    expect(isTechFromCategories(['AI/ML'])).toBe(true);
    // Mixed: one tech topic is enough, which is what lets the floor's `[Cloud/DevOps, Meetup,
    // Workshop]` reading count as tech.
    expect(isTechFromCategories(['Meetup', 'Cloud/DevOps'])).toBe(true);
    expect(isTechFromCategories(['Hackathon'])).toBe(true);
  });
});

describe('the keyword floor, as the create path uses it', () => {
  const read = (title: string) =>
    keywordTagging({ title, description: '' }).categories;

  it('recovers a real topic from the TITLE alone, for the titles that carry one', () => {
    // Actual stored titles. The floor is what makes the import path work without asking the user
    // for anything, and these three need nothing but the title.
    expect(isTechFromCategories(read('Hacktoberfest Hack Day Bengaluru | Major League Hacking'))).toBe(true);
    expect(isTechFromCategories(read('Teaching Architecture to AI Agents: Event-Driven Systems'))).toBe(true);
    expect(isTechFromCategories(read('AWS Data & AI Day Bengaluru 2026'))).toBe(true);
  });

  it('NEEDS THE DESCRIPTION for a title that names only a brand — measured, not assumed', () => {
    // `UbuCon India 2026` has no keyword in it: "UbuCon" is not a pattern, and the floor falls back
    // to ['Meetup'] on the title alone. The backfill still repaired this row to ['Open Source']
    // because it passes the stored DESCRIPTION too.
    //
    // Worth pinning because it bounds how much the floor can rescue: `POST /api/scrape-url` returns a
    // description for most pages but not all, and an import that arrives with a brand-name title and
    // an empty description will be REFUSED at create rather than guessed at. That is the intended
    // behaviour, and this is where to read why a given event asked for a category.
    expect(isTechFromCategories(read('UbuCon India 2026'))).toBe(false);
    expect(
      isTechFromCategories(
        keywordTagging({
          title: 'UbuCon India 2026',
          description: 'The Ubuntu community conference — open source talks and workshops.',
        }).categories
      )
    ).toBe(true);
  });

  it('DECLINES on a title with no topic signal, and the decline is the feature', () => {
    // `Dev Days | Bangalore` reads as `[Community/Social]` — plausible, non-tech, and exactly the
    // guess that would store another permanently-invisible row while reporting success. The route
    // answers 400 here instead. If a future change makes this read as tech, this test should be the
    // one that fails and gets re-argued.
    expect(isTechFromCategories(read('Dev Days | Bangalore, India · Luma'))).toBe(false);
  });

  it("falls back to ['Meetup'] on text it cannot read at all — so the route cannot trust it blindly", () => {
    // `lib/llm/tagger.ts` ends with `if (chosen.length === 0) chosen.push('Meetup')`. That is the
    // same fabrication removed from the validator, one layer down, which is why the create path tests
    // the floor's output for a TECH topic rather than merely for non-emptiness.
    expect(read('zzzz qqqq')).toEqual(['Meetup']);
  });
});
