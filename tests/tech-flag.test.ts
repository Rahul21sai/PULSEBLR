import { describe, it, expect } from 'vitest';
import {
  TECH_FLAG_CATEGORIES,
  TECH_CATEGORY_NAMES,
  GATHERING_CATEGORY_NAMES,
  OTHER_CATEGORY_NAMES,
  EVENT_CATEGORIES,
} from '@/lib/event-types';

/**
 * `TECH_FLAG_CATEGORIES` — the set that turns a category array into `isTechEvent`, which is the
 * single field `techOnly` filters on (`lib/events/query.ts`: `filter.isTechEvent = true`). The
 * public feed is tech-only UNCONDITIONALLY, so membership of this set decides what the product
 * shows. There is no "show all events" escape hatch any more.
 *
 * TWO CONSUMERS, both deriving the flag the same way:
 *   · `lib/llm/tagger.ts` — `keywordTagging()`, the floor used whenever every LLM provider is
 *     down. Its categories come from regexes over title + description.
 *   · `app/api/events/route.ts` — the manual-add path, where a HUMAN picked the categories.
 *
 * ── WHY THIS FILE IS MOSTLY NEGATIVE CASES ───────────────────────────────────────────────────
 *
 * A widened set fails by OVER-matching, and no aggregate reveals that: the tech count simply goes
 * up, which reads as a recall win. It is the same shape as every other over-match this codebase
 * has paid for — a bare `\bpm\b` matching the "PM" in "6 PM" tagged a fifth of the corpus
 * `Product/Design`; a bare `gaming` matched "BoardGaming Sunday"; a substring match reported
 * "SAP" 157 times. So the assertions that matter here are the ones that must STAY false.
 *
 * ── THE STANDING PROPOSAL, AND THE MEASUREMENT THAT REFUSES IT ───────────────────────────────
 *
 * `Conference`, `Workshop` and `Meetup` describe the KIND of gathering, not the topic, so an
 * event tagged only `{Conference}` is excluded from the feed even when it is a tech conference.
 * That is real recall loss and the proposal to add them keeps coming back. It is refused on
 * evidence, re-measurable with this query against live Atlas:
 *
 *     db.events.find({ startDateTime: { $gte: new Date() },
 *                      category: { $all: ['Conference'], $nin: [...TECH_CATEGORY_NAMES, 'Hackathon'] } })
 *
 * 2026-09-10: 20 rows — i.e. exactly the rows adding `Conference` would flip into the tech feed —
 * and 17 of them are not tech events. Three treks (a trek goes to a SUMMIT, and `summit` is in
 * the tagger's `Conference` pattern), five trade expos, a trauma summit, an HR summit and a
 * mental-health festival, against three genuine gains. `Workshop` is worse and is barred by a
 * rule already documented rather than by a new count: its pattern includes
 * `training|certification|course`, and CLAUDE.md §3 records that `isTechEvent` must exclude
 * course-selling sessions EVEN WHEN FREE.
 *
 * The real recall fix is at the tagger — `scripts/retag-category.ts --match=<title regex>` — and
 * the rows below are the proof that it has to be: `[Conference]` and `[Conference]` are the whole
 * category array for both "Annual Trauma Summit" and "MCP Community Connect", so no rule over
 * this set can separate them. The information is not in the array.
 *
 * If you add one anyway, this suite fails on purpose. Re-run the query first, and read
 * `lib/event-types.ts`'s docblock for the full list of what flips.
 */

/**
 * Mirrors both consumers exactly. Neither exports a function to import, which is the one piece of
 * duplication this file cannot remove — so if that ever changes, delete this and import it.
 */
const isTech = (categories: readonly string[]): boolean =>
  categories.some(c => TECH_FLAG_CATEGORIES.has(c));

describe('TECH_FLAG_CATEGORIES — what MUST count as tech', () => {
  it('contains every one of the nine tech topics', () => {
    for (const name of TECH_CATEGORY_NAMES) {
      expect(TECH_FLAG_CATEGORIES.has(name), name).toBe(true);
    }
  });

  it('contains Hackathon, which is the one gathering type that is unambiguously technical', () => {
    // There is no such thing as a non-software hackathon. This is precedent for exactly that
    // word and does not generalise to Conference/Workshop/Meetup — see the header.
    expect(TECH_FLAG_CATEGORIES.has('Hackathon')).toBe(true);
  });

  it('flags a hand-entered "Internal Hack Day" categorised only Hackathon', () => {
    // The measured defect this member exists for: the event was stored isTechEvent=false, so it
    // did not appear in the default feed and looked to its own author like it had vanished.
    expect(isTech(['Hackathon'])).toBe(true);
  });

  it('flags a conference that carries a tech TOPIC, which is the path that already works', () => {
    expect(isTech(['Conference', 'AI/ML'])).toBe(true);
    expect(isTech(['Workshop', 'Cloud/DevOps'])).toBe(true);
    expect(isTech(['Meetup', 'Open Source', 'Community/Social'])).toBe(true);
    // Order must not matter — `some()` over the array, not the first element.
    expect(isTech(['Community/Social', 'Arts/Culture', 'Hardware/Robotics'])).toBe(true);
  });

  it('holds only real categories, so a typo cannot silently stop matching', () => {
    const valid = new Set<string>(EVENT_CATEGORIES);
    for (const name of TECH_FLAG_CATEGORIES) {
      expect(valid.has(name), `${name} is not a current category`).toBe(true);
    }
  });
});

describe('TECH_FLAG_CATEGORIES — what MUST NOT count as tech', () => {
  it('excludes every gathering type except Hackathon', () => {
    for (const name of GATHERING_CATEGORY_NAMES) {
      if (name === 'Hackathon') continue;
      expect(TECH_FLAG_CATEGORIES.has(name), `${name} must not make an event tech on its own`).toBe(
        false
      );
    }
  });

  it('excludes the whole non-tech tail', () => {
    for (const name of OTHER_CATEGORY_NAMES) {
      expect(TECH_FLAG_CATEGORIES.has(name), name).toBe(false);
    }
  });

  /**
   * Real rows, real stored category arrays, measured 2026-09-10. These are the events a blanket
   * `Conference` or `Workshop` add would put in front of a Bengaluru engineer looking for people
   * to meet. The trek is first because it shows the MECHANISM rather than the ratio: the tagger's
   * `Conference` pattern lists `summit`, and a trek goes to one.
   */
  const MUST_NOT_BE_TECH: Array<[string, string[]]> = [
    ['Kudremukh New Year Trek', ['Conference', 'Meetup', 'Arts/Culture']],
    ['Tadiandamol Coorg Trek', ['Conference', 'Meetup', 'Health/Fitness']],
    ['Property Expo at Pritech Park', ['Conference']],
    ['Dubai Real Estate Expo in Bangalore', ['Conference', 'Arts/Culture']],
    ['Garment Technology Expo (GTE) 2026', ['Conference']],
    ['Global Food Pro 2027 – International Food Processing Expo', ['Conference', 'Arts/Culture']],
    ['World Healthcare Expo & Summit 2026', ['Conference']],
    ['Annual Trauma Summit', ['Conference']],
    ['Manotsava | National Mental Health Festival', ['Conference', 'Business/Finance']],
    ['Bangalore HR Summit 2026', ['Career/Hiring', 'Conference']],
    ['Bengaluru 2026 Venture Capital World Summit', ['Business/Finance', 'Conference']],
    ['How Non-Techies Can Launch Successful Tech Startups', ['Conference', 'Meetup', 'Workshop']],
    // The Workshop half. CLAUDE.md §3: course-selling is excluded even when the session is free,
    // and `certification|training|course` all sit in the tagger's Workshop pattern.
    ['Leading SAFe 6.0 (Scaled Agilist) Certification Training', ['Workshop']],
    ['Scrum Master product owner Unique scrum master interview questions', ['Workshop']],
    ['All About Scrum Master/PO Role - IT Job without Coding technical skills', ['Workshop']],
    ["🧘 Neville Goddard's Powerful Meditation for Financial Freedom", ['Workshop', 'Health/Fitness']],
    ['ABCD 6.0 - Garba & Dandiya Workshop', ['Workshop']],
    ['Paid Workshop: Deep Dive into Design Thinking', ['Product/Design', 'Workshop']],
    // The Meetup half — 323 upcoming rows carry it, and this is what they mostly are.
    ['Friday Social & Board Games Night', ['Meetup', 'Arts/Culture', 'Community/Social']],
    ['Bangalore Toastmasters Club - Public Speaking', ['Meetup']],
    ['Skating in Cubbon Park', ['Meetup']],
    ['Durga Puja 2026', ['Meetup']],
    ['Asia Jewels Show Bangalore October 2026', ['Meetup', 'Arts/Culture']],
    // Business networking, which the tech prompt excludes by name.
    [
      "Bangalore's Big Business, Tech & Entrepreneur Professional Networking Event",
      ['Startup/Founders', 'Conference'],
    ],
  ];

  for (const [title, categories] of MUST_NOT_BE_TECH) {
    it(`does not flag "${title.slice(0, 58)}"`, () => {
      expect(isTech(categories), `stored as [${categories.join('|')}]`).toBe(false);
    });
  }

  it('does not flag an empty or unclassified array', () => {
    // `keywordTagging` falls back to ['Meetup'] when no pattern matches, so this is the shape a
    // completely unrecognised event arrives in. It must not default to tech.
    expect(isTech([])).toBe(false);
    expect(isTech(['Meetup'])).toBe(false);
    expect(isTech(['Other'])).toBe(false);
  });
});
