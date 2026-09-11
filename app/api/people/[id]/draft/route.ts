import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Person from '@/lib/models/Person';
import Interaction from '@/lib/models/Interaction';
import Contact from '@/lib/models/Contact';
import Folder from '@/lib/models/Folder';
// Registers the `Event` model this process needs for the title join. A model that has never been
// imported is not registered, which surfaces as `MissingSchemaError` far from the cause — the same
// note the sibling `[id]/route.ts` carries, for the same reason.
import Event from '@/lib/models/Event';
import { requireUser } from '@/lib/api-auth';
import { rateLimit } from '@/lib/security/rate-limit';
import { isObjectIdLike } from '@/lib/person-types';
import {
  MAX_NOTES,
  generateFollowupDraft,
  materialProblem,
  selectDraftFields,
  type DraftMaterial,
  type MaterialProblem,
} from '@/lib/llm/draft-followup';

/**
 * GET  /api/people/[id]/draft — what a draft WOULD be written from. No model call, no cost.
 * POST /api/people/[id]/draft — draft a follow-up message from the note you took.
 *
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * WHY THERE IS A GET AT ALL, WHEN THE FEATURE IS THE POST.
 *
 * The UI has to say what is about to be sent to a model BEFORE sending it — somebody who wrote
 * "seemed unhappy at his job" deserves to know that before it leaves the machine, and a disclosure
 * shown afterwards is not a disclosure. That means the sheet needs the exact note the POST will use.
 *
 * The client COULD compute it: it already holds the timeline and the captures. It would be roughly
 * eight lines, and it would be a second definition of "which note" — so the screen promising what
 * will be sent and the handler deciding it could drift, and the disclosure would be accurate by
 * coincidence rather than by construction. That is the failure mode `/events/[id]`'s `WorthGoing`
 * panel already demonstrated in this repo by copying the funnel regex and falling behind it.
 *
 * So `collectMaterial()` is called by both handlers and the GET simply returns it. The disclosure is
 * then provably what the POST will send, and the cost is one cheap indexed read when a sheet opens.
 *
 * ── THE POST IS A POST, and that is not a REST quibble ───────────────────────────────────────────
 *
 *   · It spends money on every call. A GET is fair game for a browser prefetch, a link-preview
 *     crawler and a service-worker warm-up, none of which asked for a draft. (This route's own GET
 *     is safe for exactly that reason: it calls no model.)
 *   · Two presses SHOULD give two different drafts. That is the "try again" affordance, and it is the
 *     opposite of what an idempotent GET promises.
 *
 * NEITHER HANDLER TAKES A REQUEST BODY, WHICH IS THE STRONGEST FORM OF "GUARD FIRST, VALIDATE
 * SECOND". The rule exists because a validator placed at the top of a handler runs above the guard,
 * and an anonymous caller then gets 400 instead of 401 — free information that their payload parsed
 * far enough to be judged. Here there is no payload to parse: everything a draft needs is already in
 * the database, addressed by an id in the path. The body is never read, so it cannot be validated
 * early by accident.
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `params` is a Promise in this Next version and must be awaited. The inline type is used rather than
 * the generated `RouteContext<'/api/people/[id]/draft'>` helper, because that helper indexes a union
 * in `.next/types/routes.d.ts` listing only routes present at the last build — so a brand-new route
 * does not typecheck until typegen re-runs.
 */

/**
 * PER-USER, NOT PER-IP, AND KEYED ON THE ID THE GUARD RETURNED.
 *
 * `clientKey()` exists for the unauthenticated endpoints and derives an identity from headers, which
 * is only as trustworthy as the hop that set them. This route is behind `requireUser()`, so there is
 * a better key available: the session's user id. It cannot be spoofed without a session, and it
 * charges the burst to the account that would be billed for it. Note the ordering this forces — the
 * guard MUST run first because the key does not exist until it has, which is a pleasant case of the
 * correct order being the only expressible one.
 *
 * WHAT THIS HONESTLY GUARANTEES: nothing, on its own. `lib/security/rate-limit.ts` says so in its own
 * header — the bucket lives in module memory, and `vercel.json` confirms this deployment is
 * serverless, so a caller spread across cold instances gets a multiple of the limit. It is a nuisance
 * filter that makes the ACCIDENTAL case harmless: a stuck retry loop, a double-tapped button, a page
 * left open re-firing. That is acceptable here ONLY because the route is authenticated — the cost
 * lands on an identified account rather than on a stranger's burst — and because ICA applies its own
 * quota underneath, which the provider path handles as a throttle rather than as a failure. If
 * drafting ever needs a real spend ceiling, that belongs in a Mongo-backed counter, not a bigger
 * number here.
 *
 * Only the POST is limited. The GET costs one indexed read and no model tokens, which is less than
 * the `GET /api/people/[id]` beside it — limiting it would add a failure mode for no saving.
 *
 * 8 per minute: a user working through the people they met at one event drafts a handful in a row and
 * must not hit a wall, while a loop is stopped inside a second.
 */
const LIMIT = { limit: 8, windowMs: 60_000 };

/** Notes are read wider than the model will use, so the newest N are genuinely the newest. */
const NOTE_SCAN_LIMIT = 40;

/** A no-store JSON response. Every branch here returns private data or names a private row. */
function json(body: unknown, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

type Resolved =
  | { kind: 'not-found' }
  | { kind: 'merged'; mergedInto: string }
  | { kind: 'ok'; material: DraftMaterial; problem: MaterialProblem | null };

/**
 * Everything a draft is written from, for one person, scoped to one viewer.
 *
 * `userId` IS FIRST AND REQUIRED, matching `getNewEventsSince(viewerId, since)`. Every read below
 * carries it, and an optional scope fails open — here that would mean one user's private notes about
 * a named person being read on somebody else's behalf.
 */
async function collectMaterial(userId: string, id: string): Promise<Resolved> {
  /**
   * OWNERSHIP IS A QUERY FILTER, and the refusal is 404 rather than 403 — a 403 confirms the row
   * exists, and a Mongo ObjectId is a timestamp plus a counter, so neighbouring ids are enumerable.
   * This is a read of somebody's private notes with an outbound network call attached, so
   * id-guessing here would be worse than on a plain GET.
   */
  const person = await Person.findOne({ _id: id, userId })
    .select('displayName company role headline mergedInto')
    .lean();
  if (!person) return { kind: 'not-found' };

  // A tombstone's notes moved to the survivor, so drafting from the loser would write from an empty
  // record. The client is told where the human went, as the PATCH handler does.
  if (person.mergedInto) return { kind: 'merged', mergedInto: String(person.mergedInto) };

  /**
   * WHERE THE NOTE ACTUALLY LIVES — AND IT IS NOT ONLY THE TIMELINE.
   *
   * The brief for this work said the material is `Person` plus its `Interaction` timeline. That is
   * incomplete in the case that matters most. A note typed into the CAPTURE SHEET at the event lands
   * on `Contact.note`, and `attachPersonSpine()` writes its `met` interaction with NO note at all —
   * verified in `lib/contacts/service.ts`, where that `recordInteraction` call passes `personId` /
   * `kind` / `at` / `eventId` / `contactId` and nothing else. `Interaction.note` is only ever
   * populated by the person page's "Add a note".
   *
   * So drafting from the timeline alone would find nothing for the ordinary path — scan somebody,
   * type what you talked about, open their page the next morning — which is precisely the flow this
   * feature exists for. `PersonDetailClient` already renders both stores side by side, and its
   * comment records why the old field cannot simply be dropped.
   *
   * Both are read, merged, and sorted newest-first by their own timestamp, so "the note you took"
   * means the most recent thing written, whichever store it is in.
   */
  const [noteRows, contactRows] = await Promise.all([
    Interaction.find({ userId, personId: person._id, kind: 'note' })
      .select('note at')
      .sort({ at: -1 })
      .limit(NOTE_SCAN_LIMIT)
      .lean(),
    Contact.find({ userId, personId: person._id })
      .select('note scannedAt folderId company role headline')
      .sort({ scannedAt: -1 })
      .limit(NOTE_SCAN_LIMIT)
      .lean(),
  ]);

  const dated: Array<{ note: string; at: number }> = [];
  for (const row of noteRows) {
    const text = (row.note ?? '').trim();
    if (text) dated.push({ note: text, at: new Date(row.at).getTime() });
  }
  for (const row of contactRows) {
    const text = (row.note ?? '').trim();
    if (text) dated.push({ note: text, at: new Date(row.scannedAt).getTime() });
  }
  dated.sort((a, b) => b.at - a.at);
  const notes = dated.slice(0, MAX_NOTES).map(entry => entry.note);

  /**
   * WHERE YOU MET, WITH A FALLBACK THAT IS THE COMMON CASE RATHER THAN THE EDGE.
   *
   * The obvious source is the most recent `met` interaction's `eventId` joined to `Event.title`.
   * CLAUDE.md records that `Folder.eventId` is null for every folder made by hand, and a `met`
   * inherits its `eventId` from the folder — so for most people that join yields nothing and the
   * prompt would carry no event at all. The folder's own NAME is what the user typed to describe
   * where they were ("api days"), which is exactly the phrase a follow-up wants.
   *
   * A dangling `eventId` is normal too: `pruneStale()` deletes events a week past without touching
   * anything that references them. Both misses fall through, and `eventTitle: null` is a legitimate
   * outcome that the prompt builder omits a line for rather than filling in.
   */
  const met = await Interaction.find({ userId, personId: person._id, kind: 'met' })
    .select('eventId at')
    .sort({ at: -1 })
    .limit(1)
    .lean();
  const metRow = met[0];

  let eventTitle: string | null = null;
  if (metRow?.eventId) {
    const event = await Event.findById(metRow.eventId).select('title').lean();
    eventTitle = (event?.title as string | undefined) ?? null;
  }
  if (!eventTitle) {
    const folderId = contactRows[0]?.folderId;
    if (folderId) {
      const folder = await Folder.findOne({ _id: folderId, userId }).select('name').lean();
      eventTitle = (folder?.name as string | undefined) ?? null;
    }
  }

  // Company and role come from `Person` first — those are the DERIVED values with the user's own
  // override already applied — and from the newest capture only when the person carries none.
  const newest = contactRows[0];

  /**
   * BUILT THROUGH `selectDraftFields`, NOT BY HAND, even though every key here is deliberate. That
   * function is the redaction boundary, and routing the material through it means a field added to
   * this object without being added to `DRAFT_FIELDS` is dropped rather than forwarded. Assembling
   * the shape here and trusting it would move the boundary to this call site, which is exactly where
   * somebody adds `email` because the draft "might need it".
   */
  const material = selectDraftFields({
    personName: person.displayName,
    company: person.company ?? newest?.company ?? null,
    role: person.role ?? newest?.role ?? null,
    headline: person.headline ?? newest?.headline ?? null,
    eventTitle,
    metAt: metRow?.at ? new Date(metRow.at).toISOString() : null,
    notes,
  });

  return { kind: 'ok', material, problem: materialProblem(material) };
}

/** The wording for a person with nothing to draft from. Shared by both handlers. */
function noMaterialBody(problem: MaterialProblem, notes: string[]) {
  return {
    error:
      problem === 'no-name'
        ? 'This record has no name to write to yet.'
        : 'Add a note about what you talked about, then draft. A follow-up with nothing in it is worse than none.',
    code: problem,
    notes,
  };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // GUARD FIRST — before the id is read off the params, so an anonymous request cannot learn whether
  // its id was even well-formed.
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const { id } = await params;
    if (!isObjectIdLike(id)) return json({ error: 'Not found' }, 404);

    const resolved = await collectMaterial(gate.userId, id);
    if (resolved.kind === 'not-found') return json({ error: 'Not found' }, 404);
    if (resolved.kind === 'merged') {
      return json(
        {
          error: 'This person was merged into another. Draft from the surviving record instead.',
          code: 'merged',
          mergedInto: resolved.mergedInto,
        },
        409
      );
    }

    /**
     * 200 EVEN WHEN THERE IS NOTHING TO DRAFT FROM, with `canDraft: false` and the reason.
     *
     * The question the client asked — "what would you send?" — was answered successfully. A 409 here
     * would make the sheet's opening fetch look like a failure and push it into an error branch,
     * when the correct screen is a specific, actionable "add a note first". The POST still answers
     * 409 for the same state, because there the client asked for a draft and did not get one.
     */
    return json(
      {
        canDraft: resolved.problem === null,
        problem: resolved.problem,
        notes: resolved.material.notes,
        personName: resolved.material.personName,
        eventTitle: resolved.material.eventTitle,
        metAt: resolved.material.metAt,
      },
      200
    );
  } catch (error) {
    console.error('Error reading draft material:', error);
    return json({ error: 'Could not read what a draft would use.', code: 'server-error' }, 500);
  }
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  const limit = rateLimit(`draft:${gate.userId}`, LIMIT);
  if (!limit.ok) {
    return json(
      {
        error: 'You are drafting faster than the model can keep up. Try again in a moment.',
        code: 'rate-limited',
      },
      429,
      { 'Retry-After': String(limit.retryAfterSeconds) }
    );
  }

  try {
    await connectDB();
    const { id } = await params;
    if (!isObjectIdLike(id)) return json({ error: 'Not found' }, 404);

    const resolved = await collectMaterial(gate.userId, id);
    if (resolved.kind === 'not-found') return json({ error: 'Not found' }, 404);
    if (resolved.kind === 'merged') {
      return json(
        {
          error: 'This person was merged into another. Draft from the surviving record instead.',
          code: 'merged',
          mergedInto: resolved.mergedInto,
        },
        409
      );
    }

    const { material } = resolved;

    /**
     * REFUSED BEFORE THE NETWORK, not after. `generateFollowupDraft` checks this too — it must, since
     * it is the reusable unit — but answering here means the material never reaches the provider
     * branch at all.
     *
     * 409, NOT 503, AND THE DISTINCTION IS THE PRODUCT. "The service is unavailable" and "you have
     * not written down what you talked about" are different facts with different next steps, and
     * collapsing them would teach the user to wait for a service that is working fine.
     *
     * There is deliberately no draft in this branch. A note-less follow-up can only be "great to meet
     * you at X", which needs no model and tells the recipient nothing — the template
     * `lib/llm/draft-followup.ts` refuses to ship because the user cannot tell it from a real draft.
     */
    if (resolved.problem) {
      return json(noMaterialBody(resolved.problem, material.notes), 409);
    }

    /**
     * `gate.userId` IS PASSED POSITIONALLY AND FIRST, matching `getNewEventsSince(viewerId, since)`.
     * Every read above is already scoped by `{ userId }`; the argument makes the scope part of the
     * generator's signature so a future caller cannot satisfy it without having decided whose data
     * this is.
     */
    const result = await generateFollowupDraft(gate.userId, material);

    if (result.ok) {
      return json(
        {
          draft: result.draft,
          /**
           * ECHOED SO THE CLIENT CANNOT ASSUME OTHERWISE. Generating a draft records nothing —
           * `lib/llm/draft-followup.ts` types this as the literal `false` — and marking a message
           * sent stays a separate, deliberate act through the existing `PATCH /api/people/[id]`
           * with `{ messageSent: true }`, fired when the user actually opens the channel. Nothing in
           * this handler writes to the database at all.
           */
          sent: false,
          /** Provenance: the user's own notes, so the sheet can show what the draft came from. */
          notes: material.notes,
          eventTitle: material.eventTitle,
          metAt: material.metAt,
        },
        200
      );
    }

    // The detail line names a provider body or an env var; it goes to the server log and never to a
    // client. That is the `details: err.message` defect CLAUDE.md records being fixed on the tracker
    // routes — a 5xx body must not hand back the internals that produced it.
    console.error('[draft] failed for person', id, '—', result.detail);

    if (result.failure === 'no-material') {
      return json(noMaterialBody(result.problem ?? 'no-note', material.notes), 409);
    }

    if (result.failure === 'bad-response') {
      // The model answered; the answer was not a message. Retryable, and honestly labelled as the
      // model's fault rather than as an outage.
      return json(
        {
          error: 'The model returned something that was not a usable message. Try again.',
          code: 'bad-draft',
          notes: material.notes,
        },
        502
      );
    }

    /**
     * `unavailable` — no credential, a rejected one, a timeout, or a throttle that outlasted its
     * retries. `notes` rides along so the sheet can offer what the user wrote, verbatim, to copy.
     * That is the honest degradation: there is no keyword floor for prose, so the fallback is the
     * user's own words rather than a template pretending to be a draft.
     */
    return json(
      {
        error:
          'Drafting is unavailable right now — the writing model is not responding. Your note is below; nothing was lost.',
        code: 'drafting-unavailable',
        notes: material.notes,
      },
      503
    );
  } catch (error) {
    // No `details`. The only thing it ever carried was the message this omission exists to stop
    // leaking, and the real wording is in the server log above.
    console.error('Error drafting follow-up:', error);
    return json({ error: 'Could not draft a follow-up.', code: 'server-error' }, 500);
  }
}
