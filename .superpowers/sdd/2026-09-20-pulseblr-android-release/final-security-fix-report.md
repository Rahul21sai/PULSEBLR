# Android release final security-fix report

## Scope and commit

This final fix wave closes all four Important and both Minor findings from
`final-security-review.md`. The reviewed implementation is commit
`721b6368e4d0db12e39009162be00e15686fb34e` (`fix: close Android release integrity gaps`).

No workflow was dispatched. No deployment, publishing, Android SDK installation, Gradle build,
real signing, certificate fingerprint use, license acceptance, DAL publication, Play Console action,
or user toolchain mutation was performed.

## Findings closed

1. **Immutable unsigned artifact provenance.** `unsigned-aab` is the sole publisher of the original
   unsigned AAB and its SHA-256 identity. The secret-free parser job validates that exact artifact
   and publishes nothing. The protected signer redownloads the same original artifact, verifies the
   build digest, and signs those bytes. The semantic validator rejects parser publication, missing
   identity files, and substituted signer artifacts.
2. **Explicit Bubblewrap toolchain binding.** Generation revalidates the repository's toolchain,
   writes a temporary mode-`0600` Bubblewrap config containing the exact validated JDK and Android
   SDK roots, passes it with `--config`, and removes the directory in `finally`. A real pinned-CLI
   characterization under a fresh home and closed stdin proves configuration loads without entering
   a prompt or downloader path.
3. **Deployed-release freshness.** Both Android workflows require an exact expected deployed commit
   SHA. `/api/release-identity` exposes the provider-injected Vercel SHA ahead of the explicit manual
   fallback, fails closed on malformed or absent identity, and disables caching. Preflight compares
   the deployed SHA, verifies route-specific HTML markers, and compares exact local/remote SHA-256
   values for all three canonical PNGs.
4. **Upload-certificate identity.** The protected `ANDROID_UPLOAD_SHA256` variable is normalized and
   matched against the selected alias using the trusted absolute `keytool`. A later fresh protected,
   secret-free verification job independently extracts the final AAB signer and compares the same
   expected fingerprint before publishing the owner-facing artifact.
5. **Complete icon parity.** The contract now requires the canonical web any-purpose and maskable PNG
   entries and requires every web/TWA shortcut to resolve to the permanent-origin `icon-192.png`.
6. **Repository-wide action pins.** Every external action in every workflow is validated as a full
   40-character SHA; only explicit `./` local actions bypass that rule. Normal CI and scheduled jobs
   were pinned. The final provenance pass also corrected `actions/cache` to the official `v4.2.3`
   commit `5a3ec84eff668545956fd18022155c47e93e2684`, verified directly from the first-party repository.

The TWA runbook and Play submission truth sheet document the new release-SHA and upload-certificate
gates without claiming that account-owned external work has occurred.

## TDD evidence

- Icon parity RED: `npm test -- tests/twa-manifest.test.ts` produced three failures because
  synchronized icon drift returned no issues. GREEN: 22/22 tests passed after the canonical web and
  shortcut icon checks.
- Release identity RED: `npm test -- tests/release-identity.test.ts` failed because the route module
  did not exist. GREEN: 4/4 tests passed.
- Production preflight RED: the focused Android-tools suite produced seven failures against the old
  `fetchImpl` interface and accepted stale/generic content. GREEN: the strengthened focused suite
  passed with expected-release, route-marker, no-store, and icon-byte checks.
- Bubblewrap RED: focused tests showed missing `--config`, no fail-closed toolchain check, and a real
  CLI timeout under a fresh home. GREEN: `npm test -- tests/android-release-tools.test.ts` passed
  48/48, including the real pinned-CLI characterization.
- Workflow policy RED: seven mutation cases were accepted, covering parser republication,
  substituted identity/artifacts, missing signer fingerprints, missing expected-release binding, and
  mutable action pins. GREEN: `npm test -- tests/android-release-workflow.test.ts` passed 17/17.
- Provider precedence RED: the endpoint returned the manual SHA when Vercel supplied a different
  same-build SHA. GREEN: the release-identity suite passed 4/4 with provider precedence.
- Prerender marker RED: `npm test -- tests/release-route-markers.test.ts` failed because `/scan` put
  its marker inside the Suspense/client boundary. GREEN: 1/1 passed after moving the marker to the
  server-rendered wrapper, and the built `server/app/scan.html` contains exactly one scan marker.

## Final verification

Executed on the final implementation tree:

```text
npm test
64 files, 1,975 tests passed

npm test -- tests/android-release-tools.test.ts
48/48 passed

npm test -- tests/android-release-workflow.test.ts
17/17 passed

npm run android:contract
Android manifest contract: PASS

npm run validate:android-release-workflow
Android release workflow boundary validation: PASS

npx tsc --noEmit
exit 0

npm run lint
exit 0; one pre-existing app/layout.tsx custom-font warning
```

The isolated production build passed with:

```powershell
$env:PULSEBLR_DIST_DIR='.next-final-security-fix'
$env:NEXTAUTH_URL='https://pulseblr.example.com'
$env:PULSEBLR_SUPPORT_EMAIL='ci@example.invalid'
npm run build
```

The only build diagnostics were the expected MongoDB-unavailable static fallback warnings. Inspection
of the generated HTML confirmed the `home`, `scan`, `card`, `tracker`, `calendar`, `add-event`, and
`privacy` route markers. Next's automatic `tsconfig.json` rewrite was reverted with `apply_patch`; the
working file and `HEAD:tsconfig.json` had the identical Git blob
`3a13f90a773b0facb675bf5b1a8239c8f33d36f5` before commit.

`git diff --check` passed. `public/.well-known/assetlinks.json` remains absent. The added-file and
changed-file scan found no keystore/private-key artifact, real certificate fingerprint, password,
or private key. Ignored QA/build artifacts, including `.next-final-security-fix`, were preserved.

One concurrent verification attempt caused only the real Bubblewrap child characterization to reach
its 45-second timeout while tests, typecheck, and lint competed for resources. The characterization
then passed independently in 21.59 seconds, and the uncontended full suite passed twice. This was
resource contention, not an accepted failing gate.

## Self-review and remaining concerns

Self-review caught and fixed the mismatched `actions/cache` pin before this report. The post-fix
workflow suite, semantic validator, and full suite are green. No further repository-side finding was
identified in this wave.

Account-owned gates remain intentionally open: configure the protected environment variable and
signing secrets, approve and run the workflows, deploy the exact reviewed web commit, run real SDK
36/Bubblewrap/Gradle/AAB validation, perform owner-approved signing, publish both DAL fingerprints,
upload to Play Internal Testing, install from Play, and complete device/Console/closed-test gates.
