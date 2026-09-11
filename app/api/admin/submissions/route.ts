import { NextRequest, NextResponse } from 'next/server';
import mongoose from 'mongoose';
import connectDB from '@/lib/mongodb';
import Event, { type IEvent } from '@/lib/models/Event';
import User from '@/lib/models/User';
import { requireAdmin } from '@/lib/api-auth';
import { notDeletedClause } from '@/lib/events/query';
import {
  validateSubmissionEdit,
  eventValidationError,
  SUBMISSION_EDIT_FIELDS,
} from '@/lib/events/submission-edit';
import { diffFields, recordAudit } from '@/lib/admin/audit';

/**
 * The review queue for events users have submitted to the shared feed.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS ROUTE HAS TO EXIST, rather than reviewing through the normal events list.
 *
 * `/admin`'s events panel lists through `GET /api/events`, and that route now scopes to the caller:
 * `visibility: 'public'` OR no visibility key OR `createdByUserId === me`. A pending submission
 * belongs to somebody else, so it matches none of those arms — which means the moment user
 * submissions existed, they became invisible to the very person meant to approve them. Offering
 * "add for everyone" with no review surface is offering a queue that silently goes nowhere.
 *
 * It is a SEPARATE ENDPOINT rather than a `pending=true` flag on the feed, because it asks a
 * different question with different permissions. The feed's job is "what may this viewer see";
 * this one's is "what is waiting for a decision", and it is `requireAdmin()` throughout. Adding an
 * admin escape hatch to `buildEventFilter` would put a privilege branch inside the one function
 * every public read path depends on — the last place it belongs.
 *
 * WHY IT SHOWS THE SUBMITTER'S EMAIL. A reviewer is being asked to publish a stranger's `applyLink`
 * to everybody, which is the phishing vector the admin guard exists to close. Knowing who is asking
 * is part of that judgement. It is looked up per page rather than denormalised onto the event, so
 * nothing has to be kept in sync.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * The marker that says "a model extracted this from a company page", not "a person typed it in".
 *
 * `lib/scrapers/pipeline.ts` lands microsite candidates with `sourceEventId` set to
 * `microsite:<fingerprint>` and NO `createdByUserId` — deliberately, because nobody owns them and
 * claiming an owner would put an unreviewed row into `pruneStale()`'s permanent-keep set.
 *
 * MIRRORED, not imported. The constant of record is `FINGERPRINT_PREFIX` in
 * `lib/scrapers/adapters/microsite.ts`, and importing it here would pull the whole scraper module
 * graph into a route that never scrapes. The cost of the copy is bounded: if the prefix ever
 * changes, extracted rows report as `origin: 'user'` with a null submitter — a wrong label, not a
 * wrong decision, and the row is still listed either way.
 */
const EXTRACTED_MARKER = 'microsite:';

/** What a reviewer needs to see, plus what the inline editor round-trips. */
const SUBMISSION_FIELDS =
  'title description organizer venue address area city format startDateTime endDateTime ' +
  'category isFree price applyLink sourceUrl sourceEventId imageUrl visibility createdByUserId ' +
  /*
   * `+extraction` IS AN EXPLICIT OPT-IN, and the `+` is required rather than stylistic.
   * `Event.extraction` is declared `select: false`, so it is absent from every read that does not
   * ask — which is what keeps 20 KB of somebody's marketing copy out of twelve unprojected read
   * paths, three of them public. This route is the ONE place it should appear: an extracted row is
   * a machine's claim about a real event, and a reviewer cannot judge the claim without the text it
   * was made from. `diag-microsite-audit.ts` is the shell-side view of the same thing.
   *
   * Absent on a user-submitted row, which is correct — nobody extracted it.
   */
  'createdAt isTechEvent +extraction';

export async function GET(request: NextRequest) {
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const includeDecided = request.nextUrl.searchParams.get('includeDecided') === 'true';

    /*
     * ── THE `includeDecided` FILTER, AND THE BUG IT USED TO HAVE ────────────────────────────
     *
     * It selected `createdByUserId: { $exists: true }`. Every submission a PERSON makes has an
     * owner, so that read as "everything that was ever submitted" — and it is not. A microsite
     * candidate has no owner by design, so once it was decided it matched neither view: not the
     * pending one (it is no longer pending) and not this one (it has no owner). The row is fine and
     * the decision is on it; it simply vanished from the only screen that would show it, which
     * reads as the queue losing work.
     *
     * "Was this ever a submission" therefore needs both markers, because the two kinds of
     * submission are provenanced differently and nothing else distinguishes a decided one from the
     * ~1500 scraped documents. An approved microsite row has no `visibility` key and no owner —
     * exactly like a scraped row — so `sourceEventId` is the only thing left that says where it
     * came from.
     */
    // Typed as a plain record, the idiom `lib/events/query.ts` establishes and explains: Mongoose 9's
    // strict `FilterQuery<IEvent>` rejects a runtime-built filter whose branches have different key
    // sets, which is exactly what a two-view queue produces.
    const filter: Record<string, unknown> = includeDecided
      ? {
          $or: [
            { createdByUserId: { $exists: true } },
            { sourceEventId: { $regex: `^${EXTRACTED_MARKER}` } },
          ],
          // `{ deletedAt: null }`, never `$exists` — the predicate has to match a null field AND an
          // absent one, and ~1500 documents predate the field. Imported rather than written out for
          // exactly that reason: the two candidate predicates look alike and one empties the list.
          ...notDeletedClause(),
        }
      : { visibility: 'pending', ...notDeletedClause() };

    const events = await Event.find(filter)
      .select(SUBMISSION_FIELDS)
      // Oldest first: a review queue is worked front to back, and the person who has been waiting
      // longest should not be at the bottom.
      .sort({ createdAt: 1 })
      .limit(200)
      .lean();

    // One lookup for the whole page, then an in-memory join — the discipline `listFolders` uses.
    const ownerIds = [...new Set(events.map(e => e.createdByUserId).filter(Boolean))] as string[];
    const users = await User.find({ googleId: { $in: ownerIds } })
      .select('googleId email name')
      .lean();
    const byId = new Map(users.map(u => [u.googleId, u]));

    return NextResponse.json({
      submissions: events.map(e => ({
        ...e,
        _id: String(e._id),
        /*
         * WHO OR WHAT PRODUCED THIS ROW, decided here rather than in the panel.
         *
         * The panel used to render every ownerless row as "an account with no user record" — true
         * for the rare session with no `User` document, and wrong and alarming for an extracted
         * candidate, where there is no account because nobody typed it in. Classifying server-side
         * keeps knowledge of the marker in one file instead of teaching the client to parse an id.
         */
        origin: String(e.sourceEventId ?? '').startsWith(EXTRACTED_MARKER) ? 'extracted' : 'user',
        submitter: byId.get(e.createdByUserId as string)
          ? {
              email: byId.get(e.createdByUserId as string)!.email,
              name: byId.get(e.createdByUserId as string)!.name,
            }
          : // A valid session can legitimately have no User row (the E11000 case that made
            // /api/me/card 404), so a missing submitter is reported rather than hiding the event.
            null,
      })),
    });
  } catch (error) {
    console.error('Error listing submissions:', error);
    return NextResponse.json({ error: 'Failed to list submissions' }, { status: 500 });
  }
}

/**
 * Correct one submission, or decide it.
 *
 * Two operations, discriminated by which key the body carries — `edit` for a correction,
 * `decision` for approve/reject. Separate rather than combined ("fix and publish in one call")
 * because they answer to different people: a correction is a factual repair a reviewer can make
 * freely, and a decision publishes a stranger's link to every visitor. Folding them together would
 * mean one request that half-succeeds, and an audit trail that cannot say whether the reviewer read
 * what they published.
 *
 * APPROVE clears `visibility` rather than setting `'public'`, so the row ends up in exactly the
 * shape every scraped document has — absent means public, and that is the state ~1500 existing
 * documents are in. Setting the string instead would create a second representation of "public"
 * that every filter would then have to handle, forever.
 *
 * `createdByUserId` is KEPT on an approved event. It is provenance — it records that a person
 * added this rather than a scraper — and it is what keeps the row out of `pruneStale()`, which
 * would otherwise delete it a week after it happened with no upstream to re-create it from.
 *
 * REJECT sets `'private'` rather than deleting. The user typed it in; it is theirs. Rejecting a
 * submission is a decision about the SHARED feed, not permission to destroy somebody's own record —
 * so it simply goes back to being their private event, and they keep whatever they tracked or
 * scanned against it.
 */
export async function PATCH(request: NextRequest) {
  // GUARD FIRST, VALIDATE SECOND. Before any body parsing — an anonymous caller must get 401, never
  // a 400 telling them their payload parsed far enough to be judged.
  const gate = await requireAdmin();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const body = (await request.json().catch(() => ({}))) as {
      id?: string;
      decision?: string;
      edit?: unknown;
    };

    if (typeof body.id !== 'string' || !mongoose.Types.ObjectId.isValid(body.id)) {
      return NextResponse.json({ error: 'A valid event id is required.' }, { status: 400 });
    }

    const wantsEdit = body.edit !== undefined;
    const wantsDecision = body.decision !== undefined;
    if (wantsEdit && wantsDecision) {
      return NextResponse.json(
        { error: 'Correct it or decide it, one request at a time.' },
        { status: 400 }
      );
    }
    if (!wantsEdit && !wantsDecision) {
      return NextResponse.json(
        { error: "Send an 'edit' object, or a 'decision' of 'approve' or 'reject'." },
        { status: 400 }
      );
    }
    if (wantsDecision && body.decision !== 'approve' && body.decision !== 'reject') {
      return NextResponse.json(
        { error: "decision must be 'approve' or 'reject'." },
        { status: 400 }
      );
    }

    /**
     * Scoped to `visibility: 'pending'` in the FILTER, not checked afterwards — for the edit as
     * well as the decision.
     *
     * So this route can only ever act on something actually awaiting review — it cannot be used to
     * flip an unrelated event public, to re-decide one that has already been decided, or to edit a
     * live public event behind the events panel's audit trail. A miss is a 404 with no distinction
     * between "already handled" and "never existed".
     */
    const event = await Event.findOne({ _id: body.id, visibility: 'pending' });
    if (!event) {
      return NextResponse.json({ error: 'No submission waiting on that id.' }, { status: 404 });
    }

    if (wantsEdit) return await applyEdit(event, body.edit, gate);

    if (body.decision === 'approve') {
      // `set(path, undefined)` on a document, which Mongoose turns into `$unset` on save. Written
      // explicitly rather than `event.visibility = undefined` so the intent is unmistakable: the
      // key must be REMOVED, not stored as null. A stored null would fail the
      // `{ visibility: { $exists: false } }` arm every visibility filter relies on and leave the
      // approved event invisible — the same trap CLAUDE.md records for `spotlightAt`, where
      // unpinning has to send an explicit null because a plain `$set` cannot express `$unset`.
      event.set('visibility', undefined);
    } else {
      event.visibility = 'private';
    }
    // `.save()` rather than `findOneAndUpdate`, so the `pre('validate')` key hooks run. They are
    // no-ops here — both keys already exist and neither derives from `visibility` — but the rule
    // that every Event write goes through document middleware is worth not breaking for one route.
    await event.save();

    /*
     * A decision is an admin mutation, so it gets an audit row like every other one.
     *
     * `submission.approve` / `submission.reject` were already in `AUDIT_ACTIONS` with `undoKind`
     * 'none' and a bespoke message in the undo route ("Re-decide it in Submissions — that keeps the
     * review step the queue exists for") — the wiring was designed and nothing wrote it, so
     * publishing an event to the whole city was the one admin action leaving no trace.
     *
     * `recordAudit` is non-fatal and is called AFTER the write: the decision has committed and is
     * what the reviewer asked for, so a logging failure must not be reported as a failed approval.
     */
    const auditId = await recordAudit({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: body.decision === 'approve' ? 'submission.approve' : 'submission.reject',
      targetType: 'submission',
      targetId: String(event._id),
      targetLabel: event.title,
      before: { visibility: 'pending' },
      // null for approve, because the key is now absent — `normaliseValue` collapses both to null
      // and the distinction that matters (`$unset` vs `$set: null`) is asserted where it is
      // load-bearing, in the write above.
      after: { visibility: body.decision === 'approve' ? null : 'private' },
    });

    return NextResponse.json({ id: String(event._id), decision: body.decision, auditId });
  } catch (error) {
    console.error('Submission update failed:', error);
    if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
      // 400, because a schema rejection is not a server fault and retrying cannot help. A 5xx here
      // would tell the panel "retry" for something that will never succeed, and would hide a real
      // fault behind the same code as a typo.
      return NextResponse.json({ error: SCHEMA_REFUSED }, { status: 400 });
    }
    // No `details`. The only thing it ever carried was a Mongoose message naming the model and the
    // schema path, which is free reconnaissance on the shape of the data; the wording is in the log.
    return NextResponse.json({ error: 'Failed to update that submission' }, { status: 500 });
  }
}

/**
 * What a schema rejection says to the reviewer.
 *
 * It does NOT blame their edit, deliberately. `.save()` validates the WHOLE document, so a value
 * that was already on the row — a retired category on a submission written before the 32 → 22
 * consolidation, say — fails a save that only touched the title. Telling the reviewer their title is
 * invalid would send them to correct the one thing that was right. It names no field because the
 * Mongoose message carries the model name and the schema path; that belongs in the log.
 */
const SCHEMA_REFUSED =
  'Saving was refused: this submission holds a value the feed cannot store. The field is named in the server log.';

/**
 * Correct a pending submission's fields.
 *
 * ── THE WRITE IS `findOne` + ASSIGN + `.save()`, AND THE REASON IS NOT THE OBVIOUS ONE ──────
 *
 * `findOneAndUpdate` does not run document middleware — `runValidators` invokes Mongoose's separate
 * update-validator helper, not `pre('validate')` — so an update path skips the hook that derives
 * `dedupHash` and `clusterKey`. That is the rule, and this respects it.
 *
 * What the hook actually does when it runs is worth stating exactly, because it is easy to assume
 * the opposite and the assumption is load-bearing here. It is `if (!self.dedupHash)` and
 * `if (!self.clusterKey)` — FILL-IF-MISSING self-healing, not re-derivation. So `.save()` after a
 * title change PRESERVES both keys rather than recomputing them, and that is the behaviour we want:
 *
 *   · An extracted row's `clusterKey` is `microsite:<page url>|<normalised title>|<IST day>` and its
 *     `dedupHash` folds the same namespace in through `generateDedupHash`'s owner slot. The hook
 *     cannot reproduce either: it reads the namespace from `createdByUserId`, and an extracted row
 *     deliberately has none. Clearing the keys to force a recompute would therefore STRIP the
 *     namespace — and an un-namespaced pending row shares a `clusterKey` with the scraped corpus by
 *     construction, which is the silent-loss path `lib/models/Event.ts` documents at length:
 *     `ingestEvents` finds the pending row first, `mergeInto` overwrites it, `Event.create` is never
 *     reached, and the city loses the public event with the scrape reporting success.
 *   · `mergeInto`'s owned-document refusal does not cover it either, because an extracted row has no
 *     owner to be refused on.
 *   · And the model's own comment settles the general question: de-namespacing mid-life "would mutate
 *     an identity mid-life, which is the thing `clusterKey` being frozen at ingest exists to prevent".
 *
 * The cost of frozen keys, stated plainly: after a title correction the keys describe the title as
 * first seen. For an extracted row that is exactly right — the next scrape hashes the same page text
 * and finds the same row rather than landing a duplicate. For a user-authored row it means the same
 * person re-submitting the corrected title gets a second row instead of a 409. A visible duplicate
 * in a review queue, which is the right way round.
 *
 * It also makes undo correct for free. `POST /api/admin/audit/undo` reverses `event.update` with
 * `updateOne`, which cannot re-derive keys; since the edit never changed them, restoring the fields
 * restores the row exactly.
 */
async function applyEdit(
  event: IEvent,
  rawEdit: unknown,
  gate: { userId: string; email: string }
) {
  // `endDateTime` is not editable here, so the cross-field check reads it off the DOCUMENT. Taking
  // it from the request would let a caller decide what their own start date is compared against.
  const { update, issues } = validateSubmissionEdit(rawEdit, { endDateTime: event.endDateTime });
  if (issues.length > 0) return NextResponse.json(eventValidationError(issues), { status: 400 });
  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: `Nothing editable was sent. Editable fields: ${SUBMISSION_EDIT_FIELDS.join(', ')}.` },
      { status: 400 }
    );
  }

  // Read the previous values BEFORE assigning, and only for the fields this patch touches. A
  // whole-document before-image would tempt a later edit into logging fields the action never
  // went near, which is how an audit trail stops answering "who changed this".
  const before: Record<string, unknown> = {};
  for (const key of Object.keys(update)) before[key] = event.get(key);
  const titleBefore = event.title;

  for (const [key, value] of Object.entries(update)) {
    // `set(key, undefined)` is how a cleared optional field becomes `$unset` — the same mechanism
    // the approve branch uses for `visibility`.
    event.set(key, value);
  }

  try {
    await event.save();
  } catch (err) {
    if (err instanceof mongoose.Error.ValidationError || err instanceof mongoose.Error.CastError) {
      // Answered HERE as well as in the caller's catch, because the caller cannot tell an edit from a
      // decision by the time it has an error in hand, and "Failed to record that decision" is the
      // wrong sentence to show somebody who was correcting a title.
      return NextResponse.json({ error: SCHEMA_REFUSED }, { status: 400 });
    }
    throw err;
  }

  const changes = diffFields(before, update);

  /*
   * A no-op save writes no log line. An audit trail where every save lists a dozen unchanged fields
   * is unreadable, and it makes "who changed this" answer with the wrong person.
   *
   * `targetType: 'event'` and `action: 'event.update'`, deliberately, even though the row is a
   * submission. Both are what the undo path understands: `undoKind('event.update')` is
   * 'restore-fields' and the undo route writes a field patch back to `Event` for `targetType:
   * 'event'` and to `Source` otherwise. Labelling this 'submission' would send an undo of a title
   * correction at the Source collection, find nothing, and report 409 'target-missing'. The summary
   * carries the fact that it was a pending submission instead, which is where a reader needs it.
   */
  let auditId: string | null = null;
  if (changes.length > 0) {
    auditId = await recordAudit({
      actorId: gate.userId,
      actorEmail: gate.email,
      action: 'event.update',
      targetType: 'event',
      targetId: String(event._id),
      targetLabel: titleBefore,
      // `before` holds exactly the previous values of the fields that changed, which IS the patch an
      // undo writes back — so no inversion logic is needed at undo time.
      before: Object.fromEntries(changes.map(c => [c.field, c.before])),
      after: Object.fromEntries(changes.map(c => [c.field, c.after])),
      changes,
      summary: `Corrected a pending submission “${titleBefore}” — ${changes
        .map(c => c.field)
        .join(', ')}`,
    });
  }

  // The corrected row goes back, so the panel re-renders from the server's version rather than from
  // its own draft. A silent divergence between the two is how a reviewer approves what they think
  // they typed instead of what was stored.
  return NextResponse.json({
    id: String(event._id),
    edited: changes.map(c => c.field),
    auditId,
    submission: {
      _id: String(event._id),
      title: event.title,
      description: event.get('description') ?? '',
      organizer: event.get('organizer') ?? '',
      venue: event.get('venue') ?? '',
      area: event.get('area') ?? '',
      startDateTime: event.get('startDateTime'),
      category: event.get('category') ?? [],
      applyLink: event.get('applyLink') ?? '',
      isTechEvent: event.get('isTechEvent'),
    },
  });
}
