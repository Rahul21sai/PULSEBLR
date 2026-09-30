/**
 * THE PUSH SERVICES THIS APP WILL SEND TO — pure, so the subscribe-time validator
 * (`lib/notifications/reminder-policy.ts`, which a client component imports) can use the same
 * list the sender enforces. `push-transport.ts` imports node:dns, node:https and web-push, so it
 * must never be imported from anything that can reach the browser bundle; it re-exports these.
 */

/* ── Who may be contacted ─────────────────────────────────────────────────────────────────── */

/**
 * The push services browsers actually hand out, matched EXACTLY.
 *
 * ── THE ALLOWLIST, AND WHAT IT COSTS. ────────────────────────────────────────────────────────
 * Source: pushpad/known-push-services, file `whitelist`, fetched 2026-09-30 (last changed 2026-06-01,
 * when it added `jmt17.google.com`, a Chrome staging host). It is maintained by a push provider from
 * roughly 200 million live subscriptions, which is the evidence this list rests on. Apple's own
 * guidance supplies the second wildcard below: "allow access for https://*.push.apple.com"
 * (developer.apple.com, "Sending web push notifications in web apps and browsers").
 *
 * That covers every browser this app can meet: Chrome (and so the Android TWA), Opera, Samsung
 * Internet, Brave and the other Chromium browsers through FCM; Edge on Windows through WNS
 * (`wns2-….notify.windows.com`); Firefox through autopush; Safari and home-screen iOS apps through
 * `web.push.apple.com`. `android.googleapis.com` is legacy GCM, shut down in 2019. It stays because
 * it is on the measured list and is Google's own host: if Google answers a pre-FCM row with 404 or
 * 410 the row is pruned, where a refusal here would retry it every morning.
 *
 * What it refuses that a real person could have: a Firefox pointed at a self-hosted autopush
 * (`dom.push.serverURL`), a fork that routes web push through UnifiedPush to the user's own ntfy
 * server, and any vendor that ships a push service after this list was read. Such an endpoint
 * is refused at subscribe time by `validatePushSubscriptionInput` (a 400 naming the host), and,
 * for a row stored before that check existed, per device at send time as `endpoint failed the
 * SSRF check: "<host>" is not a known push service`. Extending the list is one line.
 *
 * The alternative, any public host, was weighed and rejected. With the other limits in place a
 * hostile server can no longer hurt the runner, but it would still choose where the runner sends
 * traffic: one account, once per registered endpoint per notification, at any server on the
 * internet. `POST /api/me/push` has no per-account device cap, and the reminder run fans out to every
 * row an account has.
 */
export const PUSH_SERVICE_HOSTS: readonly string[] = Object.freeze([
  'fcm.googleapis.com',
  'jmt17.google.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'updates-autopush.stage.mozaws.net',
  'updates-autopush.dev.mozaws.net',
]);

/**
 * `*.notify.windows.com` and `*.push.apple.com`. The wildcard matches exactly ONE label, the way a
 * certificate wildcard does, so `a.b.notify.windows.com` is refused. Every real host in the sources
 * above is one label deep, and a deeper name in a vendor zone is where a dangling-CNAME takeover
 * would live.
 */
export const PUSH_SERVICE_WILDCARD_PARENTS: readonly string[] = Object.freeze([
  'notify.windows.com',
  'push.apple.com',
]);

/** One DNS label as a public hostname spells it. No underscore, no leading or trailing hyphen. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Is `hostname` a known push service? Exact names, plus a single label under a wildcard parent.
 *
 * No suffix matching anywhere else: `fcm.googleapis.com.attacker.example` and
 * `evilnotify.windows.com` are both refused, and so is a trailing-dot `fcm.googleapis.com.`, which
 * no browser produces.
 */
export function isKnownPushServiceHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (PUSH_SERVICE_HOSTS.includes(host)) return true;
  return PUSH_SERVICE_WILDCARD_PARENTS.some(parent => {
    const suffix = `.${parent}`;
    return host.endsWith(suffix) && DNS_LABEL.test(host.slice(0, -suffix.length));
  });
}

/**
 * The production endpoint policy: why this URL may not be contacted, or `null` if it may.
 *
 * The port is refused before the host so the message names the right problem. No push service uses
 * one, and an allowlisted name on another port is not that service.
 */
export function pushEndpointRefusal(url: URL): string | null {
  if (url.port !== '') return `port ${url.port} is not the https default`;
  if (!isKnownPushServiceHost(url.hostname)) return `"${url.hostname}" is not a known push service`;
  return null;
}
