import { describe, it, expect } from 'vitest';
import {
  classifyEventDelete,
  classifySourceDelete,
  courseAdvertSignals,
  groupDuplicateClusters,
  looksLikeCourseAdvert,
  summariseBulkImpact,
  techDisagreement,
  type EventImpactInput,
} from '@/lib/admin/impact';

/**
 * The impact preview, and the corpus-problem detectors that feed it.
 *
 * WHY THIS SUITE EXISTS AT ALL. The control room's whole premise is that ~60 terminal scripts become
 * buttons. A script is slow to reach, which is a form of safety; a button is not. The thing that
 * replaces that safety is this: before any destructive action, the operator is told what it will
 * affect, and specifically whether a USER has tracked the event or scanned people at it. If these
 * functions under-report, the dialog reassures somebody about a delete that costs a real person
 * their contacts.
 *
 * THE NEGATIVE HALVES ARE THE IMPORTANT HALVES, twice over:
 *   · `courseAdvertSignals` drives a list of deletion candidates. A false positive there proposes
 *     removing a real event — the same class of mistake as `\bpm\b` tagging a fifth of the corpus
 *     `Product/Design`, except with a delete button next to it.
 *   · `classifyEventDelete` must return `blocked` whenever a human acted. A missed referrer is
 *     invisible: the dialog says "nothing references this event" and it is wrong.
 */

/* ────────────────────────────── Course adverts ────────────────────────────── */

describe('courseAdvertSignals — the coaching-centre leak', () => {
  /** The rows measured in the live tech feed by scripts/diag-coaching-leak.ts. */
  const MUST_MATCH: Array<[string, string]> = [
    ['the measured leak', 'Free DevOps Demo Class in Electronic City Bangalore'],
    ['placement bait', 'Java Training with Placement Assistance'],
    ['the guarantee', 'Full Stack Course — 100% Placement, job guarantee'],
    ['institute self-description', 'Best Python Training Institute in Marathahalli'],
    ['a batch, not an event', 'New DevOps batch starting this Monday — enroll now'],
    ['certification selling', 'AWS Certification Course for beginners'],
    ['crash course', 'Weekend crash course in Data Science'],
    ['trial session', 'Free trial class on Kubernetes'],
  ];

  for (const [why, title] of MUST_MATCH) {
    it(`matches ${why}: ${title}`, () => {
      expect(looksLikeCourseAdvert(title)).toBe(true);
      expect(courseAdvertSignals(title).length).toBeGreaterThan(0);
    });
  }

  /**
   * Real Bengaluru event copy that must survive. Each one uses a word from the pattern list in its
   * innocent sense, which is exactly what a bare-word matcher would destroy.
   */
  const MUST_NOT_MATCH: Array<[string, string]> = [
    ['a talk that teaches', 'A crash-course-free deep dive into Rust internals'],
    ['community show and tell', 'Demo Night — five teams, five demos'],
    ['a startup demo day', 'Demo Day: 12 founders pitch'],
    ['training as a topic, not a product', 'Distributed training of large models on GPUs'],
    ['a course as subject matter', 'How we built an internal course platform at Razorpay'],
    ['certification as a discussion', 'Panel: does certification still matter for SREs?'],
    ['a batch as a technical term', 'Batch processing with Apache Spark'],
    ['placement as a scheduling term', 'Pod placement and topology spread constraints'],
    ['a plain meetup', 'Bangalore Kubernetes Meetup #42'],
    ['a hackathon', 'IndiaFOSS 2026 — Hackathon and talks'],
    ['empty copy', ''],
  ];

  for (const [why, title] of MUST_NOT_MATCH) {
    it(`spares ${why}: ${title || '(empty)'}`, () => {
      expect(looksLikeCourseAdvert(title)).toBe(false);
    });
  }

  /**
   * KNOWN GAPS, pinned deliberately.
   *
   * The pattern list is `scripts/diag-coaching-leak.ts`'s, copied rather than re-derived so the
   * panel and the script cannot report different numbers. Checking it against that script's OWN
   * header found the header naming two rows its patterns do not actually match — so the detector
   * under-reports, and has always under-reported, on the live corpus.
   *
   * These assert the CURRENT behaviour, not the desired behaviour. They exist so that the gap is
   * discoverable instead of being rediscovered, and so that widening the list is a deliberate act:
   * if you make one of these match, this block fails and tells you to re-measure over real scraped
   * copy first (the `diag-hardware-corpus-delta.ts` treatment — run the old and new patterns over
   * the corpus and read every newly-matched row). A regex that drives a list of deletion candidates
   * fails by over-matching, and no aggregate count reveals that.
   */
  const KNOWN_GAPS: Array<[string, string, string]> = [
    [
      'a training demo whose words are not adjacent',
      'Free AI Training Demo in Electronic City',
      'the `(free|paid)\\s+(demo|trial)\\s+(class|session|lecture)` pattern needs the three words together',
    ],
    [
      'a certification funnel with two words before "certified"',
      'Get Google AI Certified in 30 days',
      '`(get|become)\\s+\\w+\\s+certified` allows exactly one word between; connectionScore catches this one instead',
    ],
  ];

  for (const [why, title, mechanism] of KNOWN_GAPS) {
    it(`does NOT yet match ${why} — ${mechanism}`, () => {
      expect(looksLikeCourseAdvert(title)).toBe(false);
    });
  }

  it('names which signatures fired, so a candidate can be argued with', () => {
    const signals = courseAdvertSignals('Free DevOps Demo Class — enroll now, 100% placement');
    expect(signals.length).toBeGreaterThan(1);
    // The panel prints these, so they have to be readable strings rather than indices.
    expect(signals.every(s => s.startsWith('/'))).toBe(true);
  });
});

/* ────────────────────────────── Tech disagreement ────────────────────────────── */

describe('techDisagreement — the app\'s two definitions of tech', () => {
  it('reports HIDDEN when categories are tech but the flag is off', () => {
    // This is the IndiaFOSS case: correct event, correct categories, unreachable in the feed.
    expect(techDisagreement({ isTechEvent: false, category: ['AI/ML', 'Data/Analytics'] })).toBe('hidden');
  });

  it('reports UNBACKED when the flag is on but nothing tech supports it', () => {
    expect(techDisagreement({ isTechEvent: true, category: ['Arts/Culture'] })).toBe('unbacked');
  });

  it('reports none when the two agree, in both directions', () => {
    expect(techDisagreement({ isTechEvent: true, category: ['Cloud/DevOps'] })).toBe('none');
    expect(techDisagreement({ isTechEvent: false, category: ['Music/Concert'] })).toBe('none');
  });

  it('counts Hackathon as tech-backing, because TECH_FLAG_CATEGORIES does', () => {
    // Hackathon is a GATHERING kind, not a topic — it is in TECH_FLAG_CATEGORIES and not in
    // TECH_CATEGORY_NAMES. Deriving from the wrong set is what hid a hand-entered "Internal Hack
    // Day" from the default feed.
    expect(techDisagreement({ isTechEvent: true, category: ['Hackathon'] })).toBe('none');
    expect(techDisagreement({ isTechEvent: false, category: ['Hackathon'] })).toBe('hidden');
  });

  it('treats a flagged event with no categories as unbacked, not as agreement', () => {
    expect(techDisagreement({ isTechEvent: true, category: [] })).toBe('unbacked');
    expect(techDisagreement({ isTechEvent: true })).toBe('unbacked');
  });

  it('treats an unflagged, uncategorised event as no disagreement to report', () => {
    expect(techDisagreement({ isTechEvent: false, category: [] })).toBe('none');
    expect(techDisagreement({})).toBe('none');
  });

  it('does not read a null flag as true', () => {
    expect(techDisagreement({ isTechEvent: null, category: ['AI/ML'] })).toBe('hidden');
  });
});

/* ────────────────────────────── Duplicate clusters ────────────────────────────── */

describe('groupDuplicateClusters', () => {
  it('groups rows sharing a clusterKey and ignores singletons', () => {
    const groups = groupDuplicateClusters([
      { id: 'a', clusterKey: 'react meetup|2026-09-10' },
      { id: 'b', clusterKey: 'react meetup|2026-09-10' },
      { id: 'c', clusterKey: 'kafka|2026-09-11' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].rows.map(r => r.id)).toEqual(['a', 'b']);
  });

  it('does NOT treat missing keys as a group of their own', () => {
    // A document with no clusterKey is a different fault with a different fix (migrate-events.ts),
    // and lumping them together would report one problem as another.
    const groups = groupDuplicateClusters([
      { id: 'a', clusterKey: undefined },
      { id: 'b', clusterKey: null },
      { id: 'c', clusterKey: '' },
    ]);
    expect(groups).toEqual([]);
  });

  it('orders the worst clusters first', () => {
    const groups = groupDuplicateClusters([
      { id: '1', clusterKey: 'pair' },
      { id: '2', clusterKey: 'pair' },
      { id: '3', clusterKey: 'triple' },
      { id: '4', clusterKey: 'triple' },
      { id: '5', clusterKey: 'triple' },
    ]);
    expect(groups[0].clusterKey).toBe('triple');
    expect(groups[0].rows).toHaveLength(3);
  });

  it('returns nothing for an empty corpus', () => {
    expect(groupDuplicateClusters([])).toEqual([]);
  });
});

/* ────────────────────────────── Event delete impact ────────────────────────────── */

const SCRAPED: EventImpactInput = {
  event: { title: 'Kafka Meetup', source: 'meetup' },
  trackerEntries: [],
  folders: [],
  contacts: 0,
};

describe('classifyEventDelete — does a human care about this row', () => {
  it('is safe-with-a-note for an untouched scraped event', () => {
    const r = classifyEventDelete(SCRAPED);
    expect(r.severity).toBe('caution');
    expect(r.warnings.map(w => w.code)).toContain('returns-on-next-scrape');
    expect(r.warnings.every(w => !w.blocking)).toBe(true);
  });

  it('BLOCKS when a user has tracked it, and counts the users not the rows', () => {
    const r = classifyEventDelete({
      ...SCRAPED,
      trackerEntries: [{ userId: 'u1' }, { userId: 'u1' }, { userId: 'u2' }],
    });
    expect(r.severity).toBe('blocked');
    const w = r.warnings.find(x => x.code === 'tracked-by-users');
    expect(w?.blocking).toBe(true);
    expect(w?.message).toContain('2 users');
    expect(r.counts.trackerEntries).toBe(3);
  });

  it('BLOCKS when a folder exists, because a folder means they went', () => {
    const r = classifyEventDelete({ ...SCRAPED, folders: [{ name: 'api days', userId: 'u1' }] });
    expect(r.severity).toBe('blocked');
    expect(r.warnings.map(w => w.code)).toContain('has-folders');
    expect(r.counts.folders).toBe(1);
  });

  it('escalates the wording when those folders hold scanned people', () => {
    const r = classifyEventDelete({
      ...SCRAPED,
      folders: [{ name: 'api days', userId: 'u1' }],
      contacts: 12,
    });
    expect(r.severity).toBe('blocked');
    const codes = r.warnings.map(w => w.code);
    // The stronger warning replaces the weaker one rather than sitting beside it.
    expect(codes).toContain('folder-has-contacts');
    expect(codes).not.toContain('has-folders');
    expect(r.warnings[0].message).toContain('12 people');
  });

  it('BLOCKS a hand-entered event and says why no scrape can restore it', () => {
    const r = classifyEventDelete({
      ...SCRAPED,
      event: { title: 'Internal Hack Day', createdByUserId: 'u9' },
    });
    expect(r.severity).toBe('blocked');
    expect(r.warnings.map(w => w.code)).toContain('hand-entered');
    // And it must NOT also claim a scrape will bring it back.
    expect(r.warnings.map(w => w.code)).not.toContain('returns-on-next-scrape');
  });

  it('BLOCKS a pending submission and points at the reversible route', () => {
    const r = classifyEventDelete({
      ...SCRAPED,
      event: { title: 'Submitted thing', createdByUserId: 'u9', visibility: 'pending' },
    });
    expect(r.severity).toBe('blocked');
    const w = r.warnings.find(x => x.code === 'pending-review');
    expect(w?.message).toContain('Submissions');
  });

  it('flags a spotlit event without blocking — it is on the front page right now', () => {
    const r = classifyEventDelete({
      ...SCRAPED,
      event: { title: 'Pinned', spotlightAt: '2026-09-09T10:00:00.000Z' },
    });
    expect(r.warnings.map(w => w.code)).toContain('spotlit');
    expect(r.warnings.find(w => w.code === 'spotlit')?.blocking).toBe(false);
    expect(r.severity).toBe('caution');
  });

  it('always reports the action as reversible, because the audit snapshot IS the backup', () => {
    // Reusing the original _id is what makes the tracker entries and folders above live again on a
    // restore — which is why a blocking warning is an "are you sure", not a refusal.
    expect(classifyEventDelete(SCRAPED).reversible).toBe(true);
    expect(classifyEventDelete({ ...SCRAPED, contacts: 4, folders: [{ name: 'f' }] }).reversible).toBe(true);
  });
});

/* ────────────────────────────── Source delete impact ────────────────────────────── */

describe('classifySourceDelete', () => {
  it('always steers towards disabling instead', () => {
    const r = classifySourceDelete({ source: { name: 'dead-group', lastEventCount: 0 } });
    expect(r.warnings.map(w => w.code)).toContain('discovery-state-lost');
    expect(r.headline).toContain('Disabling');
    expect(r.severity).toBe('caution');
  });

  it('BLOCKS deleting a source that is currently producing events', () => {
    const r = classifySourceDelete({ source: { name: 'lfdt-bengaluru', lastEventCount: 7 } });
    expect(r.severity).toBe('blocked');
    expect(r.warnings.find(w => w.code === 'source-producing')?.message).toContain('7 events');
  });

  it('treats a never-scraped source as not producing rather than throwing', () => {
    expect(classifySourceDelete({ source: { name: 'new' } }).severity).toBe('caution');
  });
});

/* ────────────────────────────── Bulk ────────────────────────────── */

describe('summariseBulkImpact — the worst row, never the average', () => {
  it('takes the worst severity in the batch', () => {
    const safe = classifyEventDelete(SCRAPED);
    const blocked = classifyEventDelete({ ...SCRAPED, folders: [{ name: 'f' }], contacts: 3 });
    // 39 harmless rows must not launder the one that costs somebody their contacts.
    const rolled = summariseBulkImpact([...Array(39).fill(safe), blocked]);
    expect(rolled.severity).toBe('blocked');
    expect(rolled.headline).toContain('1 of 40');
  });

  it('sums the counts', () => {
    const a = classifyEventDelete({ ...SCRAPED, trackerEntries: [{ userId: 'u1' }], contacts: 2, folders: [{ name: 'x' }] });
    const b = classifyEventDelete({ ...SCRAPED, trackerEntries: [{ userId: 'u2' }], contacts: 3, folders: [{ name: 'y' }] });
    const rolled = summariseBulkImpact([a, b]);
    expect(rolled.counts).toEqual({ trackerEntries: 2, folders: 2, contacts: 5 });
  });

  it('deduplicates warnings by code so 40 identical notes are one line', () => {
    const safe = classifyEventDelete(SCRAPED);
    const rolled = summariseBulkImpact([safe, safe, safe]);
    expect(rolled.warnings.filter(w => w.code === 'returns-on-next-scrape')).toHaveLength(1);
  });

  it('handles an empty selection without pretending it is dangerous', () => {
    const rolled = summariseBulkImpact([]);
    expect(rolled.severity).toBe('safe');
    expect(rolled.headline).toBe('Nothing selected');
  });
});
