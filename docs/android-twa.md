# Shipping PulseBLR to Google Play as a Trusted Web Activity

The web side is done and verified. This is the Android half, which needs a Play Console account
and a deployed domain, so it cannot be run from a checkout alone.

## Why a TWA and not Capacitor

A TWA renders in the user's **real Chrome**, not an embedded `WebView`. That is the load-bearing
difference: Google blocks OAuth in embedded webviews (`disallowed_useragent`), so a Capacitor shell
would break Google sign-in, and `lib/api-auth.ts` takes no argument through which a bearer
credential could arrive — native auth would be an architectural change, not a config flag. A TWA
needs none of it.

iOS is deliberately **not** in scope: building an `.ipa` needs macOS or a paid cloud builder, and
Apple guideline 4.2 rejects apps that are "a repackaged website". iPhone users get the installable
PWA instead — `InstallPrompt` walks them through Share → Add to Home Screen.

## The calendar reality, before you start

A **new personal Play account** (created after 13 Nov 2023) cannot publish to production until it
has run a closed test with **12 testers opted in continuously for 14 days**, then applied and waited
up to 7 more days of review. Opting out resets that tester's clock.

**Internal testing has no prerequisites.** So the achievable sequence is:

1. Internal testing → a real Play install link, same day.
2. Start the 12-tester closed test on day one, so production unlocks in the background.
3. Apply for production around day 15.

Do the account creation **first**. Identity verification can take days and everything is downstream
of it.

## Prerequisites

Bubblewrap needs Node ≥14, **JDK exactly 17** (below will not compile, above is incompatible with
the Android command-line tools), and the Android SDK command-line tools — whose path must contain
**no spaces**.

This machine has **Java 11 and no `ANDROID_HOME`**, so expect Bubblewrap's first run to download its
own JDK and SDK (several hundred MB), plus ~1 GB on the first Gradle build.

If that setup fights back on Windows, use the official image instead and skip the whole toolchain
problem:

```
docker run --rm -ti ghcr.io/googlechromelabs/bubblewrap:latest <command>
```

## Decisions already made

| Setting | Value | Why |
| --- | --- | --- |
| `packageId` | `app.pulseblr.twa` | **Immutable after the first Play upload.** Change it now or never. |
| `host` | the `NEXTAUTH_URL` host | Must be the exact host that serves `assetlinks.json` with no redirect. `lib/canonical-origin.ts` already treats `NEXTAUTH_URL` as the source of truth for anything shareable. |
| `startUrl` | `/` | Matches the manifest's `start_url`. |
| `webManifestUrl` | `https://<host>/manifest.json` | Required for the share target to survive into the app. |
| `iconUrl` | `https://<host>/icon-512.png` | Bubblewrap generates every launcher density from this; no mipmaps by hand. |
| `maskableIconUrl` | `https://<host>/icon-maskable-512.png` | |
| `themeColor` | `#FAF9F5` | Must match the web manifest or the Play app and the Chrome-installed PWA show different status bars on the same device. |
| `backgroundColor` | `#FAF9F5` | The splash ground. Matches `--paper`. |
| `display` | `standalone` | |
| `orientation` | `portrait` | Mirrors `orientation: portrait-primary`. |
| `enableNotifications` | `true` | **Set it now even though push ships later.** It adds `POST_NOTIFICATIONS` and the delegation service; retrofitting means a second Play release. |
| `appVersionCode` | `1`, then monotonic | Play rejects a reused value. |

`themeColorDark` / `navigationColorDark` have no manifest counterpart — use `--ink` `#121417`
rather than pure black.

Run `bubblewrap update` after `init` to pull the current TWA template and target SDK. Play's
target-API floor moves annually and a stale template is rejected at upload.

## The assetlinks round trip, which catches everyone

`public/.well-known/assetlinks.json` does not exist yet, and cannot until the first upload. The
reason is the trap:

**Bubblewrap generates an *upload* key, but Play App Signing re-signs with a *different* key.**
Verification uses the signing key of the installed APK, so a file carrying only the upload
fingerprint verifies for a locally-installed APK and **fails for the Play-installed one**.
`sha256_cert_fingerprints` is an array — put **both** in.

So the order is: build → upload to internal testing → read the Play signing SHA-256 from
**Play Console → Setup → App integrity** → write the file with both fingerprints → deploy → verify.

```bash
curl -i https://<host>/.well-known/assetlinks.json
```

Must be **200**, `application/json`, and **no redirect**. Digital Asset Links does not reliably
follow redirects, and a Vercel project has both `<project>.vercel.app` and any custom domain.

`scripts/diag-pwa.ts` checks this once the file exists, including that at least two fingerprints are
present. Until then it prints `pend` rather than a pass or a fail.

**The only symptom of getting any of this wrong is a browser URL bar inside the app** —
indistinguishable between a 404, a wrong fingerprint, a redirect and a `packageId` mismatch. Debug
with the real signal:

```bash
adb logcat -v brief | grep -e TWAProviderPicker
```

## The keystore

`.gitignore` already covers `*.keystore` and `*.jks`, and excludes the generated `/android/*` while
keeping `twa-manifest.json`.

**Back the keystore up somewhere outside this repo before the first build.** Committing one lets
anyone ship an update as you; losing one means you can never update the app again, because Play
matches uploads on the signing key. There is no recovery path for the second.

## Assets ready to upload

| Asset | Path | Notes |
| --- | --- | --- |
| Listing icon | `store-assets/icon-512.png` | 512×512, 32-bit **with** alpha, as Play's spec asks. |
| Feature graphic | `store-assets/feature-graphic.png` | Exactly 1024×500, 24-bit, **no** alpha. Play rejects any other size. |
| Screenshots | `public/screenshots/*.png` | Five phone at 1080×1920, one desktop at 1920×1080. Already 24-bit with no alpha, so Play takes them directly. |

Regenerate with `npm run icons` and, with a server running,
`PB_BASE=http://localhost:3200 npx tsx scripts/generate-screenshots.ts`.

## Minimum functionality, the one policy risk

Play may reject an app "whose primary purpose is to display an existing website", and a TWA is
structurally that shape. What argues against it, and is worth writing into the production
application's own words:

- **Verified Digital Asset Links**, so there is no browser chrome. An unverified TWA showing a URL
  bar reads as a webview wrapper and is a known rejection cause.
- **Share target** — the app is a share destination for event links (`/add-event`).
- **Five launcher shortcuts** — scan, card, feed, tracker, calendar.
- **Offline capture** — the QR scanner writes to IndexedDB first and drains an outbox, so it works
  on a dead conference network.
- Web push, once Stage 1 lands.

Offline **cold-boot** is not done and is not required by the TWA runtime; it is deferred because
Next 16 appends a deployment-scoped `?dpl=` to static assets and a careless cache-first rule would
serve stale chunks against new HTML — the v1 failure class recorded in `public/sw.js`'s own
changelog.

## Verifying on a real device

A green pipeline does not substitute for these:

- The app opens with **no URL bar**. This is the assetlinks check, and it is the one thing that
  silently half-works.
- **Google sign-in completes inside the app.** A TWA renders in the real browser rather than a
  WebView, but Chrome's docs do not confirm that an existing browser session carries over — so
  verify it end to end rather than assuming.
- The launcher icon shows the pulse mark, and the splash is warm `#FAF9F5` rather than white.
