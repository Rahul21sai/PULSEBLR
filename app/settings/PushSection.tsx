'use client';

import { useCallback, useEffect, useState } from 'react';
import { Banner, Button } from '../components/ui';

/**
 * Turn on notifications that arrive when the app is closed.
 *
 * The service worker has had a `push` listener since it was written and NOTHING HAS EVER SUBSCRIBED —
 * zero references to `pushManager` anywhere in the app. This is the missing half.
 *
 * ── `Notification.requestPermission()` IS CALLED INSIDE A CLICK HANDLER, AND ONLY THERE. ──────
 *
 * This is the single most important line in the file. Chrome requires a user gesture and silently
 * auto-DENIES a call made on mount — no dialog, no error, `permission` just becomes `'denied'`.
 * Safari is worse: a prompt without a gesture can block the ORIGIN permanently, and there is no way
 * to ask again from code. So there is deliberately no "ask on first visit" effect here, and the
 * self-heal below is careful never to call it.
 *
 * ── THE SELF-HEAL, AND WHY IT REPLACES HANDLING `pushsubscriptionchange`. ────────────────────
 *
 * Browsers rotate subscription keys on their own and are supposed to fire `pushsubscriptionchange` in
 * the service worker when they do. Chrome fires it inconsistently, and Safari does not implement it
 * at all — so a handler for it is code that cannot be relied on and cannot be tested. Instead: on
 * mount, if permission is already `granted` and `getSubscription()` returns something, POST it. The
 * endpoint is an idempotent upsert keyed on the endpoint, so this costs one request and repairs a
 * rotated subscription on the next visit. It asks for nothing and cannot prompt.
 *
 * ── iOS NEEDS THE APP INSTALLED, AND SAYING SO IS THE WHOLE FEATURE THERE. ───────────────────
 *
 * Web push works on iOS 16.4+ and ONLY when the site has been added to the home screen. In Safari as
 * a tab, `window.PushManager` does not exist — so the plain feature detection below would report "your
 * browser does not support notifications", which is false and unactionable. Detected separately and
 * answered with the one instruction that works. `InstallPrompt.tsx` already does the install coaching,
 * so this does not repeat it, contradict it, or try to trigger it.
 *
 * ── IT MUST RENDER, DISABLED AND EXPLAINED, WHEN THERE IS NO VAPID KEY. ─────────────────────
 *
 * `NEXT_PUBLIC_VAPID_PUBLIC_KEY` is INLINED AT BUILD TIME, so a CI build with no key inlines
 * `undefined` — and `urlBase64ToUint8Array(undefined)` would throw during render and take the whole
 * Settings page down. The key is read once, guarded, and its absence is a state of this component
 * rather than an exception.
 */

/** Inlined at build time. `undefined` in any build that had no key set — see the header. */
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;

/**
 * base64url → `Uint8Array`, which is the only form `pushManager.subscribe()` accepts for
 * `applicationServerKey`.
 *
 * Padding is re-added and the URL-safe alphabet translated back, because `atob` handles neither: an
 * unpadded base64url string throws `InvalidCharacterError`, and a VAPID public key is 65 bytes, which
 * is not a multiple of 3, so it is ALWAYS unpadded. Skipping this step is the classic way this call
 * fails, and it fails at subscribe time rather than at load.
 */
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalised = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(normalised);
  /*
   * BACKED BY AN EXPLICIT `ArrayBuffer`, and the return type is narrowed to match. `new
   * Uint8Array(length)` infers `Uint8Array<ArrayBufferLike>` under this TypeScript's lib, and
   * `ArrayBufferLike` includes `SharedArrayBuffer`, which is not a `BufferSource` — so passing the
   * obvious version to `applicationServerKey` is a type error rather than a runtime one. Allocating
   * the buffer first is the fix; casting would have been the other way to silence it, and a cast at
   * the boundary where a key crosses into a browser API is the wrong thing to make quiet.
   */
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/**
 * Is this an iPhone or iPad?
 *
 * iPadOS 13+ reports itself as a Mac, so `MacIntel` with more than one touch point is the standard
 * way to tell an iPad from a desktop — the same detection `InstallPrompt.tsx` uses, and without it
 * every iPad falls through to the wrong message.
 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

/** Installed to the home screen, or running as a PWA/TWA. Two APIs because iOS only has the second. */
function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

type Support =
  | 'checking'
  | 'ok'
  /** iOS, but in a browser tab — push is unreachable until the app is on the home screen. */
  | 'ios-needs-install'
  /** The browser genuinely has no Push API. */
  | 'unsupported'
  /** The build had no VAPID key, so nothing can be subscribed to. */
  | 'not-configured';

export default function PushSection() {
  const [support, setSupport] = useState<Support>('checking');
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'warn'; text: string } | null>(null);

  /** POST whatever subscription this browser currently holds. Idempotent; never prompts. */
  const syncSubscription = useCallback(async (subscription: PushSubscription) => {
    const res = await fetch('/api/me/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription.toJSON()),
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { count?: number };
    setDeviceCount(typeof data.count === 'number' ? data.count : null);
    setSubscribedHere(true);
  }, []);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      // Feature detection FIRST, and all three checks matter: `Notification` can be missing in an
      // embedded webview that still has a service worker, and `PushManager` is absent on iOS Safari
      // tabs even though the other two are present.
      const hasApi =
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        typeof window !== 'undefined' &&
        'PushManager' in window &&
        'Notification' in window;

      if (!hasApi) {
        // The iOS branch comes before the generic one deliberately: on an iPhone in Safari the
        // honest answer is "install it first", not "your browser cannot do this".
        if (!cancelled) setSupport(isIOS() && !isStandalone() ? 'ios-needs-install' : 'unsupported');
        return;
      }
      if (!VAPID_PUBLIC_KEY) {
        if (!cancelled) setSupport('not-configured');
        return;
      }
      if (!cancelled) {
        setSupport('ok');
        setPermission(Notification.permission);
      }

      /*
       * THE SELF-HEAL. Only when permission is ALREADY granted — reading `Notification.permission` is
       * free and prompts nothing, whereas `requestPermission()` here would be the auto-denied
       * on-mount call this component exists to avoid.
       */
      if (Notification.permission !== 'granted') return;
      try {
        const registration = await navigator.serviceWorker.ready;
        const existing = await registration.pushManager.getSubscription();
        if (cancelled) return;
        if (existing) await syncSubscription(existing);
        else {
          // Permission granted but no subscription: the browser dropped it (a cleared site data, a
          // rotation it did not re-create). Not an error, and not something to fix silently — the
          // button below is the fix, and it is now labelled "Turn on".
          const res = await fetch('/api/me/push');
          if (res.ok && !cancelled) {
            const data = (await res.json()) as { count?: number };
            setDeviceCount(typeof data.count === 'number' ? data.count : null);
          }
        }
      } catch {
        // A failed self-heal must be invisible: nothing the user asked for has failed, and the state
        // it would report is one they cannot act on.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [syncSubscription]);

  async function enable() {
    if (!VAPID_PUBLIC_KEY) return;
    setBusy(true);
    setStatus(null);
    try {
      /*
       * INSIDE THE CLICK HANDLER. See the header — this is the line that must never move into an
       * effect. Chrome auto-denies a gesture-less call and Safari can block the origin for good.
       */
      const result = await Notification.requestPermission();
      setPermission(result);

      if (result === 'denied') {
        setStatus({
          tone: 'warn',
          // Naming the browser's own UI matters: once denied, nothing this app does can ask again.
          text:
            'Your browser is blocking notifications for this site. Nothing here can ask again — ' +
            'you would need to allow them from the padlock or ⓘ icon beside the address bar.',
        });
        return;
      }
      if (result !== 'granted') {
        setStatus({ tone: 'warn', text: 'Notifications stay off until you allow them.' });
        return;
      }

      const registration = await navigator.serviceWorker.ready;
      const subscription =
        (await registration.pushManager.getSubscription()) ??
        (await registration.pushManager.subscribe({
          // REQUIRED, and not merely a formality: Chrome refuses to subscribe without it, because it
          // is the promise that every push will show something the user can see. Every push this app
          // sends does — a reminder about an event they saved.
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
        }));

      await syncSubscription(subscription);
      setStatus({ tone: 'ok', text: 'Notifications are on for this device.' });
    } catch (error) {
      setStatus({
        tone: 'error',
        text: 'Could not turn notifications on. Nothing was changed — try again.',
      });
      console.error('Push subscribe failed:', error);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setStatus(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      /*
       * THE BROWSER SIDE IS UNSUBSCRIBED FIRST, THE SERVER SECOND. If the order were reversed and the
       * second step failed, the browser would still hold a live subscription the server no longer
       * knows about — which is unrecoverable from the UI, because `getSubscription()` returning
       * something is what the self-heal keys on, and it would keep re-POSTing a row the user just
       * deleted.
       *
       * `?all=true` when there is no local subscription, because then there is no endpoint to name and
       * a row would otherwise be stranded — which is exactly the state a cleared site-data leaves.
       */
      const endpoint = subscription?.endpoint;
      if (subscription) await subscription.unsubscribe();

      const query = endpoint ? `?endpoint=${encodeURIComponent(endpoint)}` : '?all=true';
      const res = await fetch(`/api/me/push${query}`, { method: 'DELETE' });
      // A 404 is success from the user's point of view: whatever they were turning off is off.
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));

      setSubscribedHere(false);
      setDeviceCount(endpoint ? Math.max(0, (deviceCount ?? 1) - 1) : 0);
      setStatus({ tone: 'ok', text: 'Notifications are off for this device.' });
    } catch (error) {
      setStatus({ tone: 'error', text: 'Could not turn notifications off. Try again.' });
      console.error('Push unsubscribe failed:', error);
    } finally {
      setBusy(false);
    }
  }

  const otherDevices = Math.max(0, (deviceCount ?? 0) - (subscribedHere ? 1 : 0));

  return (
    <section
      id="notifications"
      className="rounded-[var(--r-flat)] border border-[var(--rule)] p-5"
    >
      <h2 className="text-[16px] font-bold text-[var(--ink)]">Event reminders</h2>
      <p className="mt-0.5 text-[13px] text-[var(--ink-2)]">
        A notification the day before an event you saved, on this device — it arrives whether or not
        PulseBLR is open.
      </p>

      {support === 'checking' && (
        <div className="mt-4 h-3 w-1/3 rounded bg-[var(--paper)]" aria-hidden="true" />
      )}

      {support === 'ios-needs-install' && (
        <Banner tone="warn" className="mt-4">
          On iPhone and iPad, notifications need PulseBLR added to your home screen first — Safari
          cannot deliver them to a browser tab. Once it is installed, open Settings inside the app and
          this will be here. Requires iOS 16.4 or later.
        </Banner>
      )}

      {support === 'unsupported' && (
        <Banner tone="warn" className="mt-4">
          This browser has no support for push notifications, so there is nothing to turn on here.
          Everything else about your saved events still works.
        </Banner>
      )}

      {support === 'not-configured' && (
        <Banner tone="warn" className="mt-4">
          Notifications are not set up on this deployment yet, so this cannot be switched on. It needs
          a VAPID key pair in the environment (<code>NEXT_PUBLIC_VAPID_PUBLIC_KEY</code> among them),
          and that value is baked in when the app is built — so it also needs a rebuild after being
          set, not just a restart.
        </Banner>
      )}

      {support === 'ok' && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            {subscribedHere ? (
              <Button tone="quiet" size="md" onClick={() => void disable()} disabled={busy}>
                {busy ? 'Working…' : 'Turn off on this device'}
              </Button>
            ) : (
              <Button
                tone="primary"
                size="md"
                onClick={() => void enable()}
                disabled={busy || permission === 'denied'}
              >
                {busy ? 'Working…' : 'Turn on notifications'}
              </Button>
            )}

            <span className="text-[13px] text-[var(--ink-2)]">
              {subscribedHere
                ? otherDevices > 0
                  ? `On here, and on ${otherDevices} other device${otherDevices === 1 ? '' : 's'}.`
                  : 'On here.'
                : otherDevices > 0
                  ? `Off here. On ${otherDevices} other device${otherDevices === 1 ? '' : 's'}.`
                  : 'Off.'}
            </span>
          </div>

          {permission === 'denied' && !status && (
            <Banner tone="warn" className="mt-3">
              Your browser is blocking notifications for this site, so the button above cannot ask.
              Allow them from the padlock or ⓘ icon beside the address bar, then reload.
            </Banner>
          )}

          {status && (
            <Banner tone={status.tone} className="mt-3">
              {status.text}
            </Banner>
          )}

          <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--ink-3)]">
            Each device is separate, so turning this on here does not turn it on elsewhere. You will
            get at most a few reminders a day, only about events you saved, and never about anything
            else. This is independent of the reminder emails — turning one off leaves the other alone.
          </p>
        </>
      )}
    </section>
  );
}
