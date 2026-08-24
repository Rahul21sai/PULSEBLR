import { describe, it, expect } from 'vitest';
import {
  TRACKER_STATUSES,
  validateTrackerInput,
  trackerValidationError,
  isSchemaRejection,
  type TrackerIssue,
} from '@/lib/tracker/validate';

/**
 * The tracker write path had the same defect twice: `POST /api/tracker` handed the raw
 * request body to `TrackerEntry.create()` and `PUT /api/tracker/[id]` handed it to
 * `{ $set: body }` with `runValidators: true`. Either way a bad `status` produced a
 * Mongoose ValidationError, which fell through to the catch-all and was reported as
 * **500 with `details: err.message`** — so a client typo read as a server fault, and the
 * response body leaked the model name and the schema path:
 *
 *   TrackerEntry validation failed: status: `Foo` is not a valid enum value for path `status`.
 *
 * These tests pin the two halves of the fix that a later refactor could quietly undo:
 * that every rejection NAMES the field and its allowed values, and that no message ever
 * carries Mongoose's own wording. The second half is the one worth having a test for —
 * "it returns 400" survives a careless change that goes back to echoing `err.message`
 * into the 400, and that still leaks.
 *
 * Scope note: this is here rather than in `scripts/diag-*.ts` because the validator is a
 * pure function over a parsed body — no database, no server. The HTTP status codes it
 * produces are asserted end-to-end by `scripts/diag-tracker-flow.ts`.
 */

/** Every message a payload produced, joined — for asserting on absence of leakage. */
function messages(issues: TrackerIssue[]): string {
  return issues.map(i => i.message).join(' | ');
}

function fields(issues: TrackerIssue[]): string[] {
  return issues.map(i => i.field);
}

describe('TRACKER_STATUSES', () => {
  it('is exactly the eight capitalised pipeline values', () => {
    expect([...TRACKER_STATUSES]).toEqual([
      'New',
      'Interested',
      'Applied',
      'Shortlisted',
      'Confirmed',
      'Attended',
      'Skipped',
      'Rejected',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(TRACKER_STATUSES).size).toBe(TRACKER_STATUSES.length);
  });
});

describe('validateTrackerInput — status', () => {
  it('accepts every value in the enum', () => {
    for (const status of TRACKER_STATUSES) {
      expect(validateTrackerInput({ status }), status).toEqual([]);
    }
  });

  it('rejects a value outside the enum', () => {
    const issues = validateTrackerInput({ status: 'Ghosted' });
    expect(fields(issues)).toEqual(['status']);
  });

  it('names the field and every allowed value in the message', () => {
    const [issue] = validateTrackerInput({ status: 'Ghosted' });
    expect(issue.message).toContain('status');
    for (const status of TRACKER_STATUSES) {
      expect(issue.message).toContain(status);
    }
  });

  it('never echoes Mongoose wording', () => {
    const blob = messages(validateTrackerInput({ status: 'Ghosted' })).toLowerCase();
    // The exact phrases a ValidationError / CastError message is built from.
    for (const leak of [
      'validation failed',
      'is not a valid enum value',
      'for path',
      'trackerentry',
      'cast to',
    ]) {
      expect(blob).not.toContain(leak);
    }
  });

  // The status values are capitalised, so a lowercase client is the likeliest real typo
  // and it must be a 400 rather than a silent pass or a 500.
  it('is case sensitive', () => {
    expect(fields(validateTrackerInput({ status: 'interested' }))).toEqual(['status']);
    expect(fields(validateTrackerInput({ status: 'INTERESTED' }))).toEqual(['status']);
  });

  it('rejects a non-string status without throwing', () => {
    for (const status of [42, null, true, {}, ['New']]) {
      expect(fields(validateTrackerInput({ status })), JSON.stringify(status)).toEqual([
        'status',
      ]);
    }
  });

  it('rejects an empty string rather than treating it as absent', () => {
    expect(fields(validateTrackerInput({ status: '' }))).toEqual(['status']);
  });

  // A PUT sends only the fields being changed; an absent status is not an error.
  it('allows status to be absent', () => {
    expect(validateTrackerInput({ notes: 'hello' })).toEqual([]);
  });
});

describe('validateTrackerInput — eventId', () => {
  const OID = '507f1f77bcf86cd799439011';

  it('accepts a 24-character hex id', () => {
    expect(validateTrackerInput({ eventId: OID }, { requireEventId: true })).toEqual([]);
  });

  it('requires eventId when asked to (POST)', () => {
    expect(fields(validateTrackerInput({ status: 'New' }, { requireEventId: true }))).toEqual([
      'eventId',
    ]);
  });

  it('does not require eventId by default (PUT sends only changed fields)', () => {
    expect(validateTrackerInput({ status: 'New' })).toEqual([]);
  });

  it('rejects a malformed id instead of letting it reach a Mongoose cast', () => {
    for (const bad of ['not-an-id', '', '507f1f77bcf86cd79943901', `${OID}0`, 'zzzf1f77bcf86cd799439011']) {
      expect(fields(validateTrackerInput({ eventId: bad }, { requireEventId: true })), bad)
        .toEqual(['eventId']);
    }
  });

  // `mongoose.Types.ObjectId.isValid` returns TRUE for any 12-character string, so a
  // guard written with it lets 'hello world!' through to become a real ObjectId. The
  // 24-hex test is the one that matches what the app actually stores.
  it('rejects a 12-character string that ObjectId.isValid would accept', () => {
    expect(fields(validateTrackerInput({ eventId: 'hello world!' }, { requireEventId: true })))
      .toEqual(['eventId']);
  });

  it('rejects a non-string eventId', () => {
    for (const bad of [42, null, {}, []]) {
      expect(fields(validateTrackerInput({ eventId: bad }, { requireEventId: true })), JSON.stringify(bad))
        .toEqual(['eventId']);
    }
  });
});

describe('validateTrackerInput — the other fields that also produced a 500', () => {
  it('rejects a non-string notes or outcome', () => {
    expect(fields(validateTrackerInput({ notes: 42 }))).toEqual(['notes']);
    expect(fields(validateTrackerInput({ outcome: [] }))).toEqual(['outcome']);
  });

  it('rejects an unparseable appliedAt', () => {
    expect(fields(validateTrackerInput({ appliedAt: 'banana' }))).toEqual(['appliedAt']);
  });

  it('accepts an ISO appliedAt, and null to clear it', () => {
    expect(validateTrackerInput({ appliedAt: '2026-08-24T10:00:00.000Z' })).toEqual([]);
    expect(validateTrackerInput({ appliedAt: null })).toEqual([]);
  });

  /**
   * Verified against the installed Mongoose, not assumed: a Date path casts `''` to null
   * and only errors on an unparseable string. `EditTrackerModal`'s `EMPTY` draft sends
   * `followUpAt: ''` for anyone recorded without a follow-up date, so a validator stricter
   * than the schema here would 400 every save from the one screen that records people.
   */
  it("accepts '' on a date field, which is exactly what the edit modal sends", () => {
    expect(validateTrackerInput({ appliedAt: '' })).toEqual([]);
    expect(
      validateTrackerInput({ connections: [{ name: 'Rahul', followUpAt: '' }] })
    ).toEqual([]);
  });

  it("accepts the edit modal's full EMPTY-draft connection shape", () => {
    expect(
      validateTrackerInput({
        notes: '',
        connections: [
          {
            name: 'Rahul',
            role: '',
            company: '',
            linkedin: '',
            context: '',
            followUpAt: '',
            followedUp: false,
          },
        ],
      })
    ).toEqual([]);
  });

  it('rejects a non-array connections', () => {
    expect(fields(validateTrackerInput({ connections: 'Rahul' }))).toEqual(['connections']);
  });

  // `ConnectionSchema.name` is `required`, so `connections: [{}]` was a 500 too.
  it('requires a name on every connection, and says which one', () => {
    const issues = validateTrackerInput({
      connections: [{ name: 'Rahul' }, { role: 'SRE' }],
    });
    expect(fields(issues)).toEqual(['connections[1].name']);
  });

  it('rejects a blank or whitespace-only connection name', () => {
    expect(fields(validateTrackerInput({ connections: [{ name: '   ' }] })))
      .toEqual(['connections[0].name']);
  });

  it('rejects an unparseable connection followUpAt', () => {
    const issues = validateTrackerInput({
      connections: [{ name: 'Rahul', followUpAt: 'next tuesday' }],
    });
    expect(fields(issues)).toEqual(['connections[0].followUpAt']);
  });

  it('accepts a fully-populated realistic payload', () => {
    expect(
      validateTrackerInput(
        {
          eventId: '507f1f77bcf86cd799439011',
          status: 'Attended',
          notes: 'Talked about Iceberg compaction.',
          outcome: 'Referred to their hiring manager',
          appliedAt: '2026-08-20T04:30:00.000Z',
          connections: [
            {
              name: 'Diag Test Person',
              role: 'Staff Engineer',
              company: 'ClickHouse',
              context: 'Met at the table by the door',
              followUpAt: '2026-08-27T04:30:00.000Z',
              followedUp: false,
            },
          ],
        },
        { requireEventId: true }
      )
    ).toEqual([]);
  });

  it('reports every bad field at once rather than stopping at the first', () => {
    const issues = validateTrackerInput(
      { status: 'Ghosted', notes: 42, appliedAt: 'banana' },
      { requireEventId: true }
    );
    expect(fields(issues).sort()).toEqual(['appliedAt', 'eventId', 'notes', 'status']);
  });
});

describe('trackerValidationError — the shape both routes return', () => {
  it('surfaces the first message as `error` and keeps the full list', () => {
    const issues = validateTrackerInput({ status: 'Ghosted', notes: 42 });
    const body = trackerValidationError(issues);
    expect(body.error).toBe(issues[0].message);
    expect(body.issues).toEqual(issues);
  });

  it('never produces an empty error string, even given no issues', () => {
    expect(trackerValidationError([]).error.length).toBeGreaterThan(0);
  });
});

/**
 * Defence in depth. Validation now runs before the write, so a Mongoose ValidationError
 * should be unreachable — but if a gap ever opens, the failure must not go back to being a
 * 500 that echoes `err.message`. The routes use this to answer with a 400 and a generic
 * message while logging the real error server-side.
 *
 * Matched structurally on `name` rather than with `instanceof`, so this module stays free of
 * the mongoose import and can be unit-tested without one.
 */
describe('isSchemaRejection', () => {
  it('recognises a Mongoose ValidationError and CastError by name', () => {
    for (const name of ['ValidationError', 'CastError']) {
      const err = Object.assign(new Error('some internal wording'), { name });
      expect(isSchemaRejection(err), name).toBe(true);
    }
  });

  it('does not claim an ordinary failure is the caller’s fault', () => {
    expect(isSchemaRejection(new Error('connection timed out'))).toBe(false);
    // A duplicate key is a real conflict the route already answers with 409.
    expect(isSchemaRejection(Object.assign(new Error('E11000'), { code: 11000 }))).toBe(false);
    expect(isSchemaRejection(new TypeError('undefined is not a function'))).toBe(false);
  });

  it('tolerates non-Error throws', () => {
    for (const thrown of [null, undefined, 'boom', 42, {}]) {
      expect(isSchemaRejection(thrown), JSON.stringify(thrown) ?? 'undefined').toBe(false);
    }
  });
});

describe('validateTrackerInput — hostile input never throws', () => {
  it('rejects a body that is not a JSON object', () => {
    for (const body of [null, undefined, 'string', 42, [], true]) {
      const issues = validateTrackerInput(body);
      expect(issues.length, JSON.stringify(body) ?? 'undefined').toBeGreaterThan(0);
    }
  });

  it('ignores unknown fields, which the schema strips anyway', () => {
    expect(validateTrackerInput({ status: 'New', wat: 'hi', __proto__: {} })).toEqual([]);
  });

  it('does not treat a prototype-polluting key as a field', () => {
    const issues = validateTrackerInput(JSON.parse('{"constructor": 1, "status": "New"}'));
    expect(issues).toEqual([]);
  });
});
