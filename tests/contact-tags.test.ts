import { describe, it, expect } from 'vitest';
import { canonicaliseTags, MAX_TAG_LENGTH, MAX_TAGS_PER_CONTACT } from '@/lib/contacts/service';
import { buildContactFilter, buildContactSort, parseContactQuery, repeatKeys } from '@/lib/contacts/query';

/**
 * A CONTACT TAG IS A FACET KEY, not a label, and that is what makes canonicalisation load-bearing.
 *
 * The People page groups and filters on the exact stored string. So `"AI/ML"` and `"ai/ml"` are not
 * an untidiness — they are two chips for one idea, and the filter silently splits that person's
 * cohort in half with nothing on screen to suggest it happened. There is no error, no warning, and
 * no way for the user to notice except by counting. That failure mode is why this is pinned here
 * rather than left to a diag script.
 *
 * `canonicaliseTags` is called from exactly one place — `pickWritable` — which is what makes scan,
 * manual add, PATCH and the offline drain agree. A tag typed offline and synced three hours later
 * has to land in the same bucket as one typed online, or the feature quietly stops working for the
 * captures made in the worst network conditions, which are the ones it exists for.
 *
 * The filter tests are here for the reason `lib/contacts/query.ts` exists at all: the list and the
 * facet counts are built from one function, so a change to it moves both. A regex that stops being
 * escaped, or a `q` that stops searching `note`, is invisible until somebody's search goes wrong.
 */

describe('canonicaliseTags', () => {
  it('lowercases, so one idea cannot become two facet chips', () => {
    // The whole reason this function exists.
    expect(canonicaliseTags(['AI/ML'])).toEqual(['ai/ml']);
    expect(canonicaliseTags(['AI/ML', 'ai/ml', 'Ai/Ml'])).toEqual(['ai/ml']);
  });

  it('collapses internal whitespace as well as trimming it', () => {
    // "senior  sre" and "senior sre" are the same tag to a person, and double spaces happen.
    expect(canonicaliseTags(['  senior   sre  '])).toEqual(['senior sre']);
    expect(canonicaliseTags(['senior sre', 'senior  sre'])).toEqual(['senior sre']);
  });

  it('dedupes, so a per-tag count cannot be inflated by one contact', () => {
    expect(canonicaliseTags(['ibm', 'ibm', 'IBM'])).toEqual(['ibm']);
  });

  it('drops blanks rather than storing an empty chip', () => {
    expect(canonicaliseTags(['', '   ', '\t', 'real'])).toEqual(['real']);
  });

  it('caps each tag, because an unbounded string renders as a broken chip', () => {
    const long = 'x'.repeat(200);
    const [only] = canonicaliseTags([long]);
    expect(only).toHaveLength(MAX_TAG_LENGTH);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 60 }, (_, i) => `tag-${i}`);
    expect(canonicaliseTags(many)).toHaveLength(MAX_TAGS_PER_CONTACT);
  });

  it('ignores non-strings instead of throwing on them', () => {
    // The input is a parsed request body — `unknown` by construction, and the offline outbox
    // replays bodies written by an older version of this app.
    expect(canonicaliseTags([1, null, undefined, {}, [], 'kept'])).toEqual(['kept']);
    expect(canonicaliseTags('not an array')).toEqual([]);
    expect(canonicaliseTags(null)).toEqual([]);
    expect(canonicaliseTags(undefined)).toEqual([]);
  });

  it('truncates before deduping, so two long tags with the same prefix collapse', () => {
    // Otherwise a 40-char cap creates duplicates it then stores: both truncate to the same string.
    const a = 'a'.repeat(45) + 'ONE';
    const b = 'a'.repeat(45) + 'TWO';
    expect(canonicaliseTags([a, b])).toHaveLength(1);
  });
});

describe('buildContactFilter', () => {
  const USER = 'devlogin:someone@example.com';

  it('always scopes by userId', () => {
    // An unscoped contacts query returns other people's private notes. The digest already shipped
    // exactly that bug, which is why `userId` is a required positional argument here rather than a
    // key on the params object a caller can forget.
    expect(buildContactFilter(USER)).toEqual({ userId: USER });
  });

  it('matches company and tag EXACTLY, not by regex', () => {
    // `companies[]` holds values the resolver produced and tags are lowercased on write, so there
    // is nothing to normalise — and a regex would let "Meta" match "Metabase".
    const filter = buildContactFilter(USER, { company: 'Meta', tag: 'hardware' });
    expect(filter.companies).toBe('Meta');
    expect(filter.tags).toBe('hardware');
  });

  it('searches name, company, role, headline AND note', () => {
    // `note` is "how we met", which is often the only thing the user remembers — "the one from the
    // Kafka talk". Dropping it from the search would make the box feel broken for the exact query
    // people actually type.
    const filter = buildContactFilter(USER, { q: 'kafka' }) as { $or: Array<Record<string, unknown>> };
    expect(filter.$or.map(clause => Object.keys(clause)[0])).toEqual([
      'name',
      'company',
      'role',
      'headline',
      'note',
    ]);
  });

  it('ESCAPES the search term — an unescaped bracket is a 500, not a miss', () => {
    // Somebody typing "Ola (Krutrim)" would otherwise throw a SyntaxError inside the driver, and a
    // typed ".*" would scan the collection. This is the assertion that catches the escaping being
    // removed as redundant.
    const filter = buildContactFilter(USER, { q: 'Ola (Krutrim) [x] a.b*' }) as {
      $or: Array<Record<string, RegExp>>;
    };
    const rx = filter.$or[0].name;
    expect(rx.source).toContain('\\(');
    expect(rx.source).toContain('\\[');
    expect(rx.source).toContain('\\.');
    expect(rx.source).toContain('\\*');
    // And it still matches the literal text it was built from.
    expect(rx.test('ola (krutrim) [x] a.b*')).toBe(true);
    // …without matching what an unescaped version would have.
    expect(rx.test('ola krutrim x axbx')).toBe(false);
  });

  it('is case-insensitive on search', () => {
    const filter = buildContactFilter(USER, { q: 'RAZORPAY' }) as { $or: Array<Record<string, RegExp>> };
    expect(filter.$or[0].name.flags).toContain('i');
  });

  it('treats follow-up-due as OUTSTANDING, not overdue', () => {
    // A follow-up scheduled for Friday is outstanding on Wednesday. `getPendingFollowUps` has its
    // own overdue-vs-upcoming window for the dashboard and the digest, and those two silently
    // disagreeing is a bug this repo has already paid for once.
    const filter = buildContactFilter(USER, { followUpDue: true });
    expect(filter.followUpAt).toEqual({ $ne: null });
    expect(filter.followedUp).toEqual({ $ne: true });
  });

  it('leaves repeatOnly OUT of the filter entirely', () => {
    // "Have I met this person before" is a property of a GROUP sharing a contactKey, not a field on
    // any document, so it cannot be a predicate. If it ever appears in the filter, something has
    // denormalised it onto the row and it will go stale.
    const filter = buildContactFilter(USER, { repeatOnly: true });
    expect(Object.keys(filter)).toEqual(['userId']);
  });

  it('omits absent filters rather than matching on undefined', () => {
    // `{ companies: undefined }` is not the same as no constraint in every Mongo driver path, and
    // an accidental null-match returns the wrong rows silently.
    const filter = buildContactFilter(USER, { company: undefined, tag: undefined, q: '' });
    expect(filter).toEqual({ userId: USER });
  });
});

describe('parseContactQuery', () => {
  it('lowercases the tag so a shared URL with different casing still matches', () => {
    // Tags are stored lowercase. Without this, a link somebody pasted with "?tag=Hardware" would
    // match nothing and read as an empty facet rather than a casing mismatch.
    expect(parseContactQuery(new URLSearchParams('tag=Hardware')).tag).toBe('hardware');
  });

  it('does not lowercase the company, which is a canonical registry name', () => {
    expect(parseContactQuery(new URLSearchParams('company=Razorpay')).company).toBe('Razorpay');
  });

  it('treats blank and whitespace-only params as absent', () => {
    const parsed = parseContactQuery(new URLSearchParams('q=%20%20&company=&tag='));
    expect(parsed.q).toBeUndefined();
    expect(parsed.company).toBeUndefined();
    expect(parsed.tag).toBeUndefined();
  });

  it('caps param length, since each one feeds a regex or an index probe', () => {
    const parsed = parseContactQuery(new URLSearchParams(`q=${'x'.repeat(5000)}`));
    expect(parsed.q).toHaveLength(200);
  });

  it('only accepts the literal string "true" for the toggles', () => {
    expect(parseContactQuery(new URLSearchParams('targetOnly=true')).targetOnly).toBe(true);
    for (const value of ['1', 'yes', 'TRUE', 'on', '']) {
      expect(parseContactQuery(new URLSearchParams(`targetOnly=${value}`)).targetOnly).toBe(false);
    }
  });
});

describe('buildContactSort', () => {
  it('defaults to most-recent, which is what the indexes are built for', () => {
    expect(buildContactSort()).toEqual({ scannedAt: -1 });
    expect(buildContactSort('recent')).toEqual({ scannedAt: -1 });
    // An unknown value must not produce an empty sort — that would return rows in storage order.
    expect(buildContactSort('nonsense' as never)).toEqual({ scannedAt: -1 });
  });

  it('breaks a company tie by name', () => {
    expect(buildContactSort('company')).toEqual({ company: 1, name: 1 });
  });
});

describe('repeatKeys', () => {
  it('returns only keys seen at more than one event', () => {
    const counts = new Map([
      ['li:twice', 2],
      ['nm:once', 1],
      ['li:thrice', 3],
    ]);
    expect(repeatKeys(counts).sort()).toEqual(['li:thrice', 'li:twice']);
  });

  it('returns an empty array rather than throwing when nobody qualifies', () => {
    // `$in: []` matches nothing, which is the correct answer for "show me people I have met more
    // than once" when there are none — not a case to special-case upstream.
    expect(repeatKeys(new Map([['nm:once', 1]]))).toEqual([]);
    expect(repeatKeys(new Map())).toEqual([]);
  });

  it('drops an empty contactKey, which would match documents indiscriminately', () => {
    // A contact written before `contactKey` existed can carry ''. Feeding that into `$in` would
    // pull in every self-healing row that has not been touched yet.
    expect(repeatKeys(new Map([['', 5], ['li:real', 2]]))).toEqual(['li:real']);
  });
});
