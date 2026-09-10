/**
 * Card metadata — `audience`, `perks`, `tier`.
 *
 * ── THE NEGATIVE CASES ARE THE POINT OF THIS FILE ────────────────────────────────
 * A classifier fails LOUDLY by missing things and SILENTLY by over-matching, and only
 * the second one is dangerous here. If `audience` misses `sre` on an on-call talk,
 * somebody filtering for SRE events sees one fewer row and can still find it every
 * other way. If a bare `\bsenior\b` matches "senior citizen yoga", a wellness event
 * is filed as being for senior engineers, it appears under a filter chip that promised
 * otherwise, and NO AGGREGATE COUNT REVEALS IT — coverage goes UP, which reads as an
 * improvement. This corpus has paid for that lesson once already: a bare `\bpm\b`
 * matched the "PM" in "6 PM" and tagged a fifth of every stored event
 * `Product/Design`.
 *
 * So most of what follows pins REFUSALS, and each one names the real phrase from
 * Bengaluru event copy that a looser pattern would have swallowed. A later
 * "simplification" that widens any of these regexes fails here on purpose.
 *
 * Pure functions only — no database, no network, no LLM. `deriveCardMetadata` and
 * `keywordTagging` are both synchronous and read nothing but their argument.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  deriveCardMetadata,
  keywordTagging,
  ADVERT_PATTERN,
  FLAGSHIP_TITLE_PATTERN,
  AUDIENCE_KEYWORDS,
  PERK_KEYWORDS,
} from '@/lib/llm/tagger';
import {
  AUDIENCE_NAMES,
  PERK_NAMES,
  EVENT_TIERS,
  FOOD_PERKS,
  hasFoodFromPerks,
} from '@/lib/event-types';

/** Terse helper: derive from a title alone, which is the weakest input the app ever has. */
const fromTitle = (title: string) => deriveCardMetadata({ title, description: '' });

/** Derive from title + description, which is what ingest actually passes. */
const fromText = (title: string, description: string) =>
  deriveCardMetadata({ title, description });

const audienceOf = (title: string, description = '') => fromText(title, description).audience;
const perksOf = (title: string, description = '') => fromText(title, description).perks;

/**
 * ── THE 0x08 GUARD ────────────────────────────────────────────────────────────────
 * CLAUDE.md records that editing `tagger.ts` through a shell heredoc once rewrote all
 * 70 `\b` word boundaries as literal 0x08 BACKSPACE bytes, so `/\b(ai|…)\b/i` became
 * `/<BS>(ai|…)<BS>/i` and matched NOTHING. `keywordTagging()` was silently dead code,
 * and it was invisible because the LLM tier was succeeding at the time — the documented
 * floor ("an event is never dropped for want of a classification") had no floor at all.
 * The recommended check is a `python -c` one-liner run by hand, which only helps the
 * person who remembers to run it. That class of bug was reproduced again, live, during
 * the session that added this file.
 *
 * So it is asserted here instead, where `npx vitest` catches it. Two assertions, because
 * either alone is insufficient:
 *
 *   1. NO 0x08 BYTE IN THE SOURCE. Catches the corruption directly and immediately,
 *      pointing at the cause rather than at a symptom three layers away.
 *   2. THE FLOOR STILL CLASSIFIES, as an aggregate over representative events. This is
 *      the assertion `scripts/diag-keyword-tagging.ts` calls decisive, and its logic is
 *      worth restating: a mangled boundary yields NO categories rather than a few wrong
 *      ones, so a total count is a sharper instrument here than any per-case expectation.
 *      It also covers corruptions that are not 0x08 — `\w`, `\s` and `\d` have the same
 *      shape of hazard and no reserved control character to look for.
 *
 * Reading a source file from a pure-function suite is unusual. It is worth one
 * `readFileSync` to make a documented, twice-repeated, silent-by-construction failure
 * impossible to land.
 */
describe('tagger source integrity', () => {
  const TAGGER = path.resolve(import.meta.dirname, '..', 'lib', 'llm', 'tagger.ts');

  it('contains no literal 0x08 BACKSPACE byte', () => {
    const bytes = readFileSync(TAGGER);
    const found: number[] = [];
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 0x08) found.push(i);
    expect(found, `0x08 at byte offset(s) ${found.slice(0, 10).join(', ')}`).toEqual([]);
  });

  it('contains no other stray C0 control byte where a regex escape belongs', () => {
    // The same accident applied to `\f` (0x0c) or `\v` (0x0b) would be just as silent.
    // Tab (0x09), LF (0x0a) and CR (0x0d) are legitimate in source and excluded.
    const bytes = readFileSync(TAGGER);
    const strays = new Set<number>();
    for (const b of bytes) {
      if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) strays.add(b);
    }
    expect([...strays].map(b => `0x${b.toString(16).padStart(2, '0')}`)).toEqual([]);
  });

  it('STILL CLASSIFIES — the aggregate assertion, which is what a mangled \\b breaks', () => {
    // Mirrors scripts/diag-keyword-tagging.ts. A dead pattern set returns the
    // `['Meetup']` placeholder for everything and zero tech flags, so both totals move
    // together and neither can be satisfied by luck.
    const cases: Array<[string, string, boolean]> = [
      ['Bangalore Kubernetes Meetup #42', 'Cloud/DevOps', true],
      ['Hands-on LLM fine-tuning workshop', 'AI/ML', true],
      ['IndiaFOSS 2026 — open source conference', 'Open Source', true],
      ['Embedded systems and FPGA design night', 'Hardware/Robotics', true],
      ['React and TypeScript frontend meetup', 'Web/Mobile', true],
      ['OWASP web application security talk', 'Cybersecurity', true],
      ['Ethereum smart contract workshop', 'Blockchain/Web3', true],
      ['Weekend trek to Skandagiri', 'Health/Fitness', false],
      ['Live jazz and open mic night', 'Arts/Culture', false],
    ];
    let categoriesMatched = 0;
    let techMatched = 0;
    for (const [title, expected, tech] of cases) {
      const r = keywordTagging({ title, description: '' });
      if (r.categories.includes(expected)) categoriesMatched++;
      if (r.isTechEvent === tech) techMatched++;
    }
    expect(categoriesMatched).toBe(cases.length);
    expect(techMatched).toBe(cases.length);
  });
});

describe('vocabulary integrity', () => {
  it('every pattern name is a member of its published vocabulary', () => {
    // A typo'd name here is not a test failure at runtime, it is a Mongoose enum
    // ValidationError on the first write — i.e. the whole backfill dying on document 1.
    for (const [name] of AUDIENCE_KEYWORDS) {
      expect(AUDIENCE_NAMES as readonly string[]).toContain(name);
    }
    for (const [name] of PERK_KEYWORDS) {
      expect(PERK_NAMES as readonly string[]).toContain(name);
    }
  });

  it('covers every audience and perk value, so no chip is unreachable from keywords', () => {
    // A vocabulary value with no keyword pattern can only ever be set by the LLM, and
    // with every provider down (measured 2026-09-10) that means never.
    //
    // Unique-ified, because a name may legitimately appear TWICE with different scopes:
    // `founders` has a phrase pattern readable anywhere and a bare pattern restricted to
    // the title. See `PatternScope` in the tagger.
    expect([...new Set(AUDIENCE_KEYWORDS.map(([n]) => n))].sort()).toEqual(
      [...AUDIENCE_NAMES].sort()
    );
    expect([...new Set(PERK_KEYWORDS.map(([n]) => n))].sort()).toEqual([...PERK_NAMES].sort());
  });

  it('never emits a duplicate, even when two patterns for one name both match', () => {
    // `founders` has two entries. Both match "Startup founders meetup for founders".
    const meta = fromText('Startup founders meetup', 'A gathering for founders and co-founders.');
    expect(meta.audience.filter(a => a === 'founders')).toHaveLength(1);
  });

  it('never emits a value outside the vocabulary, over a spread of real-ish copy', () => {
    const samples = [
      'Kubernetes 101 for beginners — lunch and swag provided',
      'Senior Citizen Yoga & Meditation Camp',
      'Free DevOps Demo Class in Electronic City Bangalore',
      'IndiaFOSS 2026',
      'Sunday Sports & Dinner meet',
      '',
    ];
    for (const s of samples) {
      const meta = fromText(s, s);
      for (const a of meta.audience) expect(AUDIENCE_NAMES as readonly string[]).toContain(a);
      for (const p of meta.perks) expect(PERK_NAMES as readonly string[]).toContain(p);
      if (meta.tier !== undefined) expect(EVENT_TIERS as readonly string[]).toContain(meta.tier);
    }
  });

  it('caps the arrays so one event cannot fill a card with chips', () => {
    const kitchenSink =
      'Students, freshers, beginners, senior engineers, founders, CTOs, product managers, ' +
      'data engineers, security engineers, SREs and researchers welcome. Breakfast, lunch, ' +
      'snacks, swag, stickers, certificates will be provided, recordings will be shared, drinks after.';
    const meta = fromText(kitchenSink, kitchenSink);
    expect(meta.audience.length).toBeLessThanOrEqual(3);
    expect(meta.perks.length).toBeLessThanOrEqual(4);
  });
});

describe('audience — refusals', () => {
  it('does not read "senior citizen" as senior engineers', () => {
    // A real and recurring Bengaluru event shape. This is why there is no bare `senior`.
    expect(audienceOf('Senior Citizen Yoga & Wellness Camp')).not.toContain('senior-engineers');
    expect(audienceOf('Free Health Check-up for Senior Citizens')).not.toContain('senior-engineers');
  });

  it('does not read a building architect as a software one', () => {
    expect(audienceOf('Heritage Architecture Walk in Basavanagudi')).not.toContain(
      'senior-engineers'
    );
    expect(audienceOf('Interior Architects Expo 2026')).not.toContain('senior-engineers');
    // …but the qualified forms must still land.
    expect(audienceOf('Solution Architects Roundtable')).toContain('senior-engineers');
    expect(audienceOf('Senior Backend Engineers: scaling reads')).toContain('senior-engineers');
  });

  it('does not read a ticket price of ₹101 as a beginner event', () => {
    // `₹` is a non-word character, so a bare `\b101\b` matches the digits after it.
    // Odd auspicious amounts like this are common in Indian event pricing.
    expect(audienceOf('Comedy Night', 'Entry ₹101 at the door')).not.toContain('juniors');
    expect(audienceOf('Open Mic', 'Tickets: Rs 101')).not.toContain('juniors');
    // The real title form still works.
    expect(audienceOf('Kubernetes 101')).toContain('juniors');
    expect(audienceOf('Intro to Rust for beginners')).toContain('juniors');
  });

  it('does not read "6 PM" or a bare UI as a product audience', () => {
    // THE canonical mistake in this codebase. Kept as a test, not a comment.
    expect(audienceOf('Kubernetes Meetup at 6 PM')).not.toContain('product');
    expect(audienceOf('Blender UI tips')).not.toContain('product');
    expect(audienceOf('Product Managers: discovery in practice')).toContain('product');
  });

  it('does not read generic uses of "data" as a data audience', () => {
    expect(audienceOf('Data Centre Tour, Whitefield')).not.toContain('data');
    expect(audienceOf('Privacy talk', 'Your data is safe with us. No data is sold.')).not.toContain(
      'data'
    );
    expect(audienceOf('Data Engineers: Iceberg in anger')).toContain('data');
  });

  it('does not read guards, job security or food security as a security audience', () => {
    expect(audienceOf('Hiring: Security Guard for our Koramangala office')).not.toContain(
      'security'
    );
    expect(audienceOf('Job security in the age of AI — a panel')).not.toContain('security');
    expect(audienceOf('Food Security and Urban Farming')).not.toContain('security');
    expect(audienceOf('AppSec Bangalore: threat modelling workshop')).toContain('security');
  });

  it('does not read "user research" or "market research" as a researcher audience', () => {
    // `researchers?` rather than `research` is what separates these at no cost.
    expect(audienceOf('User research for early-stage products')).not.toContain('researchers');
    expect(audienceOf('Market research 101 for founders')).not.toContain('researchers');
    expect(audienceOf('Paper reading group: attention is all you need')).toContain('researchers');
  });

  it('does not read a film or creative director as an engineering leader', () => {
    expect(audienceOf('Meet the Film Director — screening + Q&A')).not.toContain('leaders');
    expect(audienceOf('Creative Directors Mixer')).not.toContain('leaders');
    expect(audienceOf('CTO Roundtable: platform bets for 2027')).toContain('leaders');
    expect(audienceOf('Heads of Engineering dinner')).toContain('leaders');
  });

  // ── The three below are REAL ROWS from the live corpus, and each was a false
  // positive in the first version of these patterns. They are the most valuable tests
  // in this file: nobody would have invented them, and every one was found by printing
  // rows rather than by reading regexes.
  it('does not read a description that names the ORGANISER\'s founder as an event for founders', () => {
    // Measured: `founders` was the commonest audience at 178 of 1149 upcoming rows, and
    // these three came from one mental-health festival whose blurb names its founder.
    // Same class of leak as `Docker` attributed to a SriVidya meditation meetup.
    const blurb = 'Manotsava is a festival curated by our founder, a practising therapist.';
    expect(audienceOf('Roots & Shoots: A morning of Stories by Grandparents', blurb)).not.toContain(
      'founders'
    );
    expect(audienceOf('The Space Between: Women in Midlife', blurb)).not.toContain('founders');
    // A title that names the audience still works — that is what a title is for.
    expect(audienceOf('Brand Marketing 101 for Founders', blurb)).toContain('founders');
    // …and so does an unambiguous phrase, wherever it appears.
    expect(audienceOf('Coffee morning', 'An evening for founders only.')).toContain('founders');
  });

  it('does not read a Toastmasters public-speaking club as engineering leaders', () => {
    // Measured: the single largest block of `leaders` rows was one recurring event,
    // `In Person - PUBLIC SPEAKING/LEADERSHIP WORKSHOP`. CLAUDE.md already names
    // Toastmasters as the bulk of what the `Meetup` category catches wrongly. This is
    // why bare `leadership` and bare `executives` are not in the pattern.
    expect(
      audienceOf('In Person - PUBLIC SPEAKING/LEADERSHIP WORKSHOP - Talkmagic Toastmasters')
    ).not.toContain('leaders');
    expect(audienceOf('Thought leadership in the age of content')).not.toContain('leaders');
    // Qualified forms still land.
    expect(audienceOf('Engineering Leadership Meetup')).toContain('leaders');
    expect(audienceOf('VP Engineering fireside')).toContain('leaders');
  });

  it('does not read an edition number as a beginner event', () => {
    // Measured: 4 upcoming rows depend on the `101` branch alone, and one is
    // `LIT-MIC: Bengaluru Open Mic | Poetry, Stories, Comedy — Edition 101`, where 101
    // counts editions. Ordinal words are refused in front of it.
    expect(audienceOf('LIT-MIC: Bengaluru Open Mic — Edition 101')).not.toContain('juniors');
    expect(audienceOf('Podcast recording, Episode 101')).not.toContain('juniors');
    expect(audienceOf('Standup, Session 101')).not.toContain('juniors');
    expect(audienceOf('Docker 101')).toContain('juniors');
  });

  it('says nothing at all when the copy says nothing about who it is for', () => {
    // An empty array is the honest answer and must stay reachable — a classifier that
    // always emits something has no way to express "the copy did not say".
    expect(audienceOf('Sunday Jamming', 'Bring your guitar.')).toEqual([]);
    expect(audienceOf('')).toEqual([]);
  });
});

describe('perks — refusals', () => {
  it('does not promise a recording the event forbids', () => {
    expect(perksOf('Fireside chat', 'No recording of this session is permitted.')).not.toContain(
      'recording'
    );
    expect(perksOf('Founder AMA', 'Photography and recording are prohibited.')).not.toContain(
      'recording'
    );
    expect(perksOf('Off the record', 'Recording is not allowed.')).not.toContain('recording');
    // The positive forms must still land, or the perk is unreachable.
    expect(perksOf('Platform talk', 'Recordings will be shared with all attendees.')).toContain(
      'recording'
    );
    expect(perksOf('Kafka deep dive', 'The session will be recorded.')).toContain('recording');
  });

  it('does not read an exam as a certificate you are handed', () => {
    // This corpus is full of certification-as-subject titles, and matching them would
    // make `certificate` the commonest perk in the database while describing nothing
    // given away — and would correlate it with exactly the rows `advert` isolates.
    expect(perksOf('AWS Certification Prep Session')).not.toContain('certificate');
    expect(perksOf('Get Google AI Certified — July 2026 Cohort [6 of 8]')).not.toContain(
      'certificate'
    );
    expect(perksOf('Azure Certification Bootcamp')).not.toContain('certificate');
    expect(perksOf('Workshop', 'A certificate of participation will be issued.')).toContain(
      'certificate'
    );
    expect(perksOf('Bootcamp', 'Certificates provided.')).toContain('certificate');
  });

  it('does not read "committees" as t-shirts', () => {
    // `tees\b` was rejected for exactly this: "committees" ends in it.
    expect(perksOf('Standing committees update')).not.toContain('swag');
    expect(perksOf('Hack night', 'Free t-shirts and stickers for the first 50.')).toContain('swag');
  });

  it('does not read a merchant as merch', () => {
    expect(perksOf('Merchant onboarding for D2C brands')).not.toContain('swag');
    expect(perksOf('Meetup', 'Grab some merch on your way out.')).toContain('swag');
  });

  it('does not read a coffee-shaped EVENT as a drinks perk', () => {
    // Bare `coffee`, `tea` and `chai` were in the drinks pattern and were removed after
    // measuring: `drinks` came out the commonest perk in the corpus at 96 of 1149 rows,
    // and the matched-substring column showed four copies of `Flow State Work - Beat
    // procrastination` matching on the word `coffee` in the body copy as a SUBJECT.
    // "Coffee chat" is an event format, not something you are handed.
    expect(perksOf('Coffee chat with the platform team')).not.toContain('drinks');
    expect(perksOf('Flow State Work', 'Beat procrastination — grab a coffee and read.')).not.toContain(
      'drinks'
    );
    expect(perksOf('Chai pe Charcha: policy evening')).not.toContain('drinks');
    // The forms that really are a promise still land.
    expect(perksOf('Go meetup', 'Drinks after the talks.')).toContain('drinks');
    expect(perksOf('Platform evening', 'Free coffee all night.')).toContain('drinks');
    expect(perksOf('Rust meetup', 'Coffee and snacks provided.')).toContain('drinks');
    expect(perksOf('Launch party', 'Beer and mocktails on us.')).toContain('drinks');
  });

  it('keeps high tea in the food bucket, not the drinks one', () => {
    // `high tea` is a meal course here, so `snacks` claims it and `drinks` must not.
    const p = perksOf('Design jam', 'High tea at 4pm.');
    expect(p).toContain('snacks');
    expect(p).not.toContain('drinks');
  });

  it('says nothing when the copy promises nothing', () => {
    expect(perksOf('Kubernetes Meetup', 'Talks from 6pm, doors at 5:30.')).toEqual([]);
  });
});

describe('perks → hasFood, upgrade-only', () => {
  it('uses hasFoodFromPerks as the only definition of which perks are food', () => {
    // Pinning the seam rather than re-deriving it. If FOOD_PERKS ever changes, this
    // test follows it instead of contradicting it.
    for (const p of PERK_NAMES) {
      expect(hasFoodFromPerks([p])).toBe(FOOD_PERKS.has(p) ? 'yes' : null);
    }
  });

  it('upgrades an unknown hasFood when the perks name food', () => {
    const r = keywordTagging({
      title: 'React Bangalore meetup',
      description: 'Talks, then pizza for everyone.',
    });
    expect(r.perks).toContain('snacks');
    expect(r.hasFood).toBe('yes');
  });

  it('leaves hasFood unknown when the perks are silent about food', () => {
    // `null` from hasFoodFromPerks means SILENT, not negative. Swag is not food, and a
    // swag-only event must not come out reading 'no' either.
    const r = keywordTagging({
      title: 'Hack night',
      description: 'Stickers and t-shirts for everyone who ships.',
    });
    expect(r.perks).toContain('swag');
    expect(r.perks).not.toContain('lunch');
    expect(r.hasFood).toBe('unknown');
  });

  /*
   * THE `dinner` GAP IS CLOSED, AND THIS TEST WAS INVERTED RATHER THAN DELETED.
   *
   * It used to assert `perks: []` for an evening meetup with dinner, documenting that
   * `PERK_NAMES` had no `dinner` bucket so the commonest catering shape in this corpus
   * could not be expressed — 34 upcoming rows named a dinner, meal, buffet or thali and
   * got no food perk. Mapping dinner onto `snacks` was rejected then and is still the
   * wrong answer: a perk list is a factual claim about what is served.
   *
   * The bucket now exists, so the assertion flips. Keeping the history here matters
   * because the ADDITION had its own trap: adding a vocabulary value with no keyword
   * pattern made `dinner` an unreachable chip, which the "no chip is unreachable" test
   * above caught immediately — the "facet that can only render empty" problem moved
   * inside the vocabulary.
   */
  it('reads an evening meetup with dinner as both a perk and food', () => {
    const r = keywordTagging({
      title: 'Bangalore Go Meetup',
      description: 'Two talks, then dinner is on us.',
    });
    expect(r.perks).toContain('dinner');
    expect(r.hasFood).toBe('yes');
  });

  /*
   * THE NEGATIVE HALF, AND IT IS THE HALF THAT KEEPS THE CHIP HONEST.
   *
   * `FOOD_RE` deliberately stays BROADER than `FOOD_PERKS`: it matches `meal`, `buffet`
   * and `catering`, none of which says WHICH meal. Filing those under `dinner` would
   * make the chip a false claim about a lunchtime buffet. So `hasFood` may say yes while
   * `perks` stays silent, and that asymmetry is intended — `hasFood` is a yes/no about
   * food, `perks` is an itemised claim.
   */
  it('does not invent a dinner from a word that only means "food"', () => {
    for (const description of [
      'Catering will be provided.',
      'A buffet is included with your ticket.',
      'A meal is served during the break.',
    ]) {
      const r = keywordTagging({ title: 'Bangalore Go Meetup', description });
      expect(r.hasFood).toBe('yes');
      expect(r.perks).not.toContain('dinner');
      expect(r.perks).not.toContain('lunch');
    }
  });
});

describe('tier — advert', () => {
  it('catches the coaching-centre signatures that reached the top of the feed', () => {
    // Both of these are named in scripts/diag-coaching-leak.ts and CLAUDE.md as rows
    // that scored 58 and 70 and sat on the first page of the default tech feed.
    expect(fromTitle('Free DevOps Demo Class in Electronic City Bangalore').tier).toBe('advert');
    expect(fromTitle('Free Gen AI & Agentic AI Demo at eMexo Technologies').tier).toBe('advert');
  });

  it('catches the rest of the funnel vocabulary', () => {
    const adverts = [
      'Java Training with Placement Assistance',
      'New batch starting Monday — Full Stack Development',
      'DevOps Certification Course — enroll now',
      '100% Placement guarantee, Data Science program',
      'Admissions open: MERN stack classes, Marathahalli',
      'Get AWS Certified in 30 days',
      'Crash course: Python for absolute beginners',
      'Live project training at our BTM Layout centre',
      'Selenium coaching institute — free demo session',
    ];
    for (const t of adverts) expect(fromTitle(t).tier).toBe('advert');
  });

  it('does NOT call a community show-and-tell an advert', () => {
    // `demo` is the word that means the best events and the worst. The distinction is
    // the same one connection-score.ts makes with a lookahead, and it must not be lost.
    expect(fromTitle('Demo Night: what we shipped this month').tier).not.toBe('advert');
    expect(fromTitle('Bangalore Demo Day — 12 startups pitch').tier).not.toBe('advert');
    expect(fromTitle('Show and Tell: side projects').tier).not.toBe('advert');
    expect(fromTitle('Demos and pizza').tier).not.toBe('advert');
  });

  it('does NOT call a real webinar or bootcamp an advert', () => {
    // This is where `ADVERT_PATTERN` is deliberately NARROWER than
    // connection-score.ts's FUNNEL_PATTERN. That one penalises `webinar` and
    // `bootcamp` because they rank badly for meeting people — a fair judgement about
    // RANK. Calling them adverts is a claim about the ORGANISER, and a false one.
    expect(fromTitle('CNCF webinar: eBPF in production').tier).not.toBe('advert');
    expect(fromTitle('FOSS United Rust bootcamp, free and community-run').tier).not.toBe('advert');
    expect(fromTitle('A crash course in Rust internals')).toBeTruthy();
  });

  it('does not fire on innocent uses of course or training', () => {
    expect(ADVERT_PATTERN.test('Golf course networking morning')).toBe(false);
    expect(ADVERT_PATTERN.test('Marathon training run, Cubbon Park')).toBe(false);
    expect(ADVERT_PATTERN.test('Of course we have snacks')).toBe(false);
  });
});

describe('tier — flagship', () => {
  it('recognises marquee events by name, at any RSVP count', () => {
    expect(fromTitle('IndiaFOSS 2026').tier).toBe('flagship');
    expect(fromTitle('DevFest Bangalore 2026').tier).toBe('flagship');
    expect(fromTitle('droidCon India | Android Development Conference 2026').tier).toBe('flagship');
    expect(fromTitle('KubeCon + CloudNativeCon India').tier).toBe('flagship');
  });

  it('DOES NOT USE THE WORD "SUMMIT", and a trek proves why', () => {
    // lib/event-types.ts records the measurement: the Conference keyword pattern lists
    // `summit`, and a trek goes to one. 17 of the 20 rows it caught were not tech
    // events at all. So `summit`, `expo`, `convention` and `congress` are absent here
    // and a flagship is recognised by a name, a venue, a count, or two of those.
    expect(FLAGSHIP_TITLE_PATTERN.test('Kudremukh New Year Trek to the summit')).toBe(false);
    expect(FLAGSHIP_TITLE_PATTERN.test('Bangalore HR Summit 2026')).toBe(false);
    expect(FLAGSHIP_TITLE_PATTERN.test('Dubai Real Estate Expo in Bangalore')).toBe(false);

    // And end to end: a trek that earned a Conference category from `summit` must not
    // become a flagship on that tag alone.
    expect(
      deriveCardMetadata({
        title: 'Kudremukh New Year Trek',
        description: 'Overnight trek to the summit. Carry your own water.',
        categories: ['Conference', 'Health/Fitness'],
      }).tier
    ).not.toBe('flagship');
  });

  it('needs TWO signals when there is no marquee name', () => {
    const base = { title: 'Annual Engineering Conference', description: '' };
    // Conference alone: not enough. This is the trek guard generalised.
    expect(deriveCardMetadata({ ...base, categories: ['Conference'] }).tier).not.toBe('flagship');
    // A top-decile RSVP count alone: not enough either.
    expect(deriveCardMetadata({ ...base, attendeeCount: 150 }).tier).not.toBe('flagship');
    // Both together: flagship.
    expect(
      deriveCardMetadata({ ...base, categories: ['Conference'], attendeeCount: 150 }).tier
    ).toBe('flagship');
    // Conference plus a convention-centre venue: flagship.
    expect(
      deriveCardMetadata({
        ...base,
        categories: ['Conference'],
        venue: 'Bangalore International Exhibition Centre',
      }).tier
    ).toBe('flagship');
  });

  it('does NOT call a big RSVP count a flagship on its own — a lake walk had 445', () => {
    // There was a `>= 400 ⇒ flagship` rule. Against the live corpus it selected exactly
    // one row, `UNFOLD Walk: Agara Edition` at 445 attendees, which is a walk round a
    // lake — and 445 is also the CEILING of this corpus, so no safe threshold exists
    // above it. A marquee name is now the only single-signal route.
    expect(
      deriveCardMetadata({ title: 'UNFOLD Walk: Agara Edition', description: '', attendeeCount: 445 })
        .tier
    ).not.toBe('flagship');
    expect(
      deriveCardMetadata({ title: 'Community Fun Run', description: '', attendeeCount: 1101 }).tier
    ).not.toBe('flagship');
  });

  it('does not treat a five-star hotel as a flagship venue, BY NAME', () => {
    // The first version of the venue pattern named JW Marriott, Sheraton Grand, Taj and
    // friends, and a test asserting that a generic "Hotel Sai Palace" is not a flagship
    // venue passed while missing the point entirely. Measured against the corpus, that
    // list promoted two rows: `Bangalore's Big Business, Tech & Entrepreneur
    // Professional Networking Event` (JW Marriott) — a row lib/event-types.ts lists by
    // name among the false positives a blanket Conference rule would admit — and
    // `Apparel Sourcing Week 2026` (Sheraton Grand). A mixer books a ballroom because
    // that is what mixers do.
    for (const venue of [
      'JW Marriott Hotel Bengaluru',
      'Sheraton Grand Bengaluru Whitefield',
      'Taj Yeshwantpur, Bengaluru',
      'The Leela Palace',
      'Hotel Sai Palace, Majestic',
    ]) {
      expect(
        deriveCardMetadata({
          title: "Bangalore's Big Business & Entrepreneur Networking Event",
          description: '',
          categories: ['Conference'],
          venue,
        }).tier,
        venue
      ).not.toBe('flagship');
    }
    // Purpose-built convention space is booked for a different reason and at a different
    // scale, and those rows are the ones that survived.
    for (const venue of [
      'NIMHANS Convention Centre',
      'Bangalore International Exhibition Centre',
      'Karnataka Trade Promotion Organisation',
    ]) {
      expect(
        deriveCardMetadata({
          title: 'Annual Developer Conference',
          description: '',
          categories: ['Conference'],
          venue,
        }).tier,
        venue
      ).toBe('flagship');
    }
  });

  it('ranks advert above flagship, because a coaching centre can look like both', () => {
    // A certification course held in a convention centre with a Conference tag would
    // otherwise be promoted to flagship — exactly the row this label exists to isolate.
    expect(
      deriveCardMetadata({
        title: 'Data Science Certification Course — new batch starting',
        description: 'Admissions open. 100% placement guarantee.',
        categories: ['Conference'],
        venue: 'Bangalore International Exhibition Centre',
        attendeeCount: 600,
      }).tier
    ).toBe('advert');
  });
});

describe('tier — community, and the absent case', () => {
  it('asserts community only on positive evidence of a peer gathering', () => {
    expect(fromTitle('Bangalore Kubernetes Meetup #42').tier).toBe('community');
    expect(fromTitle('FOSS United Bengaluru monthly meetup').tier).toBe('community');
    expect(fromTitle('Hack Night at the Postman office').tier).toBe('community');
    expect(
      deriveCardMetadata({ title: 'Rust Bengaluru', description: '', categories: ['Meetup'] }).tier
    ).toBe('community');
  });

  it('LEAVES TIER ABSENT when nothing says — community is not the default', () => {
    // EVENT_TIERS has no `unknown` member, so absence is the only way to say "nothing
    // here tells me". Defaulting the silent case to `community` would put most of the
    // corpus in one bucket and would assert, of a comedy show scraped from District,
    // that it is a community engineering gathering.
    expect(fromTitle('Stand-up comedy at Courtyard').tier).toBeUndefined();
    expect(fromTitle('Kudremukh Trek').tier).toBeUndefined();
    expect(fromTitle('').tier).toBeUndefined();
  });
});

describe('keywordTagging still returns everything it used to', () => {
  it('classifies and now also carries card metadata', () => {
    const r = keywordTagging({
      title: 'Bangalore Kubernetes Meetup: beginners welcome',
      description: 'Talks on operators and on-call. Pizza and stickers provided.',
      venue: 'Postman office, Indiranagar',
    });
    // The pre-existing contract.
    expect(r.categories.length).toBeGreaterThan(0);
    expect(r.categories).toContain('Cloud/DevOps');
    expect(r.isTechEvent).toBe(true);
    expect(r.format).toBe('offline');
    expect(r.confidence).toBe(0.6);
    // The addition.
    expect(r.audience).toContain('juniors');
    expect(r.perks).toContain('snacks');
    expect(r.perks).toContain('swag');
    expect(r.tier).toBe('community');
  });

  it('never throws and always returns the three new keys, on adversarial input', () => {
    const nasty = [
      { title: '', description: '' },
      { title: '🎉'.repeat(200), description: ' \uD800 lone surrogate' },
      { title: 'a'.repeat(5000), description: 'b'.repeat(20000) },
      { title: '₹101 101 101', description: '101' },
    ];
    for (const input of nasty) {
      const r = keywordTagging(input);
      expect(Array.isArray(r.audience)).toBe(true);
      expect(Array.isArray(r.perks)).toBe(true);
      expect(['yes', 'no', 'unknown']).toContain(r.hasFood);
    }
  });
});
