import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import { requireUser } from '@/lib/api-auth';
import PushSubscription from '@/lib/models/PushSubscription';
import { validatePushSubscriptionInput } from '@/lib/notifications/reminder-policy';

/**
 * The signed-in user's push subscriptions — the consent record for web push.
 *
 * GET     how many devices this account has, so Settings can say "on, 2 devices" truthfully
 * POST    subscribe (idempotent upsert on `endpoint`)
 * DELETE  unsubscribe one endpoint, or all of this account's devices
 *
 * ── GUARD FIRST, VALIDATE SECOND. ────────────────────────────────────────────────────────────
 * `requireUser()` returns before `request.json()` is called on both mutating methods. Backwards, an
 * anonymous caller sending a malformed body would get 400 instead of 401 — which tells a stranger
 * their payload parsed and validated far enough to be judged, and breaks the contract
 * `scripts/diag-api-auth.ts` asserts for every mutating route. This ordering is easiest to get wrong
 * in exactly the situation this route is in: the validator is the newest thing in the file, and the
 * natural place to put validation is the top of the handler, which is above the guard.
 *
 * ── A REPLAYED SUBSCRIBE IS 200, NEVER 409. ──────────────────────────────────────────────────
 * The app re-POSTs its existing subscription on every load as a self-heal (browsers rotate keys on
 * their own and fire `pushsubscriptionchange` unreliably, and Safari not at all). If that answered
 * 409 the client would need to distinguish "already yours" from "somebody else's", which is a
 * decision the server can make correctly and the client cannot. Same reasoning as `clientId`
 * idempotency on `POST /api/contacts`.
 *
 * ── THE UPSERT IS KEYED ON `endpoint` ALONE, AND REASSIGNS THE OWNER. ────────────────────────
 * Not a bug: a push endpoint belongs to a browser profile, not a person, so two Google accounts on
 * one device legitimately hand it back and forth. Keyed per-user instead, the previous account's row
 * would stay live and their private saved-event titles would keep landing on this device's lock
 * screen. See the header of `lib/models/PushSubscription.ts`.
 *
 * ── 404, NEVER 403, ON A ROW THAT IS NOT THE CALLER'S. ───────────────────────────────────────
 * DELETE is scoped by `userId` in the FILTER, so an endpoint belonging to somebody else simply
 * matches nothing and answers 404. A 403 would confirm the endpoint exists and is subscribed, which
 * is a fact about another account.
 *
 * No `details: err.message` on any 500 branch — that string names the model and the schema path.
 */

/** Refuse in the shape the preferences route uses, so a client can render either one. */
function invalid(issues: { field: string; message: string }[]) {
  return NextResponse.json({ error: 'Invalid subscription', issues }, { status: 400 });
}

export async function GET() {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const rows = await PushSubscription.find({ userId: gate.userId })
      .select('endpoint userAgent lastSeenAt failureCount createdAt')
      .sort({ createdAt: -1 })
      .lean();

    return NextResponse.json(
      {
        // The count is what Settings renders. The endpoints themselves are the caller's own, so
        // returning them is not disclosure — but only the TAIL is sent: the full URL is a live
        // credential-shaped capability (anybody holding it can push to the device, subject only to
        // VAPID), and the UI needs an identifier, not the thing itself.
        devices: rows.map(row => ({
          id: String(row._id),
          endpointTail: String(row.endpoint).slice(-12),
          userAgent: row.userAgent ?? null,
          lastSeenAt: row.lastSeenAt ?? null,
          failureCount: row.failureCount ?? 0,
          createdAt: row.createdAt ?? null,
        })),
        count: rows.length,
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Error reading push subscriptions:', error);
    return NextResponse.json({ error: 'Failed to read your notification devices' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  // Read and shape-check BEFORE touching the database — a malformed request needs no connection to
  // refuse, and `request.json()` throwing on a non-JSON body is handled here rather than becoming a
  // 500 one layer down.
  const body = await request.json().catch(() => null);
  if (body === null) return invalid([{ field: 'body', message: 'Expected a JSON object.' }]);

  const { subscription, issues } = validatePushSubscriptionInput({
    ...(body as Record<string, unknown>),
    // The client does not have to send this and cannot be trusted about it either way; the request's
    // own header is the better source and costs nothing.
    userAgent:
      (body as Record<string, unknown>).userAgent ?? request.headers.get('user-agent') ?? undefined,
  });
  if (!subscription) return invalid(issues);

  try {
    await connectDB();

    /*
     * `$set` the owner and the keys, `$setOnInsert` nothing that must survive a handover. Note
     * `failureCount: 0` is SET rather than set-on-insert: a device coming back after failures is
     * demonstrably alive again, and leaving a stale count would misreport it to an operator forever.
     */
    const row = await PushSubscription.findOneAndUpdate(
      { endpoint: subscription.endpoint },
      {
        $set: {
          userId: gate.userId,
          p256dh: subscription.p256dh,
          auth: subscription.auth,
          userAgent: subscription.userAgent,
          lastSeenAt: new Date(),
          failureCount: 0,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const count = await PushSubscription.countDocuments({ userId: gate.userId });
    return NextResponse.json(
      { ok: true, id: String(row._id), count },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Error saving push subscription:', error);
    return NextResponse.json({ error: 'Failed to turn on notifications' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  /*
   * The endpoint comes from the QUERY STRING, not a body. `fetch(..., { method: 'DELETE' })` with a
   * body is legal but is dropped by some intermediaries, and the browser already has the endpoint
   * from `getSubscription()`. `all=true` covers the case the UI actually needs when a user says "off
   * everywhere" — and, more importantly, when `getSubscription()` returns null because the browser
   * already dropped the subscription locally, leaving a row nothing else can name.
   */
  const endpoint = request.nextUrl.searchParams.get('endpoint');
  const all = request.nextUrl.searchParams.get('all') === 'true';
  if (!endpoint && !all) {
    return invalid([{ field: 'endpoint', message: 'Pass ?endpoint=… or ?all=true.' }]);
  }

  try {
    await connectDB();

    // SCOPED BY `userId` IN THE FILTER, always. That is what makes the 404 below honest rather than a
    // check somebody could forget: an endpoint belonging to another account cannot match.
    const filter = all
      ? { userId: gate.userId }
      : { userId: gate.userId, endpoint };
    const result = await PushSubscription.deleteMany(filter);

    if ((result.deletedCount ?? 0) === 0) {
      // 404 rather than 403 or a cheerful 200. Not found is the truth for "not yours" and for
      // "already gone", and those two must be indistinguishable from outside.
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const count = await PushSubscription.countDocuments({ userId: gate.userId });
    return NextResponse.json(
      { ok: true, deleted: result.deletedCount ?? 0, count },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Error deleting push subscription:', error);
    return NextResponse.json({ error: 'Failed to turn off notifications' }, { status: 500 });
  }
}
