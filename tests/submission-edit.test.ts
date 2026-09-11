/**
 * `validateSubmissionEdit()` — what a reviewer may correct on a PENDING submission.
 *
 * The submissions queue could only approve or reject, so a nearly-right submission had no path
 * forward: approve published the flaw to every visitor, reject threw the event away. The first
 * group below is why the allowlist has to be narrower than the admin event editor's — this runs on
 * a row nobody has approved yet, so "publish it" and "pin it to the home page" must not be
 * reachable from the same form as "fix the title".
 *
 * Every rejection is asserted rather than assumed, because an allowlist is only worth having if it
 * actually drops things, and because the two halves of the `isTechEvent` derivation (`Hackathon` in,
 * `Conference` out) are exactly what a later "simplification" would collapse.
 */
import { describe, it, expect } from 'vitest';
import {
  validateSubmissionEdit,
  SUBMISSION_EDIT_FIELDS,
  eventValidationError,
} from '../lib/events/submission-edit';
import { TECH_CATEGORY_NAMES } from '../lib/event-types';

/** Field names present in the resulting patch. */
function keys(body: unknown): string[] {
  return Object.keys(validateSubmissionEdit(body).update).sort();
}
function issuesFor(body: unknown): string[] {
  return validateSubmissionEdit(body).issues.map(i => i.field).sort();
}

describe('the allowlist: fields a reviewer must NOT be able to write', () => {
  it('drops identity fields, so correcting a title cannot detach the row from its cluster', () => {
    // Both are derived in `pre('validate')` and frozen at ingest. A writable `clusterKey` on a
    // pending row is the silent-loss path: an un-namespaced key lets the next scrape merge the real
    // public event into this one and report success.
    expect(keys({ dedupHash: 'x', clusterKey: 'y' })).toEqual([]);
  });

  it('drops `visibility` and `createdByUserId`, so an edit cannot publish or re-own the row', () => {
    // The whole point of the queue is that publishing is a separate, audited decision.
    expect(keys({ visibility: 'public', createdByUserId: 'someone-else' })).toEqual([]);
  });

  it('drops `spotlightAt`, which would pin an unreviewed row to the home page', () => {
    // Editable through /admin's event editor by design; not from here, and not on a row nobody has
    // approved. It is also the one field CLAUDE.md calls editorial — nothing recomputes it.
    expect(keys({ spotlightAt: new Date().toISOString() })).toEqual([]);
  });

  it('drops DERIVED fields a backfill would silently revert', () => {
    expect(keys({ connectionScore: 100, companies: ['Google'], tagConfidence: 1 })).toEqual([]);
  });

  it('drops provenance, which decides when pruneStale() deletes the row', () => {
    expect(keys({ source: 'manual', sourceEventId: 'microsite:abc', lastSeenAt: new Date().toISOString() })).toEqual([]);
  });

  it('drops `isTechEvent` when it is TYPED, because it is derived below instead', () => {
    // Accepting it would let the flag and the categories disagree — the app's two definitions of
    // "tech" drifting apart, which CLAUDE.md §3 measured at 75 of 1048 events.
    expect(keys({ isTechEvent: true })).toEqual([]);
  });

  it('drops fields that are out of the queue’s scope but editable in /admin', () => {
    // Not dangerous — just not this panel's job. They must not arrive by accident either.
    expect(keys({ endDateTime: new Date().toISOString(), price: 500, imageUrl: 'https://x.test/a.png', sourceUrl: 'https://x.test', format: 'online', city: 'Bengaluru', address: 'MG Road', tags: ['ai'] })).toEqual([]);
  });

  it('drops mongo internals', () => {
    expect(keys({ _id: 'abc', __v: 3, createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null })).toEqual([]);
  });

  it('accepts exactly the eight documented fields and nothing else', () => {
    expect([...SUBMISSION_EDIT_FIELDS].sort()).toEqual([
      'applyLink',
      'area',
      'category',
      'description',
      'organizer',
      'startDateTime',
      'title',
      'venue',
    ]);
    const patch = validateSubmissionEdit({
      title: 'Open Source India 2026',
      description: 'Two days of talks.',
      organizer: 'Open Source India',
      venue: 'NIMHANS Convention Centre',
      area: 'Hosur Road',
      startDateTime: '2026-10-15T04:00:00.000Z',
      category: ['Open Source', 'Conference'],
      applyLink: 'https://osidays.com/register',
    });
    expect(patch.issues).toEqual([]);
    // `isTechEvent` is the ninth key, derived rather than accepted — asserted on its own below.
    expect(Object.keys(patch.update).sort()).toEqual([
      'applyLink',
      'area',
      'category',
      'description',
      'isTechEvent',
      'organizer',
      'startDateTime',
      'title',
      'venue',
    ]);
  });
});

describe('links: only http(s), because applyLink is rendered into an href', () => {
  // Stored XSS against every visitor AND against the admin reviewing the submission, which is the
  // one case where the reviewer is the target of the thing they are reviewing.
  for (const bad of [
    'javascript:alert(document.cookie)',
    'JavaScript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
  ]) {
    it(`rejects ${bad.slice(0, 28)}`, () => {
      const { update, issues } = validateSubmissionEdit({ applyLink: bad });
      expect(update.applyLink).toBeUndefined();
      expect(issues.map(i => i.field)).toContain('applyLink');
    });
  }

  it('accepts http and https', () => {
    expect(validateSubmissionEdit({ applyLink: 'https://konfhub.com/x' }).update.applyLink).toBe(
      'https://konfhub.com/x'
    );
    expect(validateSubmissionEdit({ applyLink: 'http://example.test/a' }).update.applyLink).toBe(
      'http://example.test/a'
    );
  });

  it('rejects text that is not a URL at all, naming the field', () => {
    expect(issuesFor({ applyLink: 'ask on whatsapp' })).toEqual(['applyLink']);
  });

  it('clears the link when it is sent empty, rather than storing an empty string', () => {
    const { update, issues } = validateSubmissionEdit({ applyLink: '' });
    expect(issues).toEqual([]);
    expect('applyLink' in update).toBe(true);
    expect(update.applyLink).toBeUndefined();
  });
});

describe('required text cannot be emptied', () => {
  // `title` and `description` are `required` in the schema, so clearing them would surface as a
  // Mongoose ValidationError turned 500 rather than as the reviewer's own mistake.
  it('refuses an empty or blank title', () => {
    expect(issuesFor({ title: '' })).toEqual(['title']);
    expect(issuesFor({ title: '   ' })).toEqual(['title']);
    expect(issuesFor({ title: null })).toEqual(['title']);
  });

  it('refuses an empty description', () => {
    expect(issuesFor({ description: '' })).toEqual(['description']);
  });

  it('trims, and allows the optional text fields to be cleared', () => {
    expect(validateSubmissionEdit({ title: '  Kafka Meetup  ' }).update.title).toBe('Kafka Meetup');
    for (const field of ['venue', 'area', 'organizer']) {
      const { update, issues } = validateSubmissionEdit({ [field]: '' });
      expect(issues).toEqual([]);
      expect(field in update).toBe(true);
      expect(update[field]).toBeUndefined();
    }
  });

  it('refuses a title longer than the schema allows instead of silently truncating it', () => {
    expect(issuesFor({ title: 'x'.repeat(301) })).toEqual(['title']);
  });
});

describe('dates', () => {
  it('coerces an ISO string to a Date', () => {
    const { update } = validateSubmissionEdit({ startDateTime: '2026-10-15T04:00:00.000Z' });
    expect(update.startDateTime).toBeInstanceOf(Date);
    expect((update.startDateTime as Date).toISOString()).toBe('2026-10-15T04:00:00.000Z');
  });

  it('refuses an unparseable date and refuses to clear the start', () => {
    expect(issuesFor({ startDateTime: 'next tuesday' })).toEqual(['startDateTime']);
    expect(issuesFor({ startDateTime: '' })).toEqual(['startDateTime']);
  });

  /*
   * The cross-field check `validateEventUpdate` cannot make on its own.
   *
   * It compares start against end only when both are in the same patch — right for a form that
   * submits both, and blind here, because `endDateTime` is not editable from the queue at all. So a
   * start moved past an end already on the row would sail through, and `lib/events/query.ts` treats
   * an event as ongoing once it has started and not yet ended: a backwards range makes a row that
   * can never be "now".
   */
  it('refuses a start moved past the end already stored on the submission', () => {
    const result = validateSubmissionEdit(
      { startDateTime: '2026-10-20T04:00:00.000Z' },
      { endDateTime: new Date('2026-10-15T12:00:00.000Z') }
    );
    expect(result.issues.map(i => i.field)).toEqual(['startDateTime']);
  });

  it('accepts a start before the stored end, and ignores an unusable stored end', () => {
    expect(
      validateSubmissionEdit(
        { startDateTime: '2026-10-14T04:00:00.000Z' },
        { endDateTime: new Date('2026-10-15T12:00:00.000Z') }
      ).issues
    ).toEqual([]);
    // A row with no end, or a corrupt one, must not block an otherwise valid correction.
    expect(validateSubmissionEdit({ startDateTime: '2026-10-14T04:00:00.000Z' }, {}).issues).toEqual([]);
    expect(
      validateSubmissionEdit({ startDateTime: '2026-10-14T04:00:00.000Z' }, { endDateTime: 'nonsense' })
        .issues
    ).toEqual([]);
  });
});

describe('categories, and the isTechEvent derivation', () => {
  it('names the unknown category rather than saying "category is invalid"', () => {
    const { update, issues } = validateSubmissionEdit({ category: ['AI/ML', 'Networking/Meetup'] });
    expect(update.category).toBeUndefined();
    expect(issues).toHaveLength(1);
    // 'Networking/Meetup' was retired in the 32 → 22 consolidation; a reviewer needs to know WHICH
    // chip is wrong, not that one of six is.
    expect(issues[0].message).toContain('Networking/Meetup');
  });

  it('de-duplicates the list', () => {
    expect(validateSubmissionEdit({ category: ['AI/ML', 'AI/ML'] }).update.category).toEqual(['AI/ML']);
  });

  /*
   * `TECH_FLAG_CATEGORIES`, NOT `TECH_CATEGORY_NAMES`. The difference is one value and it shipped
   * as a bug: `Hackathon` names a KIND of gathering so it lives in `GATHERING_CATEGORY_NAMES`, and
   * deriving from the narrower set stored a hand-entered "Internal Hack Day" as `isTechEvent: false`
   * — invisible in the default tech-only feed. The reviewer approves an event and it vanishes.
   */
  it('flags a Hackathon as tech even though it is not a tech TOPIC', () => {
    expect(validateSubmissionEdit({ category: ['Hackathon'] }).update.isTechEvent).toBe(true);
  });

  it('does NOT flag Conference or Workshop, which are mostly not tech in this corpus', () => {
    // Measured: 20 upcoming `Conference` rows with no tech topic, 17 of them treks, expos and HR
    // summits. `Workshop` re-opens the course-selling hole. See lib/event-types.ts.
    expect(validateSubmissionEdit({ category: ['Conference'] }).update.isTechEvent).toBe(false);
    expect(validateSubmissionEdit({ category: ['Workshop'] }).update.isTechEvent).toBe(false);
    expect(validateSubmissionEdit({ category: ['Meetup'] }).update.isTechEvent).toBe(false);
  });

  it('flags every tech topic', () => {
    for (const name of TECH_CATEGORY_NAMES) {
      expect(validateSubmissionEdit({ category: [name] }).update.isTechEvent).toBe(true);
    }
  });

  it('flags a mixed list on the strength of its one tech member', () => {
    expect(
      validateSubmissionEdit({ category: ['Community/Social', 'Open Source'] }).update.isTechEvent
    ).toBe(true);
  });

  it('unflags when the last tech category is removed', () => {
    expect(validateSubmissionEdit({ category: ['Arts/Culture'] }).update.isTechEvent).toBe(false);
  });

  it('leaves the flag ALONE when categories were not part of the edit', () => {
    // Otherwise correcting a venue would silently re-decide whether the event is in the tech feed.
    expect('isTechEvent' in validateSubmissionEdit({ venue: 'Bagmane' }).update).toBe(false);
  });

  it('leaves the flag alone when the category list was REJECTED', () => {
    // Deciding the feed from a value that failed validation would be deciding it from a typo.
    expect('isTechEvent' in validateSubmissionEdit({ category: ['Nope'] }).update).toBe(false);
  });

  it('an empty category list unflags rather than throwing', () => {
    const { update, issues } = validateSubmissionEdit({ category: [] });
    expect(issues).toEqual([]);
    expect(update.category).toEqual([]);
    expect(update.isTechEvent).toBe(false);
  });

  it('refuses a category that is not a list', () => {
    expect(issuesFor({ category: 'AI/ML' })).toEqual(['category']);
  });
});

describe('the request envelope', () => {
  it('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'title=x', 42, ['title']]) {
      expect(validateSubmissionEdit(body).issues.map(i => i.field)).toEqual(['body']);
    }
  });

  it('produces an empty patch for an empty object, so the route can answer 400', () => {
    expect(validateSubmissionEdit({}).update).toEqual({});
    expect(validateSubmissionEdit({}).issues).toEqual([]);
  });

  it('reports one field by name and several by count, leaking no Mongoose wording', () => {
    const one = eventValidationError([{ field: 'title', message: 'cannot be empty' }]);
    expect(one.error).toBe('title cannot be empty');
    const many = eventValidationError([
      { field: 'title', message: 'cannot be empty' },
      { field: 'applyLink', message: 'must be http or https' },
    ]);
    expect(many.error).toBe('2 fields are invalid');
    expect(many.fields).toHaveLength(2);
    expect(JSON.stringify(many)).not.toMatch(/validation failed|Path `|enum value/);
  });
});
