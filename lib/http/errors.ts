/**
 * What an API route's failure may tell the caller, decided in ONE place rather than by each route.
 *
 * ── THE DEFECT CLASS ─────────────────────────────────────────────────────────────────────────
 * Routes used to answer a thrown error with `{ error, details: err.message }` and a 500. On a
 * Mongoose error that message names the MODEL, the SCHEMA PATH and the VALUE the caller sent.
 * Measured on the installed Mongoose 9.7.2:
 *
 *   ShapeProbe validation failed: status: `Ghosted` is not a valid enum value for path `status`.
 *
 * The error OBJECT carries more than its message. `JSON.stringify` of a ValidationError includes
 * every `enumValues` list and `maxlength`, and an E11000 from the driver carries
 * `errorResponse.errmsg`, which names the DATABASE and the collection (`pulseblr.folders`), the index
 * and `keyValue`. So an error object must never become a response body, nor any part of one.
 *
 * The STATUS was wrong as well as the body. A caller's typo reported as 500 says "server fault,
 * retry", and a client that believes it retries a record that can never save.
 *
 * ── THE RULES, ONE FUNCTION EACH ─────────────────────────────────────────────────────────────
 *   · A ValidationError or CastError on a field the caller sent is a 400 naming THAT FIELD, in the
 *     caller's vocabulary. Never the model, the value, or Mongoose's wording (`rejectedFields`).
 *   · A duplicate key is the ROUTE's decision, made on WHICH index collided (`duplicateKeyFields`).
 *     An index the route did not expect is a schema bug, not user error: CLAUDE.md §9 records the
 *     folder index that capped every user at one folder while the route answered "You already have
 *     a folder with that name". So `routeFailure` answers an unhandled duplicate as the 500 it is.
 *   · Anything else is a 500 carrying the route's own sentence (`routeFailure`).
 *   · The real error goes to the server log through `errorLogLine`, as ONE inert line. Its text
 *     carries the caller's values, so a newline or an ESC sequence in a field would otherwise forge
 *     log lines or drive the operator's terminal: the CWE-117 case lib/security/control-chars.ts
 *     documents for push-service bodies.
 *
 * Pure: no mongoose import (errors are matched on `name`, `code` and shape, as `isSchemaRejection`
 * already is), and no next/server. `tests/http-errors.test.ts` drives it with REAL Mongoose and
 * MongoDB errors built in process, so a change of shape in either library fails there rather than
 * in production. `tests/api-error-leaks.test.ts` scans every route for the old shape.
 */
import { toLogLine } from '@/lib/security/control-chars';

/*
 * ONE DEFINITION of "the schema refused the request", and it predates this module: the tracker
 * write paths introduced it, and `app/api/contacts/sync` already imported it from there. Re-exported
 * rather than re-implemented, so the tracker's 400 and every other route's 400 cannot disagree about
 * which errors qualify. It belongs here, generic, with `lib/tracker/validate.ts` re-exporting it; that
 * file is outside this change, so the move is left to whoever owns it next.
 */
import { isSchemaRejection } from '@/lib/tracker/validate';

export { isSchemaRejection };

/**
 * One field the schema refused, in the shape `eventValidationError` and `sourceValidationError`
 * already use: `message` is a predicate that FOLLOWS the field name ("is too long"), so
 * `${field} ${message}` reads as a sentence. Those two builders can take this array unchanged, which
 * is what the admin and owner edit screens read to mark a field inline.
 */
export interface RejectedField {
  /** The caller's name for the field: `name`, `tags[2]`, `people[0].name`, `id`. */
  field: string;
  message: string;
}

/**
 * How a route's schema paths map onto the names its CALLER uses. Everything is optional; with none
 * of it, a path is named as-is (bracketed indices, `_id` read as `id`), which is right for a route
 * whose body mirrors the schema.
 */
export interface FieldVocabulary {
  /**
   * The caller's fields are stored under this prefix, e.g. `'card.'` for a body of `{ headline }`
   * written to `card.headline`. Stripped before naming, and a path OUTSIDE it is not the caller's to
   * be told about: it is somebody else's field on the same document.
   */
  prefix?: string;
  /** Top-level field → the name the caller used, e.g. `{ _id: 'contactId' }`. */
  rename?: Readonly<Record<string, string>>;
  /**
   * The only top-level fields the caller can have sent. A refusal on anything else (a derived key,
   * a legacy value on a field nobody can edit) is not named, and a refusal on nothing but those is
   * not the caller's mistake at all, so `routeFailure` answers it as a 500.
   */
  fields?: readonly string[];
  /**
   * Name an array ELEMENT by its array: `category`, not `category[0]`. For a form that edits the
   * array as ONE input (the category picker) and marks errors by input name, where the indexed name
   * would match nothing on screen. Off by default: the tracker's `connections[1].name` needs its
   * index to say which person is missing a name.
   */
  collapseIndices?: boolean;
}

/** What `routeFailure` hands back; the route passes both to `NextResponse.json` unchanged. */
export interface RouteFailure {
  status: 400 | 500;
  body: Record<string, unknown>;
}

export interface FailureOptions extends FieldVocabulary {
  /**
   * Builds the 400 body. Defaults to `invalidInputBody` (`{ error, issues }`). The event and source
   * routes pass `eventValidationError` / `sourceValidationError` instead, because their edit screens
   * read `fields` to mark each input.
   */
  invalidBody?: (rejected: RejectedField[]) => Record<string, unknown>;
}

// ── schema rejections ────────────────────────────────────────────────────────────────────────

/**
 * A field name is sent to the caller only if it is a plain dotted/indexed identifier. Schema paths
 * always are; a Map key or a path assembled from input might not be, and a name that is not ours to
 * vouch for is dropped rather than echoed.
 */
const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\[\d+\]|\.[A-Za-z_$][\w$]*)*$/;
const MAX_FIELD_CHARS = 100;

/**
 * Validator kinds, measured on Mongoose 9.7.2. The wording describes the VALUE, never the edit, so
 * it stays true when `.save()` refuses a legacy value the request did not touch.
 */
const VALIDATOR_PROBLEMS: Readonly<Record<string, string>> = {
  required: 'is required',
  maxlength: 'is too long',
  minlength: 'is too short',
  enum: 'is not one of the allowed values',
  min: 'is too small',
  max: 'is too large',
  regexp: 'is not in the expected format',
};

/**
 * CastError kinds, measured on Mongoose 9.7.2, lowercased. The spelling varies by type (`Number`,
 * `string`, `Embedded` beside `embedded`, `[string]` for an array element), hence the normalising.
 */
const CAST_PROBLEMS: Readonly<Record<string, string>> = {
  date: 'must be a valid date',
  objectid: 'must be a valid id',
  number: 'must be a number',
  boolean: 'must be true or false',
  string: 'must be text',
  object: 'must be an object',
  embedded: 'must be an object',
  map: 'must be an object',
  array: 'must be a list',
};

const FALLBACK_PROBLEM = 'is not valid';

function problemFor(inner: { name?: unknown; kind?: unknown }): string {
  const kind = typeof inner.kind === 'string' ? inner.kind : '';
  if (inner.name === 'CastError') {
    // `[string]` is an array ELEMENT's cast, and the path already carries the index.
    const base = kind.replace(/^\[(.*)\]$/, '$1').toLowerCase();
    return CAST_PROBLEMS[base] ?? FALLBACK_PROBLEM;
  }
  return VALIDATOR_PROBLEMS[kind] ?? FALLBACK_PROBLEM;
}

/** A schema path in the caller's vocabulary, or null when it is not theirs to be told about. */
function callerField(path: string, vocabulary: FieldVocabulary): string | null {
  let rest = path;
  if (vocabulary.prefix) {
    if (!rest.startsWith(vocabulary.prefix)) return null;
    rest = rest.slice(vocabulary.prefix.length);
  }
  if (!rest) return null;

  const [head, ...tail] = rest.split('.');
  const name = vocabulary.rename?.[head] ?? (head === '_id' ? 'id' : head);
  if (vocabulary.fields && !vocabulary.fields.includes(name)) return null;

  // `people.0.name` → `people[0].name`, the notation `lib/tracker/validate.ts` already uses.
  let rendered = name;
  for (const segment of tail) {
    if (!/^\d+$/.test(segment)) rendered += `.${segment}`;
    else if (!vocabulary.collapseIndices) rendered += `[${segment}]`;
  }

  return rendered.length <= MAX_FIELD_CHARS && IDENTIFIER_PATH.test(rendered) ? rendered : null;
}

/**
 * The fields a schema rejection refused, named for the caller.
 *
 * `null` when the error is not a schema rejection at all. An EMPTY array when it is one but none of
 * the refused paths is the caller's, which is a server-side problem rather than a bad request.
 *
 * A ValidationError is read by the KEYS of its `errors` map, which are full paths (`people.0.name`).
 * Each inner error's own `.path` is local to its subdocument (`name`), so it would misname a field.
 */
export function rejectedFields(
  error: unknown,
  vocabulary: FieldVocabulary = {}
): RejectedField[] | null {
  if (!isSchemaRejection(error)) return null;
  const e = error as { name?: unknown; errors?: unknown; path?: unknown; kind?: unknown };

  const refused: Array<[path: string, inner: { name?: unknown; kind?: unknown }]> = [];
  if (e.name === 'ValidationError') {
    if (e.errors && typeof e.errors === 'object') {
      for (const [path, inner] of Object.entries(e.errors as Record<string, unknown>)) {
        refused.push([path, inner && typeof inner === 'object' ? inner : {}]);
      }
    }
  } else if (typeof e.path === 'string') {
    refused.push([e.path, { name: 'CastError', kind: e.kind }]);
  }

  const out: RejectedField[] = [];
  const seen = new Set<string>();
  for (const [path, inner] of refused) {
    const field = callerField(path, vocabulary);
    if (!field || seen.has(field)) continue;
    seen.add(field);
    out.push({ field, message: problemFor(inner) });
  }
  return out;
}

/**
 * The `{ error, issues }` 400 body the tracker, manual-event, preferences and push routes use, so a
 * client that renders one renders all of them. `error` is the first issue, as it is on the tracker.
 */
export function invalidInputBody(rejected: readonly RejectedField[]): {
  error: string;
  issues: { field: string; message: string }[];
} {
  const issues = rejected.map(({ field, message }) => ({ field, message: `${field} ${message}` }));
  return { error: issues[0]?.message ?? 'The request was not valid', issues };
}

// ── duplicate keys ───────────────────────────────────────────────────────────────────────────

/**
 * The fields of the unique index an E11000 collided on, from `keyPattern`, so a route can branch on
 * WHICH clash it hit instead of guessing. `null` when this is not a duplicate-key error. An EMPTY
 * array when it is one but names no index, which a route must treat as unexpected: it cannot know it
 * is the clash it handles.
 *
 * Never `keyValue`. That is the caller's data, and a route has no reason to read it back.
 */
export function duplicateKeyFields(error: unknown): string[] | null {
  if (!error || typeof error !== 'object') return null;
  const e = error as { code?: unknown; keyPattern?: unknown; errorResponse?: { keyPattern?: unknown } };
  if (e.code !== 11000) return null;
  const pattern = e.keyPattern ?? e.errorResponse?.keyPattern;
  return pattern && typeof pattern === 'object' ? Object.keys(pattern) : [];
}

// ── the catch-all ────────────────────────────────────────────────────────────────────────────

/**
 * The response for an error the route has not handled itself: a 400 naming the caller's fields if
 * the schema refused them, otherwise a 500 carrying `fallback`, which the route writes for a person.
 * Nothing in the body is ever derived from the error's text.
 *
 * Call it AFTER any duplicate-key branch the route owns. A duplicate that reaches it was not
 * expected, so it is the 500 CLAUDE.md §9 asks for rather than a guessed 409.
 */
export function routeFailure(
  error: unknown,
  fallback: string,
  options: FailureOptions = {}
): RouteFailure {
  const rejected = rejectedFields(error, options);
  if (rejected && rejected.length > 0) {
    return { status: 400, body: (options.invalidBody ?? invalidInputBody)(rejected) };
  }
  return { status: 500, body: { error: fallback } };
}

// ── the log line ─────────────────────────────────────────────────────────────────────────────

const LOG_HEAD_MAX = 1000;
const LOG_FRAME_MAX = 200;
const LOG_FRAMES = 6;

/**
 * Stack frames, read only from AFTER the message.
 *
 * V8 writes `${name}: ${message}` above the frames, and a message can contain line breaks, so a line
 * of the caller's text that happens to start with "at " would otherwise be read as a frame. When the
 * current message is not in the stack (Mongoose appends to a ValidationError's message after the
 * stack is captured), the first line is skipped instead. Every frame goes through `toLogLine` anyway,
 * so a misread costs readability, never the one-line guarantee.
 */
function stackFrames(stack: unknown, message: string): string[] {
  if (typeof stack !== 'string' || !stack) return [];
  const at = message ? stack.indexOf(message) : -1;
  const newline = stack.indexOf('\n');
  const rest = at >= 0 ? stack.slice(at + message.length) : newline >= 0 ? stack.slice(newline + 1) : '';
  return rest
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^at\s/.test(line));
}

/**
 * The real error, for `console.error`, as ONE bounded, inert line: name, code, the full message and
 * the first few frames, each through `toLogLine`. The message is kept because it is what an operator
 * needs; what is removed is its power to break or forge a line.
 *
 * Never throws, because it runs inside catch blocks.
 */
export function errorLogLine(error: unknown): string {
  try {
    if (!error || typeof error !== 'object') {
      return toLogLine(error, LOG_HEAD_MAX) || '(a thrown value with no text)';
    }
    const e = error as { name?: unknown; message?: unknown; code?: unknown; stack?: unknown };
    const name = typeof e.name === 'string' && e.name ? e.name : 'Error';
    const message = typeof e.message === 'string' ? e.message : '';
    const code = typeof e.code === 'number' || typeof e.code === 'string' ? ` [code ${e.code}]` : '';
    const head = toLogLine(message ? `${name}${code}: ${message}` : `${name}${code}`, LOG_HEAD_MAX);
    const frames = stackFrames(e.stack, message)
      .slice(0, LOG_FRAMES)
      .map(frame => toLogLine(frame, LOG_FRAME_MAX));
    return frames.length > 0 ? `${head} | ${frames.join(' | ')}` : head;
  } catch {
    // A getter that throws, say. There is nothing safe left to print.
    return '(an error that could not be described)';
  }
}

// ── the one deliberate exception ─────────────────────────────────────────────────────────────

/**
 * Error classes whose message is written FOR the caller. Every other message is internal.
 *
 * `UnsafeUrlError` (lib/security/safe-fetch.ts) is fixed wording about why a URL the caller supplied
 * was refused, and `POST /api/scrape-url` relies on it so a person learns WHY rather than merely
 * that. Its only variable text is the URL scheme, which the WHATWG parser limits to
 * `[a-z0-9+.-]`. Keeping this list HERE, rather than as a `.message` read in a route, is what lets
 * `tests/api-error-leaks.test.ts` hold every route to "never `.message` in a body" with no exceptions.
 */
const CALLER_FACING_ERRORS: ReadonlySet<string> = new Set(['UnsafeUrlError']);

/** The message of a caller-facing error, as one clean line, or `null` for any other error. */
export function callerFacingMessage(error: unknown): string | null {
  if (!(error instanceof Error) || !CALLER_FACING_ERRORS.has(error.name)) return null;
  return toLogLine(error.message, 200) || null;
}
