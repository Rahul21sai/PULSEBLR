# PulseBLR Mobile Production Design

**Date:** 20 September 2026  
**Status:** Approved by Rahul; implementation planned
**Repository:** existing PulseBLR repository  
**Android package:** `app.pulseblr.twa`  
**Permanent web origin:** `https://pulseblr-u9f1.vercel.app`

## Objective

Ship the existing PulseBLR Next.js application as a production-quality Android application through
Google Play while keeping the web application, PWA, release configuration, tests, and Android
generation inputs in one repository.

The Play application is a Trusted Web Activity (TWA), not an embedded WebView. The Play-distributed
Android package opens the same production origin as the web application in the device's real Chrome
runtime. This preserves Google OAuth compatibility and lets the web and mobile experiences share one
application, backend, database, authentication model, and release source of truth.

## Approaches considered

### 1. One repository, generated Android project (selected)

Check in the web application, PWA assets, TWA manifest, generation scripts, tests, and release
documentation. Regenerate the Bubblewrap Gradle project from the checked-in manifest and keep the
generated project ignored unless native customisation becomes necessary.

This gives PulseBLR one product source of truth, avoids Gradle-template drift, and keeps signing
material outside Git. It is the smallest architecture that still supports deterministic CI checks
and a signed Play release.

### 2. One repository, committed generated Android project

This makes sense only after PulseBLR needs reviewed native Java/Kotlin or Gradle customisations.
Bubblewrap overwrites generated files during updates, so committing them now would add large,
noisy diffs without adding product capability.

### 3. Separate Android repository

This is appropriate only for a separate native team, release cadence, or React Native/Flutter
application. It would duplicate versioning and deployment coordination for a TWA that is inseparable
from its web origin, so it is rejected for the current product.

## Repository and artifact model

```text
pulseblr/
├── app/                         Next.js routes, UI, API, privacy/deletion surfaces
├── public/                      PWA assets, service worker, Digital Asset Links
├── android/
│   └── twa-manifest.json       checked-in Android generation source of truth
├── scripts/                     deterministic generation and release verification
├── store-assets/               Play listing icon and feature graphic
├── tests/                       web, policy, deletion, and release-contract tests
└── docs/                        operator and Play release documentation
```

The repository produces two independently deployed artifacts:

1. A Next.js production deployment at `https://pulseblr-u9f1.vercel.app`.
2. A signed Android App Bundle (`.aab`) uploaded to Google Play.

The AAB is distributed by Google Play; it is not hosted on another web domain. At runtime the TWA
loads the permanent PulseBLR origin above.

## Permanent identities

- Web origin: `https://pulseblr-u9f1.vercel.app`
- Android package ID: `app.pulseblr.twa`
- Initial Android version code/name: `1` / `1`
- Display mode: `standalone`
- Orientation: `portrait-primary`
- Minimum Android SDK: 21
- Required 2026 target and compile SDK: 36

The package ID, verified host, and signing lineage must be treated as release identities after the
first Play upload. Changing the web host later would require a coordinated application update and
Digital Asset Links migration; changing the package ID would create a different Play application.

## Web and PWA production work

The production origin must deploy the repository's current PWA contract before Android generation:

- current `/manifest.json` with the warm `#FAF9F5` theme/background;
- PNG any-purpose and maskable icons, including `/icon-512.png` and
  `/icon-maskable-512.png`;
- the v5 service worker and offline fallback;
- `/privacy` and `/delete-account` public policy routes;
- the public Play verification file at `/.well-known/assetlinks.json` once certificate
  fingerprints exist;
- working share target `/add-event` and launcher routes `/scan`, `/card`, `/tracker`, `/calendar`,
  and `/`.

The web manifest and Android TWA manifest will expose the same five shortcuts. Tests will fail when
the two manifests drift.

Production readiness also requires authoritative Vercel environment verification for MongoDB,
Auth.js, Google OAuth, administration, and any advertised notification/email features. Development
login must remain disabled in production. The Google OAuth callback must be registered as
`https://pulseblr-u9f1.vercel.app/api/auth/callback/google`.

## Account deletion and Play policy design

Google-account creation makes deletion a production release requirement. PulseBLR will provide both
an authenticated in-app deletion control and a public browser-accessible deletion page.

### Public route

`/delete-account` will:

- work while signed out and outside the installed TWA;
- explain how to sign in and reach the Settings deletion control;
- identify the categories deleted and any narrowly defined retention exceptions;
- explain that already delivered email and calendar copies are outside PulseBLR's active store;
- provide a developer/support contact for users who cannot sign in;
- be linked from Settings, `/privacy`, and the login legal copy.

The deployed canonical URL is the URL entered in Play Console's account-deletion field.

### Authenticated deletion API

`DELETE /api/me/account` will:

- authenticate with `requireUser()` and never call `ensureUser()`;
- validate that the request `Origin` exactly matches the configured production origin;
- require an explicit confirmation value in the request body;
- execute all MongoDB changes in one transaction and fail closed when transactional guarantees are
  unavailable;
- be scoped exclusively to the authenticated user;
- be idempotent so a safe retry completes as a no-op;
- return only success and per-category diagnostic counts, never deleted personal data.

The production MongoDB deployment must therefore be transaction-capable (Atlas replica set or
equivalent). Browser cleanup runs only after the database transaction commits.

### Server-side deletion cascade

The transaction removes:

| Data | Ownership field/action |
| --- | --- |
| `TrackerEntry` | delete by `userId` |
| `Folder` | delete by `userId`, revoking intake tokens |
| `Contact` | delete by `userId` |
| `Person` | delete by `userId` |
| `Interaction` | delete by `userId` |
| `McpToken` | delete by `userId`, immediately revoking bearer tokens |
| `PushSubscription` | delete by `userId` |
| `ReminderLog` | delete by `userId` |
| `DigestLog` | delete by `userId` |
| `Event` | hard-delete by `createdByUserId`, including approved submissions |
| user-event audit snapshots | delete audit rows that reference the deleted event IDs |
| `User` | delete last by `googleId` |

For an administrator deleting their account, audit rows about other users' data remain for
operational integrity, but matching actor identity fields are replaced with a non-identifying
deleted-actor marker. Audit rows containing the administrator's own deleted event snapshots are
removed.

### Client cleanup

After server success, the Settings deletion flow will:

1. remove only the current owner's rows from both IndexedDB outbox stores;
2. unsubscribe the current browser push subscription on a best-effort basis;
3. clear service-worker/Cache Storage data;
4. sign out through Auth.js and navigate to `/delete-account?complete=1`.

The destructive action uses a dedicated danger zone and a final typed confirmation. It will not ask
for a password because PulseBLR uses Google OAuth and does not possess a user password.

Deleting a database row cannot globally revoke already issued Auth.js JWTs. Signing out invalidates
the current browser state; a later Google sign-in on any device is treated as deliberate
re-registration and may create a new empty PulseBLR account.

## Android generation and SDK design

Bubblewrap is an official Google Chrome Labs tool, but mutable `latest` tags are not reproducible.
Implementation will:

1. select and pin an exact reviewed `@bubblewrap/cli` version;
2. use the managed JDK 17 explicitly rather than the machine's Java 11 PATH entry;
3. install Android platform 36, build-tools, platform-tools, and required licenses under the managed
   SDK root;
4. regenerate the ignored Gradle project from `android/twa-manifest.json`;
5. assert generated `compileSdk` and `targetSdk` are both 36;
6. run an unsigned/debug CI build and a local signed release bundle build;
7. inspect the resulting bundle rather than trusting template metadata alone.

The TWA configuration will include the five web-manifest shortcuts, notifications, share target,
maskable icon, and fixed production host. Android generation must not proceed against missing or
stale production manifest/icon URLs.

## Signing and Digital Asset Links

Signing material is never committed or printed in logs.

- Rahul selects the upload-key passwords, certificate identity, and external backup location.
- The upload keystore remains outside Git and is backed up before the first Play upload.
- CI may build unsigned/debug Android artifacts without signing secrets.
- A protected release process may consume signing values only from secret storage.

Digital Asset Links rollout is ordered as follows:

1. Create the upload key and record its SHA-256 certificate fingerprint.
2. Publish `assetlinks.json` with the upload fingerprint for locally signed verification.
3. Build and upload the first signed AAB to Play Internal Testing with Play App Signing enabled.
4. Obtain the distinct Play App Signing SHA-256 fingerprint from App Integrity.
5. Publish both fingerprints at `/.well-known/assetlinks.json`.
6. Verify HTTP 200, JSON content type, no redirect, correct package ID, and both fingerprints.
7. Install from Play and confirm the application opens with no browser URL bar.

## Release automation

The same repository's CI will provide separate gates:

### Web gate

- clean dependency install;
- TypeScript and ESLint;
- complete Vitest suite;
- production Next.js build;
- manifest, privacy/deletion, service-worker, and deploy-readiness diagnostics.

### Android gate

- exact Bubblewrap version;
- deterministic generation from the checked-in manifest;
- package, host, version, shortcut, SDK 36, and signing-path assertions;
- unsigned/debug Gradle build;
- retained CI artifact and readable failure diagnostics.

### Protected release gate

- monotonic version code;
- release AAB build with external signing material;
- certificate and bundle inspection;
- explicit human approval before any Play upload.

Deployment, pushing/merging, Play Console creation, AAB upload, and production rollout remain
explicit external actions. They are performed only with Rahul's approval and authenticated account
access.

## Test and verification strategy

Implementation follows test-driven development.

### Automated deletion tests

- unauthenticated, cross-origin, and malformed confirmation rejection;
- complete cascade across every owned collection;
- second-user isolation for every deletion filter;
- user-created public/private/pending event deletion;
- token/link invalidation for card, calendar, intake, MCP, and push records;
- audit snapshot deletion and administrator actor redaction;
- transaction rollback on injected failure;
- idempotent retry without recreating `User`;
- owner-scoped IndexedDB purge without deleting another account's queued data;
- public policy copy and all required links.

### Automated release tests

- web/TWA manifest parity, including all five shortcuts;
- exact origin and package identity;
- icon and screenshot format/dimensions;
- production build and existing full regression suite;
- generated Android SDK/package/version assertions;
- Gradle debug bundle build;
- deployed-origin PWA diagnostics after deployment.

### Real-device acceptance

The Play-installed build must verify:

- no URL bar (Digital Asset Links verified);
- Google sign-in and sign-out;
- feed, event detail, tracker, calendar, scan, card, and Settings flows;
- share-target event import and all launcher shortcuts;
- camera permission and QR capture;
- offline cold start and queued-capture recovery;
- push permission and delivery when configured;
- correct icon, splash, theme, and back-navigation behaviour;
- account deletion, local cleanup, and signed-out public deletion page.

## Play Console completion

Repository work cannot replace the following account-owned steps:

- verified developer identity and public support email;
- application creation and Play App Signing enrollment;
- privacy-policy and deletion URLs;
- Data safety, content rating, target audience, ads, and app-access declarations;
- store description, icon, feature graphic, and screenshots;
- Internal Testing installation and acceptance;
- closed-testing requirement when the account is a qualifying new personal account;
- final production submission and review.

The checked-in store assets already provide the listing icon, feature graphic, and six screenshots.
Policy declarations must match the implemented behavior and named service providers rather than use
generic boilerplate.

## Delivery sequence

1. Implement and verify account deletion and policy surfaces.
2. Align manifests, shortcuts, release scripts, docs, and CI.
3. Verify the full web/PWA regression suite and production build.
4. With approval, deploy the current web/PWA release to the permanent origin.
5. Verify every TWA URL on production.
6. Install SDK 36 tooling and generate/verify the Android project.
7. With Rahul's signing inputs, create and back up the upload key and build the signed AAB.
8. With approval, upload to Internal Testing and obtain the Play signing fingerprint.
9. Deploy both Digital Asset Link fingerprints and verify the Play-installed app.
10. Complete Play declarations, closed testing if applicable, and production submission.

## Definition of done

PulseBLR mobile is complete only when the same-repository source passes all web and Android gates, a
signed target-SDK-36 AAB is accepted by Play, the production origin serves the current PWA and both
certificate fingerprints, the Play-installed build passes real-device acceptance with no URL bar,
policy declarations match actual data handling, and the required Play testing/review path is
complete. A locally generated project or a green web build alone is not completion.
