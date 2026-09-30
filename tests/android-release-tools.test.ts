import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightProductionOrigin } from '../scripts/android-preflight';
import {
  LOCAL_DEBUG_FLAG,
  assertLocalDebugAllowed,
  changedJsonPaths,
  localDebugTwaManifest,
  parseGenerateArgs,
  postprocessGeneratedProject,
  renderShortcutUrlResources,
  runBubblewrapUpdate,
  runLocalDebugGeneration,
  startLocalAssetServer,
} from '../scripts/android-generate';
import {
  LOCAL_DEBUG_MARKER as GRADLE_LOCAL_DEBUG_MARKER,
  gradleMemoryArgs,
  runGradle,
} from '../scripts/android-gradle.mjs';
import {
  checkAndroidToolchain,
  validateAndroidSdk,
  validateJavaVersion,
} from '../scripts/android-toolchain';
import {
  BUBBLEWRAP_ASSETS,
  BUBBLEWRAP_ICON_RENDERS,
  GRADLE_DISTRIBUTION_SHA256,
  LOCAL_DEBUG_MARKER,
  RELEASE_CONTEXT_VARIABLES,
  bubblewrapIconRenderer,
  expectedEmbeddedWebManifest,
  parseAndroidVerifyArgs,
  parseGeneratedProject,
  releaseContextReasons,
  stripGradleComments,
  verifyAab,
  verifyGeneratedIcons,
  verifyGeneratedProject,
  verifyOriginAssets,
} from '../scripts/android-verify';

const root = path.resolve(import.meta.dirname, '..');
const template = path.join(root, 'node_modules', '@bubblewrap', 'core', 'template_project');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pulseblr-android-'));
  temporaryDirectories.push(directory);
  return directory;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
}

const productionWebManifestResValue = `resValue "string", "webManifestUrl", 'https://pulseblr-u9f1.vercel.app/manifest.json'`;

/** The checked-in inputs a generated project is compared against: public/manifest.json and twa-manifest.json. */
function writeRepositoryInputs(repositoryRoot: string): string {
  const androidRoot = path.join(repositoryRoot, 'android');
  mkdirSync(path.join(repositoryRoot, 'public'), { recursive: true });
  mkdirSync(androidRoot, { recursive: true });
  for (const asset of BUBBLEWRAP_ASSETS) copyFileSync(path.join(root, asset.file), path.join(repositoryRoot, asset.file));
  copyFileSync(path.join(root, 'android', 'twa-manifest.json'), path.join(androidRoot, 'twa-manifest.json'));
  return androidRoot;
}

/**
 * A minimal project in the shape the postprocess LEAVES: build-tools pinned, jcenter gone, the
 * Gradle checksum present, the real template wrapper jar, the production webManifestUrl and a
 * byte-exact embedded web manifest. Returns the android/ directory.
 */
function writeGeneratedProject(repositoryRoot: string): string {
  const projectRoot = writeRepositoryInputs(repositoryRoot);
  const resourceRoot = path.join(projectRoot, 'app', 'src', 'main', 'res');
  mkdirSync(path.join(resourceRoot, 'xml'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'values'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'raw'), { recursive: true });
  mkdirSync(path.join(projectRoot, 'gradle', 'wrapper'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'app', 'build.gradle'), `
    android {
      compileSdkVersion 36
      buildToolsVersion "36.0.0"
      defaultConfig {
        applicationId "app.pulseblr.twa"
        minSdkVersion 21
        targetSdkVersion 36
        versionCode 1
        versionName "1"
        ${productionWebManifestResValue}
      }
    }
  `);
  writeFileSync(path.join(projectRoot, 'build.gradle'), 'buildscript { repositories { google()\n mavenCentral() } }\nallprojects { repositories { google()\n mavenCentral() } }\n');
  writeFileSync(path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties'), [
    'distributionBase=GRADLE_USER_HOME',
    'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.11.1-bin.zip',
    `distributionSha256Sum=${GRADLE_DISTRIBUTION_SHA256}`,
    '',
  ].join('\n'));
  copyFileSync(path.join(template, 'gradle', 'wrapper', 'gradle-wrapper.jar'), path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'));
  writeFileSync(path.join(resourceRoot, 'raw', 'web_app_manifest.json'), expectedEmbeddedWebManifest(repositoryRoot, '/'));
  writeFileSync(path.join(resourceRoot, 'values', 'strings.xml'), `
    <resources>
      <string name="shortcut_scan_url">https://pulseblr-u9f1.vercel.app/scan</string>
      <string name="shortcut_card_url">https://pulseblr-u9f1.vercel.app/card</string>
      <string name="shortcut_feed_url">https://pulseblr-u9f1.vercel.app/</string>
      <string name="shortcut_tracker_url">https://pulseblr-u9f1.vercel.app/tracker</string>
      <string name="shortcut_calendar_url">https://pulseblr-u9f1.vercel.app/calendar</string>
    </resources>
  `);
  writeFileSync(path.join(resourceRoot, 'xml', 'shortcuts.xml'), `
    <shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
      <shortcut android:shortcutId="scan"><intent android:data="@string/shortcut_scan_url"/></shortcut>
      <shortcut android:shortcutId="card"><intent android:data="@string/shortcut_card_url"/></shortcut>
      <shortcut android:shortcutId="feed"><intent android:data="@string/shortcut_feed_url"/></shortcut>
      <shortcut android:shortcutId="tracker"><intent android:data="@string/shortcut_tracker_url"/></shortcut>
      <shortcut android:shortcutId="calendar"><intent android:data="@string/shortcut_calendar_url"/></shortcut>
    </shortcuts>
  `);
  return projectRoot;
}

/**
 * The shape Bubblewrap 1.25.0 leaves BEFORE the postprocess. The top-level build.gradle and the
 * gradle/wrapper files are copied from the real pinned template, so the jcenter/checksum pins are
 * tested against upstream's actual bytes rather than a hand-written approximation.
 */
function writeBubblewrapGeneratedRepository(repositoryRoot: string, webManifestResValue = productionWebManifestResValue): string {
  const androidRoot = writeRepositoryInputs(repositoryRoot);
  const resourceRoot = path.join(androidRoot, 'app', 'src', 'main', 'res');
  mkdirSync(path.join(resourceRoot, 'xml'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'values'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'raw'), { recursive: true });
  mkdirSync(path.join(androidRoot, 'gradle', 'wrapper'), { recursive: true });
  copyFileSync(path.join(template, 'build.gradle'), path.join(androidRoot, 'build.gradle'));
  for (const file of ['gradle-wrapper.properties', 'gradle-wrapper.jar']) {
    copyFileSync(path.join(template, 'gradle', 'wrapper', file), path.join(androidRoot, 'gradle', 'wrapper', file));
  }
  writeFileSync(path.join(resourceRoot, 'raw', 'web_app_manifest.json'), expectedEmbeddedWebManifest(repositoryRoot, '/'));
  writeFileSync(path.join(androidRoot, 'app', 'build.gradle'), `
import groovy.xml.MarkupBuilder

android {
    compileSdkVersion 36
    defaultConfig {
        applicationId "app.pulseblr.twa"
        minSdkVersion 21
        targetSdkVersion 36
        versionCode 1
        versionName "1"
        ${webManifestResValue}
    }
}

task generateShorcutsFile {
    assert twaManifest.shortcuts.size() < 5, "You can have at most 4 shortcuts."
    twaManifest.shortcuts.eachWithIndex { s, i ->
        assert s.name != null, 'Missing name'
        assert s.short_name != null, 'Missing short_name'
        assert s.url != null, 'Missing url'
        assert s.icon != null, 'Missing icon'
    }

    def shortcutsFile = new File("$projectDir/src/main/res/xml", "shortcuts.xml")
    def xmlWriter = new StringWriter()
    def xmlMarkup = new MarkupBuilder(new IndentPrinter(xmlWriter, "    ", true))
    xmlMarkup
        .'shortcuts'('xmlns:android': 'http://schemas.android.com/apk/res/android') {
            twaManifest.shortcuts.eachWithIndex { s, i ->
                'shortcut'(
                        'android:shortcutId': 'shortcut' + i,
                        'android:enabled': 'true',
                        'android:icon': '@drawable/' + s.icon,
                        'android:shortcutShortLabel': '@string/shortcut_short_name_' + i,
                        'android:shortcutLongLabel': '@string/shortcut_name_' + i) {
                    'intent'(
                            'android:action': 'android.intent.action.MAIN',
                            'android:targetPackage': twaManifest.applicationId,
                            'android:targetClass': twaManifest.applicationId + '.LauncherActivity',
                            'android:data': s.url)
                    'categories'('android:name': 'android.intent.category.LAUNCHER')
                }
            }
        }
    shortcutsFile.text = xmlWriter.toString() + '\\n'
}
  `);
  writeFileSync(path.join(resourceRoot, 'xml', 'shortcuts.xml'), '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android" />\n');
  writeFileSync(path.join(resourceRoot, 'values', 'strings.xml'), '<resources />\n');
  return androidRoot;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Android production-origin preflight', () => {
  const expectedReleaseId = '0123456789abcdef0123456789abcdef01234567';
  const routeMarkers: Record<string, string> = {
    '/': 'home',
    '/scan': 'scan',
    '/card': 'card',
    '/tracker': 'tracker',
    '/calendar': 'calendar',
    '/add-event': 'add-event',
    '/privacy': 'privacy',
    '/delete-account': 'delete-account',
  };

  function successfulFetch(requests: Array<{ url: string; init?: RequestInit }> = []): typeof fetch {
    const web = readJson('public/manifest.json');
    return async (input, init) => {
      const url = String(input);
      const pathname = new URL(url).pathname;
      requests.push({ url, init });
      if (pathname === '/api/release-identity') {
        return Response.json({ commitSha: expectedReleaseId }, { headers: { 'cache-control': 'no-store' } });
      }
      if (pathname === '/manifest.json') {
        return new Response(JSON.stringify(web), {
          status: 200,
          headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
        });
      }
      if (pathname.endsWith('.png')) {
        return new Response(readFileSync(path.join(root, 'public', pathname.slice(1))), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      const marker = routeMarkers[pathname];
      if (!marker) throw new Error(`unexpected test route ${pathname}`);
      return new Response(`<!doctype html><main data-pulseblr-route="${marker}"></main>`, {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };
  }

  it('requires the caller to supply an immutable expected deployed commit SHA', async () => {
    let requests = 0;
    await expect(preflightProductionOrigin({
      expectedReleaseId: '',
      fetchImpl: async () => { requests += 1; return new Response(); },
    })).rejects.toThrow(/expected.*commit|release.*required/i);
    expect(requests).toBe(0);
  });

  it('rejects a stale deployed release even when every response is direct and successful', async () => {
    const fetchImpl = successfulFetch();
    await expect(preflightProductionOrigin({
      expectedReleaseId: 'ffffffffffffffffffffffffffffffffffffffff',
      fetchImpl,
    })).rejects.toThrow(/deployed.*commit|release.*expected/i);
  });

  it('rejects a generic 200 fallback body that lacks the route-specific marker', async () => {
    const baseFetch = successfulFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      const pathname = new URL(String(input)).pathname;
      if (pathname === '/scan') {
        return new Response('<!doctype html><main data-pulseblr-route="home"></main>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      }
      return baseFetch(input, init);
    };

    await expect(preflightProductionOrigin({ expectedReleaseId, fetchImpl })).rejects.toThrow(/scan.*marker|route.*scan/i);
  });

  it('rejects a PNG response whose bytes differ from the checked-in approved asset', async () => {
    const baseFetch = successfulFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/icon-192.png') {
        return new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return baseFetch(input, init);
    };

    await expect(preflightProductionOrigin({ expectedReleaseId, fetchImpl })).rejects.toThrow(/icon-192.*bytes|SHA-256|approved/i);
  });

  it('rejects redirects and invalid response metadata before trusting content', async () => {
    const baseFetch = successfulFetch();
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/privacy') return Response.redirect('https://other.example/', 302);
      return baseFetch(input, init);
    };

    await expect(preflightProductionOrigin({ expectedReleaseId, fetchImpl })).rejects.toThrow(/privacy.*redirect|location/i);
  });

  it('rejects a semantically stale remote manifest', async () => {
    const baseFetch = successfulFetch();
    const staleWeb = readJson('public/manifest.json');
    staleWeb.theme_color = '#000000';
    const fetchImpl: typeof fetch = async (input, init) => {
      if (new URL(String(input)).pathname === '/manifest.json') {
        return new Response(JSON.stringify(staleWeb), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return baseFetch(input, init);
    };

    await expect(preflightProductionOrigin({ expectedReleaseId, fetchImpl })).rejects.toThrow(/theme-color|manifest/i);
  });

  it('accepts only the expected release, route markers, and exact checked-in icon bytes', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];

    await expect(preflightProductionOrigin({ expectedReleaseId, fetchImpl: successfulFetch(requests) })).resolves.toEqual({
      checked: 14,
      urls: [
        'https://pulseblr-u9f1.vercel.app/api/release-identity',
        'https://pulseblr-u9f1.vercel.app/manifest.json',
        'https://pulseblr-u9f1.vercel.app/',
        'https://pulseblr-u9f1.vercel.app/scan',
        'https://pulseblr-u9f1.vercel.app/card',
        'https://pulseblr-u9f1.vercel.app/tracker',
        'https://pulseblr-u9f1.vercel.app/calendar',
        'https://pulseblr-u9f1.vercel.app/add-event',
        'https://pulseblr-u9f1.vercel.app/privacy',
        'https://pulseblr-u9f1.vercel.app/delete-account',
        'https://pulseblr-u9f1.vercel.app/icon-512.png',
        'https://pulseblr-u9f1.vercel.app/icon-192.png',
        'https://pulseblr-u9f1.vercel.app/icon-maskable-512.png',
        // The notification small icon: Bubblewrap embeds it, so the deployed bytes are checked too.
        'https://pulseblr-u9f1.vercel.app/badge-96.png',
      ],
    });
    expect(requests.every(request => request.init?.redirect === 'manual')).toBe(true);
    expect(requests.every(request => request.init?.cache === 'no-store')).toBe(true);
  });
});

describe('generated Android project verification', () => {
  it('parses Gradle metadata and resolves shortcut URLs from string resources', () => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());

    expect(parseGeneratedProject(projectRoot)).toEqual({
      applicationId: 'app.pulseblr.twa',
      compileSdk: 36,
      targetSdk: 36,
      minSdk: 21,
      versionCode: 1,
      versionName: '1',
      shortcutCount: 5,
      shortcutPaths: ['/scan', '/card', '/', '/tracker', '/calendar'],
    });
  });

  it('rejects Java 11 and a missing Android 36 platform', () => {
    expect(() => validateJavaVersion('openjdk version "11.0.22"')).toThrow(/17/);
    expect(() => validateAndroidSdk({ platform36: false, buildTools36: true, platformTools: true })).toThrow(/android-36/);
  });

  it('accepts only Java major 17 and every required Android SDK component', () => {
    expect(validateJavaVersion('openjdk version "17.0.11" 2024-04-16')).toBe(17);
    expect(validateJavaVersion('java version "17"')).toBe(17);
    expect(() => validateJavaVersion('openjdk version "21.0.5"')).toThrow(/17/);
    expect(() => validateJavaVersion('not a java version')).toThrow(/version/i);
    expect(validateAndroidSdk({ platform36: true, buildTools36: true, platformTools: true })).toEqual({
      platform36: true,
      buildTools36: true,
      platformTools: true,
    });
    expect(() => validateAndroidSdk({ platform36: true, buildTools36: false, platformTools: true })).toThrow(/36\.0\.0/);
    expect(() => validateAndroidSdk({ platform36: true, buildTools36: true, platformTools: false })).toThrow(/platform-tools/);
  });

  it('checks configured toolchain paths through injected process and filesystem boundaries', () => {
    const toolRoot = temporaryDirectory();
    const javaHome = path.join(toolRoot, 'jdk');
    const sdkRoot = path.join(toolRoot, 'sdk');
    const expectedJava = path.join(javaHome, 'bin', 'java.exe');
    const requiredFiles = [
      expectedJava,
      path.join(sdkRoot, 'platforms', 'android-36', 'android.jar'),
      path.join(sdkRoot, 'build-tools', '36.0.0', 'aapt2.exe'),
      path.join(sdkRoot, 'platform-tools', 'adb.exe'),
    ];
    const calls: Array<{ command: string; args: readonly string[] }> = [];

    expect(checkAndroidToolchain({
      env: { JAVA_HOME: javaHome, ANDROID_HOME: sdkRoot },
      platform: 'win32',
      fileExists: file => requiredFiles.includes(file),
      run: (command, args) => {
        calls.push({ command, args });
        return { status: 0, stdout: '', stderr: 'openjdk version "17.0.11"' };
      },
    })).toEqual({ javaHome, sdkRoot, java: expectedJava, platform: path.join(sdkRoot, 'platforms', 'android-36', 'android.jar'), buildTools: path.join(sdkRoot, 'build-tools', '36.0.0', 'aapt2.exe'), platformTools: path.join(sdkRoot, 'platform-tools', 'adb.exe') });
    expect(calls).toEqual([{ command: expectedJava, args: ['-version'] }]);
  });

  it('fails closed when required toolchain configuration or Java execution is unavailable', () => {
    expect(() => checkAndroidToolchain({ env: {}, platform: 'linux' })).toThrow(/JAVA_HOME/);
    expect(() => checkAndroidToolchain({ env: { JAVA_HOME: '/jdk' }, platform: 'linux' })).toThrow(/ANDROID_SDK_ROOT|ANDROID_HOME/);
    expect(() => checkAndroidToolchain({
      env: { JAVA_HOME: '/jdk', ANDROID_SDK_ROOT: '/sdk' },
      platform: 'linux',
      fileExists: () => true,
      run: () => ({ status: 1, stdout: '', stderr: 'failed' }),
    })).toThrow(/java -version/i);
  });

  it('rejects direct or unresolved shortcut URLs instead of trusting IDs and counts', () => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());
    const shortcutsFile = path.join(projectRoot, 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
    writeFileSync(shortcutsFile, readFileSync(shortcutsFile, 'utf8').replace('@string/shortcut_scan_url', 'https://pulseblr-u9f1.vercel.app/scan'));
    expect(() => parseGeneratedProject(projectRoot)).toThrow(/@string|resource/i);

    writeGeneratedProject(path.dirname(projectRoot));
    writeFileSync(shortcutsFile, readFileSync(shortcutsFile, 'utf8').replace('@string/shortcut_scan_url', '@string/missing_url'));
    expect(() => parseGeneratedProject(projectRoot)).toThrow(/missing_url|resource/i);
  });

  it('requires the checked generated project to remain at initial version 1 and SDK 36', () => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());
    expect(verifyGeneratedProject(projectRoot)).toEqual(expect.objectContaining({ versionCode: 1, targetSdk: 36 }));

    const gradleFile = path.join(projectRoot, 'app', 'build.gradle');
    writeFileSync(gradleFile, readFileSync(gradleFile, 'utf8').replace('versionCode 1', 'versionCode 2'));
    expect(() => verifyGeneratedProject(projectRoot)).toThrow(/versionCode|1/);
  });

  it('rejects duplicate Gradle assignments that could override verified metadata later', () => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());
    const gradleFile = path.join(projectRoot, 'app', 'build.gradle');
    writeFileSync(gradleFile, `${readFileSync(gradleFile, 'utf8')}\nandroid.defaultConfig.targetSdkVersion 35\n`);

    expect(() => parseGeneratedProject(projectRoot)).toThrow(/targetSdk|duplicate|exactly once/i);
  });
});

describe('Android App Bundle verification', () => {
  const validManifestDump = `
    <manifest xmlns:android="http://schemas.android.com/apk/res/android" android:compileSdkVersion="36"
      package="app.pulseblr.twa" android:versionCode="42" android:versionName="2.0.0">
      <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="36"/>
      <application android:label="@string/appName"/>
    </manifest>
  `;
  const debuggableManifestDump = validManifestDump.replace('<application ', '<application android:debuggable="true" ');
  const origin = 'https://pulseblr-u9f1.vercel.app';
  /** Shaped like `bundletool dump resources --values` output measured on the real debug bundle. */
  function resourceDump(overrides: Record<string, string> = {}, extraNames: string[] = []): string {
    const strings: Record<string, string> = {
      hostName: 'pulseblr-u9f1.vercel.app',
      launchUrl: `${origin}/`,
      webManifestUrl: `${origin}/manifest.json`,
      shortcut_url_0: `${origin}/scan`,
      shortcut_url_1: `${origin}/card`,
      shortcut_url_2: `${origin}/`,
      shortcut_url_3: `${origin}/tracker`,
      shortcut_url_4: `${origin}/calendar`,
      ...overrides,
    };
    const lines = ['Package \'app.pulseblr.twa\':'];
    let id = 0x7f0f0000;
    for (const [name, value] of Object.entries(strings)) {
      lines.push(`0x${(id++).toString(16)} - string/${name}`, `\t(default) - [STR] "${value}"`);
    }
    for (const name of ['mipmap/ic_launcher', 'mipmap/ic_maskable', 'drawable/splash', 'drawable/ic_notification_icon',
      'drawable/shortcut_0', 'drawable/shortcut_1', 'drawable/shortcut_2', 'drawable/shortcut_3', 'drawable/shortcut_4', ...extraNames]) {
      lines.push(`0x${(id++).toString(16)} - ${name}`, '\t(default) - [FILE] res/x.png');
    }
    return lines.join('\n');
  }
  const bundleCommand = (manifest: string, resources = resourceDump()) => (args: readonly string[]) => {
    if (args.includes('resources')) return { status: 0, stdout: resources, stderr: '' };
    if (args.includes('dump')) return { status: 0, stdout: manifest, stderr: '' };
    return undefined;
  };

  function createBundleInputs(): { aab: string; bundletoolJar: string; javaHome: string } {
    const directory = temporaryDirectory();
    const aab = path.join(directory, 'app-release.aab');
    const bundletoolJar = path.join(directory, 'bundletool-all-1.18.3.jar');
    writeFileSync(aab, 'controlled bundle fixture');
    writeFileSync(bundletoolJar, 'controlled jar fixture');
    return { aab, bundletoolJar, javaHome: path.join(directory, 'jdk') };
  }

  it('hashes Bundletool before executing it and rejects every non-pinned jar', () => {
    const { aab, bundletoolJar, javaHome } = createBundleInputs();
    let commandCount = 0;

    expect(() => verifyAab(aab, {
      bundletoolJar,
      javaHome,
      platform: 'linux',
      fileExists: () => true,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      run: () => {
        commandCount += 1;
        return { status: 0, stdout: '', stderr: '' };
      },
    })).toThrow(/SHA-256|hash/i);
    expect(commandCount).toBe(0);
  });

  it('validates, dumps, parses, and signature-checks a bundle with an explicit release version', () => {
    const { aab, bundletoolJar, javaHome } = createBundleInputs();
    const commands: Array<{ command: string; args: readonly string[] }> = [];

    const metadata = verifyAab(aab, {
      bundletoolJar,
      javaHome,
      platform: 'linux',
      fileExists: () => true,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      hashFile: file => {
        expect(file).toBe(bundletoolJar);
        return 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
      },
      run: (command, args) => {
        commands.push({ command, args });
        if (args[0] === '-version') return { status: 0, stdout: '', stderr: 'openjdk version "17.0.11"' };
        if (args.includes('validate')) return { status: 0, stdout: '', stderr: '' };
        return bundleCommand(validManifestDump)(args) ?? { status: 0, stdout: 'jar verified.', stderr: '' };
      },
    });

    expect(metadata).toEqual({
      packageName: 'app.pulseblr.twa',
      versionCode: 42,
      versionName: '2.0.0',
      minSdk: 21,
      targetSdk: 36,
      compileSdk: 36,
      hostName: 'pulseblr-u9f1.vercel.app',
      shortcutUrls: [`${origin}/scan`, `${origin}/card`, `${origin}/`, `${origin}/tracker`, `${origin}/calendar`],
      debuggable: false,
      signed: true,
    });
    const java = path.join(javaHome, 'bin', 'java');
    const jarsigner = path.join(javaHome, 'bin', 'jarsigner');
    expect(commands).toEqual([
      { command: java, args: ['-version'] },
      { command: java, args: ['-jar', bundletoolJar, 'validate', `--bundle=${aab}`] },
      { command: java, args: ['-jar', bundletoolJar, 'dump', 'manifest', `--bundle=${aab}`, '--module=base'] },
      { command: java, args: ['-jar', bundletoolJar, 'dump', 'resources', `--bundle=${aab}`, '--values'] },
      { command: jarsigner, args: ['-verify', '-verbose', '-certs', '-strict', aab] },
    ]);
  });

  it('accepts only the explicit Android self-signed certificate policy under strict verification', () => {
    const { aab, bundletoolJar, javaHome } = createBundleInputs();
    expect(verifyAab(aab, {
      bundletoolJar,
      javaHome,
      platform: 'linux',
      fileExists: () => true,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      hashFile: () => 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29',
      run: (_command, args) => {
        if (args[0] === '-version') return { status: 0, stdout: '', stderr: 'openjdk version "17.0.11"' };
        if (args.includes('validate')) return { status: 0, stdout: '', stderr: '' };
        return bundleCommand(validManifestDump)(args) ?? {
          status: 24,
          stdout: 'jar verified, with signer errors.\nThis jar contains entries whose certificate chain is invalid.\nThis jar contains entries whose signer certificate is self-signed.',
          stderr: '',
        };
      },
    })).toEqual(expect.objectContaining({ versionCode: 42 }));
  });

  it('requires the same JAVA_HOME JDK 17 for Bundletool and jarsigner', () => {
    const { aab, bundletoolJar, javaHome } = createBundleInputs();
    const common = {
      bundletoolJar,
      platform: 'linux' as const,
      fileExists: () => true,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      hashFile: () => 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29',
    };
    expect(() => verifyAab(aab, { ...common, env: {} })).toThrow(/JAVA_HOME/);
    expect(() => verifyAab(aab, {
      ...common,
      javaHome,
      run: () => ({ status: 0, stdout: '', stderr: 'openjdk version "11.0.22"' }),
    })).toThrow(/17/);
  });

  it.each([
    ['Bundletool validation', { validateStatus: 1, dump: validManifestDump, signerStatus: 0, signer: 'jar verified.' }, /validate/i],
    ['manifest metadata', { validateStatus: 0, dump: validManifestDump.replace('targetSdkVersion="36"', 'targetSdkVersion="35"'), signerStatus: 0, signer: 'jar verified.' }, /targetSdk|36/i],
    ['unsigned output', { validateStatus: 0, dump: validManifestDump, signerStatus: 0, signer: 'This jar is unsigned.' }, /signed|signature/i],
    ['ambiguous signer output', { validateStatus: 0, dump: validManifestDump, signerStatus: 0, signer: 'verification completed' }, /signed|signature|verified/i],
    ['expired signer warning', { validateStatus: 0, dump: validManifestDump, signerStatus: 0, signer: 'jar verified.\nThe signer certificate has expired.' }, /signed|signature|valid|expired/i],
    ['strict expired status', { validateStatus: 0, dump: validManifestDump, signerStatus: 4, signer: 'jar verified, with signer errors.\nThe signer certificate has expired.' }, /signed|signature|valid|expired/i],
  ])('fails closed on invalid %s', (_label, fixture, message) => {
    const { aab, bundletoolJar, javaHome } = createBundleInputs();
    expect(() => verifyAab(aab, {
      bundletoolJar,
      javaHome,
      platform: 'linux',
      fileExists: () => true,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      hashFile: () => 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29',
      run: (_command, args) => {
        if (args[0] === '-version') return { status: 0, stdout: '', stderr: 'openjdk version "17.0.11"' };
        if (args.includes('validate')) return { status: fixture.validateStatus, stdout: '', stderr: '' };
        return bundleCommand(fixture.dump)(args) ?? { status: fixture.signerStatus, stdout: fixture.signer, stderr: '' };
      },
    })).toThrow(message);
  });

  // jarsigner -verbose output for the real AGP 8.9.1 app-debug.aab, measured 2026-09-27.
  const measuredUnsignedOutput = [
    '  s = signature was verified ',
    '  m = entry is listed in manifest',
    '  k = at least one certificate was found in keystore',
    '',
    'no manifest.',
    '',
    'jar is unsigned.',
  ].join('\n');

  function verifyWith(options: { manifest?: string; resources?: string; signer?: { status: number; stdout: string }; allowUnsignedDebug?: boolean }) {
    const { aab, bundletoolJar, javaHome } = createBundleInputs();
    return verifyAab(aab, {
      bundletoolJar,
      javaHome,
      platform: 'linux',
      fileExists: () => true,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      allowUnsignedDebug: options.allowUnsignedDebug,
      hashFile: () => 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29',
      run: (_command, args) => {
        if (args[0] === '-version') return { status: 0, stdout: '', stderr: 'openjdk version "17.0.11"' };
        if (args.includes('validate')) return { status: 0, stdout: '', stderr: '' };
        return bundleCommand(options.manifest ?? validManifestDump, options.resources ?? resourceDump())(args) ??
          { ...(options.signer ?? { status: 0, stdout: 'jar verified.' }), stderr: '' };
      },
    });
  }

  it('accepts the measured unsigned debug bundle only with --unsigned-debug and only when debuggable', () => {
    const unsigned = { status: 0, stdout: measuredUnsignedOutput };
    expect(verifyWith({ manifest: debuggableManifestDump, signer: unsigned, allowUnsignedDebug: true }))
      .toEqual(expect.objectContaining({ debuggable: true, signed: false }));
    expect(() => verifyWith({ manifest: debuggableManifestDump, signer: unsigned })).toThrow(/signature|unsigned/i);
    expect(() => verifyWith({ manifest: validManifestDump, signer: unsigned, allowUnsignedDebug: true })).toThrow(/debuggable/);
    expect(() => verifyWith({ manifest: debuggableManifestDump, signer: { status: 0, stdout: 'jar verified.' }, allowUnsignedDebug: true })).toThrow(/wholly unsigned/);
  });

  it.each([
    ['a loopback webManifestUrl', resourceDump({ webManifestUrl: 'http://127.0.0.1:5555/manifest.json' }), /webManifestUrl/],
    ['a different host', resourceDump({ hostName: 'evil.example' }), /hostName/],
    ['a shortcut on another path', resourceDump({ shortcut_url_0: `${origin}/other` }), /shortcut_url_0/],
    ['a sixth shortcut', resourceDump({ shortcut_url_5: `${origin}/extra` }), /exactly 5/],
    ['loopback anywhere in resources', resourceDump({ appName: 'see http://localhost:1' }), /loopback/],
    ['a missing icon family', resourceDump().replace('drawable/ic_notification_icon', 'drawable/other'), /ic_notification_icon/],
  ])('fails the bundle on %s', (_label, resources, message) => {
    expect(() => verifyWith({ resources })).toThrow(message);
  });

  it('fails the bundle on a compileSdk other than 36', () => {
    expect(() => verifyWith({ manifest: validManifestDump.replace('compileSdkVersion="36"', 'compileSdkVersion="35"') })).toThrow(/compileSdk/);
  });
});

describe('Android verification CLI grammar', () => {
  it('accepts only the documented project and AAB command forms', () => {
    expect(parseAndroidVerifyArgs(['--project', 'android'])).toEqual({ mode: 'project', projectPath: 'android' });
    expect(parseAndroidVerifyArgs(['--aab', 'app.aab'])).toEqual({ mode: 'aab', aabPath: 'app.aab' });
    expect(parseAndroidVerifyArgs(['--aab', 'app.aab', '--expected-version-code', '42'])).toEqual({
      mode: 'aab',
      aabPath: 'app.aab',
      expectedVersionCode: 42,
    });
    expect(parseAndroidVerifyArgs(['--aab', 'app.aab', '--unsigned-debug'])).toEqual({ mode: 'aab', aabPath: 'app.aab', unsignedDebug: true });
    expect(() => parseAndroidVerifyArgs(['--aab', 'app.aab', '--unsigned'])).toThrow(/argument|usage/i);
    expect(() => parseAndroidVerifyArgs(['--aab', 'app.aab', '--unsigned-debug', '--expected-version-code'])).toThrow(/argument|usage|positive/i);
  });

  it.each([
    ['misspelled release flag', ['--aab', 'app.aab', '--expected-vesion-code', '42']],
    ['duplicate release flag', ['--aab', 'app.aab', '--expected-version-code', '42', '--expected-version-code', '43']],
    ['extra project argument', ['--project', 'android', 'extra']],
    ['mixed modes', ['--aab', 'app.aab', '--project', 'android']],
    ['unknown mode', ['--verify', 'app.aab']],
  ])('rejects %s rather than ignoring it', (_label, args) => {
    expect(() => parseAndroidVerifyArgs(args)).toThrow(/argument|usage|unknown|positive integer/i);
  });
});

describe('deterministic Android command wrappers', () => {
  const validatedToolchain = {
    javaHome: path.resolve('controlled', 'jdk-17'),
    sdkRoot: path.resolve('controlled', 'android-sdk'),
    java: path.resolve('controlled', 'jdk-17', 'bin', 'java'),
    platform: path.resolve('controlled', 'android-sdk', 'platforms', 'android-36', 'android.jar'),
    buildTools: path.resolve('controlled', 'android-sdk', 'build-tools', '36.0.0', 'aapt2'),
    platformTools: path.resolve('controlled', 'android-sdk', 'platform-tools', 'adb'),
  };

  it('runs only the repository-local pinned Bubblewrap CLI from the generated project', () => {
    const repositoryRoot = temporaryDirectory();
    const controlledEnvironment = { PATH: 'controlled' };
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const sequence: string[] = [];
    let configPath = '';
    const status = runBubblewrapUpdate({
      repositoryRoot,
      env: controlledEnvironment,
      validateToolchain: () => validatedToolchain,
      run: (command, args, options) => {
        sequence.push('update');
        const configFlag = args.indexOf('--config');
        expect(configFlag).toBeGreaterThan(0);
        configPath = args[configFlag + 1];
        expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
          jdkPath: validatedToolchain.javaHome,
          androidSdkPath: validatedToolchain.sdkRoot,
        });
        calls.push({ command, args, options });
        return { status: 0 };
      },
      postprocess: processedRoot => {
        expect(processedRoot).toBe(repositoryRoot);
        sequence.push('postprocess');
      },
    });

    expect(status).toBe(0);
    expect(sequence).toEqual(['update', 'postprocess']);
    expect(calls).toEqual([{
      command: process.execPath,
      args: [
        path.join(repositoryRoot, 'node_modules', '@bubblewrap', 'cli', 'bin', 'bubblewrap.js'),
        'update',
        '--skipVersionUpgrade',
        '--config',
        configPath,
      ],
      options: {
        cwd: path.join(repositoryRoot, 'android'),
        env: controlledEnvironment,
        stdio: 'inherit',
      },
    }]);
    expect(existsSync(configPath)).toBe(false);
  });

  it('fails closed before starting Bubblewrap when the required JDK or SDK configuration is absent', () => {
    let processStarted = false;
    expect(() => runBubblewrapUpdate({
      env: {},
      run: () => { processStarted = true; return { status: 0 }; },
      postprocess: () => undefined,
    })).toThrow(/JAVA_HOME|required/i);
    expect(processStarted).toBe(false);
  });

  // A ceiling for a hang, not a performance claim. Measured 2026-09-27 on the Windows dev
  // machine (Defender real-time scanning, other dev servers and tsc running): `require()` of
  // Cli.js loads 1,628 modules / 23.9 MB even for `help`, because every command module and
  // @bubblewrap/core are imported eagerly. That took 5.2-6.7 s once those files had been read
  // recently, but 57 s, 88 s and 117 s for the first process to read them after a pause;
  // `Cli.run(['help', ...])` itself took 8-12 ms every time. The previous 45 s budget sat below
  // the cold figure, so spawnSync killed the child mid-require() and the test reported
  // "expected null to be +0", which reads as a behaviour change and was not one. Nothing below
  // is relaxed: prompting, downloading and config fallback are asserted on the output and the
  // filesystem, and a genuine hang still fails at this ceiling. The vitest timeout must sit
  // ABOVE it: vitest fails a synchronous test that returns late, so a slow success would
  // otherwise surface as a generic timeout instead of the spawn diagnostics.
  const REAL_CLI_BUDGET_MS = 240_000;

  it('loads the real pinned CLI from an explicit config under a fresh home without prompting or downloading', () => {
    const freshHome = temporaryDirectory();
    const configPath = path.join(freshHome, 'bubblewrap-config.json');
    const config = `${JSON.stringify({
      jdkPath: validatedToolchain.javaHome,
      androidSdkPath: validatedToolchain.sdkRoot,
    }, null, 2)}\n`;
    writeFileSync(configPath, config, { mode: 0o600 });
    const cliModule = path.join(root, 'node_modules', '@bubblewrap', 'cli', 'dist', 'lib', 'Cli.js');
    const invokeRealCli = [
      "const { Cli } = require(process.argv[1]);",
      "new Cli().run(['help', '--config', process.argv[2]])",
      "  .then(ok => process.exit(ok ? 0 : 1), error => { console.error(error); process.exit(1); });",
    ].join('\n');

    const result = spawnSync(process.execPath, ['-e', invokeRealCli, cliModule, configPath], {
      cwd: freshHome,
      encoding: 'utf8',
      input: '',
      timeout: REAL_CLI_BUDGET_MS,
      env: {
        ...process.env,
        HOME: freshHome,
        USERPROFILE: freshHome,
        APPDATA: path.join(freshHome, 'appdata'),
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error, `real Bubblewrap CLI spawn failed or exceeded the ${REAL_CLI_BUDGET_MS} ms budget (signal ${result.signal})\n${output}`).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).toMatch(/bubblewrap \[command\]/i);
    expect(output).not.toMatch(/download|install.*JDK|install.*Android SDK|terms.*conditions|\?\s*$/i);
    expect(readFileSync(configPath, 'utf8')).toBe(config);
    expect(existsSync(path.join(freshHome, '.bubblewrap'))).toBe(false);
  }, REAL_CLI_BUDGET_MS + 30_000);

  it('propagates Bubblewrap launch and command failures without falling back to a mutable executable', () => {
    let postprocessCalls = 0;
    const postprocess = () => { postprocessCalls += 1; };
    expect(runBubblewrapUpdate({ validateToolchain: () => validatedToolchain, run: () => ({ status: 9 }), postprocess })).toBe(9);
    expect(runBubblewrapUpdate({ validateToolchain: () => validatedToolchain, run: () => ({ status: null }), postprocess })).toBe(1);
    expect(postprocessCalls).toBe(0);
  });

  it('propagates a compatibility transformation failure after a successful update', () => {
    expect(() => runBubblewrapUpdate({
      validateToolchain: () => validatedToolchain,
      run: () => ({ status: 0 }),
      postprocess: () => { throw new Error('generated template drift'); },
    })).toThrow(/template drift/);
  });

  it('passes Bubblewrap only operational environment variables and strips credentials', () => {
    let childEnvironment: Record<string, string | undefined> | undefined;
    expect(runBubblewrapUpdate({
      env: {
        Path: 'C:\\Windows\\System32',
        SystemRoot: 'C:\\Windows',
        TEMP: 'C:\\Temp',
        CI: 'true',
        GITHUB_TOKEN: 'secret-token',
        AWS_SECRET_ACCESS_KEY: 'secret-key',
        NPM_TOKEN: 'npm-secret',
        HTTPS_PROXY: 'https://user:password@proxy.example',
        NODE_OPTIONS: '--require untrusted.js',
      },
      validateToolchain: () => validatedToolchain,
      run: (_command, _args, options) => {
        childEnvironment = options.env;
        return { status: 0 };
      },
      postprocess: () => undefined,
    })).toBe(0);
    expect(childEnvironment).toEqual({
      Path: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      CI: 'true',
    });
  });

  it.each([
    ['win32', 'gradlew.bat', true],
    ['linux', './gradlew', false],
  ] as const)('uses the platform wrapper with --no-daemon on %s', (platform, wrapper, shell) => {
    const repositoryRoot = temporaryDirectory();
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    expect(runGradle('bundleRelease', {
      repositoryRoot,
      platform,
      env: { PATH: 'controlled' },
      run: (command: string, args: readonly string[], options: Record<string, unknown>) => {
        calls.push({ command, args, options });
        return { status: 0 };
      },
    })).toBe(0);
    const jvmArgs = '-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m';
    expect(calls).toEqual([{
      // Absolute and quoted on Windows: cmd.exe skips the working directory when
      // NoDefaultCurrentDirectoryInExePath=1, which is set on the development machine.
      command: shell ? `"${path.join(repositoryRoot, 'android', wrapper)}"` : wrapper,
      // The .bat wrapper goes through a shell, so the one space-bearing argument is quoted there.
      args: ['--no-daemon', shell ? `"${jvmArgs}"` : jvmArgs, '-Dorg.gradle.workers.max=2', 'bundleRelease'],
      options: {
        cwd: path.join(repositoryRoot, 'android'),
        env: { PATH: 'controlled' },
        stdio: 'inherit',
        shell,
      },
    }]);
  });

  it('rejects every non-bundle Gradle task before starting a process', () => {
    let called = false;
    expect(() => runGradle('clean', { run: () => {
      called = true;
      return { status: 0 };
    } })).toThrow(/bundleDebug|bundleRelease/);
    expect(called).toBe(false);
  });
});

describe('Bubblewrap five-shortcut compatibility postprocessor', () => {
  it('materializes a verifiable five-shortcut project and patches the later Gradle generator', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);

    const metadata = postprocessGeneratedProject(repositoryRoot);

    expect(metadata).toEqual({
      shortcutCount: 5,
      shortcutPaths: ['/scan', '/card', '/', '/tracker', '/calendar'],
    });
    expect(verifyGeneratedProject(androidRoot)).toEqual(expect.objectContaining({
      shortcutCount: 5,
      shortcutPaths: ['/scan', '/card', '/', '/tracker', '/calendar'],
    }));
    const gradle = readFileSync(path.join(androidRoot, 'app', 'build.gradle'), 'utf8');
    expect(gradle).toContain('assert twaManifest.shortcuts.size() == 5');
    expect(gradle).toContain("'android:data': '@string/shortcut_url_' + i");
    expect(gradle).not.toContain("'android:data': s.url");
  });

  it.each([
    ['shortcut limit', 'assert twaManifest.shortcuts.size() < 5', 'assert twaManifest.shortcuts.size() < 6'],
    ['direct URL writer', "'android:data': s.url", "'android:data': s.uri"],
  ])('rejects upstream drift in the expected %s shape without partially writing artifacts', (_label, expected, drifted) => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    const gradleFile = path.join(androidRoot, 'app', 'build.gradle');
    const originalGradle = readFileSync(gradleFile, 'utf8').replace(expected, drifted);
    writeFileSync(gradleFile, originalGradle);

    expect(() => postprocessGeneratedProject(repositoryRoot)).toThrow(/Bubblewrap 1\.25\.0|template|replacement/i);
    expect(readFileSync(gradleFile, 'utf8')).toBe(originalGradle);
    expect(() => readFileSync(path.join(androidRoot, 'app', 'src', 'main', 'res', 'values', 'pulseblr_shortcut_urls.xml'))).toThrow();
  });

  it('rejects a non-empty upstream shortcuts artifact before mutating any generated file', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    const gradleFile = path.join(androidRoot, 'app', 'build.gradle');
    const shortcutsFile = path.join(androidRoot, 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
    const originalGradle = readFileSync(gradleFile, 'utf8');
    const driftedShortcuts = '<shortcuts xmlns:android="http://schemas.android.com/apk/res/android"><shortcut /></shortcuts>\n';
    writeFileSync(shortcutsFile, driftedShortcuts);

    expect(() => postprocessGeneratedProject(repositoryRoot)).toThrow(/empty|upstream|shortcuts/i);
    expect(readFileSync(gradleFile, 'utf8')).toBe(originalGradle);
    expect(readFileSync(shortcutsFile, 'utf8')).toBe(driftedShortcuts);
    expect(() => readFileSync(path.join(androidRoot, 'app', 'src', 'main', 'res', 'values', 'pulseblr_shortcut_urls.xml'))).toThrow();
  });

  it('restores every original when a late compatibility commit write fails', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    const gradleFile = path.join(androidRoot, 'app', 'build.gradle');
    const shortcutsFile = path.join(androidRoot, 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
    const resourcesFile = path.join(androidRoot, 'app', 'src', 'main', 'res', 'values', 'pulseblr_shortcut_urls.xml');
    writeFileSync(resourcesFile, '<resources><string name="previous">keep</string></resources>\n');
    const originals = [gradleFile, shortcutsFile, resourcesFile].map(file => readFileSync(file, 'utf8'));
    let commits = 0;

    expect(() => postprocessGeneratedProject(repositoryRoot, {
      commitStagedFile: (staged, target) => {
        commits += 1;
        if (commits === 3) throw new Error('simulated disk failure');
        copyFileSync(staged, target);
      },
    })).toThrow(/simulated disk failure|commit/i);
    expect([gradleFile, shortcutsFile, resourcesFile].map(file => readFileSync(file, 'utf8'))).toEqual(originals);
    expect(readdirSync(repositoryRoot).filter(name => name.startsWith('.pulseblr-android-stage-'))).toEqual([]);
  });

  it('rejects manifest shortcut drift before changing the generated project', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    const twaFile = path.join(androidRoot, 'twa-manifest.json');
    const twa = JSON.parse(readFileSync(twaFile, 'utf8')) as { shortcuts: unknown[] };
    twa.shortcuts = twa.shortcuts.slice(0, 4);
    writeFileSync(twaFile, JSON.stringify(twa));
    const gradleFile = path.join(androidRoot, 'app', 'build.gradle');
    const originalGradle = readFileSync(gradleFile, 'utf8');

    expect(() => postprocessGeneratedProject(repositoryRoot)).toThrow(/shortcut/i);
    expect(readFileSync(gradleFile, 'utf8')).toBe(originalGradle);
  });

  it('rejects web shortcut query drift even when Task 1 path parity still matches', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    const webFile = path.join(repositoryRoot, 'public', 'manifest.json');
    const web = JSON.parse(readFileSync(webFile, 'utf8')) as { shortcuts: Array<{ url: string }> };
    web.shortcuts[0].url = '/scan?unexpected=1';
    writeFileSync(webFile, JSON.stringify(web));
    const gradleFile = path.join(androidRoot, 'app', 'build.gradle');
    const originalGradle = readFileSync(gradleFile, 'utf8');

    expect(() => postprocessGeneratedProject(repositoryRoot)).toThrow(/exact|shortcut|query/i);
    expect(readFileSync(gradleFile, 'utf8')).toBe(originalGradle);
  });

  it('XML-escapes resource values deterministically', () => {
    expect(renderShortcutUrlResources(['https://example.test/<scan>?a=1&b="two"'])).toContain(
      'https://example.test/&lt;scan&gt;?a=1&amp;b=&quot;two&quot;',
    );
  });

  it('pins the Gradle checksum, replaces both jcenter() repositories and pins build-tools 36.0.0', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    postprocessGeneratedProject(repositoryRoot);
    const wrapper = readFileSync(path.join(androidRoot, 'gradle', 'wrapper', 'gradle-wrapper.properties'), 'utf8');
    expect(wrapper).toContain(`distributionSha256Sum=${GRADLE_DISTRIBUTION_SHA256}`);
    expect(readFileSync(path.join(androidRoot, 'build.gradle'), 'utf8')).not.toMatch(/jcenter\(\)/);
    expect(readFileSync(path.join(androidRoot, 'app', 'build.gradle'), 'utf8')).toContain('buildToolsVersion "36.0.0"');
  });

  it('restores the embedded webManifestUrl from the local-debug origin to production', () => {
    const repositoryRoot = temporaryDirectory();
    const origin = 'http://127.0.0.1:43210';
    const androidRoot = writeBubblewrapGeneratedRepository(
      repositoryRoot,
      `resValue "string", "webManifestUrl", '${origin}/manifest.json'`,
    );
    postprocessGeneratedProject(repositoryRoot, { localDebugAssetOrigin: origin });
    expect(readFileSync(path.join(androidRoot, 'app', 'build.gradle'), 'utf8')).toContain(productionWebManifestResValue);
    expect(verifyGeneratedProject(androidRoot, { env: {} }).buildMode).toBe('deployed-origin');
  });

  it('rejects template drift in the jcenter count before writing anything', () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeBubblewrapGeneratedRepository(repositoryRoot);
    const rootGradle = path.join(androidRoot, 'build.gradle');
    writeFileSync(rootGradle, readFileSync(rootGradle, 'utf8').replace('jcenter()', 'mavenCentral()'));
    const appGradle = path.join(androidRoot, 'app', 'build.gradle');
    const before = readFileSync(appGradle, 'utf8');
    expect(() => postprocessGeneratedProject(repositoryRoot)).toThrow(/jcenter/);
    expect(readFileSync(appGradle, 'utf8')).toBe(before);
  });
});

describe('local-debug generation', () => {
  it('parses only the documented generation flags', () => {
    expect(parseGenerateArgs([])).toEqual({ mode: 'deployed-origin' });
    expect(parseGenerateArgs([LOCAL_DEBUG_FLAG])).toEqual({ mode: 'local-debug' });
    expect(() => parseGenerateArgs(['--local'])).toThrow(/usage/i);
    expect(() => parseGenerateArgs([LOCAL_DEBUG_FLAG, 'extra'])).toThrow(/usage/i);
  });

  it.each([
    ['GitHub Actions', { GITHUB_ACTIONS: 'true' }],
    ['CI', { CI: 'true' }],
    ['lower-case Windows env name', { ci: '1' }],
    ...RELEASE_CONTEXT_VARIABLES.map(name => [`${name} (even empty)`, { [name]: '' }] as [string, Record<string, string>]),
  ])('refuses --local-debug in a release context: %s', (_label, env) => {
    expect(() => assertLocalDebugAllowed(env, '/android', () => [])).toThrow(/Refusing --local-debug/);
  });

  it('refuses --local-debug when a keystore is present in android/', () => {
    expect(() => assertLocalDebugAllowed({}, '/android', () => ['twa-manifest.json', 'android.keystore'])).toThrow(/android\.keystore/);
    expect(() => assertLocalDebugAllowed({ CI: 'false', PATH: 'x' }, '/android', () => ['twa-manifest.json'])).not.toThrow();
  });

  it('refuses before starting the toolchain check, the server or Bubblewrap', async () => {
    const repositoryRoot = temporaryDirectory();
    writeRepositoryInputs(repositoryRoot);
    let touched = false;
    await expect(runLocalDebugGeneration({
      repositoryRoot,
      env: { ANDROID_UPLOAD_KEYSTORE_PASSWORD: 'x' },
      validateToolchain: () => { touched = true; throw new Error('unreachable'); },
      run: async () => { touched = true; return { status: 0 }; },
    })).rejects.toThrow(/Refusing --local-debug/);
    expect(touched).toBe(false);
    expect(existsSync(path.join(repositoryRoot, 'android', LOCAL_DEBUG_MARKER))).toBe(false);
  });

  it('moves only the asset URL fields to loopback and keeps host, package, start URL and shortcuts', () => {
    const twa = readJson('android/twa-manifest.json');
    const local = localDebugTwaManifest(twa, 'http://127.0.0.1:5555');
    expect(changedJsonPaths(twa, local).sort()).toEqual([
      'iconUrl', 'maskableIconUrl', 'monochromeIconUrl', 'shortcuts.0.chosenIconUrl', 'shortcuts.1.chosenIconUrl',
      'shortcuts.2.chosenIconUrl', 'shortcuts.3.chosenIconUrl', 'shortcuts.4.chosenIconUrl', 'webManifestUrl',
    ]);
    expect(local.iconUrl).toBe('http://127.0.0.1:5555/icon-512.png');
    expect(local.monochromeIconUrl).toBe('http://127.0.0.1:5555/badge-96.png');
    for (const field of ['host', 'packageId', 'startUrl', 'fullScopeUrl', 'shareTarget', 'appVersionCode']) {
      expect(local[field]).toEqual(twa[field]);
    }
    expect((local.shortcuts as Array<{ url: string }>).map(s => s.url)).toEqual((twa.shortcuts as Array<{ url: string }>).map(s => s.url));
  });

  it('rejects a non-loopback asset origin and asset URLs outside the served table', () => {
    const twa = readJson('android/twa-manifest.json');
    expect(() => localDebugTwaManifest(twa, 'http://0.0.0.0:5555')).toThrow(/127\.0\.0\.1/);
    expect(() => localDebugTwaManifest(twa, 'https://evil.example')).toThrow(/127\.0\.0\.1/);
    expect(() => localDebugTwaManifest({ ...twa, iconUrl: 'https://pulseblr-u9f1.vercel.app/icon-96.png' }, 'http://127.0.0.1:5555')).toThrow(/served asset/);
    expect(() => localDebugTwaManifest({ ...twa, iconUrl: 'https://other.example/icon-512.png' }, 'http://127.0.0.1:5555')).toThrow(/served asset/);
  });

  it('accounts for every field Bubblewrap fetches: monochromeIconUrl is rewritten, never passed through or dropped', () => {
    // A fetched URL the rewrite skipped would be downloaded from PRODUCTION, where the loopback
    // server cannot see it, so each one is either rewritten or refused. Nothing slips through.
    const twa = readJson('android/twa-manifest.json');
    const origin = 'http://127.0.0.1:5555';
    const withoutMonochrome = structuredClone(twa);
    delete withoutMonochrome.monochromeIconUrl;
    expect(() => localDebugTwaManifest(withoutMonochrome, origin)).toThrow(/monochromeIconUrl must be a URL string/);
    expect(() => localDebugTwaManifest({ ...twa, monochromeIconUrl: 'https://pulseblr-u9f1.vercel.app/icon-96.png' }, origin)).toThrow(/monochromeIconUrl .*served asset/);
    expect(() => localDebugTwaManifest({ ...twa, monochromeIconUrl: 'https://other.example/badge-96.png' }, origin)).toThrow(/monochromeIconUrl .*served asset/);
    // The shortcut icon variants are still outside the asset table, so they are still refused.
    for (const variant of ['chosenMaskableIconUrl', 'chosenMonochromeIconUrl']) {
      const withVariant = structuredClone(twa);
      (withVariant.shortcuts as Array<Record<string, unknown>>)[2][variant] = 'https://pulseblr-u9f1.vercel.app/badge-96.png';
      expect(() => localDebugTwaManifest(withVariant, origin)).toThrow(/shortcut 2 icon variants/);
    }
  });

  it('serves exactly the checked-in bytes on 127.0.0.1 and records every other request', async () => {
    const server = await startLocalAssetServer(root);
    try {
      expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      for (const asset of BUBBLEWRAP_ASSETS) {
        const response = await fetch(`${server.origin}${asset.route}`);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe(asset.contentType);
        expect(Buffer.from(await response.arrayBuffer()).equals(readFileSync(path.join(root, asset.file)))).toBe(true);
      }
      expect((await fetch(`${server.origin}/sw.js`)).status).toBe(404);
      expect((await fetch(`${server.origin}/icon-512.png?x=1`)).status).toBe(404);
      expect((await fetch(`${server.origin}/icon-512.png`, { method: 'POST' })).status).toBe(405);
      expect(server.unexpected).toEqual(['GET /sw.js', 'GET /icon-512.png?x=1', 'POST /icon-512.png']);
    } finally {
      await server.close();
    }
  });

  const toolchain = {
    javaHome: '/jdk', sdkRoot: '/sdk', java: '/jdk/bin/java', platform: '/p', buildTools: '/b', platformTools: '/t',
  };

  async function fakeBubblewrap(args: readonly string[], extraPath?: string, skip?: string): Promise<{ status: number }> {
    const manifest = JSON.parse(readFileSync(args[args.indexOf('--manifest') + 1], 'utf8')) as Record<string, unknown>;
    const urls = [manifest.iconUrl, manifest.maskableIconUrl, manifest.monochromeIconUrl, manifest.webManifestUrl,
      ...(manifest.shortcuts as Array<{ chosenIconUrl: string }>).map(s => s.chosenIconUrl)] as string[];
    for (const url of urls.filter(url => !skip || !url.endsWith(skip))) await (await fetch(url)).arrayBuffer();
    if (extraPath) await (await fetch(new URL(extraPath, String(manifest.iconUrl)))).arrayBuffer();
    return { status: 0 };
  }

  it('hands Bubblewrap a temporary manifest, marks the output and passes the loopback origin to the postprocess', async () => {
    const repositoryRoot = temporaryDirectory();
    const androidRoot = writeRepositoryInputs(repositoryRoot);
    const checkedIn = readFileSync(path.join(androidRoot, 'twa-manifest.json'));
    let postprocessOrigin: string | undefined;
    let verified = false;
    expect(await runLocalDebugGeneration({
      repositoryRoot,
      env: { PATH: 'x' },
      validateToolchain: () => toolchain,
      run: async (_command, args) => {
        expect(args[args.indexOf('--manifest') + 1]).not.toBe(path.join(androidRoot, 'twa-manifest.json'));
        expect(existsSync(path.join(androidRoot, LOCAL_DEBUG_MARKER))).toBe(true);
        return fakeBubblewrap(args);
      },
      postprocess: (_root, options) => { postprocessOrigin = options.localDebugAssetOrigin; },
      verify: () => { verified = true; },
      log: () => undefined,
    })).toBe(0);
    expect(postprocessOrigin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(verified).toBe(true);
    expect(readFileSync(path.join(androidRoot, 'twa-manifest.json')).equals(checkedIn)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(androidRoot, LOCAL_DEBUG_MARKER), 'utf8'))).toEqual(expect.objectContaining({ mode: 'local-debug', releaseArtifact: false }));
  });

  it.each([
    ['an unexpected request', '/sw.js', undefined, /outside the local-debug table/],
    ['an asset Bubblewrap never fetched', undefined, '/manifest.json', /never fetched/],
  ])('fails closed on %s', async (_label, extraPath, skip, message) => {
    const repositoryRoot = temporaryDirectory();
    writeRepositoryInputs(repositoryRoot);
    let postprocessed = false;
    await expect(runLocalDebugGeneration({
      repositoryRoot,
      env: {},
      validateToolchain: () => toolchain,
      run: async (_command, args) => fakeBubblewrap(args, extraPath, skip),
      postprocess: () => { postprocessed = true; },
      verify: () => undefined,
      log: () => undefined,
    })).rejects.toThrow(message);
    expect(postprocessed).toBe(false);
  });
});

describe('origin asset bytes before deployed-origin generation', () => {
  function originFetch(override: (route: string) => Response | undefined = () => undefined, manifestCrlf = false): typeof fetch {
    return async input => {
      const route = new URL(String(input)).pathname;
      const custom = override(route);
      if (custom) return custom;
      const asset = BUBBLEWRAP_ASSETS.find(candidate => candidate.route === route);
      if (!asset) return new Response('', { status: 404 });
      let bytes = readFileSync(path.join(root, asset.file));
      if (route === '/manifest.json') {
        const lf = bytes.toString('utf8').replace(/\r\n/g, '\n');
        bytes = Buffer.from(manifestCrlf ? lf.replace(/\n/g, '\r\n') : lf);
      }
      return new Response(bytes, { status: 200, headers: { 'content-type': asset.contentType } });
    };
  }

  it('accepts origin bytes equal to the checked-in files (manifest compared as git stores it, LF)', async () => {
    const routes = (checks: Array<{ url: string }>) => checks.map(check => new URL(check.url).pathname);
    const expected = ['/icon-512.png', '/icon-192.png', '/icon-maskable-512.png', '/badge-96.png', '/manifest.json'];
    expect(routes(await verifyOriginAssets({ repositoryRoot: root, fetchImpl: originFetch() }))).toEqual(expected);
    expect(routes(await verifyOriginAssets({ repositoryRoot: root, fetchImpl: originFetch(undefined, true) }))).toEqual(expected);
  });

  it.each([
    ['a different icon', (route: string) => route === '/icon-192.png' ? new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } }) : undefined, /SHA-256/],
    ['a stale manifest', (route: string) => route === '/manifest.json' ? new Response('{}', { headers: { 'content-type': 'application/json' } }) : undefined, /SHA-256/],
    ['a 404 icon (stale deploy)', (route: string) => route === '/icon-512.png' ? new Response('', { status: 404 }) : undefined, /200/],
    ['a redirect', (route: string) => route === '/icon-maskable-512.png' ? new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }) : undefined, /redirect/],
    ['an HTML fallback', (route: string) => route === '/icon-512.png' ? new Response('<html>', { headers: { 'content-type': 'text/html' } }) : undefined, /image\/png/],
  ])('fails closed on %s', async (_label, override, message) => {
    await expect(verifyOriginAssets({ repositoryRoot: root, fetchImpl: originFetch(override) })).rejects.toThrow(message);
  });
});

describe('generated project build integrity and embedded bytes', () => {
  function mutateFile(file: string, before: string | RegExp, after: string): void {
    const source = readFileSync(file, 'utf8');
    const next = source.replace(before, after);
    expect(next, `mutation did not land in ${file}`).not.toBe(source);
    writeFileSync(file, next);
  }

  it.each([
    ['missing Gradle checksum', 'gradle/wrapper/gradle-wrapper.properties', /distributionSha256Sum=.*\n/, '', /distributionSha256Sum/],
    ['wrong Gradle checksum', 'gradle/wrapper/gradle-wrapper.properties', GRADLE_DISTRIBUTION_SHA256, '0'.repeat(64), /distributionSha256Sum/],
    ['another Gradle distribution', 'gradle/wrapper/gradle-wrapper.properties', '8.11.1', '8.12', /distributionUrl/],
    ['jcenter() still present', 'build.gradle', 'mavenCentral() } }\nallprojects', 'jcenter() } }\nallprojects', /jcenter/],
    ['unpinned build-tools', 'app/build.gradle', /\s*buildToolsVersion "36\.0\.0"/, '', /buildToolsVersion/],
    ['other build-tools', 'app/build.gradle', 'buildToolsVersion "36.0.0"', 'buildToolsVersion "35.0.0"', /buildToolsVersion/],
    ['loopback webManifestUrl', 'app/build.gradle', 'https://pulseblr-u9f1.vercel.app/manifest.json', 'http://127.0.0.1:5555/manifest.json', /webManifestUrl/],
    ['loopback elsewhere', 'app/src/main/res/values/strings.xml', '</resources>', '<string name="x">http://localhost:1/</string></resources>', /loopback/],
    ['a stale embedded manifest', 'app/src/main/res/raw/web_app_manifest.json', '#FAF9F5', '#000000', /web_app_manifest/],
  ])('rejects %s', (_label, file, before, after, message) => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());
    expect(verifyGeneratedProject(projectRoot, { env: {} }).buildMode).toBe('deployed-origin');
    mutateFile(path.join(projectRoot, file), before, after);
    expect(() => verifyGeneratedProject(projectRoot, { env: {} })).toThrow(message);
  });

  it('rejects a wrapper jar that is not the pinned official Gradle jar', () => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());
    writeFileSync(path.join(projectRoot, 'gradle', 'wrapper', 'gradle-wrapper.jar'), 'not the wrapper');
    expect(() => verifyGeneratedProject(projectRoot, { env: {} })).toThrow(/wrapper jar/);
  });

  it('keeps URLs inside Gradle strings while stripping real comments', () => {
    expect(stripGradleComments(`a 'https://x.test/y' // gone\nb "c//d" /* gone */ e`)).toBe(`a 'https://x.test/y' \nb "c//d"  e`);
  });

  it('reports local-debug and refuses it in a release or CI context', () => {
    const projectRoot = writeGeneratedProject(temporaryDirectory());
    writeFileSync(path.join(projectRoot, LOCAL_DEBUG_MARKER), '{}');
    expect(verifyGeneratedProject(projectRoot, { env: {} }).buildMode).toBe('local-debug');
    expect(() => verifyGeneratedProject(projectRoot, { env: { GITHUB_ACTIONS: 'true' } })).toThrow(/LOCAL-DEBUG/);
    expect(() => verifyGeneratedProject(projectRoot, { env: { ANDROID_UPLOAD_SHA256: 'x' } })).toThrow(/LOCAL-DEBUG/);
    expect(releaseContextReasons({ CI: 'false' })).toEqual([]);
  });

  const fakeRender = (source: Buffer, size: number, bg: string | undefined) =>
    Promise.resolve(Buffer.from(`${createHash('sha256').update(source).digest('hex')}:${size}:${bg ?? ''}`));
  const expectedFake = (route: string, size: number, bg: string | undefined) => {
    const asset = BUBBLEWRAP_ASSETS.find(candidate => candidate.route === route)!;
    return Buffer.from(`${createHash('sha256').update(readFileSync(path.join(root, asset.file))).digest('hex')}:${size}:${bg ?? ''}`);
  };

  it('requires every embedded PNG to be the rendering of the checked-in source, and no other PNG', async () => {
    const repositoryRoot = temporaryDirectory();
    const projectRoot = writeGeneratedProject(repositoryRoot);
    for (const icon of BUBBLEWRAP_ICON_RENDERS) {
      for (const [file, size] of icon.outputs) {
        mkdirSync(path.dirname(path.join(projectRoot, file)), { recursive: true });
        writeFileSync(path.join(projectRoot, file), expectedFake(icon.route, size, icon.withBackground ? '#FAF9F5' : undefined));
      }
    }
    expect(await verifyGeneratedIcons(projectRoot, repositoryRoot, { renderIcon: fakeRender })).toBe(46);

    const splash = path.join(projectRoot, 'app/src/main/res/drawable-xxhdpi/splash.png');
    const original = readFileSync(splash);
    writeFileSync(splash, expectedFake('/icon-192.png', 900, '#FAF9F5'));
    await expect(verifyGeneratedIcons(projectRoot, repositoryRoot, { renderIcon: fakeRender })).rejects.toThrow(/splash\.png/);
    writeFileSync(splash, original);

    writeFileSync(path.join(projectRoot, 'app/src/main/res/drawable-mdpi/unexpected.png'), 'x');
    await expect(verifyGeneratedIcons(projectRoot, repositoryRoot, { renderIcon: fakeRender })).rejects.toThrow(/unexpected\.png/);
  });
});

describe('Android notification small icon', () => {
  // Android draws a small icon from its ALPHA CHANNEL ONLY. Bubblewrap renders it from
  // `monochromeIconUrl || iconUrl`, and with no monochromeIconUrl that was the opaque launcher tile:
  // a solid grey square on every notification.
  const notificationRenders = BUBBLEWRAP_ICON_RENDERS.filter(render =>
    render.outputs.some(([file]) => file.endsWith('/ic_notification_icon.png')));

  it('is verified as a rendering of the badge that twa-manifest.json names, never of the iconUrl tile', () => {
    expect(notificationRenders).toHaveLength(1);
    const [render] = notificationRenders;
    expect(render.route).toBe('/badge-96.png');
    expect(render.outputs.map(([, size]) => size)).toEqual([24, 36, 48, 72, 96]);
    expect(render.outputs.every(([file]) => file.endsWith('/ic_notification_icon.png'))).toBe(true);
    const twa = readJson('android/twa-manifest.json');
    expect(twa.monochromeIconUrl).toBe(`https://pulseblr-u9f1.vercel.app${render.route}`);
    expect(BUBBLEWRAP_ASSETS.find(asset => asset.route === render.route)?.file).toBe('public/badge-96.png');
  });

  async function alphaOf(png: Buffer) {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    const alpha = (x: number, y: number) => data[(y * info.width + x) * 4 + 3];
    let transparent = 0;
    let opaque = 0;
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] === 0) transparent += 1;
      if (data[index] === 255) opaque += 1;
    }
    const pixels = info.width * info.height;
    return {
      corners: [alpha(0, 0), alpha(info.width - 1, 0), alpha(0, info.height - 1), alpha(info.width - 1, info.height - 1)],
      transparent: transparent / pixels,
      opaque: opaque / pixels,
    };
  }

  // Bubblewrap's OWN renderer, the one verify-generated compares against. Its first load in a
  // process was measured at 21 s on the dev machine (Defender scanning Jimp); warm it is ~1 s.
  it('keeps a transparent ground through Bubblewrap\'s own renderer at every density, where the tile renders opaque', async () => {
    const render = bubblewrapIconRenderer(root);
    const badge = readFileSync(path.join(root, 'public', 'badge-96.png'));
    const tile = readFileSync(path.join(root, 'public', 'icon-512.png'));
    for (const [, size] of notificationRenders[0].outputs) {
      const fromBadge = await alphaOf(await render(badge, size, undefined));
      expect(fromBadge.corners, `${size}px corners`).toEqual([0, 0, 0, 0]);
      // Measured 85-91% transparent, 3.6-7.1% fully opaque: a trace on nothing.
      expect(fromBadge.transparent, `${size}px transparent share`).toBeGreaterThan(0.8);
      expect(fromBadge.opaque, `${size}px opaque share`).toBeGreaterThan(0);
      // The control: the source this replaced has no transparent pixel at all, i.e. a square.
      expect((await alphaOf(await render(tile, size, undefined))).transparent, `${size}px tile`).toBe(0);
    }
  }, 180_000);
});

describe('Gradle runner memory bounds and local-debug refusal', () => {
  it('shares the local-debug marker name with the verifier', () => {
    expect(GRADLE_LOCAL_DEBUG_MARKER).toBe(LOCAL_DEBUG_MARKER);
  });

  it('refuses bundleRelease on a local-debug project but still allows bundleDebug', () => {
    const repositoryRoot = temporaryDirectory();
    mkdirSync(path.join(repositoryRoot, 'android'));
    writeFileSync(path.join(repositoryRoot, 'android', LOCAL_DEBUG_MARKER), '{}');
    let calls = 0;
    const run = () => { calls += 1; return { status: 0 }; };
    expect(() => runGradle('bundleRelease', { repositoryRoot, platform: 'linux', env: {}, run })).toThrow(/LOCAL-DEBUG/);
    expect(calls).toBe(0);
    expect(runGradle('bundleDebug', { repositoryRoot, platform: 'linux', env: {}, run })).toBe(0);
    expect(calls).toBe(1);
  });

  it('bounds the build JVM by default and honours validated overrides', () => {
    expect(gradleMemoryArgs({})).toEqual(['-Dorg.gradle.jvmargs=-Xmx1024m -XX:MaxMetaspaceSize=512m', '-Dorg.gradle.workers.max=2']);
    expect(gradleMemoryArgs({ PULSEBLR_GRADLE_JVMARGS: '-Xmx768m', PULSEBLR_GRADLE_WORKERS_MAX: '1' }))
      .toEqual(['-Dorg.gradle.jvmargs=-Xmx768m', '-Dorg.gradle.workers.max=1']);
    expect(() => gradleMemoryArgs({ PULSEBLR_GRADLE_JVMARGS: '-XX:+UseG1GC' })).toThrow(/-Xmx/);
    expect(() => gradleMemoryArgs({ PULSEBLR_GRADLE_JVMARGS: '-Xmx1g\n-Dx=1' })).toThrow(/single line/);
    expect(() => gradleMemoryArgs({ PULSEBLR_GRADLE_WORKERS_MAX: '0' })).toThrow(/positive/);
  });
});
