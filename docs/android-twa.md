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
Feed, Tracker, Calendar), share target `/add-event`, the warm `#FAF9F5` theme/background, and the
three permanent-origin icon URLs (`iconUrl`, `maskableIconUrl`, and `monochromeIconUrl` naming the
transparent notification badge; see [Icons](#icons)). Run it without an Android SDK or network access:

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
   deployed bytes of every PNG Bubblewrap embeds (the same table generation uses, so the notification
   badge is included) with the checked-in assets. Do not generate if it fails.
4. **Generate** — `npm run android:generate` revalidates the configured JDK 17/SDK 36 paths, writes
   those exact roots to a restrictive one-use Bubblewrap config, passes it with `--config`, and
   removes it on exit. It does not enter Bubblewrap's prompt/bootstrap/download path and has no
   signing material in scope. **Immediately before Bubblewrap runs** it re-downloads the five assets
   Bubblewrap is about to embed (`icon-512.png`, `icon-192.png`, `icon-maskable-512.png`,
   `badge-96.png`, `manifest.json`) and requires the SHA-256 of the checked-in `public/` file,
   refusing redirects, non-200s and wrong media types. `manifest.json` is compared with CRLF folded to
   LF, because git stores it LF and a Windows checkout has it CRLF; that is the only normalisation.
5. **Verify** — `npm run android:verify-generated` proves the generated project retains the package,
   version, shortcuts, and SDK contract, the build-integrity pins below, and the **embedded bytes**:
   `res/raw/web_app_manifest.json` must equal `JSON.stringify` of `public/manifest.json` with
   `start_url` set to the TWA `startUrl` (Bubblewrap re-serialises it, so it is never byte-identical
   to the source, but it is a deterministic function of it), and every one of the 46 launcher,
   splash, shortcut, adaptive and notification PNGs must equal what Bubblewrap's own `ImageHelper`
   renders from the checked-in source (the five notification PNGs from `badge-96.png`, not the
   launcher tile), with no other PNG present. This closes the window a deploy between preflight and
   generation used to slip through. It also fails on any loopback address in the generated sources
   and requires the embedded `webManifestUrl` to be the production URL.
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

## Build-integrity pins (applied by the postprocess, asserted by verify-generated)

| Pin | Value | Provenance |
| --- | --- | --- |
| Gradle distribution | `gradle-8.11.1-bin.zip`, `distributionSha256Sum=f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6` | Gradle's published checksum, <https://services.gradle.org/distributions/gradle-8.11.1-bin.zip.sha256>, fetched 2026-09-27. Bubblewrap 1.25.0's template sets no checksum at all. |
| Wrapper jar | SHA-256 `3dc39ad6...edf9f` | The template ships the official Gradle **5.3-5.6.4** wrapper jar (matched against every release's `wrapperChecksumUrl` in <https://services.gradle.org/versions/all>), not the 8.11.1 one. It bootstraps 8.11.1 and honours the checksum, so it is pinned rather than replaced. |
| Repositories | `google()` + `mavenCentral()` | The template's two `jcenter()` entries are replaced. JCenter is read-only and removed in Gradle 9; the debug build resolved every dependency without it. |
| Build tools | `buildToolsVersion "36.0.0"` | Without it AGP 8.9.1 picks its own default and downloads it, so `android:toolchain` would be checking a component the build never used. |

## Icons

**Notification small icon: `monochromeIconUrl` is `/badge-96.png`.** Bubblewrap 1.25.0 renders
`drawable/ic_notification_icon` from `monochromeIconUrl || iconUrl`, and Android draws a small icon
from its alpha channel alone. With no `monochromeIconUrl` it was rendered from the opaque launcher
tile, so every notification showed a solid grey square. `badge-96.png` is the white-on-transparent
trace from `public/icon-mono.svg`, the same badge `sw.js` sends with web push. Measured 2026-09-30
through Bubblewrap's own renderer: the five notification PNGs (24-96 px) are 85-91% transparent with
transparent corners, where the tile's renderings had no transparent pixel at all. The contract,
preflight, pre-generation hash check, local-debug rewrite and verify-generated all name it, so a
manifest that drops the field fails rather than silently falling back to the tile.

**Maskable icon: byte-identical to `icon-512.png`, and that is correct.** A launcher may crop a
maskable icon to any shape, so only a centred circle is guaranteed visible. There are two bounds, and
Android's is the tighter one: the web's safe zone is a circle of radius 40% of the size, but
Bubblewrap's adaptive-icon template draws `ic_maskable` inset 8.5dp inside the 108dp layer, so
Android's 66dp never-clipped circle is 33/91 = **36.3%** of the image. `icon-512.svg` was authored
inside both. Measured 2026-09-30, the farthest non-ground pixel is 33.8% of the size from the centre
at 512 and 34.0% at 192, and every corner is the solid `#12513C` ground. So nothing was re-rendered.
`tests/maskable-icon.test.ts` measures both files against both bounds (the Android one derived from
the pinned template), and `scripts/generate-icons.js` refuses to write a maskable that fails them.

## Local-debug generation (before the mobile branch is deployed)

`npm run android:generate -- --local-debug` exists for one purpose: building a **debug** bundle while
the production origin still serves the old build (at the time of writing its PNG icons 404, so a
normal generation correctly refuses). It:

- serves exactly the five checked-in files above from a server bound to `127.0.0.1` on an ephemeral
  port that the script starts and stops. Any other request is a 404/405, is recorded, and fails the
  generation, and so does an asset Bubblewrap never fetched;
- gives Bubblewrap a **temporary** copy of `twa-manifest.json` via `--manifest`, in which only
  `iconUrl`, `maskableIconUrl`, `monochromeIconUrl`, `webManifestUrl` and the five `chosenIconUrl`s
  point at that server. Every field Bubblewrap downloads is either rewritten or refused (the shortcut
  `chosenMaskableIconUrl`/`chosenMonochromeIconUrl` variants are refused, and a missing
  `monochromeIconUrl` fails), because a fetched URL left on production would be downloaded from
  production where the local server cannot see it. A diff proves nothing else changed. `host`,
  `packageId`, `startUrl`, the shortcut targets and the share target stay as checked in, so **the app
  still opens `https://pulseblr-u9f1.vercel.app`**. The
  checked-in `android/twa-manifest.json` is never written;
- restores the one asset URL Bubblewrap also embeds at runtime (`webManifestUrl`) to production;
- writes `android/pulseblr-local-debug.json` before Bubblewrap starts and prints a loud banner from
  generate, verify-generated and verify-aab.

**It is refused** (a tested rule) whenever `GITHUB_ACTIONS=true` or `CI` is set, whenever any of
`ANDROID_UPLOAD_KEYSTORE_BASE64`, `ANDROID_UPLOAD_KEYSTORE_PASSWORD`, `ANDROID_UPLOAD_KEY_PASSWORD`,
`ANDROID_UPLOAD_KEY_ALIAS`, `ANDROID_UPLOAD_SHA256`, `PB_UPLOAD_SHA256`, `TRUSTED_JDK_PATH` or
`PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA` is present (even empty), and whenever a `*.keystore`, `*.jks`,
`*.p12` or `*.pfx` sits in `android/`. A marked project also fails verify-generated in those
contexts, and `android-gradle.mjs bundleRelease` refuses it outright.

What it **proves**: the checked-in contract generates, postprocesses and builds into a bundle whose
package, SDK, version, shortcuts, embedded icons and web manifest are exactly the checked-in ones.
What it **does not**: it is not a release artifact. It says nothing about what the deployed origin
serves, so the routes the app opens may not exist there yet. **It is unsigned**: measured
2026-09-27, AGP 8.9.1's `bundleDebug` writes `app-debug.aab` with no JAR manifest at all (jarsigner:
`no manifest.` / `jar is unsigned.`). So Digital Asset Links cannot verify it (no `assetlinks.json`
exists, and a debug fingerprint must never be put in one), the app would show the browser URL bar,
and Play rejects it as both unsigned and `debuggable`. To install on a device, build an APK from it
with Bundletool and your own local debug key; that is outside this pipeline. Regenerate without the
flag after deployment. A successful deployed-origin generation removes the marker.

Verify it with `npm run android:verify-aab -- android/app/build/outputs/bundle/debug/app-debug.aab --unsigned-debug`.
The flag accepts an unsigned bundle **only** if its manifest says `android:debuggable="true"` and
jarsigner reports it wholly unsigned; a release bundle is never debuggable, so the flag cannot admit
one. Without the flag, an unsigned bundle fails as before. The AAB gate also checks compileSdk 36,
`hostName`, `launchUrl`, `webManifestUrl`, exactly five production shortcut URLs, no loopback string
in any resource, and the presence of every icon family.

## Local toolchain notes

- **Android command-line tools 23+ upload usage metrics.** In cmdline-tools 23.0 `sdkmanager` is a
  shim over the new Android CLI: `--licenses` is a no-op, metrics are sent unless `--no-metrics` is
  passed, and the shim rejects that flag. Its launcher also downloads the CLI itself from
  `dl.google.com/android/cli/latest/`. Locally, call the CLI directly with `--no-metrics` and set
  `ANDROID_USER_HOME` to an isolated directory. CI does not use it: **Android TWA debug gate** pins
  setup-android to cmdline-tools 16.0 (build 12266719, the classic sdkmanager, no metrics), then
  fails the job if the resolved `sdkmanager` is anything else, including the shim. It accepts
  licences with a bounded `printf` instead of `yes |`, which exits 141 under `pipefail`.
  `android-release.yml` still has the old `yes | sdkmanager --licenses` step and implicit
  cmdline-tools version; it needs the same change, owned separately.
- **Gradle memory.** `android-gradle.mjs` runs `--no-daemon` with
  `-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m -Dorg.gradle.workers.max=2`, which
  override the template's `-Xmx1536m`. Override per process with `PULSEBLR_GRADLE_JVMARGS` (it must
  contain an `-Xmx` bound) and `PULSEBLR_GRADLE_WORKERS_MAX`. Check free memory before a build; the
  debug build was run only with at least 1.8 GB available.

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
