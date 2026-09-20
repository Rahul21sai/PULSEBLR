# PulseBLR Android TWA Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the same PulseBLR repository deterministically generate, verify, and package a target-SDK-36 Android TWA for Google Play, with deploy-time origin checks and certificate-correct Digital Asset Links.

**Architecture:** The checked-in web and TWA manifests form the release contract; pure validators enforce semantic parity and small CLIs apply those validators to local files, the deployed origin, generated Gradle output, and the final AAB. Bubblewrap 1.25.0 and Bundletool 1.18.3 are pinned. Generated Android source and signing material remain outside Git, while offline contract checks run in normal CI and the network/toolchain build runs through an explicit post-deployment workflow.

**Tech Stack:** Next.js/PWA JSON manifests, TypeScript/tsx, Vitest, `@bubblewrap/cli` 1.25.0, Temurin JDK 17, Android SDK/Build Tools 36.0.0, Gradle, Bundletool 1.18.3, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-20-pulseblr-mobile-production-design.md`

## Global Constraints

- Work only in the existing `codex/mobile-twa` worktree and preserve all pre-existing changes.
- Permanent origin is exactly `https://pulseblr-u9f1.vercel.app`.
- Android package ID is exactly `app.pulseblr.twa`.
- Initial version code/name are `1` / `1`; version code must increase for every Play upload.
- Generated Android `compileSdkVersion` and `targetSdkVersion` must both be 36; `minSdkVersion` remains 21.
- Pin `@bubblewrap/cli` exactly to `1.25.0`; no `latest` tag may remain in an executable instruction.
- Pin Bundletool exactly to 1.18.3 and verify SHA-256 `a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29` before execution.
- Web and Android manifests expose the same five shortcuts: `/scan`, `/card`, `/`, `/tracker`, `/calendar`.
- Share target remains `GET https://pulseblr-u9f1.vercel.app/add-event`.
- Android generation must fail when the production manifest, icons, routes, privacy page, or deletion page are stale/missing.
- Keep `/android/*` generated files ignored except `android/twa-manifest.json`.
- Keep all `*.keystore`, `*.jks`, passwords, and Play credentials outside Git and logs.
- Normal CI may build a debug AAB; release signing and Play upload require explicit human approval.
- Digital Asset Links must use HTTP 200, JSON content type, no redirect, exact package ID, and the exact expected fingerprint set.
- Follow strict TDD for validators and scripts; configuration-only files are verified by executing the commands they wire, not by source-grep tests.

## File Structure

- Create `lib/mobile-release-contract.ts`: semantic web/TWA manifest and generated-project validators.
- Modify `android/twa-manifest.json`: add Calendar shortcut and preserve permanent identity.
- Modify `tests/twa-manifest.test.ts`: semantic parity, identity, share target, version, SDK contract.
- Create `scripts/android-contract.ts`: offline checked-in-manifest gate.
- Create `scripts/android-preflight.ts`: real deployed-origin gate with manual redirect handling.
- Create `scripts/android-toolchain.ts`: JDK 17/SDK 36 capability gate.
- Create `scripts/android-generate.ts`: invoke the locally pinned Bubblewrap CLI in `android/`.
- Create `scripts/android-verify.ts`: generated Gradle/resources and AAB inspection.
- Create `tests/android-release-tools.test.ts`: controlled fixtures for all script failure modes.
- Modify `package.json` and `package-lock.json`: exact Bubblewrap dependency and Android commands.
- Create `lib/digital-asset-links.ts`: fingerprint validation, statement generation, deployed-response validation.
- Create `scripts/generate-assetlinks.ts`: owner-invoked generation of the public file.
- Create `scripts/diag-assetlinks.ts`: no-redirect remote verification.
- Create `tests/digital-asset-links.test.ts`: semantic DAL tests.
- Modify `.github/workflows/ci.yml`: run the offline Android contract.
- Create `.github/workflows/android-twa.yml`: manual post-deployment debug-AAB gate.
- Create `.github/workflows/android-release.yml`: protected signed-build gate that stops before upload.
- Modify `docs/android-twa.md`: exact commands and truthful current state.
- Create `docs/play-store-submission.md`: listing copy, Data Safety inventory, app-access and device-QA checklist.

---

### Task 1: Semantic Web/TWA Release Contract

**Files:**
- Create: `lib/mobile-release-contract.ts`
- Modify: `android/twa-manifest.json`
- Modify: `tests/twa-manifest.test.ts`
- Create: `scripts/android-contract.ts`

**Interfaces:**
- Produces: `PRODUCTION_ORIGIN`, `ANDROID_PACKAGE_ID`, `REQUIRED_ANDROID_SDK`.
- Produces: `validateWebAndTwaParity(web, twa): ReleaseContractIssue[]`.
- Produces: `assertWebAndTwaParity(web, twa): void`.
- Consumes later: preflight and generated-project scripts use the same constants and validation rules.

- [ ] **Step 1: Replace the current permissive test with failing semantic parity cases**

The expected values must be literal, not derived from the implementation under test:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_PACKAGE_ID,
  PRODUCTION_ORIGIN,
  assertWebAndTwaParity,
  validateWebAndTwaParity,
} from '../lib/mobile-release-contract';

const root = path.resolve(import.meta.dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as T;

describe('PulseBLR mobile release contract', () => {
  it('keeps the immutable package and origin identities', () => {
    const twa = read<Record<string, unknown>>('android/twa-manifest.json');
    expect(ANDROID_PACKAGE_ID).toBe('app.pulseblr.twa');
    expect(PRODUCTION_ORIGIN).toBe('https://pulseblr-u9f1.vercel.app');
    expect(twa.packageId).toBe('app.pulseblr.twa');
    expect(twa.host).toBe('pulseblr-u9f1.vercel.app');
  });

  it('accepts the checked-in web and TWA manifests as one five-shortcut product', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = read<Record<string, unknown>>('android/twa-manifest.json');
    expect(() => assertWebAndTwaParity(web, twa)).not.toThrow();
    expect((twa.shortcuts as Array<{ url: string }>).map(item => new URL(item.url).pathname)).toEqual([
      '/scan', '/card', '/', '/tracker', '/calendar',
    ]);
  });

  it('reports a missing Calendar shortcut as a user-visible integration break', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    twa.shortcuts = (twa.shortcuts as Array<{ url: string }>).filter(item => !item.url.endsWith('/calendar'));
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));
  });

  it.each([
    ['packageId', 'com.example.other', 'package-id'],
    ['themeColor', '#000000', 'theme-color'],
    ['orientation', 'landscape', 'orientation'],
    ['minSdkVersion', 23, 'min-sdk'],
  ])('reports invalid %s', (field, value, code) => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    twa[field] = value;
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code }));
  });

  it('rejects share-target drift', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    (twa.shareTarget as { action: string }).action = `${PRODUCTION_ORIGIN}/wrong`;
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'share-target' }));
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/twa-manifest.test.ts`

Expected: FAIL because the contract module does not exist and the TWA manifest lacks `/calendar`.

- [ ] **Step 3: Implement the pure semantic validator**

```ts
export const PRODUCTION_ORIGIN = 'https://pulseblr-u9f1.vercel.app';
export const ANDROID_PACKAGE_ID = 'app.pulseblr.twa';
export const REQUIRED_ANDROID_SDK = 36;
export const MIN_ANDROID_SDK = 21;

export interface ReleaseContractIssue {
  code: string;
  message: string;
}

type Shortcut = { name: string; short_name?: string; shortName?: string; url: string };
type WebManifest = {
  theme_color?: string;
  background_color?: string;
  display?: string;
  orientation?: string;
  shortcuts?: Shortcut[];
  share_target?: { action?: string; method?: string; enctype?: string; params?: Record<string, string> };
};
type TwaManifest = {
  packageId?: string;
  host?: string;
  themeColor?: string;
  backgroundColor?: string;
  display?: string;
  orientation?: string;
  minSdkVersion?: number;
  appVersionCode?: number;
  appVersion?: string;
  iconUrl?: string;
  maskableIconUrl?: string;
  shortcuts?: Shortcut[];
  shareTarget?: { action?: string; method?: string; enctype?: string; params?: Record<string, string> };
};

export function validateWebAndTwaParity(web: WebManifest, twa: TwaManifest): ReleaseContractIssue[] {
  const issues: ReleaseContractIssue[] = [];
  const add = (condition: boolean, code: string, message: string) => { if (!condition) issues.push({ code, message }); };
  add(twa.packageId === ANDROID_PACKAGE_ID, 'package-id', `packageId must be ${ANDROID_PACKAGE_ID}`);
  add(twa.host === new URL(PRODUCTION_ORIGIN).host, 'host', `host must be ${new URL(PRODUCTION_ORIGIN).host}`);
  add(twa.themeColor === web.theme_color, 'theme-color', 'theme colors must match');
  add(twa.backgroundColor === web.background_color, 'background-color', 'background colors must match');
  add(twa.display === web.display, 'display', 'display modes must match');
  add(twa.orientation === web.orientation, 'orientation', 'orientations must match');
  add(twa.minSdkVersion === MIN_ANDROID_SDK, 'min-sdk', `minSdkVersion must be ${MIN_ANDROID_SDK}`);
  add(Number.isInteger(twa.appVersionCode) && Number(twa.appVersionCode) > 0, 'version-code', 'appVersionCode must be a positive integer');
  add(typeof twa.appVersion === 'string' && twa.appVersion.length > 0, 'version-name', 'appVersion must be non-empty');
  const webPaths = (web.shortcuts ?? []).map(item => new URL(item.url, PRODUCTION_ORIGIN).pathname);
  const twaPaths = (twa.shortcuts ?? []).map(item => new URL(item.url, PRODUCTION_ORIGIN).pathname);
  add(JSON.stringify(twaPaths) === JSON.stringify(webPaths), 'shortcut-parity', 'web and Android shortcuts must have identical ordered paths');
  const webShare = web.share_target;
  const twaShare = twa.shareTarget;
  add(
    Boolean(webShare && twaShare) &&
      new URL(twaShare?.action ?? '', PRODUCTION_ORIGIN).toString() === new URL(webShare?.action ?? '', PRODUCTION_ORIGIN).toString() &&
      twaShare?.method === webShare?.method && twaShare?.enctype === webShare?.enctype &&
      JSON.stringify(twaShare?.params) === JSON.stringify(webShare?.params),
    'share-target',
    'web and Android share targets must match',
  );
  add(twa.iconUrl === `${PRODUCTION_ORIGIN}/icon-512.png`, 'icon-url', 'Android icon URL must use the permanent origin');
  add(twa.maskableIconUrl === `${PRODUCTION_ORIGIN}/icon-maskable-512.png`, 'maskable-icon-url', 'Android maskable icon URL must use the permanent origin');
  return issues;
}

export function assertWebAndTwaParity(web: WebManifest, twa: TwaManifest): void {
  const issues = validateWebAndTwaParity(web, twa);
  if (issues.length) throw new Error(issues.map(issue => `${issue.code}: ${issue.message}`).join('\n'));
}
```

- [ ] **Step 4: Add Calendar to the TWA manifest and the offline CLI**

Append this exact shortcut after Tracker:

```json
{
  "name": "Calendar",
  "shortName": "Calendar",
  "url": "https://pulseblr-u9f1.vercel.app/calendar",
  "chosenIconUrl": "https://pulseblr-u9f1.vercel.app/icon-192.png"
}
```

`scripts/android-contract.ts` reads `public/manifest.json` and `android/twa-manifest.json`, calls `assertWebAndTwaParity`, prints `Android manifest contract: PASS` on success, and exits non-zero with issue messages on failure. It must not mutate files or fetch the network.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npm test -- tests/twa-manifest.test.ts tests/manifest.test.ts
npx tsx scripts/android-contract.ts
npx tsc --noEmit
```

Expected: all commands exit 0.

Commit:

```powershell
git add -- lib/mobile-release-contract.ts android/twa-manifest.json tests/twa-manifest.test.ts scripts/android-contract.ts
git commit -m "feat: enforce web and Android release parity"
```

---

### Task 2: Deterministic Toolchain, Origin Preflight, Generation, and Artifact Verification

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `scripts/android-preflight.ts`
- Create: `scripts/android-toolchain.ts`
- Create: `scripts/android-generate.ts`
- Create: `scripts/android-verify.ts`
- Create: `tests/android-release-tools.test.ts`

**Interfaces:**
- Consumes: Task 1 constants and `assertWebAndTwaParity`.
- Produces: `preflightProductionOrigin(fetchImpl?)`, `validateJavaVersion`, `validateAndroidSdk`, `parseGeneratedProject`, `verifyGeneratedProject`, and `verifyAab`.
- Produces package commands: `android:contract`, `android:toolchain`, `android:preflight`, `android:generate`, `android:verify-generated`, `android:bundle:debug`, `android:verify-aab`.

- [ ] **Step 1: Pin the official Bubblewrap CLI**

Run: `npm install --save-dev --save-exact @bubblewrap/cli@1.25.0`

Expected: exact `1.25.0` in both package files. Bubblewrap is the official Google Chrome Labs TWA generator; no install script receives signing secrets.

- [ ] **Step 2: Write failing tool tests against controlled responses and generated fixtures**

```ts
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { preflightProductionOrigin } from '../scripts/android-preflight';
import { validateAndroidSdk, validateJavaVersion } from '../scripts/android-toolchain';
import { parseGeneratedProject } from '../scripts/android-verify';

describe('Android production-origin preflight', () => {
  it('rejects redirects and stale manifest content', async () => {
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return new Response(JSON.stringify({ theme_color: '#000000' }), { status: 200, headers: { 'content-type': 'application/json' } });
      return Response.redirect('https://other.example/', 302);
    };
    await expect(preflightProductionOrigin(fetchImpl)).rejects.toThrow(/manifest|redirect/i);
  });

  it('accepts only direct successful responses for every required route and asset', async () => {
    const web = await import('../public/manifest.json', { with: { type: 'json' } }).then(module => module.default);
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      if (url.endsWith('/manifest.json')) return Response.json(web);
      if (url.endsWith('.png')) return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
      return new Response('<!doctype html><title>PulseBLR</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    };
    await expect(preflightProductionOrigin(fetchImpl)).resolves.toEqual(expect.objectContaining({ checked: expect.any(Number) }));
  });
});

describe('generated Android project verification', () => {
  it('parses the actual Gradle and shortcut artifacts and requires SDK 36', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'pulseblr-android-'));
    mkdirSync(path.join(root, 'app', 'src', 'main', 'res', 'xml'), { recursive: true });
    writeFileSync(path.join(root, 'app', 'build.gradle'), `android { compileSdkVersion 36\n defaultConfig { applicationId "app.pulseblr.twa"\n minSdkVersion 21\n targetSdkVersion 36\n versionCode 1\n versionName "1" } }`);
    writeFileSync(path.join(root, 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml'), `<shortcuts><shortcut android:shortcutId="scan"><intent android:data="https://pulseblr-u9f1.vercel.app/scan"/></shortcut><shortcut android:shortcutId="card"><intent android:data="https://pulseblr-u9f1.vercel.app/card"/></shortcut><shortcut android:shortcutId="feed"><intent android:data="https://pulseblr-u9f1.vercel.app/"/></shortcut><shortcut android:shortcutId="tracker"><intent android:data="https://pulseblr-u9f1.vercel.app/tracker"/></shortcut><shortcut android:shortcutId="calendar"><intent android:data="https://pulseblr-u9f1.vercel.app/calendar"/></shortcut></shortcuts>`);
    expect(parseGeneratedProject(root)).toEqual(expect.objectContaining({
      applicationId: 'app.pulseblr.twa', compileSdk: 36, targetSdk: 36, minSdk: 21,
      versionCode: 1, versionName: '1', shortcutCount: 5,
      shortcutPaths: ['/scan', '/card', '/', '/tracker', '/calendar'],
    }));
  });

  it('rejects Java 11 and a missing Android 36 platform', () => {
    expect(() => validateJavaVersion('openjdk version "11.0.22"')).toThrow(/17/);
    expect(() => validateAndroidSdk({ platform36: false, buildTools36: true, platformTools: true })).toThrow(/android-36/);
  });
});
```

If TypeScript's JSON import attributes are unsupported by this repository configuration, read the fixture with `readFileSync`; do not weaken compiler settings.

- [ ] **Step 3: Run the focused test and verify RED**

Run: `npm test -- tests/android-release-tools.test.ts`

Expected: FAIL because the three Android script modules do not exist.

- [ ] **Step 4: Implement deployed-origin preflight**

`preflightProductionOrigin` must use `{ redirect: 'manual', cache: 'no-store' }`, require status 200, reject any `Location`, validate content types, compare the fetched manifest semantically with the checked-in manifest, and check these exact paths:

```ts
const requiredHtml = ['/', '/scan', '/card', '/tracker', '/calendar', '/add-event', '/privacy', '/delete-account'];
const requiredPng = ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];
```

Use `assertWebAndTwaParity(remoteManifest, checkedInTwaManifest)` so the live manifest must satisfy the same release contract. The CLI entry runs only when `import.meta.url === pathToFileURL(process.argv[1]).href`, prints each checked URL without response bodies, and exits non-zero on the first failure.

- [ ] **Step 5: Implement toolchain and generated-project verification**

`scripts/android-toolchain.ts` must:

- require `JAVA_HOME` and `ANDROID_SDK_ROOT` (accept `ANDROID_HOME` only as a compatibility alias);
- execute `$JAVA_HOME/bin/java -version` and require major 17;
- require `platforms/android-36/android.jar`;
- require `build-tools/36.0.0/aapt2` (`aapt2.exe` on Windows);
- require `platform-tools/adb` (`adb.exe` on Windows);
- print paths but never environment secrets.

`scripts/android-verify.ts` must parse the generated Gradle file and shortcut resources as an artifact, return a typed metadata object, and require:

```ts
{
  applicationId: 'app.pulseblr.twa',
  compileSdk: 36,
  targetSdk: 36,
  minSdk: 21,
  versionCode: 1,
  versionName: '1',
  shortcutCount: 5,
  shortcutPaths: ['/scan', '/card', '/', '/tracker', '/calendar'],
}
```

The generated-project verifier must resolve the shortcut URLs through the generated XML string resources rather than accepting any five shortcut IDs.

For `android:verify-aab`, use `BUNDLETOOL_JAR` or the checked CI cache path, hash the jar before running it, then invoke:

```text
java -jar bundletool-all-1.18.3.jar validate --bundle=<aab>
java -jar bundletool-all-1.18.3.jar dump manifest --bundle=<aab> --module=base
```

Parse the dump and assert package, version, min SDK, and target SDK. Run `jarsigner -verify -verbose -certs <aab>` and reject unsigned/invalid output. Never print keystore paths or passwords.

- [ ] **Step 6: Implement deterministic generation and package commands**

`scripts/android-generate.ts` must spawn the repository-local CLI through Node, with cwd `android/`:

```ts
const cli = path.join(process.cwd(), 'node_modules', '@bubblewrap', 'cli', 'bin', 'bubblewrap.js');
const child = spawnSync(process.execPath, [cli, 'update', '--skipVersionUpgrade'], {
  cwd: path.join(process.cwd(), 'android'),
  env: process.env,
  stdio: 'inherit',
});
if (child.status !== 0) process.exit(child.status ?? 1);
```

Add exact package scripts:

```json
{
  "android:contract": "tsx scripts/android-contract.ts",
  "android:toolchain": "tsx scripts/android-toolchain.ts",
  "android:preflight": "tsx scripts/android-preflight.ts",
  "android:generate": "tsx scripts/android-generate.ts",
  "android:verify-generated": "tsx scripts/android-verify.ts --project android",
  "android:bundle:debug": "node scripts/android-gradle.mjs bundleDebug",
  "android:verify-aab": "tsx scripts/android-verify.ts --aab"
}
```

Create `scripts/android-gradle.mjs` as a portable `spawnSync` wrapper choosing `gradlew.bat` on Windows and `./gradlew` elsewhere, cwd `android/`, passing `--no-daemon` and the requested allowlisted task. Accept only `bundleDebug` or `bundleRelease`; reject every other argument.

- [ ] **Step 7: Verify offline portions and commit**

Run:

```powershell
npm test -- tests/android-release-tools.test.ts tests/twa-manifest.test.ts
npm run android:contract
npx tsc --noEmit
```

Expected: all commands exit 0. Do not run production preflight or generation until the web release is deployed.

Commit:

```powershell
git add -- package.json package-lock.json scripts/android-preflight.ts scripts/android-toolchain.ts scripts/android-generate.ts scripts/android-gradle.mjs scripts/android-verify.ts tests/android-release-tools.test.ts
git commit -m "build: make Android generation reproducible"
```

---

### Task 3: Digital Asset Links Generation and Verification

**Files:**
- Create: `lib/digital-asset-links.ts`
- Create: `scripts/generate-assetlinks.ts`
- Create: `scripts/diag-assetlinks.ts`
- Create: `tests/digital-asset-links.test.ts`

**Interfaces:**
- Produces: `normalizeSha256Fingerprint`, `createAssetLinks`, `validateAssetLinks`.
- Produces: a generator that writes `public/.well-known/assetlinks.json` only with explicit owner-provided fingerprints.
- Produces: remote no-redirect verifier used after each certificate stage.

- [ ] **Step 1: Write failing semantic DAL tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  createAssetLinks,
  normalizeSha256Fingerprint,
  validateAssetLinks,
} from '../lib/digital-asset-links';

const upload = 'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA';
const play = 'BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB';

describe('Digital Asset Links contract', () => {
  it('normalizes lowercase compact SHA-256 into Android colon notation', () => {
    expect(normalizeSha256Fingerprint('aa'.repeat(32))).toBe(upload);
  });

  it('creates one Android statement with deduplicated upload and Play fingerprints', () => {
    const statements = createAssetLinks([upload, play, upload]);
    expect(statements).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'app.pulseblr.twa',
        sha256_cert_fingerprints: [upload, play],
      },
    }]);
    expect(validateAssetLinks(statements, [upload, play])).toEqual([]);
  });

  it('rejects the wrong package, a malformed certificate, or a missing expected fingerprint', () => {
    expect(() => normalizeSha256Fingerprint('not-a-certificate')).toThrow(/SHA-256/);
    const statements = createAssetLinks([upload]);
    (statements[0].target as { package_name: string }).package_name = 'com.example.other';
    expect(validateAssetLinks(statements, [upload, play]).map(issue => issue.code)).toEqual(expect.arrayContaining(['package-id', 'fingerprints']));
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- tests/digital-asset-links.test.ts`

Expected: FAIL because `lib/digital-asset-links.ts` does not exist.

- [ ] **Step 3: Implement the pure generator/validator**

Accept either 64 compact hexadecimal characters or 32 colon-separated byte pairs, normalize to uppercase colon notation, deduplicate while preserving input order, and always use package `app.pulseblr.twa` plus relation `delegate_permission/common.handle_all_urls`.

The generator CLI reads `PB_UPLOAD_SHA256` and optional `PB_PLAY_SHA256`. With no `--write`, print JSON to stdout. With `--write`, create `public/.well-known/assetlinks.json` using two-space JSON plus trailing newline. Refuse `--write` unless at least the upload fingerprint is present. Never log certificate source paths.

The diagnostic CLI reads expected fingerprints from the same variables, fetches the exact production URL with `redirect: 'manual'`, requires 200/JSON/no `Location`, parses JSON, and calls `validateAssetLinks`. After Play enrollment, both variables are required by the release command.

- [ ] **Step 4: Verify and commit the tooling without inventing fingerprints**

Run:

```powershell
npm test -- tests/digital-asset-links.test.ts
npx tsc --noEmit
```

Expected: both exit 0. `public/.well-known/assetlinks.json` remains absent until Rahul creates the upload key and provides its fingerprint.

Commit:

```powershell
git add -- lib/digital-asset-links.ts scripts/generate-assetlinks.ts scripts/diag-assetlinks.ts tests/digital-asset-links.test.ts
git commit -m "build: generate verified Digital Asset Links"
```

---

### Task 4: CI Gates, Release Runbook, and Play Submission Truth Sheet

**Files:**
- Modify: `.github/workflows/ci.yml`
- Create: `.github/workflows/android-twa.yml`
- Create: `.github/workflows/android-release.yml`
- Modify: `docs/android-twa.md`
- Create: `docs/play-store-submission.md`

**Interfaces:**
- Consumes: all package commands from Tasks 1–3.
- Produces: offline PR gate, manual post-deploy debug build, protected signed build, and owner-facing Play submission checklist.

- [ ] **Step 1: Add the offline manifest contract to normal CI**

After unit tests and before the Next.js build, run:

```yaml
- name: Android release contract
  run: npm run android:contract
```

Keep normal CI independent of the network and Android SDK.

- [ ] **Step 2: Add the manual post-deployment Android workflow**

`.github/workflows/android-twa.yml` must use `workflow_dispatch`, Ubuntu, Node 20, Temurin 17, and `android-actions/setup-android@v3`. Its exact command order is:

```yaml
- run: npm ci
- run: yes | sdkmanager --licenses > /dev/null
- run: sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0"
- run: npm run android:toolchain
- run: npm run android:contract
- run: npm run android:preflight
- run: npm run android:generate
- run: npm run android:verify-generated
- run: npm run android:bundle:debug
- run: npm run android:verify-aab -- android/app/build/outputs/bundle/debug/app-debug.aab
```

Set `ANDROID_SDK_ROOT` from the setup action and download Bundletool only from:

`https://github.com/google/bundletool/releases/download/1.18.3/bundletool-all-1.18.3.jar`

Verify its exact SHA-256 before setting `BUNDLETOOL_JAR`. Upload only the debug AAB and text diagnostics through `actions/upload-artifact@v4`; never upload SDK caches or signing material.

- [ ] **Step 3: Add a protected signed-build workflow that stops before Play upload**

`.github/workflows/android-release.yml` uses `workflow_dispatch`, requires a protected GitHub environment named `android-release`, accepts `version_code` as a required positive integer input, and consumes encrypted keystore/password/alias secrets. It reconstructs the keystore in the runner's temporary directory, updates the generated release version, runs `bundleRelease`, validates the signed AAB, uploads the AAB as a protected artifact, and deletes the temporary keystore in an `if: always()` step. It must not contain a Play upload action; Play upload remains a separately approved external action.

Mask every secret with `::add-mask::` before use and never pass passwords on a command line that Actions prints. Use environment variables or a temporary Gradle properties file with restrictive permissions, removed in the cleanup step.

- [ ] **Step 4: Correct the Android runbook**

Update `docs/android-twa.md` to:

- replace every `@latest` and mutable container tag with repository scripts/exact versions;
- state truthfully that JDK 17 exists but SDK 36/platform-tools/build-tools are not ready until `npm run android:toolchain` passes;
- state that `assetlinks.json` may be published with the upload certificate before first Play upload, but Play-installed verification requires both upload and Play signing certificates;
- document the exact sequence contract → deploy approval → preflight → generate → verify → debug build → signing approval → Internal Testing → second fingerprint → DAL redeploy → Play-install QA;
- document how version codes increase and how a lost upload key affects updates;
- retain the 12-testers/14-days warning for qualifying new personal accounts;
- never include actual passwords, keystore locations outside the documented relative placeholder, or certificate fingerprints.

- [ ] **Step 5: Create the Play submission truth sheet**

`docs/play-store-submission.md` must contain ready-to-copy short/full descriptions grounded in actual PulseBLR features; asset paths/dimensions; privacy and deletion URLs; a Data Safety inventory for Google profile data, events, contacts/scans, private notes, tokens, push endpoints, email delivery, and NVIDIA NIM processing; app-access instructions; content-rating/ads/target-audience prompts; internal/closed-test instructions; and the complete real-device acceptance checklist from the spec. Mark user-owned console fields as checkboxes, not asserted facts.

The support email entry must reference `PULSEBLR_SUPPORT_EMAIL`; do not put a guessed address in the document.

- [ ] **Step 6: Verify workflows through their wired commands and run the full repository gate**

Run locally:

```powershell
npm ci
npm run android:contract
npm test
npx tsc --noEmit
npm run lint
$env:PULSEBLR_SUPPORT_EMAIL='ci@example.invalid'
$env:NEXTAUTH_URL='http://localhost:3000'
$env:NEXTAUTH_SECRET='ci-build-only-not-a-real-secret'
npm run build
```

Then perform a YAML parse check using Ruby's standard YAML parser available on GitHub's Ubuntu runner or an installed local equivalent:

```powershell
ruby -e "require 'yaml'; Dir['.github/workflows/*.yml'].each { |f| YAML.load_file(f, aliases: true); puts \"PASS #{f}\" }"
```

Expected: every command exits 0. Production preflight, Android generation, Gradle build, and AAB inspection remain gated on deployment and installed SDK 36 tooling.

- [ ] **Step 7: Commit**

```powershell
git add -- .github/workflows/ci.yml .github/workflows/android-twa.yml .github/workflows/android-release.yml docs/android-twa.md docs/play-store-submission.md
git commit -m "ci: add Android and Play release gates"
```

---

## Plan Completion Gate

Repository implementation is complete only after all four task reviews are clean, normal CI is green, the permanent origin has been explicitly approved for deployment, the manual Android workflow produces a target-SDK-36 debug AAB, and the artifact validator proves its package/version/SDK/signature. Full product completion still requires Rahul-owned signing, both real certificate fingerprints, Internal Testing upload, Play-installed no-URL-bar verification, console declarations, any required closed test, and production review.
