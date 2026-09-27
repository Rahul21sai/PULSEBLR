/**
 * Android generated-project and AAB verification.
 *
 * Two independent questions are answered here, and they are kept apart on purpose:
 *
 * 1. `--project`: is the Bubblewrap output in android/ the project we meant to build? That is
 *    package/version/SDK/shortcut metadata, the BUILD INTEGRITY pins the postprocess adds
 *    (Gradle distribution checksum, wrapper jar, build-tools, no jcenter), and the BYTES
 *    Bubblewrap embedded (the web manifest in res/raw and every launcher/splash/shortcut/
 *    notification PNG it rendered). Bubblewrap downloads those assets over the network, so
 *    "run preflight first" was procedure only: a deploy between preflight and generation, or a
 *    stale origin, went straight into the app. The embedded-bytes checks re-derive every output
 *    from the checked-in public/ files and compare, so they catch a substitution whenever it
 *    happened.
 * 2. `--aab`: does the built bundle carry the contract (Bundletool validate + manifest dump +
 *    jarsigner)?
 *
 * The shared release-context rule (`releaseContextReasons`) also lives here, because both the
 * generator (refusing `--local-debug`) and the verifier (refusing a local-debug project in a
 * release/CI context) need exactly the same definition, and android-generate.ts imports this
 * module, not the other way round.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import {
  ANDROID_PACKAGE_ID,
  MIN_ANDROID_SDK,
  PRODUCTION_ORIGIN,
  REQUIRED_ANDROID_SDK,
} from '../lib/mobile-release-contract';
import { validateJavaVersion } from './android-toolchain';

export interface GeneratedProjectMetadata {
  applicationId: string;
  compileSdk: number;
  targetSdk: number;
  minSdk: number;
  versionCode: number;
  versionName: string;
  shortcutCount: number;
  shortcutPaths: string[];
}

export type AndroidBuildMode = 'deployed-origin' | 'local-debug';

export interface VerifiedProject extends GeneratedProjectMetadata {
  buildMode: AndroidBuildMode;
}

export interface AabMetadata {
  packageName: string;
  versionCode: number;
  versionName: string;
  minSdk: number;
  targetSdk: number;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface VerifyAabOptions {
  bundletoolJar?: string;
  expectedVersionCode?: number;
  expectedVersionName?: string;
  projectRoot?: string;
  env?: Record<string, string | undefined>;
  javaHome?: string;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  hashFile?: (file: string) => string;
  run?: (command: string, args: readonly string[]) => CommandResult;
  /**
   * Accept a wholly UNSIGNED bundle, but only if its manifest says android:debuggable="true".
   * Measured 2026-09-27: AGP 8.9.1's bundleDebug writes app-debug.aab with no META-INF signature at
   * all (jarsigner: "no manifest. jar is unsigned."), so without this the debug gate could never
   * pass. A release bundle is not debuggable, so this cannot admit one; a partially signed bundle
   * or any signer error still fails.
   */
  allowUnsignedDebug?: boolean;
}

export interface AabVerification extends AabMetadata {
  compileSdk: number;
  hostName: string;
  shortcutUrls: string[];
  debuggable: boolean;
  signed: boolean;
}

export type AndroidVerifyCommand =
  | { mode: 'project'; projectPath: string }
  | { mode: 'aab'; aabPath: string; expectedVersionCode?: number; unsignedDebug?: boolean };

/** Resource entries the bundle must contain: every icon family Bubblewrap generates. */
export const REQUIRED_BUNDLE_ICON_RESOURCES = [
  'mipmap/ic_launcher',
  'mipmap/ic_maskable',
  'drawable/splash',
  'drawable/ic_notification_icon',
  ...[0, 1, 2, 3, 4].map(index => `drawable/shortcut_${index}`),
];

const bundletoolSha256 = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const bundletoolFilename = 'bundletool-all-1.18.3.jar';

/**
 * Written into android/ by `android:generate -- --local-debug`, removed by a successful
 * deployed-origin generation. It describes the CURRENT contents of android/, which is why the
 * generator writes it before Bubblewrap starts (a half-finished local-debug run is still marked)
 * and a deployed-origin run removes it only after full success (a failed run leaves the previous
 * local-debug output marked). Both failure directions therefore err towards "local-debug", which
 * is the direction every release gate refuses. android-gradle.mjs duplicates this name because it
 * is plain JS; a test pins the two together.
 */
export const LOCAL_DEBUG_MARKER = 'pulseblr-local-debug.json';

/**
 * Bubblewrap 1.25.0's template wrapper points at exactly this distribution
 * (node_modules/@bubblewrap/core/template_project/gradle/wrapper/gradle-wrapper.properties) and
 * ships NO distributionSha256Sum, so the wrapper would run whatever bytes that URL returned.
 * The checksum below is Gradle's own published value, fetched 2026-09-27 from
 *   https://services.gradle.org/distributions/gradle-8.11.1-bin.zip.sha256
 * (301 to https://downloads.gradle.org/distributions/gradle-8.11.1-bin.zip.sha256).
 * With it set, the wrapper refuses a distribution whose SHA-256 differs.
 */
export const GRADLE_DISTRIBUTION_URL = 'https://services.gradle.org/distributions/gradle-8.11.1-bin.zip';
export const GRADLE_DISTRIBUTION_SHA256 = 'f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6';

/**
 * The template's gradle/wrapper/gradle-wrapper.jar is NOT the 8.11.1 wrapper (whose published
 * checksum is 2db75c40...8046). It is the official wrapper jar shipped with Gradle 5.3 through
 * 5.6.4: matched 2026-09-27 against every release's `wrapperChecksumUrl` in
 * https://services.gradle.org/versions/all (e.g.
 * https://services.gradle.org/distributions/gradle-5.6.4-wrapper.jar.sha256). An old but genuine
 * wrapper bootstraps a newer distribution and honours distributionSha256Sum (supported since
 * Gradle 4.5), so it is pinned as-is rather than replaced: this jar is the code that performs the
 * checksum check above, and it is the one piece of the build that runs before any checksum.
 */
export const GRADLE_WRAPPER_JAR_SHA256 = '3dc39ad650d40f6c029bd8ff605c6d95865d657dbfdeacdb079db0ddfffedf9f';

/**
 * Pinned in app/build.gradle by the postprocess. Without it AGP 8.9.1 uses its own default
 * build-tools version, which is not the 36.0.0 that android-toolchain.ts checks for, and with
 * licences accepted it silently downloads that other version during the build: the toolchain
 * check would then be asserting a component the build never used. Pinning makes the check and
 * the build name the same thing.
 */
export const ANDROID_BUILD_TOOLS_VERSION = '36.0.0';

/**
 * Every URL Bubblewrap 1.25.0 fetches during `update`, read from its source rather than guessed:
 * TwaGenerator.createTwaProject fetches iconUrl (launcher, splash, notification), each shortcut's
 * chosenIconUrl, maskableIconUrl, and webManifestUrl (writeWebManifest). cli/cmds/shared.js only
 * validates the iconUrl string; it does not fetch it. twa-manifest.json declares no
 * monochromeIconUrl and no maskable/monochrome shortcut icons, so nothing else is requested.
 */
export const BUBBLEWRAP_ASSETS = [
  { route: '/icon-512.png', file: 'public/icon-512.png', contentType: 'image/png' },
  { route: '/icon-192.png', file: 'public/icon-192.png', contentType: 'image/png' },
  { route: '/icon-maskable-512.png', file: 'public/icon-maskable-512.png', contentType: 'image/png' },
  { route: '/manifest.json', file: 'public/manifest.json', contentType: 'application/manifest+json' },
] as const;

export type BubblewrapAsset = (typeof BUBBLEWRAP_ASSETS)[number];

const initialProjectMetadata: GeneratedProjectMetadata = {
  applicationId: ANDROID_PACKAGE_ID,
  compileSdk: REQUIRED_ANDROID_SDK,
  targetSdk: REQUIRED_ANDROID_SDK,
  minSdk: MIN_ANDROID_SDK,
  versionCode: 1,
  versionName: '1',
  shortcutCount: 5,
  shortcutPaths: ['/scan', '/card', '/', '/tracker', '/calendar'],
};

// ---------------------------------------------------------------------------------------------
// Release context
// ---------------------------------------------------------------------------------------------

/**
 * Variables whose mere PRESENCE (even empty) means signing material or a release gate is in
 * scope. The ANDROID_UPLOAD_* names and TRUSTED_JDK_PATH are exactly what android-release.yml's
 * signing step receives; PB_UPLOAD_SHA256 is the DAL generator's input (docs/android-twa.md);
 * PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA is the preflight input, i.e. someone intends a
 * deployed-origin build. Presence rather than non-emptiness, because the workflow binds these
 * names even when a secret resolves to "".
 */
export const RELEASE_CONTEXT_VARIABLES = [
  'ANDROID_UPLOAD_KEYSTORE_BASE64',
  'ANDROID_UPLOAD_KEYSTORE_PASSWORD',
  'ANDROID_UPLOAD_KEY_PASSWORD',
  'ANDROID_UPLOAD_KEY_ALIAS',
  'ANDROID_UPLOAD_SHA256',
  'PB_UPLOAD_SHA256',
  'TRUSTED_JDK_PATH',
  'PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA',
] as const;

export interface ReleaseContextOptions {
  androidRoot?: string;
  listDirectory?: (directory: string) => string[];
}

function defaultListDirectory(directory: string): string[] {
  try {
    return readdirSync(directory);
  } catch {
    return [];
  }
}

/**
 * Why this process looks like a release/signing context, or [] if it does not. Local-debug output
 * is refused in ANY of these, because it is only honest as a developer's pre-deployment check:
 * - GitHub Actions or CI at all. No workflow uses local-debug; the release workflow must never be
 *   able to reach it by passing a flag, and CI builds must come from the deployed origin.
 * - A signing/release variable is present (see RELEASE_CONTEXT_VARIABLES).
 * - A keystore sits in android/ (twa-manifest.json's signingKey is ./android.keystore, so that is
 *   where an upload key would be put; Bubblewrap's removeTwaProject never deletes it).
 * Environment names are compared case-insensitively because Windows environments are.
 */
export function releaseContextReasons(
  env: Record<string, string | undefined>,
  options: ReleaseContextOptions = {},
): string[] {
  const reasons: string[] = [];
  const upper = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) upper.set(key.toUpperCase(), value);
  if (upper.get('GITHUB_ACTIONS') === 'true') reasons.push('running under GitHub Actions (GITHUB_ACTIONS=true)');
  const ci = upper.get('CI');
  if (ci !== undefined && ci !== '' && ci.toLowerCase() !== 'false' && ci !== '0') reasons.push(`running in CI (CI=${ci})`);
  for (const name of RELEASE_CONTEXT_VARIABLES) {
    if (upper.has(name)) reasons.push(`release/signing variable ${name} is set`);
  }
  if (options.androidRoot) {
    const keystores = (options.listDirectory ?? defaultListDirectory)(options.androidRoot)
      .filter(name => /\.(keystore|jks|p12|pfx)$/i.test(name));
    for (const name of keystores) reasons.push(`signing material android/${name} is present`);
  }
  return reasons;
}

export function readBuildMode(projectRoot: string): AndroidBuildMode {
  return existsSync(path.join(projectRoot, LOCAL_DEBUG_MARKER)) ? 'local-debug' : 'deployed-origin';
}

// ---------------------------------------------------------------------------------------------
// Asset bytes
// ---------------------------------------------------------------------------------------------

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * The bytes an origin is expected to serve for a checked-in asset. PNGs are compared exactly.
 * manifest.json is compared with CRLF folded to LF: git stores it LF (`git ls-files --eol` reports
 * i/lf) and Vercel deploys the git bytes, while a Windows checkout under core.autocrlf=true has it
 * as w/crlf. Without the fold, every Windows run would report the deployed manifest as tampered.
 * That fold is the ONLY normalisation; any other byte difference fails.
 */
export function canonicalAssetBytes(asset: Pick<BubblewrapAsset, 'route'>, bytes: Uint8Array): Buffer {
  const buffer = Buffer.from(bytes);
  if (asset.route !== '/manifest.json') return buffer;
  return Buffer.from(buffer.toString('utf8').replace(/\r\n/g, '\n'), 'utf8');
}

export function readCheckedInAsset(repositoryRoot: string, asset: BubblewrapAsset): Buffer {
  return canonicalAssetBytes(asset, readFileSync(path.join(repositoryRoot, asset.file)));
}

export interface OriginAssetCheckOptions {
  repositoryRoot: string;
  fetchImpl?: typeof fetch;
  origin?: string;
}

export interface OriginAssetCheck {
  url: string;
  sha256: string;
}

/**
 * Gap 1 for deployed-origin generation: immediately before Bubblewrap runs, download every asset
 * it is about to download and require the SHA-256 of the checked-in file. Fails closed on any
 * redirect (Bubblewrap follows redirects, so a redirect is a second origin), non-200, wrong
 * media type or byte difference. This narrows the preflight->generate window to seconds; the
 * post-generation embedded-bytes checks below close the rest of it.
 */
export async function verifyOriginAssets(options: OriginAssetCheckOptions): Promise<OriginAssetCheck[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const origin = options.origin ?? PRODUCTION_ORIGIN;
  const results: OriginAssetCheck[] = [];
  for (const asset of BUBBLEWRAP_ASSETS) {
    const url = new URL(asset.route, origin).href;
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store' });
    if (response.headers.has('location') || (response.status >= 300 && response.status < 400)) {
      throw new Error(`${url} redirected; Bubblewrap would follow it to bytes nobody checked`);
    }
    if (response.status !== 200) {
      throw new Error(`${url} must return 200 before generation (received ${response.status}); deploy the checked-in public/ assets first, or use --local-debug for a pre-deployment debug build`);
    }
    const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? '';
    const acceptable = asset.route === '/manifest.json' ? ['application/manifest+json', 'application/json'] : ['image/png'];
    if (!acceptable.includes(mediaType)) {
      throw new Error(`${url} must be served as ${acceptable.join(' or ')} (received ${mediaType || 'no Content-Type'})`);
    }
    const remote = canonicalAssetBytes(asset, new Uint8Array(await response.arrayBuffer()));
    const local = readCheckedInAsset(options.repositoryRoot, asset);
    const remoteSha = sha256(remote);
    const localSha = sha256(local);
    if (remoteSha !== localSha) {
      throw new Error(`${url} SHA-256 ${remoteSha} does not match checked-in ${asset.file} (${localSha}); refusing to let Bubblewrap embed unchecked origin bytes`);
    }
    results.push({ url, sha256: remoteSha });
  }
  return results;
}

// ---------------------------------------------------------------------------------------------
// Generated project metadata
// ---------------------------------------------------------------------------------------------

/**
 * Removes Groovy comments OUTSIDE string literals. The earlier regex-only version also deleted
 * everything after the `//` in `'https://...'`, which truncated the embedded webManifestUrl the
 * first time a check needed to read a URL out of build.gradle.
 */
export function stripGradleComments(source: string): string {
  let output = '';
  let quote: string | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      output += char;
      if (char === '\\' && index + 1 < source.length) {
        output += next;
        index += 1;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      output += '\n';
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 1;
    } else {
      output += char;
    }
  }
  return output;
}

function requiredUniqueMatch(source: string, pattern: RegExp, field: string): string {
  const flags = `${pattern.flags.replaceAll('g', '')}g`;
  const matches = [...source.matchAll(new RegExp(pattern.source, flags))];
  if (matches.length === 0) throw new Error(`Generated Gradle artifact is missing ${field}`);
  if (matches.length !== 1) {
    throw new Error(`Generated Gradle artifact must assign ${field} exactly once (found ${matches.length})`);
  }
  return matches[0][1];
}

function appGradleFile(projectRoot: string): string {
  const candidates = [path.join(projectRoot, 'app', 'build.gradle'), path.join(projectRoot, 'app', 'build.gradle.kts')];
  const gradleFile = candidates.find(existsSync);
  if (!gradleFile) throw new Error('Generated project is missing app/build.gradle');
  return gradleFile;
}

function parseGradle(projectRoot: string): Omit<GeneratedProjectMetadata, 'shortcutCount' | 'shortcutPaths'> {
  const source = stripGradleComments(readFileSync(appGradleFile(projectRoot), 'utf8'));
  const number = (pattern: RegExp, field: string) => Number(requiredUniqueMatch(source, pattern, field));
  return {
    applicationId: requiredUniqueMatch(source, /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/, 'applicationId'),
    compileSdk: number(/\bcompileSdk(?:Version)?\s*(?:=\s*)?(\d+)/, 'compileSdk'),
    targetSdk: number(/\btargetSdk(?:Version)?\s*(?:=\s*)?(\d+)/, 'targetSdk'),
    minSdk: number(/\bminSdk(?:Version)?\s*(?:=\s*)?(\d+)/, 'minSdk'),
    versionCode: number(/\bversionCode\s*(?:=\s*)?(\d+)/, 'versionCode'),
    versionName: requiredUniqueMatch(source, /\bversionName\s*(?:=\s*)?["']([^"']+)["']/, 'versionName'),
  };
}

function readStringResources(resourceRoot: string): Map<string, string> {
  const valuesRoot = path.join(resourceRoot, 'values');
  if (!existsSync(valuesRoot)) throw new Error('Generated project is missing res/values string resources');
  const resources = new Map<string, string>();
  for (const entry of readdirSync(valuesRoot, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== '.xml') continue;
    const xml = readFileSync(path.join(valuesRoot, entry.name), 'utf8');
    const $ = load(xml, { xmlMode: true });
    $('resources > string').each((_index, element) => {
      const name = $(element).attr('name');
      if (!name) return;
      if (resources.has(name)) throw new Error(`Duplicate Android string resource @string/${name}`);
      resources.set(name, $(element).text().trim());
    });
  }
  return resources;
}

function parseShortcutPaths(projectRoot: string): string[] {
  const resourceRoot = path.join(projectRoot, 'app', 'src', 'main', 'res');
  const shortcutFile = path.join(resourceRoot, 'xml', 'shortcuts.xml');
  if (!existsSync(shortcutFile)) throw new Error('Generated project is missing res/xml/shortcuts.xml');
  const resources = readStringResources(resourceRoot);
  const $ = load(readFileSync(shortcutFile, 'utf8'), { xmlMode: true });
  const paths: string[] = [];
  $('shortcuts > shortcut').each((_index, shortcut) => {
    const reference = $(shortcut).find('intent').first().attr('android:data');
    const match = reference ? /^@string\/([A-Za-z0-9_]+)$/.exec(reference) : null;
    if (!match) throw new Error('Each generated shortcut URL must use an @string resource reference');
    const value = resources.get(match[1]);
    if (!value) throw new Error(`Missing Android string resource @string/${match[1]}`);
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid shortcut URL in @string/${match[1]}`);
    }
    if (url.origin !== PRODUCTION_ORIGIN || url.search || url.hash || url.username || url.password) {
      throw new Error(`Shortcut @string/${match[1]} must use the permanent production origin and a plain path`);
    }
    paths.push(url.pathname);
  });
  return paths;
}

export function parseGeneratedProject(projectRoot: string): GeneratedProjectMetadata {
  const gradle = parseGradle(projectRoot);
  const shortcutPaths = parseShortcutPaths(projectRoot);
  return { ...gradle, shortcutCount: shortcutPaths.length, shortcutPaths };
}

// ---------------------------------------------------------------------------------------------
// Build integrity (gaps 2-4) and the embedded runtime URLs
// ---------------------------------------------------------------------------------------------

function propertiesOf(source: string): Map<string, string[]> {
  const values = new Map<string, string[]>();
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const match = /^([^=:\s]+)\s*[=:]\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/\\(.)/g, '$1');
    values.set(match[1], [...(values.get(match[1]) ?? []), value]);
  }
  return values;
}

/**
 * Asserts the three build-integrity pins the postprocess adds. Each is checked on the generated
 * files rather than trusted from the postprocess, because the files are what Gradle reads.
 */
export function verifyGradleIntegrity(projectRoot: string): void {
  const wrapperProperties = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties');
  if (!existsSync(wrapperProperties)) throw new Error('Generated project is missing gradle/wrapper/gradle-wrapper.properties');
  const properties = propertiesOf(readFileSync(wrapperProperties, 'utf8'));
  const only = (key: string): string => {
    const values = properties.get(key) ?? [];
    if (values.length !== 1) throw new Error(`gradle-wrapper.properties must set ${key} exactly once (found ${values.length})`);
    return values[0];
  };
  if (only('distributionUrl') !== GRADLE_DISTRIBUTION_URL) {
    throw new Error(`gradle-wrapper.properties distributionUrl must be ${GRADLE_DISTRIBUTION_URL}`);
  }
  if (only('distributionSha256Sum').toLowerCase() !== GRADLE_DISTRIBUTION_SHA256) {
    throw new Error(`gradle-wrapper.properties distributionSha256Sum must be Gradle's published ${GRADLE_DISTRIBUTION_SHA256}`);
  }
  const wrapperJar = path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar');
  if (!existsSync(wrapperJar) || sha256(readFileSync(wrapperJar)) !== GRADLE_WRAPPER_JAR_SHA256) {
    throw new Error('gradle/wrapper/gradle-wrapper.jar must be the pinned official Gradle wrapper jar');
  }

  const gradleFiles = [path.join(projectRoot, 'build.gradle'), appGradleFile(projectRoot), path.join(projectRoot, 'settings.gradle')]
    .filter(existsSync);
  for (const file of gradleFiles) {
    if (/\bjcenter\s*\(/.test(stripGradleComments(readFileSync(file, 'utf8')))) {
      throw new Error(`${path.relative(projectRoot, file)} must not use jcenter() (read-only since 2021, removed in Gradle 9)`);
    }
  }
  const appSource = stripGradleComments(readFileSync(appGradleFile(projectRoot), 'utf8'));
  const buildTools = requiredUniqueMatch(appSource, /\bbuildToolsVersion\s*(?:=\s*)?["']([^"']+)["']/, 'buildToolsVersion');
  if (buildTools !== ANDROID_BUILD_TOOLS_VERSION) {
    throw new Error(`app/build.gradle buildToolsVersion must be ${ANDROID_BUILD_TOOLS_VERSION} (received ${buildTools})`);
  }
}

/**
 * The template embeds webManifestUrl as a runtime string resource (resValue "webManifestUrl",
 * surfaced as <meta-data android:name="web_manifest_url">, read by ChromeOS and Meta Quest). In
 * local-debug mode Bubblewrap is handed a loopback webManifestUrl so it can DOWNLOAD the
 * manifest, and the postprocess restores the production value. This asserts the restoration in
 * both modes, and that no loopback address survives anywhere in the generated sources.
 */
export function verifyEmbeddedRuntimeUrls(projectRoot: string): void {
  const appSource = stripGradleComments(readFileSync(appGradleFile(projectRoot), 'utf8'));
  const webManifestUrl = requiredUniqueMatch(
    appSource,
    /\bresValue\s+["']string["']\s*,\s*["']webManifestUrl["']\s*,\s*["']([^"']*)["']/,
    'the webManifestUrl resValue',
  );
  if (webManifestUrl !== `${PRODUCTION_ORIGIN}/manifest.json`) {
    throw new Error(`Embedded webManifestUrl must be ${PRODUCTION_ORIGIN}/manifest.json (received ${webManifestUrl})`);
  }
  const loopback = /\b(?:127(?:\.\d{1,3}){3}|localhost|0\.0\.0\.0)\b|\[::1?\]/i;
  const textExtensions = new Set(['.gradle', '.kts', '.xml', '.json', '.java', '.kt', '.properties', '.pro', '.txt']);
  const skipped = new Set([LOCAL_DEBUG_MARKER, 'twa-manifest.json']);
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(projectRoot, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        if (entry.name === '.gradle' || relative === 'app/build' || relative === 'build') continue;
        visit(full);
      } else if (entry.isFile() && !skipped.has(relative) && textExtensions.has(path.extname(entry.name))) {
        if (loopback.test(readFileSync(full, 'utf8'))) {
          throw new Error(`Generated ${relative} embeds a loopback address; a local-debug asset URL leaked into the app`);
        }
      }
    }
  };
  visit(projectRoot);
}

/**
 * Bubblewrap's writeWebManifest fetches webManifestUrl, JSON.parses it, overwrites start_url with
 * the TWA's startUrl and writes JSON.stringify(result) - compact and key-order preserving - to
 * res/raw/web_app_manifest.json. So it is NOT byte-identical to public/manifest.json, but it IS
 * a deterministic function of it: this recomputes that function from the checked-in file and
 * requires the embedded bytes to equal it exactly. A stale or substituted origin manifest fails.
 */
export function expectedEmbeddedWebManifest(repositoryRoot: string, startUrl: string): string {
  const source = readFileSync(path.join(repositoryRoot, 'public', 'manifest.json'), 'utf8').trim();
  const manifest = JSON.parse(source) as Record<string, unknown>;
  manifest.start_url = startUrl;
  return JSON.stringify(manifest);
}

export function verifyEmbeddedWebManifest(projectRoot: string, repositoryRoot: string): void {
  const twa = JSON.parse(readFileSync(path.join(projectRoot, 'twa-manifest.json'), 'utf8')) as { startUrl?: unknown };
  if (typeof twa.startUrl !== 'string') throw new Error('twa-manifest.json must declare startUrl');
  const embeddedFile = path.join(projectRoot, 'app', 'src', 'main', 'res', 'raw', 'web_app_manifest.json');
  if (!existsSync(embeddedFile)) throw new Error('Generated project is missing res/raw/web_app_manifest.json');
  const embedded = readFileSync(embeddedFile, 'utf8');
  if (embedded !== expectedEmbeddedWebManifest(repositoryRoot, twa.startUrl)) {
    throw new Error('Embedded res/raw/web_app_manifest.json does not match checked-in public/manifest.json (with start_url set to the TWA startUrl)');
  }
}

export interface VerifyGeneratedProjectOptions {
  repositoryRoot?: string;
  env?: Record<string, string | undefined>;
}

export function verifyGeneratedProject(
  projectRoot: string,
  options: VerifyGeneratedProjectOptions = {},
): VerifiedProject {
  const actual = parseGeneratedProject(projectRoot);
  for (const [field, expected] of Object.entries(initialProjectMetadata)) {
    const received = actual[field as keyof GeneratedProjectMetadata];
    if (JSON.stringify(received) !== JSON.stringify(expected)) {
      throw new Error(`Generated project ${field} must be ${JSON.stringify(expected)} (received ${JSON.stringify(received)})`);
    }
  }
  verifyGradleIntegrity(projectRoot);
  verifyEmbeddedRuntimeUrls(projectRoot);
  verifyEmbeddedWebManifest(projectRoot, options.repositoryRoot ?? path.dirname(path.resolve(projectRoot)));
  const buildMode = readBuildMode(projectRoot);
  if (buildMode === 'local-debug') {
    const reasons = releaseContextReasons(options.env ?? process.env, { androidRoot: projectRoot });
    if (reasons.length) {
      throw new Error(`Refusing a LOCAL-DEBUG Android project in a release/signing context: ${reasons.join('; ')}`);
    }
  }
  return { ...actual, buildMode };
}

// ---------------------------------------------------------------------------------------------
// Embedded icon bytes
// ---------------------------------------------------------------------------------------------

interface IconRender {
  route: '/icon-512.png' | '/icon-192.png' | '/icon-maskable-512.png';
  withBackground: boolean;
  outputs: ReadonlyArray<readonly [string, number]>;
}

const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi'] as const;
const perDensity = (directory: 'mipmap' | 'drawable', file: string, sizes: readonly number[]) =>
  densities.map((density, index) => [`app/src/main/res/${directory}-${density}/${file}`, sizes[index]] as const);

/**
 * Mirrors the IMAGES / SPLASH_IMAGES / shortcutImages / ADAPTIVE_IMAGES / NOTIFICATION_IMAGES
 * tables in @bubblewrap/core 1.25.0 dist/lib/TwaGenerator.js. They are not exported, so they are
 * restated here - and the exact-file-set assertion in verifyGeneratedIcons turns any upstream
 * drift into a failure rather than an unchecked PNG.
 */
export const BUBBLEWRAP_ICON_RENDERS: readonly IconRender[] = [
  {
    route: '/icon-512.png',
    withBackground: false,
    outputs: [...perDensity('mipmap', 'ic_launcher.png', [48, 72, 96, 144, 192]), ['store_icon.png', 512]],
  },
  { route: '/icon-512.png', withBackground: true, outputs: perDensity('drawable', 'splash.png', [300, 450, 600, 900, 1200]) },
  ...[0, 1, 2, 3, 4].map(index => ({
    route: '/icon-192.png' as const,
    withBackground: false,
    outputs: perDensity('drawable', `shortcut_${index}.png`, [48, 72, 96, 144, 192]),
  })),
  { route: '/icon-maskable-512.png', withBackground: false, outputs: perDensity('mipmap', 'ic_maskable.png', [82, 123, 164, 246, 328]) },
  { route: '/icon-512.png', withBackground: false, outputs: perDensity('drawable', 'ic_notification_icon.png', [24, 36, 48, 72, 96]) },
];

export type IconRenderer = (source: Buffer, size: number, backgroundColor: string | undefined) => Promise<Buffer>;

/**
 * Renders with Bubblewrap's OWN ImageHelper (same file, same Jimp) rather than a re-implementation,
 * so "equal bytes" means "this PNG is what Bubblewrap produces from the checked-in source".
 * Jimp is pure JavaScript, so the output is a deterministic function of the input bytes.
 */
export function bubblewrapIconRenderer(repositoryRoot: string): IconRenderer {
  const coreRequire = createRequire(path.join(repositoryRoot, 'node_modules', '@bubblewrap', 'core', 'package.json'));
  const { ImageHelper } = coreRequire('./dist/lib/ImageHelper') as {
    ImageHelper: new () => { saveIcon: (icon: { url: string; data: Buffer }, size: number, file: string, background?: unknown) => Promise<void> };
  };
  const Color = coreRequire('color') as (value: string) => unknown;
  const helper = new ImageHelper();
  return async (source, size, backgroundColor) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pulseblr-icon-'));
    try {
      const file = path.join(directory, 'icon.png');
      await helper.saveIcon({ url: 'checked-in', data: source }, size, file, backgroundColor ? Color(backgroundColor) : undefined);
      return readFileSync(file);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function listPngs(projectRoot: string): string[] {
  const found: string[] = [];
  const resourceRoot = path.join(projectRoot, 'app', 'src', 'main', 'res');
  const visit = (directory: string) => {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && /\.png$/i.test(entry.name)) found.push(path.relative(projectRoot, full).split(path.sep).join('/'));
    }
  };
  visit(resourceRoot);
  if (existsSync(path.join(projectRoot, 'store_icon.png'))) found.push('store_icon.png');
  return found.sort();
}

export interface VerifyGeneratedIconsOptions {
  renderIcon?: IconRenderer;
}

/**
 * Every PNG Bubblewrap embedded must equal what Bubblewrap renders from the checked-in public/
 * source, and no other PNG may exist. This is the post-generation half of gap 1: it holds even if
 * the origin changed between the pre-generation hash check and Bubblewrap's own download.
 */
export async function verifyGeneratedIcons(
  projectRoot: string,
  repositoryRoot: string,
  options: VerifyGeneratedIconsOptions = {},
): Promise<number> {
  const twa = JSON.parse(readFileSync(path.join(projectRoot, 'twa-manifest.json'), 'utf8')) as { backgroundColor?: string };
  const expectedFiles = BUBBLEWRAP_ICON_RENDERS.flatMap(render => render.outputs.map(([file]) => file)).sort();
  const actualFiles = listPngs(projectRoot);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    const missing = expectedFiles.filter(file => !actualFiles.includes(file));
    const extra = actualFiles.filter(file => !expectedFiles.includes(file));
    throw new Error(`Generated PNG set differs from Bubblewrap 1.25.0's icon tables (missing: ${missing.join(', ') || 'none'}; unexpected: ${extra.join(', ') || 'none'})`);
  }
  const render = options.renderIcon ?? bubblewrapIconRenderer(repositoryRoot);
  const sources = new Map(BUBBLEWRAP_ASSETS.map(asset => [asset.route, readCheckedInAsset(repositoryRoot, asset)]));
  let checked = 0;
  for (const icon of BUBBLEWRAP_ICON_RENDERS) {
    const source = sources.get(icon.route);
    if (!source) throw new Error(`No checked-in source for ${icon.route}`);
    for (const [file, size] of icon.outputs) {
      const expected = await render(source, size, icon.withBackground ? twa.backgroundColor : undefined);
      const actual = readFileSync(path.join(projectRoot, file));
      if (!expected.equals(actual)) {
        throw new Error(`Embedded ${file} is not Bubblewrap's rendering of checked-in public${icon.route} at ${size}px; the icon bytes came from somewhere else`);
      }
      checked += 1;
    }
  }
  return checked;
}

// ---------------------------------------------------------------------------------------------
// AAB
// ---------------------------------------------------------------------------------------------

function sha256File(file: string): string {
  return sha256(readFileSync(file));
}

function parseBundleManifest(xml: string): AabMetadata {
  const $ = load(xml, { xmlMode: true });
  const manifest = $('manifest').first();
  const usesSdk = manifest.find('uses-sdk').first();
  const requiredAttribute = (value: string | undefined, field: string): string => {
    if (!value) throw new Error(`Bundle manifest is missing ${field}`);
    return value;
  };
  const requiredInteger = (value: string | undefined, field: string): number => {
    const source = requiredAttribute(value, field);
    if (!/^\d+$/.test(source)) throw new Error(`Bundle manifest ${field} must be an integer`);
    return Number(source);
  };
  return {
    packageName: requiredAttribute(manifest.attr('package'), 'package'),
    versionCode: requiredInteger(manifest.attr('android:versionCode'), 'versionCode'),
    versionName: requiredAttribute(manifest.attr('android:versionName'), 'versionName'),
    minSdk: requiredInteger(usesSdk.attr('android:minSdkVersion'), 'minSdk'),
    targetSdk: requiredInteger(usesSdk.attr('android:targetSdkVersion'), 'targetSdk'),
  };
}

function defaultBundletoolJar(env: Record<string, string | undefined>): string {
  return env.BUNDLETOOL_JAR ?? path.join(homedir(), '.cache', 'bundletool', bundletoolFilename);
}

export function verifyAab(aabPath: string, options: VerifyAabOptions = {}): AabVerification {
  if (!existsSync(aabPath)) throw new Error('Android App Bundle does not exist');
  const env = options.env ?? process.env;
  const bundletoolJar = options.bundletoolJar ?? defaultBundletoolJar(env);
  if (!existsSync(bundletoolJar)) throw new Error(`Bundletool ${bundletoolFilename} is required`);

  const hash = (options.hashFile ?? sha256File)(bundletoolJar);
  if (hash.toLowerCase() !== bundletoolSha256) {
    throw new Error(`Bundletool SHA-256 must match the pinned ${bundletoolFilename} digest`);
  }

  const projectMetadata = options.expectedVersionCode === undefined || options.expectedVersionName === undefined
    ? parseGeneratedProject(options.projectRoot ?? path.resolve('android'))
    : undefined;
  const expectedVersionCode = options.expectedVersionCode ?? projectMetadata?.versionCode;
  const expectedVersionName = options.expectedVersionName ?? projectMetadata?.versionName;
  if (!Number.isInteger(expectedVersionCode) || Number(expectedVersionCode) <= 0) {
    throw new Error('Expected AAB versionCode must be a positive integer');
  }
  if (!expectedVersionName) throw new Error('Expected AAB versionName must be non-empty');

  const run = options.run ?? ((command, args) => {
    const result = spawnSync(command, [...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  const javaHome = options.javaHome ?? env.JAVA_HOME;
  if (!javaHome) throw new Error('JAVA_HOME is required for AAB verification');
  const executableSuffix = (options.platform ?? process.platform) === 'win32' ? '.exe' : '';
  const java = path.join(javaHome, 'bin', `java${executableSuffix}`);
  const jarsigner = path.join(javaHome, 'bin', `jarsigner${executableSuffix}`);
  const fileExists = options.fileExists ?? existsSync;
  if (!fileExists(java) || !fileExists(jarsigner)) {
    throw new Error('JAVA_HOME must contain both JDK 17 java and jarsigner executables');
  }
  const javaVersion = run(java, ['-version']);
  if (javaVersion.status !== 0) throw new Error('JAVA_HOME java -version failed during AAB verification');
  validateJavaVersion(`${javaVersion.stdout}\n${javaVersion.stderr}`);
  const validate = run(java, ['-jar', bundletoolJar, 'validate', `--bundle=${aabPath}`]);
  if (validate.status !== 0) throw new Error('Bundletool validate failed');
  const dump = run(java, ['-jar', bundletoolJar, 'dump', 'manifest', `--bundle=${aabPath}`, '--module=base']);
  if (dump.status !== 0) throw new Error('Bundletool manifest dump failed');

  const metadata = parseBundleManifest(dump.stdout);
  const expected: AabMetadata = {
    packageName: ANDROID_PACKAGE_ID,
    versionCode: Number(expectedVersionCode),
    versionName: expectedVersionName,
    minSdk: MIN_ANDROID_SDK,
    targetSdk: REQUIRED_ANDROID_SDK,
  };
  for (const [field, value] of Object.entries(expected)) {
    const received = metadata[field as keyof AabMetadata];
    if (received !== value) throw new Error(`Bundle ${field} must be ${value} (received ${received})`);
  }

  const compileSdk = /\bandroid:compileSdkVersion="(\d+)"/.exec(dump.stdout)?.[1];
  if (Number(compileSdk) !== REQUIRED_ANDROID_SDK) {
    throw new Error(`Bundle compileSdk must be ${REQUIRED_ANDROID_SDK} (received ${compileSdk ?? 'none'})`);
  }
  const debuggable = /<application\b[^>]*\bandroid:debuggable="true"/.test(dump.stdout);

  // The runtime contract lives in resources, not the manifest: the TWA reads launchUrl/hostName,
  // the shortcuts read shortcut_url_N and ChromeOS reads webManifestUrl. Checked in the BUILT
  // bundle so nothing between verify-generated and Gradle can have changed them.
  const resourceDump = run(java, ['-jar', bundletoolJar, 'dump', 'resources', `--bundle=${aabPath}`, '--values']);
  if (resourceDump.status !== 0) throw new Error('Bundletool resource dump failed');
  const resources = parseBundleResources(resourceDump.stdout);
  const hostName = new URL(PRODUCTION_ORIGIN).host;
  const requiredStrings: Record<string, string> = {
    hostName,
    launchUrl: `${PRODUCTION_ORIGIN}/`,
    webManifestUrl: `${PRODUCTION_ORIGIN}/manifest.json`,
  };
  const shortcutUrls = initialProjectMetadata.shortcutPaths.map((shortcutPath, index) => {
    requiredStrings[`shortcut_url_${index}`] = new URL(shortcutPath, PRODUCTION_ORIGIN).href;
    return requiredStrings[`shortcut_url_${index}`];
  });
  for (const [name, value] of Object.entries(requiredStrings)) {
    const received = resources.strings.get(name);
    if (received !== value) throw new Error(`Bundle @string/${name} must be ${value} (received ${received ?? 'none'})`);
  }
  if (resources.strings.has(`shortcut_url_${shortcutUrls.length}`)) {
    throw new Error(`Bundle must define exactly ${shortcutUrls.length} shortcut URLs`);
  }
  if (/\b(?:127(?:\.\d{1,3}){3}|localhost)\b/i.test(resourceDump.stdout)) {
    throw new Error('Bundle resources embed a loopback address');
  }
  for (const name of REQUIRED_BUNDLE_ICON_RESOURCES) {
    if (!resources.names.has(name)) throw new Error(`Bundle is missing icon resource @${name}`);
  }
  const verification = { ...metadata, compileSdk: REQUIRED_ANDROID_SDK, hostName, shortcutUrls, debuggable };

  const signature = run(jarsigner, ['-verify', '-verbose', '-certs', '-strict', aabPath]);
  const signatureOutput = `${signature.stdout}\n${signature.stderr}`;
  const signatureStatus = signature.status;
  if (options.allowUnsignedDebug) {
    // `-verbose` always prints a legend mentioning "signature" and "certificate", so those words
    // prove nothing. Wholly unsigned means jarsigner found no JAR manifest at all and said so.
    const whollyUnsigned = signatureStatus === 0 &&
      /^no manifest\.\s*$/im.test(signatureOutput) &&
      /^jar is unsigned\.\s*$/im.test(signatureOutput) &&
      !/\bjar verified\b/i.test(signatureOutput);
    if (!debuggable) throw new Error('--unsigned-debug accepts only a debuggable bundle; this one is not debuggable');
    if (!whollyUnsigned) throw new Error('--unsigned-debug requires a wholly unsigned bundle (jarsigner reported signature data)');
    return { ...verification, signed: false };
  }
  const selfSignedPolicy =
    signatureStatus !== null &&
    signatureStatus > 0 &&
    (signatureStatus & ~24) === 0 &&
    (signatureStatus & 16) === 16 &&
    /signer certificate is self-signed/i.test(signatureOutput);
  const verified = /\bjar verified(?:, with signer errors)?\./i.test(signatureOutput);
  const validityFailure = /\b(?:expired|not yet valid|revoked|unsigned|not signed)\b|signature (?:invalid|error)/i.test(signatureOutput);
  const unapprovedSignerError =
    /with signer errors/i.test(signatureOutput) && !selfSignedPolicy ||
    /certificate chain is invalid/i.test(signatureOutput) && !selfSignedPolicy ||
    /signer certificate is self-signed/i.test(signatureOutput) && !selfSignedPolicy;
  if (
    (signatureStatus !== 0 && !selfSignedPolicy) ||
    !verified ||
    validityFailure ||
    unapprovedSignerError
  ) {
    throw new Error('AAB signature verification failed or the bundle is unsigned');
  }
  return { ...verification, signed: true };
}

/** Parses `bundletool dump resources --values`: `0x.. - type/name` lines, then `\t(config) - [STR] "value"`. */
export function parseBundleResources(dump: string): { names: Set<string>; strings: Map<string, string> } {
  const names = new Set<string>();
  const strings = new Map<string, string>();
  let current: string | undefined;
  for (const line of dump.split(/\r?\n/)) {
    const header = /^0x[0-9a-f]+ - ([a-z-]+\/[A-Za-z0-9_.]+)\s*$/i.exec(line.trim());
    if (header) {
      current = header[1];
      names.add(current);
      continue;
    }
    const value = /^\(default\) - \[STR\] "(.*)"$/.exec(line.trim());
    if (current?.startsWith('string/') && value && !strings.has(current.slice(7))) {
      strings.set(current.slice(7), value[1]);
    }
  }
  return { names, strings };
}

export function parseAndroidVerifyArgs(args: readonly string[]): AndroidVerifyCommand {
  if (args[0] === '--project') {
    if (args.length !== 2 || !args[1] || args[1].startsWith('--')) {
      throw new Error('Invalid arguments; usage: --project <generated-project>');
    }
    return { mode: 'project', projectPath: args[1] };
  }
  if (args[0] === '--aab') {
    if (args.length < 2 || args.length > 4 || !args[1] || args[1].startsWith('--')) {
      throw new Error('Invalid arguments; usage: --aab <bundle> [--expected-version-code <positive-integer> | --unsigned-debug]');
    }
    if (args.length === 2) return { mode: 'aab', aabPath: args[1] };
    if (args.length === 3 && args[2] === '--unsigned-debug') return { mode: 'aab', aabPath: args[1], unsignedDebug: true };
    if (args[2] !== '--expected-version-code' || !/^[1-9]\d*$/.test(args[3])) {
      throw new Error('Unknown argument or invalid --expected-version-code positive integer');
    }
    const expectedVersionCode = Number(args[3]);
    if (!Number.isSafeInteger(expectedVersionCode)) {
      throw new Error('--expected-version-code must be a positive integer');
    }
    return { mode: 'aab', aabPath: args[1], expectedVersionCode };
  }
  throw new Error('Unknown argument; usage: --project <generated-project> or --aab <bundle>');
}

const localDebugBanner = [
  '',
  '!!! LOCAL-DEBUG ANDROID BUILD - NOT A RELEASE ARTIFACT !!!',
  'Icons and the embedded web manifest came from checked-in public/ files served on 127.0.0.1,',
  'not from the deployed origin. The app still opens https://pulseblr-u9f1.vercel.app, which has',
  'not been shown to serve this build; the bundle is UNSIGNED and debuggable, so Play rejects it',
  'and Digital Asset Links cannot verify it (the app will show a browser URL bar).',
  '',
].join('\n');

export function printLocalDebugBanner(): void {
  console.warn(localDebugBanner);
}

async function main(): Promise<void> {
  let command: AndroidVerifyCommand;
  try {
    command = parseAndroidVerifyArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  try {
    if (command.mode === 'aab') {
      const aabPath = path.resolve(command.aabPath);
      const metadata = verifyAab(aabPath, {
        expectedVersionCode: command.expectedVersionCode,
        allowUnsignedDebug: command.unsignedDebug,
      });
      console.log([
        `Android App Bundle: PASS (${statSync(aabPath).size} bytes, sha256 ${sha256File(aabPath)})`,
        `  package ${metadata.packageName}; versionCode ${metadata.versionCode}; versionName ${metadata.versionName}`,
        `  minSdk ${metadata.minSdk}; targetSdk ${metadata.targetSdk}; compileSdk ${metadata.compileSdk}; host ${metadata.hostName}`,
        `  ${metadata.shortcutUrls.length} shortcuts: ${metadata.shortcutUrls.join(' ')}`,
        `  icon resources present: ${REQUIRED_BUNDLE_ICON_RESOURCES.join(', ')}`,
        `  debuggable ${metadata.debuggable}; signed ${metadata.signed}${metadata.signed ? '' : ' (UNSIGNED debug bundle, accepted only via --unsigned-debug)'}`,
      ].join('\n'));
      if (readBuildMode(path.resolve('android')) === 'local-debug') printLocalDebugBanner();
    } else {
      const projectRoot = path.resolve(command.projectPath);
      const metadata = verifyGeneratedProject(projectRoot);
      const icons = await verifyGeneratedIcons(projectRoot, path.dirname(projectRoot));
      console.log(`Generated Android project: PASS (${metadata.applicationId}, version ${metadata.versionCode}, mode ${metadata.buildMode}, ${metadata.shortcutCount} shortcuts, ${icons} embedded icons byte-checked, web manifest byte-checked, Gradle ${GRADLE_DISTRIBUTION_SHA256.slice(0, 12)}... pinned, build-tools ${ANDROID_BUILD_TOOLS_VERSION})`);
      if (metadata.buildMode === 'local-debug') printLocalDebugBanner();
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main();
