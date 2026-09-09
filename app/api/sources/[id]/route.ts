import { NextRequest, NextResponse } from 'next/server';
import dbConnect from '@/lib/mongodb';
import Source from '@/lib/models/Source';
import { requireAdmin } from '@/lib/api-auth';
import { validateNewSource, sourceValidationError } from '@/lib/sources/admin-validate';

/**
 * A 24-hex-character ObjectId, checked BEFORE it reaches Mongoose.
 *
 * `Source.findById('garbage')` throws a CastError whose message names the model and the path,
 * which the catch-all below would answer as a 500 — a client mistake reported as a server
 * fault, and free reconnaissance on the internal shape of the data. Same reasoning as
 * `lib/tracker/validate.ts`, and deliberately NOT `mongoose.Types.ObjectId.isValid()`, which
 * returns true for any 12-character string.
 */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;

/** The 400 for a malformed id: names the field, leaks no Mongoose wording. */
function badId() {
  return NextResponse.json({ error: 'id must be a 24-character hex ObjectId' }, { status: 400 });
}

/**
 * GET /api/sources/[id] -- one source row. ADMIN ONLY.
 *
 * Was unguarded, like its collection sibling. See the long note on `GET /api/sources`: the row
 * carries the upstream `url`, the discovery `handle`, and `lastError`, which is internal
 * diagnostic text. Both are now asserted in `MUST_REFUSE` in `scripts/diag-api-auth.ts`.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    const { id } = await params;
    if (!OBJECT_ID.test(id)) return badId();

    await dbConnect();
    const source = await Source.findById(id);

    if (!source) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    }

    return NextResponse.json({ source });
  } catch (error) {
    console.error('Error fetching source:', error);
    return NextResponse.json({ error: 'Failed to fetch source' }, { status: 500 });
  }
}

/** The only fields a PUT may change — the same four `validateNewSource` accepts on create. */
const UPDATABLE = ['name', 'type', 'url', 'kind', 'handle', 'enabled'] as const;

/**
 * PUT /api/sources/[id] -- edit one source. ADMIN ONLY: this is how a source gets disabled,
 * which silently shrinks the feed.
 *
 * IT USED TO PASS THE RAW BODY STRAIGHT TO `findByIdAndUpdate`, while its own POST sibling had
 * been hardened with an allowlist and a header comment explaining exactly why: a `Source` row is
 * not inert data, it is an INSTRUCTION to the scraper, so whatever lands in `url` / `handle` is
 * dereferenced on the next run by a job with no user in front of it — and
 * `lib/scrapers/core/http.ts` does NOT go through `lib/security/safe-fetch.ts`, so there is no
 * second line of defence at fetch time. Two consequences the allowlist removes:
 *
 *   · an injected `url` becomes an SSRF the nightly cron performs, unattended, from inside the
 *     deployment's network — the exact hole `POST /api/scrape-url` has a whole guard module for.
 *   · the scraper's own HEALTH BOOKKEEPING was writable. `consecutiveEmptyScrapes` feeds the
 *     digest's unhealthy-source report and the ordering in `loadDiscovered()`, so a seeded value
 *     hides a dead feed from the one report that would have named it, or pushes a good source to
 *     the back of the scrape queue. `lastError` / `lastScrapedAt` fake a history.
 *
 * THE SAME CHANGE ALSO DISARMS A LATENT INDEX BUG. `Source.index({ kind, handle }, { unique,
 * sparse })` is the compound-sparse shape that once capped every user at ONE folder (CLAUDE.md
 * §9): on a compound index `sparse` omits a document only when EVERY indexed field is missing, so
 * the first row with a `kind` and no `handle` indexes `handle: null` and the next such row
 * collides. It survives today only because all the handle-less rows also lack a `kind`. This PUT
 * was the ONLY path that could write that shape, because `validateNewSource` already refuses a
 * `kind` without a `handle` and vice versa (`lib/sources/admin-validate.ts:94-97`). Running the
 * same validator here closes the last door to it.
 *
 * Partial updates still work — `app/admin/AdminDashboard.tsx` sends exactly `{ enabled: false }`
 * for the enable/disable toggle — so anything the caller did not supply is taken from the STORED
 * row before validating, and only the supplied keys are written back.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  // Guard first, validate second (CLAUDE.md §6): an anonymous caller sending a bad body must
  // get 401, never a 400 that tells them their payload parsed far enough to be judged.
  const { id } = await params;
  if (!OBJECT_ID.test(id)) return badId();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'request body must be valid JSON' }, { status: 400 });
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: 'body must be a JSON object' }, { status: 400 });
  }
  const patch = body as Record<string, unknown>;

  const supplied = UPDATABLE.filter(field => field in patch);
  if (supplied.length === 0) {
    return NextResponse.json(
      { error: `nothing to update — supply one of ${UPDATABLE.join(', ')}` },
      { status: 400 }
    );
  }

  try {
    await dbConnect();
    const existing = await Source.findById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    }

    /*
     * Validate the RESULT of the edit, not the fragment, so a supplied `url` is scheme-checked
     * and a supplied half of the identity pair is judged against the half already stored.
     *
     * `kind` / `handle` are carried over from the stored row ONLY when the caller touches one of
     * them. Passing them unconditionally would make a legacy half-identified row (a `kind` with
     * no `handle`) fail validation on an unrelated `{ enabled: false }` toggle — refusing an edit
     * because of a defect the edit does not touch.
     */
    const touchesIdentity = 'kind' in patch || 'handle' in patch;
    const candidate: Record<string, unknown> = {
      name: 'name' in patch ? patch.name : existing.name,
      type: 'type' in patch ? patch.type : existing.type,
      url: 'url' in patch ? patch.url : existing.url,
      ...(touchesIdentity
        ? {
            kind: 'kind' in patch ? patch.kind : existing.kind,
            handle: 'handle' in patch ? patch.handle : existing.handle,
          }
        : {}),
      ...('enabled' in patch ? { enabled: patch.enabled } : {}),
    };

    const { doc, issues } = validateNewSource(candidate);
    if (issues.length > 0) {
      return NextResponse.json(sourceValidationError(issues), { status: 400 });
    }

    /*
     * Write back only what the caller asked to change, taken from the VALIDATED doc rather than
     * from the body — so the trimming and URL canonicalisation `validateNewSource` performs are
     * what lands in the database.
     *
     * A key the validator dropped is skipped rather than `$set` to undefined: clearing the
     * `kind`/`handle` identity pair is deliberately not expressible here, because a half-cleared
     * pair is the index collision above. Delete the row and re-register it instead.
     */
    const update: Record<string, unknown> = {};
    for (const field of supplied) {
      if (doc[field] !== undefined) update[field] = doc[field];
    }

    const source = await Source.findByIdAndUpdate(
      id,
      { $set: update },
      { new: true, runValidators: true }
    );

    if (!source) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    }

    return NextResponse.json({ source });
  } catch (error) {
    console.error('Error updating source:', error);
    // `{ kind, handle }` is unique, so an edit that collides with an existing row is the
    // caller's mistake, not a server fault. Branch on keyPattern rather than assuming which
    // index it was — see the folders E11000 story in CLAUDE.md §9.
    const err = error as { code?: number; keyPattern?: Record<string, unknown> };
    if (err.code === 11000) {
      const onIdentity = err.keyPattern && ('handle' in err.keyPattern || 'kind' in err.keyPattern);
      return NextResponse.json(
        {
          error: onIdentity
            ? 'Another source already has that kind and handle.'
            : 'That change collides with an existing source.',
        },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: 'Failed to update source' }, { status: 500 });
  }
}

// ADMIN ONLY: deleting a Source destroys persisted discovery state that took
// multiple runs to build, and it does not come back on its own.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    const { id } = await params;
    // Same reason as the other two handlers: a malformed id is the caller's mistake, and letting
    // it reach Mongoose turns it into a 500 whose message names the model.
    if (!OBJECT_ID.test(id)) return badId();

    await dbConnect();
    const source = await Source.findByIdAndDelete(id);

    if (!source) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    }

    return NextResponse.json({ message: 'Source deleted successfully' });
  } catch (error) {
    console.error('Error deleting source:', error);
    return NextResponse.json({ error: 'Failed to delete source' }, { status: 500 });
  }
}
