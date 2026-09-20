# Shipping PulseBLR to Google Play as a Trusted Web Activity

PulseBLR's Android application is a Trusted Web Activity (TWA), not an embedded WebView. It opens
the permanent PulseBLR origin in the device's real Chrome runtime, preserving Google OAuth and the
same web/PWA source of truth. This runbook describes gates and owner actions; it does **not** claim
that a deployment, Android build, signing run, Play installation, or store submission has happened.

## Current, verified boundaries

- `@bubblewrap/cli` is pinned in this repository at **1.25.0**; use the repository commands below,
  never an unpinned package command.
- Bundletool is **1.18.3** in the GitHub workflows. Its download is SHA-256 checked before an AAB
  verifier can use it.
- Every external action in every checked-in workflow is pinned to a full commit SHA; repository-local
  actions, if introduced later, must use an explicit `./` path.
- JDK 17 is available, but Android SDK 36, platform-tools, and build-tools 36.0.0 are **not ready
  for a release until** `npm run android:toolchain` succeeds in the intended environment.
- `public/.well-known/assetlinks.json` is deliberately absent. Neither an upload certificate nor a
  Play signing certificate fingerprint has been supplied to this repository.
- The permanent identity is `https://pulseblr-u9f1.vercel.app` and package ID is
  `app.pulseblr.twa`. Treat both as immutable after the first Play upload.

## Release contract

The checked-in contract preserves these values: Android SDK/target SDK 36, minimum SDK 21,
`standalone`, `portrait-primary`, app version code/name `1`/`1`, the five shortcuts (Scan, My code,
Feed, Tracker, Calendar), share target `/add-event`, and the warm `#FAF9F5` theme/background. Run it
without an Android SDK or network access:

```powershell
npm run android:contract
```

Normal CI runs this offline contract after unit tests and before the Next.js build. It intentionally
does not install an Android SDK, fetch the production origin, or run Gradle.

## Required release sequence

Follow this order; each arrow is a stop/go gate, not an assertion that its next stage has happened:

1. **Contract** — `npm run android:contract` passes.
2. **Deploy approval** — Rahul approves deployment of the current web/PWA contract to the permanent
   origin.
3. **Preflight** — set `PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA` to the exact 40-character commit SHA
   approved and deployed, then run `npm run android:preflight`. The gate compares that value with
   `/api/release-identity`, requires a page-specific marker in every route body, and compares the
   required deployed PNG bytes with the checked-in assets. Do not generate if it fails.
4. **Generate** — `npm run android:generate` revalidates the configured JDK 17/SDK 36 paths, writes
   those exact roots to a restrictive one-use Bubblewrap config, passes it with `--config`, and
   removes it on exit. It does not enter Bubblewrap's prompt/bootstrap/download path and has no
   signing material in scope.
5. **Verify** — `npm run android:verify-generated` proves the generated project retains the package,
   version, shortcuts, and SDK contract.
6. **Debug build** — `npm run android:bundle:debug`, then the AAB inspection gate, runs only with
   the installed SDK tooling.
7. **Signing approval** — the `android-release` GitHub environment approval unlocks owner-provided
   signing secrets only after secret-free generation and the unsigned release bundle.
8. **Internal Testing** — Rahul approves the separately authenticated Play Console upload and enables
   Play App Signing.
9. **Second fingerprint** — obtain the Play App Signing SHA-256 certificate fingerprint from App
   Integrity; it is distinct from the upload certificate.
10. **DAL redeploy** — publish and diagnose both Digital Asset Links fingerprints on the permanent
    origin.
11. **Play-install QA** — install from Play and complete the real-device checklist before any wider
    testing or production action.

The deployment must expose its build identity through `PULSEBLR_RELEASE_COMMIT_SHA` or Vercel's
`VERCEL_GIT_COMMIT_SHA`; `/api/release-identity` fails closed if neither is an exact commit SHA. For a
post-deployment debug build, dispatch **Android TWA debug gate** with that same SHA as
`expected_release_commit_sha`. It installs exactly platform tools, platform 36, and build-tools
36.0.0; validates the pinned Bundletool SHA-256; and uploads only a debug AAB plus text diagnostics.
It never receives signing material.

For a proposed signed bundle, dispatch **Android protected release build** with a new positive
`version_code` and the same exact `expected_release_commit_sha`. Its first, unprotected
`unsigned-aab` job has no signing secrets or protected
environment: it runs `npm ci`, preflight, generation, generated-project verification, and
`bundleRelease`, computes its SHA-256, and is the only job that uploads the original unsigned AAB and
identity. A fresh secret-free `verify-unsigned-aab` job downloads that immutable artifact, checks the
build-job identity, SHA-256 checks Bundletool, and gates package/version/SDK metadata without uploading
or re-authoring signable bytes. Only after that success does the fresh protected `signed-aab` job
download the same original artifact and identity, re-check them with the fixed system SHA-256 tool,
and reconstruct the keystore in runner temporary storage. Passwords are environment-only; the signing
step validates the SHA-pinned setup-Java output's hosted-toolcache path and invokes its absolute tools
rather than ambient Java state. Trap-based cleanup removes the keystore immediately with an `always()`
backstop. A final fresh secret-free job, also gated by `android-release` so it can independently read
the expected public certificate identity, performs Bundletool metadata, strict signature, and signer
fingerprint validation before it alone publishes the owner-facing AAB and non-secret diagnostics. No
Play upload action is present.

## Digital Asset Links rollout

`assetlinks.json` may be published with the **upload certificate** as soon as Rahul has created the
upload key, before the first Play upload. The owner commands are deliberately explicit (there are no
npm aliases):

```powershell
npx tsx scripts/generate-assetlinks.ts [--write]
npx tsx scripts/diag-assetlinks.ts
```

Supply owner-held fingerprint variables only in the approved shell/session. The normalized upload
fingerprint supplied as `PB_UPLOAD_SHA256` for DAL must be the same public certificate identity stored
as the protected GitHub environment variable `ANDROID_UPLOAD_SHA256`; the workflow checks the selected
keystore alias before signing and independently checks the final AAB signer before publication. With `--write`, the
generator creates `public/.well-known/assetlinks.json`; without it, it prints the candidate JSON.
The diagnostic requires an HTTP 200 JSON response with no redirect and validates the permanent
origin/package relationship.

An app installed directly with the upload key can verify the upload certificate. A Play-installed app
requires **both** the upload certificate and the Play App Signing certificate in the same file. After
Internal Testing, add the second fingerprint, redeploy the DAL file, run the diagnostic, and verify
the Play-installed build has no browser URL bar. Do not invent a fingerprint or create the file until
the owner provides the real values.

## Version and upload-key ownership

Play rejects a reused version code. Start at `1`; every uploaded AAB must use a strictly increasing
integer from `1` through Play's maximum `2100000000`. The protected workflow rejects zero, signs,
decimals, exponent forms, whitespace, leading junk, and values above that bound before checkout or
generation. Its `version_code` changes the generated release bundle only, so the checked-in manifest
remains the initial contract.

The upload keystore is release identity material. Keep its external owner-approved backup and the
relative `./android.keystore` placeholder out of Git. Losing the upload key blocks new updates until
the owner completes the Play App Signing upload-key reset process (where eligible); it is not a
substitute for a backup and does not change the existing app-signing identity. Never put passwords,
keystore bytes/absolute paths, or certificate fingerprints in this runbook or repository.

## Play account timing

For a qualifying new personal Play developer account, production access requires a closed test with
**12 testers opted in continuously for 14 days**. An opt-out resets that tester's clock; the later
production-access review can take additional time. Internal Testing does not replace that requirement.

## Store assets and real-device QA

The checked-in listing assets are ready for a Console owner to inspect, not proof they were uploaded:

| Asset | Repository path | Required shape |
| --- | --- | --- |
| Listing icon | `store-assets/icon-512.png` | 512×512 PNG, 32-bit with alpha |
| Feature graphic | `store-assets/feature-graphic.png` | 1024×500 PNG, 24-bit, no alpha |
| Phone screenshots | `public/screenshots/feed.png`, `feed-rows.png`, `event.png`, `calendar.png`, `topics.png` | 1080×1920 PNG |
| Wide screenshot | `public/screenshots/wide-feed.png` | 1920×1080 PNG |

The full Play Console truth sheet, including declaration prompts and the acceptance checklist, is in
[`docs/play-store-submission.md`](play-store-submission.md).
