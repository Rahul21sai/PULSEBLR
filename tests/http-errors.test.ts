/**
 * lib/http/errors.ts, driven with REAL errors.
 *
 * Every error below is produced by the installed Mongoose and MongoDB driver, in process, with no
 * connection: a model's `validate()`, a query's `cast()`, and the driver's own `MongoServerError`.
 * Look-alike objects would pin the helper to the shapes it was written against rather than the
 * shapes the libraries emit, and the whole point is that a Mongoose upgrade which moves a field
 * fails HERE instead of quietly turning a 400 back into a 500 in production.
 *
 * The leakage assertions are deliberately about the SERIALISED body, because that is what reaches a
 * client: `JSON.stringify` is what `NextResponse.json` does to it.
 */
import { describe, expect, it } from 'vitest';
import mongoose, { Schema } from 'mongoose';
import {
  callerFacingMessage,
  duplicateKeyFields,
  errorLogLine,
  invalidInputBody,
  isSchemaRejection,
  rejectedFields,
  routeFailure,
} from '@/lib/http/errors';
import { isSchemaRejection as trackerIsSchemaRejection } from '@/lib/tracker/validate';
import { eventValidationError } from '@/lib/events/admin-validate';
import { UnsafeUrlError } from '@/lib/security/safe-fetch';

const MODEL = 'HttpErrorsProbe';

const ProbeSchema = new Schema({
  status: { type: String, enum: ['New', 'Applied'] },
  name: { type: String, required: true, maxlength: 5 },
  when: Date,
  ref: Schema.Types.ObjectId,
  card: { headline: { type: String, maxlength: 3 }, token: String },
  tags: [{ type: String, maxlength: 4 }],
  people: [new Schema({ name: { type: String, required: true } }, { _id: false })],
  lookup: { type: Map, of: { type: String, maxlength: 2 } },
});
const Probe = mongoose.models[MODEL] || mongoose.model(MODEL, ProbeSchema);

/** A real ValidationError from the installed Mongoose. */
async function validationError(doc: Record<string, unknown>): Promise<unknown> {
  try {
    await new Probe(doc).validate();
  } catch (error) {
    return error;
  }
  throw new Error('expected the probe document to fail validation');
}

/** A real query CastError, raised by casting the filter without running it. */
function castError(filter: Record<string, unknown>): unknown {
  try {
    Probe.findOne(filter).cast(Probe);
  } catch (error) {
    return error;
  }
  throw new Error('expected the probe filter to fail casting');
}

/** A real driver E11000, shaped exactly as the server's reply is. */
function duplicateKey(keyPattern?: Record<string, number>): unknown {
  return new mongoose.mongo.MongoServerError({
    code: 11000,
    errmsg:
      'E11000 duplicate key error collection: pulseblr.folders index: userId_1_slug_1 dup key: { userId: "u1", slug: "secret-folder" }',
    ...(keyPattern ? { keyPattern, keyValue: { userId: 'u1', slug: 'secret-folder' } } : {}),
  });
}

/** Things a client must never see, whatever the error was. */
function expectNoInternals(body: unknown, extra: string[] = []) {
  const wire = JSON.stringify(body);
  for (const internal of [
    MODEL,
    'validation failed',
    'Cast to',
    'Path `',
    'at path',
    'enumValues',
    'E11000',
    'pulseblr.folders',
    'userId_1_slug_1',
    'secret-folder',
    'keyValue',
    ...extra,
  ]) {
    expect(wire).not.toContain(internal);
  }
}

const invalid = () =>
  validationError({
    status: 'Ghosted',
    name: 'toolongname',
    when: 'not a date',
    ref: 'xyz',
    card: { headline: 'abcd' },
    tags: ['abcdef'],
    people: [{}],
  });

describe('rejectedFields — which fields the schema refused, in the caller’s words', () => {
  it('names every refused field by its FULL path, with the problem and nothing else', async () => {
    const error = await invalid();
    const rejected = rejectedFields(error);
    // Compared as a Map, so order-insensitively: the order is Mongoose's business, not the contract.
    expect(rejected).toHaveLength(7);
    expect(new Map(rejected!.map(r => [r.field, r.message]))).toEqual(
      new Map([
        ['status', 'is not one of the allowed values'],
        ['name', 'is too long'],
        ['when', 'must be a valid date'],
        ['ref', 'must be a valid id'],
        ['card.headline', 'is too long'],
        ['tags[0]', 'is too long'],
        // The inner error's own `.path` here is `name`, local to the subdocument. Reading it would
        // have named the wrong field entirely.
        ['people[0].name', 'is required'],
      ])
    );
    expectNoInternals(rejected, ['Ghosted', 'toolongname', 'not a date', 'xyz']);
  });

  it('strips a storage prefix, and does not name a path outside it', async () => {
    const error = await validationError({ name: 'toolongname', card: { headline: 'abcd' } });
    expect(rejectedFields(error, { prefix: 'card.' })).toEqual([
      { field: 'headline', message: 'is too long' },
    ]);
  });

  it('names only the caller’s fields, and returns [] — not null — when none of them failed', async () => {
    const error = await validationError({ name: 'toolongname', status: 'Ghosted' });
    expect(rejectedFields(error, { fields: ['status'] })).toEqual([
      { field: 'status', message: 'is not one of the allowed values' },
    ]);
    // A schema rejection that is nobody's input is still a schema rejection: [] is the signal the
    // catch-all uses to answer 500 rather than blame the caller.
    expect(rejectedFields(error, { fields: ['card'] })).toEqual([]);
  });

  it('names an array element by its array when the form edits the array as one input', async () => {
    const error = await validationError({ name: 'ok', tags: ['okay', 'abcdef', 'ghijkl'] });
    expect(rejectedFields(error)).toEqual([
      { field: 'tags[1]', message: 'is too long' },
      { field: 'tags[2]', message: 'is too long' },
    ]);
    // Two refused elements, ONE input on screen: collapsed and de-duplicated.
    expect(rejectedFields(error, { collapseIndices: true })).toEqual([{ field: 'tags', message: 'is too long' }]);
  });

  it('folds a derived path into the field it derives from, once', async () => {
    // Folder's `slug` is derived from `name`; when both are refused the caller hears about `name` once.
    const error = await validationError({ status: 'Ghosted' });
    const rejected = rejectedFields(error, { rename: { status: 'name' } });
    expect(rejected?.map(r => r.field)).toEqual(['name']);
  });

  it('reads a query CastError on `_id` as the caller’s `id`, or a renamed field', () => {
    const error = castError({ _id: 'not-an-id' });
    expect(rejectedFields(error)).toEqual([{ field: 'id', message: 'must be a valid id' }]);
    expect(rejectedFields(error, { rename: { _id: 'contactId' } })).toEqual([
      { field: 'contactId', message: 'must be a valid id' },
    ]);
    expectNoInternals(rejectedFields(error), ['not-an-id']);
  });

  it('drops a refused path that is not a plain identifier, rather than echoing it', async () => {
    // A Map key is caller-chosen text inside the schema path itself.
    const error = await validationError({ name: 'ok', lookup: { 'x-y\u001b[31m': 'abc' } });
    expect(isSchemaRejection(error)).toBe(true);
    expect(rejectedFields(error)).toEqual([]);
  });

  it('is null for anything that is not a schema rejection', () => {
    for (const other of [duplicateKey({ userId: 1, slug: 1 }), new Error('x'), new TypeError('y'), null, 'boom', 42]) {
      expect(rejectedFields(other)).toBeNull();
    }
  });
});

describe('routeFailure — the catch-all', () => {
  it('answers a ValidationError with 400 naming the field, not the model, value or wording', async () => {
    const error = await validationError({ name: 'ok', status: 'Ghosted' });
    const failure = routeFailure(error, 'Failed to save');
    expect(failure.status).toBe(400);
    expect(failure.body).toEqual({
      error: 'status is not one of the allowed values',
      issues: [{ field: 'status', message: 'status is not one of the allowed values' }],
    });
    expectNoInternals(failure.body, ['Ghosted', 'New', 'Applied']);
  });

  it('answers a CastError with 400', () => {
    const failure = routeFailure(castError({ when: 'garbage' }), 'Failed to load');
    expect(failure.status).toBe(400);
    expect(failure.body).toEqual({
      error: 'when must be a valid date',
      issues: [{ field: 'when', message: 'when must be a valid date' }],
    });
    expectNoInternals(failure.body, ['garbage']);
  });

  it('hands the refused fields to a route’s own builder, in the shape its edit screen reads', async () => {
    const error = await validationError({ name: 'toolongname' });
    const failure = routeFailure(error, 'Failed to update event', { invalidBody: eventValidationError });
    expect(failure).toEqual({
      status: 400,
      body: { error: 'name is too long', fields: [{ field: 'name', message: 'is too long' }] },
    });
  });

  it('answers a duplicate key the route did not handle as a 500, never a guessed 409', () => {
    const failure = routeFailure(duplicateKey({ userId: 1, slug: 1 }), 'Failed to create folder');
    expect(failure).toEqual({ status: 500, body: { error: 'Failed to create folder' } });
    expectNoInternals(failure.body);
  });

  it('answers any other error with exactly the route’s sentence and nothing of the error', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:27017 for db pulseblr-prod'), {
      details: 'stack goes here',
    });
    const failure = routeFailure(error, 'Failed to list contacts');
    expect(failure).toEqual({ status: 500, body: { error: 'Failed to list contacts' } });
    expectNoInternals(failure.body, ['ECONNREFUSED', '10.0.0.7', 'pulseblr-prod', 'details']);
  });

  it('answers a schema rejection of fields the caller never sent as a 500', async () => {
    const error = await validationError({ name: 'toolongname' });
    expect(routeFailure(error, 'Failed to save', { fields: ['status'] })).toEqual({
      status: 500,
      body: { error: 'Failed to save' },
    });
  });

  it('builds the tracker-shaped body from rejected fields', () => {
    expect(invalidInputBody([{ field: 'tags[1]', message: 'is too long' }])).toEqual({
      error: 'tags[1] is too long',
      issues: [{ field: 'tags[1]', message: 'tags[1] is too long' }],
    });
  });
});

describe('duplicateKeyFields — which index collided', () => {
  it('reads keyPattern, so a route can tell a name clash from a schema bug', () => {
    expect(duplicateKeyFields(duplicateKey({ userId: 1, slug: 1 }))).toEqual(['userId', 'slug']);
    expect(duplicateKeyFields(duplicateKey({ userId: 1, clientId: 1 }))).toEqual(['userId', 'clientId']);
  });

  it('finds keyPattern on the raw server reply when it is only there', () => {
    const error = { code: 11000, errorResponse: { keyPattern: { dedupHash: 1 } } };
    expect(duplicateKeyFields(error)).toEqual(['dedupHash']);
  });

  it('is [] for an E11000 that names no index, so no route can take it for the clash it handles', () => {
    expect(duplicateKeyFields(duplicateKey())).toEqual([]);
  });

  it('is null for anything that is not a duplicate key', async () => {
    for (const other of [await invalid(), { code: 11001 }, { code: '11000' }, new Error('E11000'), null]) {
      expect(duplicateKeyFields(other)).toBeNull();
    }
  });
});

describe('errorLogLine — the real error, for the server log only', () => {
  it('keeps what an operator needs: the model, the path and the message', async () => {
    const line = errorLogLine(await validationError({ name: 'ok', status: 'Ghosted' }));
    expect(line).toContain('ValidationError');
    expect(line).toContain(MODEL);
    expect(line).toContain('Ghosted');
    expect(line).toMatch(/\| at /);
  });

  it('keeps the code and the index of a duplicate key', () => {
    const line = errorLogLine(duplicateKey({ userId: 1, slug: 1 }));
    expect(line).toContain('[code 11000]');
    expect(line).toContain('userId_1_slug_1');
  });

  it('is ONE inert line even when the caller’s value is built to forge more', async () => {
    const hostile = 'x\r\n    at forged (C:/evil.ts:1:1)\n::error::pwned\u001b[31m\u202e##[group]';
    const line = errorLogLine(await validationError({ name: 'ok', status: hostile }));
    expect(line).not.toMatch(/[\r\n\u000b\u000c\u0085\u2028\u2029]/);
    expect(line).not.toMatch(/[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/);
    expect(line).not.toContain('\u202e');
    expect(line).not.toContain('##[');
    expect(line.startsWith('::')).toBe(false);
  });

  it('is bounded', () => {
    const line = errorLogLine(new Error('y'.repeat(50_000)));
    expect(line.length).toBeLessThan(3000);
  });

  it('describes a thrown non-Error, and never throws on a hostile one', () => {
    expect(errorLogLine('plain string\nsecond line')).toBe('plain string second line');
    expect(errorLogLine(undefined)).toBe('(a thrown value with no text)');
    const booby = {
      get name(): string {
        throw new Error('getter');
      },
    };
    expect(errorLogLine(booby)).toBe('(an error that could not be described)');
  });
});

describe('callerFacingMessage — the one error whose message is written for the caller', () => {
  it('passes an UnsafeUrlError through as one clean line', () => {
    expect(callerFacingMessage(new UnsafeUrlError('Destination resolves to a non-public address'))).toBe(
      'Destination resolves to a non-public address'
    );
    expect(callerFacingMessage(new UnsafeUrlError('two\nlines\u001b[0m'))).toBe('two lines[0m');
  });

  it('refuses every other error, whatever its message says', async () => {
    for (const other of [new Error('Destination host could not be resolved'), await invalid(), duplicateKey(), 'x', null]) {
      expect(callerFacingMessage(other)).toBeNull();
    }
  });
});

describe('one definition of "schema rejection"', () => {
  it('is the tracker’s own function, re-exported, not a second copy that can drift', () => {
    expect(isSchemaRejection).toBe(trackerIsSchemaRejection);
  });
});
