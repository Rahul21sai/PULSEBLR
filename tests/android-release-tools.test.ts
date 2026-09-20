import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightProductionOrigin } from '../scripts/android-preflight';
import {
  postprocessGeneratedProject,
  renderShortcutUrlResources,
  runBubblewrapUpdate,
} from '../scripts/android-generate';
import { runGradle } from '../scripts/android-gradle.mjs';
import {
  checkAndroidToolchain,
  validateAndroidSdk,
  validateJavaVersion,
} from '../scripts/android-toolchain';
import { parseGeneratedProject, verifyAab, verifyGeneratedProject } from '../scripts/android-verify';

const root = path.resolve(import.meta.dirname, '..');
const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'pulseblr-android-'));
  temporaryDirectories.push(directory);
  return directory;
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
}

function writeGeneratedProject(projectRoot: string): void {
  const resourceRoot = path.join(projectRoot, 'app', 'src', 'main', 'res');
  mkdirSync(path.join(resourceRoot, 'xml'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'values'), { recursive: true });
  writeFileSync(path.join(projectRoot, 'app', 'build.gradle'), `
    android {
      compileSdkVersion 36
      defaultConfig {
        applicationId "app.pulseblr.twa"
        minSdkVersion 21
        targetSdkVersion 36
        versionCode 1
        versionName "1"
      }
    }
  `);
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
}

function writeBubblewrapGeneratedRepository(repositoryRoot: string): string {
  const androidRoot = path.join(repositoryRoot, 'android');
  const resourceRoot = path.join(androidRoot, 'app', 'src', 'main', 'res');
  mkdirSync(path.join(repositoryRoot, 'public'), { recursive: true });
  mkdirSync(path.join(resourceRoot, 'xml'), { recursive: true });
  writeFileSync(path.join(repositoryRoot, 'public', 'manifest.json'), readFileSync(path.join(root, 'public', 'manifest.json')));
  writeFileSync(path.join(androidRoot, 'twa-manifest.json'), readFileSync(path.join(root, 'android', 'twa-manifest.json')));
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
  return androidRoot;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('Android production-origin preflight', () => {
  it('rejects redirects and stops before reading redirected content', async () => {
    const web = readJson('public/manifest.json');
    const requested: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith('/manifest.json')) {
        return new Response(JSON.stringify(web), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return Response.redirect('https://other.example/', 302);
    };

    await expect(preflightProductionOrigin(fetchImpl)).rejects.toThrow(/manifest|redirect/i);
    expect(requested.length).toBeLessThan(12);
  });

  it.each([
    ['a non-200 response', new Response('unavailable', { status: 503, headers: { 'content-type': 'text/html' } }), /200/],
    ['a Location header on status 200', new Response('moved', { status: 200, headers: { 'content-type': 'text/html', location: '/other' } }), /location|redirect/i],
    ['the wrong media type', new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }), /content-type|text\/html/i],
  ])('rejects %s', async (_label, failedResponse, message) => {
    const web = readJson('public/manifest.json');
    const fetchImpl: typeof fetch = async input => {
      if (String(input).endsWith('/manifest.json')) {
        return new Response(JSON.stringify(web), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return failedResponse.clone();
    };

    await expect(preflightProductionOrigin(fetchImpl)).rejects.toThrow(message);
  });

  it('rejects a semantically stale remote manifest', async () => {
    const web = readJson('public/manifest.json');
    web.theme_color = '#000000';
    const fetchImpl: typeof fetch = async input => {
      if (String(input).endsWith('/manifest.json')) {
        return new Response(JSON.stringify(web), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      throw new Error('preflight should stop at the stale manifest');
    };

    await expect(preflightProductionOrigin(fetchImpl)).rejects.toThrow(/theme-color|manifest/i);
  });

  it('accepts only direct successful responses for every required route and asset', async () => {
    const web = readJson('public/manifest.json');
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith('/manifest.json')) {
        return new Response(JSON.stringify(web), {
          status: 200,
          headers: { 'content-type': 'application/manifest+json; charset=utf-8' },
        });
      }
      if (url.endsWith('.png')) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          status: 200,
          headers: { 'content-type': 'image/png' },
        });
      }
      return new Response('<!doctype html><title>PulseBLR</title>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    };

    await expect(preflightProductionOrigin(fetchImpl)).resolves.toEqual({
      checked: 12,
      urls: [
        'https://pulseblr-u9f1.vercel.app/manifest.json',
        'https://pulseblr-u9f1.vercel.app/',
        'https://pulseblr-u9f1.vercel.app/scan',
        'https://pulseblr-u9f1.vercel.app/card',
        'https://pulseblr-u9f1.vercel.app/tracker',
        'https://pulseblr-u9f1.vercel.app/calendar',
        'https://pulseblr-u9f1.vercel.app/add-event',
        'https://pulseblr-u9f1.vercel.app/privacy',
        'https://pulseblr-u9f1.vercel.app/delete-account',
        'https://pulseblr-u9f1.vercel.app/icon-192.png',
        'https://pulseblr-u9f1.vercel.app/icon-512.png',
        'https://pulseblr-u9f1.vercel.app/icon-maskable-512.png',
      ],
    });
    expect(requests.every(request => request.init?.redirect === 'manual')).toBe(true);
    expect(requests.every(request => request.init?.cache === 'no-store')).toBe(true);
  });
});

describe('generated Android project verification', () => {
  it('parses Gradle metadata and resolves shortcut URLs from string resources', () => {
    const projectRoot = temporaryDirectory();
    writeGeneratedProject(projectRoot);

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
    const projectRoot = temporaryDirectory();
    writeGeneratedProject(projectRoot);
    const shortcutsFile = path.join(projectRoot, 'app', 'src', 'main', 'res', 'xml', 'shortcuts.xml');
    writeFileSync(shortcutsFile, readFileSync(shortcutsFile, 'utf8').replace('@string/shortcut_scan_url', 'https://pulseblr-u9f1.vercel.app/scan'));
    expect(() => parseGeneratedProject(projectRoot)).toThrow(/@string|resource/i);

    writeGeneratedProject(projectRoot);
    writeFileSync(shortcutsFile, readFileSync(shortcutsFile, 'utf8').replace('@string/shortcut_scan_url', '@string/missing_url'));
    expect(() => parseGeneratedProject(projectRoot)).toThrow(/missing_url|resource/i);
  });

  it('requires the checked generated project to remain at initial version 1 and SDK 36', () => {
    const projectRoot = temporaryDirectory();
    writeGeneratedProject(projectRoot);
    expect(verifyGeneratedProject(projectRoot)).toEqual(expect.objectContaining({ versionCode: 1, targetSdk: 36 }));

    const gradleFile = path.join(projectRoot, 'app', 'build.gradle');
    writeFileSync(gradleFile, readFileSync(gradleFile, 'utf8').replace('versionCode 1', 'versionCode 2'));
    expect(() => verifyGeneratedProject(projectRoot)).toThrow(/versionCode|1/);
  });
});

describe('Android App Bundle verification', () => {
  const validManifestDump = `
    <manifest xmlns:android="http://schemas.android.com/apk/res/android"
      package="app.pulseblr.twa" android:versionCode="42" android:versionName="2.0.0">
      <uses-sdk android:minSdkVersion="21" android:targetSdkVersion="36"/>
    </manifest>
  `;

  function createBundleInputs(): { aab: string; bundletoolJar: string } {
    const directory = temporaryDirectory();
    const aab = path.join(directory, 'app-release.aab');
    const bundletoolJar = path.join(directory, 'bundletool-all-1.18.3.jar');
    writeFileSync(aab, 'controlled bundle fixture');
    writeFileSync(bundletoolJar, 'controlled jar fixture');
    return { aab, bundletoolJar };
  }

  it('hashes Bundletool before executing it and rejects every non-pinned jar', () => {
    const { aab, bundletoolJar } = createBundleInputs();
    let commandCount = 0;

    expect(() => verifyAab(aab, {
      bundletoolJar,
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
    const { aab, bundletoolJar } = createBundleInputs();
    const commands: Array<{ command: string; args: readonly string[] }> = [];

    const metadata = verifyAab(aab, {
      bundletoolJar,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      hashFile: file => {
        expect(file).toBe(bundletoolJar);
        return 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
      },
      run: (command, args) => {
        commands.push({ command, args });
        if (args.includes('validate')) return { status: 0, stdout: '', stderr: '' };
        if (args.includes('dump')) return { status: 0, stdout: validManifestDump, stderr: '' };
        return { status: 0, stdout: 'jar verified.', stderr: '' };
      },
    });

    expect(metadata).toEqual({
      packageName: 'app.pulseblr.twa',
      versionCode: 42,
      versionName: '2.0.0',
      minSdk: 21,
      targetSdk: 36,
    });
    expect(commands).toEqual([
      { command: 'java', args: ['-jar', bundletoolJar, 'validate', `--bundle=${aab}`] },
      { command: 'java', args: ['-jar', bundletoolJar, 'dump', 'manifest', `--bundle=${aab}`, '--module=base'] },
      { command: 'jarsigner', args: ['-verify', '-verbose', '-certs', aab] },
    ]);
  });

  it.each([
    ['Bundletool validation', { validateStatus: 1, dump: validManifestDump, signer: 'jar verified.' }, /validate/i],
    ['manifest metadata', { validateStatus: 0, dump: validManifestDump.replace('targetSdkVersion="36"', 'targetSdkVersion="35"'), signer: 'jar verified.' }, /targetSdk|36/i],
    ['unsigned output', { validateStatus: 0, dump: validManifestDump, signer: 'This jar is unsigned.' }, /signed|signature/i],
    ['ambiguous signer output', { validateStatus: 0, dump: validManifestDump, signer: 'verification completed' }, /signed|signature|verified/i],
  ])('fails closed on invalid %s', (_label, fixture, message) => {
    const { aab, bundletoolJar } = createBundleInputs();
    expect(() => verifyAab(aab, {
      bundletoolJar,
      expectedVersionCode: 42,
      expectedVersionName: '2.0.0',
      hashFile: () => 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29',
      run: (_command, args) => {
        if (args.includes('validate')) return { status: fixture.validateStatus, stdout: '', stderr: '' };
        if (args.includes('dump')) return { status: 0, stdout: fixture.dump, stderr: '' };
        return { status: 0, stdout: fixture.signer, stderr: '' };
      },
    })).toThrow(message);
  });
});

describe('deterministic Android command wrappers', () => {
  it('runs only the repository-local pinned Bubblewrap CLI from the generated project', () => {
    const repositoryRoot = temporaryDirectory();
    const controlledEnvironment = { PATH: 'controlled' };
    const calls: Array<{ command: string; args: readonly string[]; options: unknown }> = [];
    const sequence: string[] = [];
    const status = runBubblewrapUpdate({
      repositoryRoot,
      env: controlledEnvironment,
      run: (command, args, options) => {
        sequence.push('update');
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
      args: [path.join(repositoryRoot, 'node_modules', '@bubblewrap', 'cli', 'bin', 'bubblewrap.js'), 'update', '--skipVersionUpgrade'],
      options: {
        cwd: path.join(repositoryRoot, 'android'),
        env: controlledEnvironment,
        stdio: 'inherit',
      },
    }]);
  });

  it('propagates Bubblewrap launch and command failures without falling back to a mutable executable', () => {
    let postprocessCalls = 0;
    const postprocess = () => { postprocessCalls += 1; };
    expect(runBubblewrapUpdate({ run: () => ({ status: 9 }), postprocess })).toBe(9);
    expect(runBubblewrapUpdate({ run: () => ({ status: null }), postprocess })).toBe(1);
    expect(postprocessCalls).toBe(0);
  });

  it('propagates a compatibility transformation failure after a successful update', () => {
    expect(() => runBubblewrapUpdate({
      run: () => ({ status: 0 }),
      postprocess: () => { throw new Error('generated template drift'); },
    })).toThrow(/template drift/);
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
    expect(calls).toEqual([{
      command: wrapper,
      args: ['--no-daemon', 'bundleRelease'],
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
});
