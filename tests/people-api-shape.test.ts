import { describe, it, expect } from 'vitest';
import {
  INTERACTION_ICON,
  INTERACTION_LABEL,
  MAX_BULK_PEOPLE,
  MAX_BULK_TAGS,
  MAX_NOTE_LENGTH,
  MAX_OVERRIDE_LENGTH,
  MAX_OWN_TAGS,
  isObjectIdLike,
  linkedinUrlFromKeys,
  personSubtitle,
  personToDTO,
  personToMergeCandidate,
  validateMergeRequest,
  validatePersonPatch,
  validateTagBulk,
} from '@/lib/person-types';

/**
 * The REQUEST/RESPONSE SHAPE for `/api/people/*`, pinned without a database or a server.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS A UNIT SUITE AND NOT A DIAG SCRIPT. `vitest.config.mts` scopes this directory to pure
 * functions, and everything here is one: the validators take a parsed body and return a verdict, the
 * mappers take a plain object and return JSON. Nothing touches Mongo, `auth()` or the network. The
 * live behaviour — the guards, the 401s, the merge actually moving rows — belongs to the
 * `scripts/diag-*.ts` family, and duplicating it here would only produce slow, flaky copies.
 *
 * WHAT MAKES THESE WORTH THE COST rather than being tests of the obvious:
 *
 *   · A ROUTE THAT HANDS THE RAW BODY TO MONGOOSE REPORTS THE CALLER'S MISTAKE AS A 500, and pays
 *     twice — a 5xx tells a client to retry something that can never work, and the message names the
 *     model and the schema path as free reconnaissance. Both tracker write paths shipped exactly that.
 *     The validators exist so a bad request is refused BEFORE `connectDB()`, and these tests are what
 *     stop somebody "simplifying" one of them back into a spread.
 *   · A BLANK OVERRIDE MEANS "NO OVERRIDE", NOT "FORCE EMPTY". Pinning `''` produces a field no later
 *     capture can ever fill, which reads as broken rather than cleared — and it is the wrong-but-
 *     plausible reading of `derivePersonFields`, so it is pinned here as well as there.
 *   · AN EMPTY PATCH MUST BE A 400. A PATCH the server silently ignores looks identical to one it
 *     applied, which is how a typo'd field name becomes "the app is not saving my edits".
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 */

const OID = '68b5f0c1a2b3c4d5e6f70819';
const OTHER = '68b5f0c1a2b3c4d5e6f7081a';

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   isObjectIdLike
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('isObjectIdLike', () => {
  it('accepts a real 24-hex id, in either case', () => {
    expect(isObjectIdLike(OID)).toBe(true);
    expect(isObjectIdLike(OID.toUpperCase())).toBe(true);
  });

  /**
   * STRICTER THAN `mongoose.Types.ObjectId.isValid` ON PURPOSE, and this is the case that matters.
   * That helper accepts ANY 12-character string and coerces its bytes into an id — so a lookup runs
   * against something the caller never named, and the 404 that comes back is meaningless. Every id
   * this app hands out is 24 hex characters, so nothing legitimate is refused by being strict.
   */
  it('refuses a 12-character string, which mongoose would have accepted', () => {
    expect(isObjectIdLike('notanid12345')).toBe(false);
  });

  it('refuses the near misses', () => {
    expect(isObjectIdLike('')).toBe(false);
    expect(isObjectIdLike(OID.slice(0, 23))).toBe(false); // 23 chars
    expect(isObjectIdLike(`${OID}0`)).toBe(false); // 25 chars
    expect(isObjectIdLike(`${OID.slice(0, 23)}z`)).toBe(false); // non-hex
    expect(isObjectIdLike(` ${OID}`)).toBe(false); // padded — a URL segment is not trimmed for us
    expect(isObjectIdLike(null)).toBe(false);
    expect(isObjectIdLike(undefined)).toBe(false);
    expect(isObjectIdLike(123)).toBe(false);
    expect(isObjectIdLike({ toString: () => OID })).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   validatePersonPatch
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('validatePersonPatch — refusals', () => {
  it('refuses a non-object body, which is also what a malformed JSON body arrives as', () => {
    for (const body of [null, undefined, 'string', 42, [], true]) {
      const result = validatePersonPatch(body);
      expect(result.ok).toBe(false);
    }
  });

  /**
   * An empty patch is NOT a no-op success. The route would answer 200 having changed nothing, which
   * the client cannot tell apart from a successful save.
   */
  it('refuses an empty patch', () => {
    const result = validatePersonPatch({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/nothing to change/i);
  });

  it('refuses a body whose only keys are unknown', () => {
    // The trap this guards: `{ nickname: 'Ash' }` looks like it should work and would otherwise be
    // dropped silently, so the user retypes it and concludes the page is broken.
    expect(validatePersonPatch({ nickname: 'Ash', userId: 'someone-else' }).ok).toBe(false);
  });

  it('never lets a body assign ownership or derived counters', () => {
    // `userId`, `eventCount` and `mergedInto` are not members of `PersonPatch`, so an allowlist —
    // not a spread — is what keeps them unassignable. `POST /api/events` had to learn this the hard
    // way: `{ ...body }` let a caller set `visibility`, `createdByUserId` and `spotlightAt`.
    const result = validatePersonPatch({
      note: 'legitimate',
      userId: 'attacker',
      eventCount: 99,
      mergedInto: OTHER,
      contactKeys: ['li:someone-else'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value)).toEqual(['note']);
  });
});

describe('validatePersonPatch — overrides', () => {
  it('trims and keeps a real correction', () => {
    const result = validatePersonPatch({ overrides: { displayName: '  Asha Rao  ' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.overrides).toEqual({ displayName: 'Asha Rao' });
  });

  /**
   * THE CLEARING CASE, both spellings. A form that has never held a value sends `null`; one the user
   * emptied sends `''`. Both mean "go back to what the captures say".
   */
  it('treats a blank or null override as a CLEAR, not as a pinned empty value', () => {
    const blank = validatePersonPatch({ overrides: { company: '   ' } });
    expect(blank.ok).toBe(true);
    if (blank.ok) expect(blank.value.overrides).toEqual({ company: '' });

    const nulled = validatePersonPatch({ overrides: { role: null } });
    expect(nulled.ok).toBe(true);
    if (nulled.ok) expect(nulled.value.overrides).toEqual({ role: '' });
  });

  it('leaves an omitted override alone rather than clearing it', () => {
    // Sending only a company must not wipe a name correction made earlier. The route merges field by
    // field, so an absent key has to stay absent all the way through.
    const result = validatePersonPatch({ overrides: { company: 'Razorpay' } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.overrides).toEqual({ company: 'Razorpay' });
      expect('displayName' in (result.value.overrides ?? {})).toBe(false);
    }
  });

  it('refuses a non-string override and names the field', () => {
    const result = validatePersonPatch({ overrides: { displayName: 42 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('overrides.displayName');
  });

  it('refuses an override past the schema length, so the API never 500s on a cast', () => {
    const result = validatePersonPatch({
      overrides: { company: 'x'.repeat(MAX_OVERRIDE_LENGTH + 1) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('overrides.company');
  });

  it('refuses overrides that is not an object', () => {
    expect(validatePersonPatch({ overrides: 'Asha' }).ok).toBe(false);
    expect(validatePersonPatch({ overrides: ['Asha'] }).ok).toBe(false);
  });

  it('drops an overrides object with no recognised keys, and then refuses the empty patch', () => {
    expect(validatePersonPatch({ overrides: { headline: 'nope' } }).ok).toBe(false);
  });
});

describe('validatePersonPatch — ownTags', () => {
  it('keeps an EMPTY array, because clearing every tag is a real instruction', () => {
    const result = validatePersonPatch({ ownTags: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ownTags).toEqual([]);
  });

  it('drops blank entries rather than failing the save', () => {
    const result = validatePersonPatch({ ownTags: ['embedded', '   ', 'arm'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ownTags).toEqual(['embedded', 'arm']);
  });

  /**
   * Case is NOT normalised here — `canonicaliseTags()` on the server owns that, and it is called from
   * exactly one place so a tag typed offline and one typed here land in the same facet bucket. A
   * second lowercaser in this file would be a second definition of a facet KEY.
   */
  it('leaves canonicalisation to the server', () => {
    const result = validatePersonPatch({ ownTags: ['AI/ML'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.ownTags).toEqual(['AI/ML']);
  });

  it('refuses a non-array, a non-string entry, and too many tags', () => {
    expect(validatePersonPatch({ ownTags: 'embedded' }).ok).toBe(false);
    expect(validatePersonPatch({ ownTags: [1] }).ok).toBe(false);
    expect(
      validatePersonPatch({ ownTags: Array.from({ length: MAX_OWN_TAGS + 1 }, (_, i) => `t${i}`) }).ok
    ).toBe(false);
  });

  it('refuses a single tag longer than the schema allows', () => {
    expect(validatePersonPatch({ ownTags: ['x'.repeat(41)] }).ok).toBe(false);
  });
});

describe('validatePersonPatch — notes append, so an empty one is refused', () => {
  it('accepts a trimmed note', () => {
    const result = validatePersonPatch({ note: '  wants an intro to the platform team  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.note).toBe('wants an intro to the platform team');
  });

  /**
   * The timeline is append-only and has no delete, so a blank note is a permanent row that says
   * nothing. Refusing beats ignoring: ignoring returns 200 for a write that did not happen.
   */
  it('refuses a blank note and names the field', () => {
    const result = validatePersonPatch({ note: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('note');
  });

  it('refuses a note past the schema maxlength', () => {
    expect(validatePersonPatch({ note: 'x'.repeat(MAX_NOTE_LENGTH + 1) }).ok).toBe(false);
  });
});

describe('validatePersonPatch — follow-ups', () => {
  it('accepts done', () => {
    const result = validatePersonPatch({ followUp: { action: 'done' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.followUp).toEqual({ action: 'done' });
  });

  /**
   * NORMALISED TO AN ISO INSTANT, so the route never re-parses and two clients sending the same moment
   * in different notations are indistinguishable. Noon IST is what the UI sends — `+05:30`, NOT a bare
   * `YYYY-MM-DD`, which Mongoose casts to UTC midnight, i.e. 5:30 AM IST, so anything later
   * subtracting hours slides the reminder into the previous day.
   */
  it('normalises a +05:30 instant without moving it', () => {
    const result = validatePersonPatch({ followUp: { action: 'set', at: '2026-09-20T12:00:00+05:30' } });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.followUp && 'at' in result.value.followUp) {
      expect(result.value.followUp.at).toBe('2026-09-20T06:30:00.000Z');
      expect(Date.parse(result.value.followUp.at)).toBe(Date.parse('2026-09-20T12:00:00+05:30'));
    }
  });

  it('refuses a missing or unparseable date, and an unknown action', () => {
    expect(validatePersonPatch({ followUp: { action: 'set' } }).ok).toBe(false);
    expect(validatePersonPatch({ followUp: { action: 'set', at: 'next tuesday' } }).ok).toBe(false);
    expect(validatePersonPatch({ followUp: { action: 'snooze' } }).ok).toBe(false);
    expect(validatePersonPatch({ followUp: 'done' }).ok).toBe(false);
  });
});

describe('validatePersonPatch — messageSent', () => {
  it('accepts only literal true', () => {
    expect(validatePersonPatch({ messageSent: true }).ok).toBe(true);
    // `false` is not "do not record it" — it is a caller confusing a flag for a toggle, and the
    // timeline has no way to un-send a message.
    expect(validatePersonPatch({ messageSent: false }).ok).toBe(false);
    expect(validatePersonPatch({ messageSent: 'yes' }).ok).toBe(false);
  });
});

describe('validatePersonPatch — combined edits', () => {
  it('accepts a name correction and tags in one request', () => {
    // The edit sheet saves both together on purpose: split into two round trips, the second can fail
    // after the first has landed and the user is left with half a save and no way to see which half.
    const result = validatePersonPatch({
      overrides: { displayName: 'Asha Rao', company: 'Postman' },
      ownTags: ['hardware'],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.overrides).toEqual({ displayName: 'Asha Rao', company: 'Postman' });
      expect(result.value.ownTags).toEqual(['hardware']);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   validateMergeRequest
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('validateMergeRequest — merge', () => {
  it('accepts two distinct ids', () => {
    const result = validateMergeRequest({ action: 'merge', winnerId: OID, loserId: OTHER });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ action: 'merge', winnerId: OID, loserId: OTHER });
  });

  /**
   * `mergePersons` returns null for a self-merge, which the route would have to translate into
   * something — and a 404 there would imply one of the two people is gone. Refusing here means the
   * 400 names the actual problem.
   */
  it('refuses merging a person into themselves', () => {
    const result = validateMergeRequest({ action: 'merge', winnerId: OID, loserId: OID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('loserId');
  });

  it('refuses a malformed or missing id and names which one', () => {
    const missing = validateMergeRequest({ action: 'merge', winnerId: OID });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.field).toBe('loserId');

    const bad = validateMergeRequest({ action: 'merge', winnerId: 'nope', loserId: OTHER });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.field).toBe('winnerId');
  });

  /**
   * THE PER-FIELD WINNING VALUES REUSE THE PATCH VALIDATOR, so "which name survives" is bounded by
   * exactly the same rules as a name correction typed on the person page. Two validators for one
   * concept is how a 200-character cap becomes a 500 on one path and a 400 on the other.
   */
  it('validates per-field choices through the same override rules', () => {
    const ok = validateMergeRequest({
      action: 'merge',
      winnerId: OID,
      loserId: OTHER,
      overrides: { displayName: 'Asha Rao', company: 'Postman' },
    });
    expect(ok.ok).toBe(true);
    if (ok.ok && ok.value.action === 'merge') {
      expect(ok.value.overrides).toEqual({ displayName: 'Asha Rao', company: 'Postman' });
    }

    const tooLong = validateMergeRequest({
      action: 'merge',
      winnerId: OID,
      loserId: OTHER,
      overrides: { company: 'x'.repeat(MAX_OVERRIDE_LENGTH + 1) },
    });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.field).toBe('overrides.company');
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   * REGRESSION. THIS EXACT CASE SHIPPED BROKEN AND WAS CAUGHT BY THIS FILE.
   *
   * `validateMergeRequest` used to validate its `overrides` by delegating the whole body to
   * `validatePersonPatch({ overrides })`. That inherited the patch path's "an empty patch is a 400"
   * rule — which is right for a PATCH and wrong here. The merge sheet only asks the user to choose
   * between fields the two records DISAGREE on, so the ordinary merge (nothing contested, most
   * commonly a `nm:` row and its `li:` upgrade) sends `overrides: {}` and was refused with
   * "Nothing to change" — a 400 on the single commonest merge in the product.
   *
   * The fix was to extract `validateOverrides`, which checks shape and deliberately does NOT enforce
   * "at least one field", leaving that rule with the caller that owns it. These three cases pin the
   * seam from both sides so a later "why are there two validators" tidy-up cannot re-close it.
   * ─────────────────────────────────────────────────────────────────────────────────────────────
   */
  it('accepts a merge whose overrides object is EMPTY — nothing was contested', () => {
    const result = validateMergeRequest({
      action: 'merge',
      winnerId: OID,
      loserId: OTHER,
      overrides: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'merge') {
      // Absent, not `{}`: the route skips the override write entirely, so derivation stays free to
      // keep improving the record from later captures.
      expect(result.value.overrides).toBeUndefined();
    }
  });

  it('accepts a merge with the overrides key omitted altogether', () => {
    const result = validateMergeRequest({ action: 'merge', winnerId: OID, loserId: OTHER });
    expect(result.ok).toBe(true);
    if (result.ok && result.value.action === 'merge') {
      expect(result.value.overrides).toBeUndefined();
    }
  });

  it('still refuses an EMPTY PATCH on the person route — the rule belongs there, not in overrides', () => {
    // The other side of the same seam. Loosening `validateOverrides` must not loosen this: a PATCH the
    // server silently ignores is indistinguishable to the client from one that worked.
    expect(validatePersonPatch({ overrides: {} }).ok).toBe(false);
    expect(validatePersonPatch({}).ok).toBe(false);
  });

  it('shares the override RULES with the patch path — one definition, checked from both ends', () => {
    const long = 'x'.repeat(MAX_OVERRIDE_LENGTH + 1);
    // Same field, same cap, same refusal, whichever route the value arrives through. Two validators
    // for one concept is how a 200-character cap becomes a 400 on one path and a 500 on the other.
    const viaPatch = validatePersonPatch({ overrides: { role: long } });
    const viaMerge = validateMergeRequest({
      action: 'merge',
      winnerId: OID,
      loserId: OTHER,
      overrides: { role: long },
    });
    expect(viaPatch.ok).toBe(false);
    expect(viaMerge.ok).toBe(false);
    if (!viaPatch.ok && !viaMerge.ok) expect(viaMerge.field).toBe(viaPatch.field);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   validateTagBulk — the bulk-tag write path
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('validateTagBulk', () => {
  it('accepts a batch of people and a tag to add', () => {
    const result = validateTagBulk({ personIds: [OID, OTHER], add: ['hardware'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ personIds: [OID, OTHER], add: ['hardware'], remove: [] });
    }
  });

  it('accepts a removal, and both directions in one request', () => {
    const removal = validateTagBulk({ personIds: [OID], remove: ['hardware'] });
    expect(removal.ok).toBe(true);
    if (removal.ok) expect(removal.value).toMatchObject({ add: [], remove: ['hardware'] });

    const both = validateTagBulk({ personIds: [OID], add: ['fpga'], remove: ['hardware'] });
    expect(both.ok).toBe(true);
    if (both.ok) expect(both.value).toMatchObject({ add: ['fpga'], remove: ['hardware'] });
  });

  it('dedupes repeated ids without refusing them', () => {
    // A double-tapped card is a user's mistake to absorb, not one to fail a batch of forty over.
    const result = validateTagBulk({ personIds: [OID, OID, OTHER], add: ['x'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.personIds).toEqual([OID, OTHER]);
  });

  /**
   * A MALFORMED ID IS REFUSED, NOT SKIPPED. Skipping answers 200 for a request that tagged fewer people
   * than it named, and the caller has no way to tell which — the same reason the route reports
   * `matched` beside `requested` for the ids that were well-formed but not the caller's.
   */
  it('refuses the whole batch when any id is malformed', () => {
    const result = validateTagBulk({ personIds: [OID, 'nope'], add: ['x'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('personIds');
  });

  it('refuses an empty or missing selection', () => {
    expect(validateTagBulk({ personIds: [], add: ['x'] }).ok).toBe(false);
    expect(validateTagBulk({ add: ['x'] }).ok).toBe(false);
    expect(validateTagBulk({ personIds: OID, add: ['x'] }).ok).toBe(false);
  });

  /** A real cap, not a formality: the route reads every matched person AND their captures. */
  it('refuses a batch past MAX_BULK_PEOPLE', () => {
    const many = Array.from({ length: MAX_BULK_PEOPLE + 1 }, (_, i) =>
      i.toString(16).padStart(24, '0')
    );
    const result = validateTagBulk({ personIds: many, add: ['x'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('personIds');
  });

  it('refuses a request that would change nothing', () => {
    // Not a no-op success — see the empty-patch reasoning above; it is the identical trap.
    expect(validateTagBulk({ personIds: [OID] }).ok).toBe(false);
    expect(validateTagBulk({ personIds: [OID], add: [], remove: [] }).ok).toBe(false);
    expect(validateTagBulk({ personIds: [OID], add: ['   '] }).ok).toBe(false);
  });

  it('refuses a non-array or non-string tag list, and too many tags', () => {
    expect(validateTagBulk({ personIds: [OID], add: 'hardware' }).ok).toBe(false);
    expect(validateTagBulk({ personIds: [OID], add: [7] }).ok).toBe(false);
    expect(
      validateTagBulk({
        personIds: [OID],
        add: Array.from({ length: MAX_BULK_TAGS + 1 }, (_, i) => `t${i}`),
      }).ok
    ).toBe(false);
  });

  it('refuses a tag longer than the schema allows', () => {
    expect(validateTagBulk({ personIds: [OID], add: ['x'.repeat(41)] }).ok).toBe(false);
  });

  /**
   * CANONICALISATION IS NOT DONE HERE, and that is the point of the assertion rather than an omission.
   * `canonicaliseTags()` lives in a mongoose module and is the SINGLE definition every write path
   * shares; a second lowercaser in a client-safe file is exactly how `"AI/ML"` and `"ai/ml"` become two
   * chips for one idea and split a cohort in half with nothing on screen to say so.
   */
  it('leaves case and separators to the server canonicaliser', () => {
    const result = validateTagBulk({ personIds: [OID], add: ['  AI/ML  '] });
    expect(result.ok).toBe(true);
    // Trimmed (that is shape), NOT lowercased (that is canonicalisation).
    if (result.ok) expect(result.value.add).toEqual(['AI/ML']);
  });

  it('refuses a non-object body, which is also what a malformed JSON body arrives as', () => {
    for (const body of [null, undefined, 'x', 5, [], true]) {
      expect(validateTagBulk(body).ok).toBe(false);
    }
  });

  it('never lets a bulk body assign ownership', () => {
    // `userId` is not a member of `TagBulkRequest`. Ownership is the route's `{_id: {$in}, userId}`
    // filter, so a foreign id cannot widen the write — it simply fails to match.
    const result = validateTagBulk({ personIds: [OID], add: ['x'], userId: 'attacker' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.value).sort()).toEqual(['add', 'personIds', 'remove']);
  });
});

describe('validateMergeRequest — dismiss and unmerge', () => {
  it('accepts a dismissal of two distinct people', () => {
    const result = validateMergeRequest({ action: 'dismiss', personId: OID, otherId: OTHER });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ action: 'dismiss', personId: OID, otherId: OTHER });
  });

  it('refuses a person being their own duplicate', () => {
    expect(validateMergeRequest({ action: 'dismiss', personId: OID, otherId: OID }).ok).toBe(false);
  });

  it('accepts an unmerge by the loser id', () => {
    // The LOSER is the addressable half of a merge: it is the row carrying `mergedInto`, so it is the
    // only one that knows what to reverse.
    const result = validateMergeRequest({ action: 'unmerge', loserId: OID });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual({ action: 'unmerge', loserId: OID });
  });

  it('refuses an unknown or missing action', () => {
    const result = validateMergeRequest({ loserId: OID });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('action');
    expect(validateMergeRequest({ action: 'delete', loserId: OID }).ok).toBe(false);
    expect(validateMergeRequest(null).ok).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   RESPONSE SHAPE
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('personToDTO', () => {
  const now = new Date('2026-09-08T06:30:00.000Z');

  it('turns every Date into an ISO string, because JSON has no Date', () => {
    // Typing these `Date` on the client compiles fine and then every `.getTime()` throws at runtime —
    // the reason `lib/event-types.ts` and `lib/contacts/types.ts` exist at all.
    const dto = personToDTO({
      _id: OID,
      displayName: 'Asha Rao',
      lastInteractionAt: now,
      nextActionAt: now,
      createdAt: now,
      updatedAt: now,
    });
    expect(dto.lastInteractionAt).toBe('2026-09-08T06:30:00.000Z');
    expect(dto.nextActionAt).toBe('2026-09-08T06:30:00.000Z');
    expect(typeof dto.createdAt).toBe('string');
  });

  it('supplies the schema defaults for a document that predates a field', () => {
    const dto = personToDTO({ _id: OID });
    expect(dto).toMatchObject({
      _id: OID,
      contactKeys: [],
      tags: [],
      ownTags: [],
      companies: [],
      isTargetCompany: false,
      eventCount: 0,
      interactionCount: 0,
      lastInteractionAt: null,
      nextActionAt: null,
      mergedInto: null,
    });
    // `displayName` is `required` in the schema, so a blank one means a pre-spine row. Naming it
    // honestly beats an empty heading with no explanation.
    expect(dto.displayName).toBe('Unnamed');
  });

  it('always reports overrides as a full object, so the edit sheet has three fields to read', () => {
    const dto = personToDTO({ _id: OID, displayName: 'Asha', overrides: { company: 'Postman' } });
    expect(dto.overrides).toEqual({ displayName: null, company: 'Postman', role: null });
  });

  it('reports mergedInto as a STRING id, so the client can link to the survivor', () => {
    const dto = personToDTO({ _id: OID, displayName: 'Asha', mergedInto: OTHER });
    expect(dto.mergedInto).toBe(OTHER);
  });

  it('never emits an Invalid Date for an unparseable stored value', () => {
    const dto = personToDTO({ _id: OID, displayName: 'Asha', lastInteractionAt: 'not a date' });
    expect(dto.lastInteractionAt).toBeNull();
  });

  it('derives the same candidate fields for the merge compare as for the card', () => {
    // One mapper, so the two halves of a side-by-side compare cannot disagree about what they show.
    const person = {
      _id: OID,
      displayName: 'Asha Rao',
      company: 'Postman',
      eventCount: 2,
      interactionCount: 5,
    };
    expect(personToMergeCandidate(person)).toMatchObject({
      _id: OID,
      displayName: 'Asha Rao',
      company: 'Postman',
      eventCount: 2,
      interactionCount: 5,
    });
  });
});

describe('linkedinUrlFromKeys', () => {
  /**
   * The whole design rests on this measurement: a LinkedIn QR is
   * `https://www.linkedin.com/in/<public-vanity-slug>?fromQR=1` — 19 samples spanning Jun 2018 to
   * Mar 2026, six locales, iOS and Android, ZERO structural variation and no name anywhere in it. So
   * the slug is a globally unique identity available offline, and `li:<slug>` is the top key tier.
   */
  it('builds the profile URL from a li: key', () => {
    expect(linkedinUrlFromKeys(['nm:asha rao', 'li:naga-sai-rahul-vudumula-93419524b'])).toBe(
      'https://www.linkedin.com/in/naga-sai-rahul-vudumula-93419524b'
    );
  });

  it('returns null when no key is a LinkedIn one', () => {
    expect(linkedinUrlFromKeys(['nm:asha rao', 'em:asha@example.com', 'ph:9876543210'])).toBeNull();
    expect(linkedinUrlFromKeys([])).toBeNull();
    expect(linkedinUrlFromKeys(undefined)).toBeNull();
  });

  /**
   * A stored key becomes an `href`, so a slug containing a slash would point the link somewhere else
   * entirely. The tier prefix is machine-written today; the check costs nothing and the failure mode
   * it prevents is a link to an attacker's page rendered inside the user's own contact list.
   */
  it('refuses a slug that is not a single path segment', () => {
    expect(linkedinUrlFromKeys(['li:evil.example/in/someone'])).toBeNull();
    expect(linkedinUrlFromKeys(['li:has space'])).toBeNull();
    expect(linkedinUrlFromKeys(['li:'])).toBeNull();
    expect(linkedinUrlFromKeys(['li:?x=1'])).toBeNull();
  });
});

describe('personSubtitle', () => {
  it('joins role and company, and prefers role over headline', () => {
    expect(personSubtitle({ role: 'Staff Engineer', company: 'Razorpay' })).toBe(
      'Staff Engineer · Razorpay'
    );
    expect(
      personSubtitle({ role: 'Staff Engineer', headline: 'Building things', company: 'Razorpay' })
    ).toBe('Staff Engineer · Razorpay');
    expect(personSubtitle({ headline: 'Building things' })).toBe('Building things');
  });

  it('returns an empty string rather than stray separators when nothing is known', () => {
    // A LinkedIn QR carries no employer, so this is the COMMON case, not an edge one. " · " on its
    // own under a name reads as a rendering bug.
    expect(personSubtitle({})).toBe('');
    expect(personSubtitle({ company: null, role: null, headline: null })).toBe('');
  });
});

describe('interaction vocabulary', () => {
  /**
   * `Record<InteractionKind, string>` means a seventh kind added to the schema fails the BUILD rather
   * than rendering a raw enum value at somebody. This test is the runtime half: it asserts the two
   * maps stay in step with each other, which the type alone cannot.
   */
  it('labels and icons cover exactly the same kinds', () => {
    expect(Object.keys(INTERACTION_ICON).sort()).toEqual(Object.keys(INTERACTION_LABEL).sort());
  });

  it('covers every kind the schema defines', () => {
    // Spelled literally rather than imported: importing `INTERACTION_KINDS` pulls mongoose into this
    // suite, and a test that reads the same constant it is checking asserts nothing.
    expect(Object.keys(INTERACTION_LABEL).sort()).toEqual(
      [
        'follow-up-done',
        'follow-up-set',
        'intake',
        'merged',
        'message-sent',
        'met',
        'note',
      ].sort()
    );
  });
});
