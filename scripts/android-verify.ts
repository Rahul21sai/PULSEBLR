import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import {
  ANDROID_PACKAGE_ID,
  MIN_ANDROID_SDK,
  PRODUCTION_ORIGIN,
  REQUIRED_ANDROID_SDK,
} from '../lib/mobile-release-contract';

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
  javaBin?: string;
  jarsignerBin?: string;
  hashFile?: (file: string) => string;
  run?: (command: string, args: readonly string[]) => CommandResult;
}

const bundletoolSha256 = 'a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29';
const bundletoolFilename = 'bundletool-all-1.18.3.jar';

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

function requiredMatch(source: string, pattern: RegExp, field: string): string {
  const match = pattern.exec(source);
  if (!match) throw new Error(`Generated Gradle artifact is missing ${field}`);
  return match[1];
}

function parseGradle(projectRoot: string): Omit<GeneratedProjectMetadata, 'shortcutCount' | 'shortcutPaths'> {
  const candidates = [path.join(projectRoot, 'app', 'build.gradle'), path.join(projectRoot, 'app', 'build.gradle.kts')];
  const gradleFile = candidates.find(existsSync);
  if (!gradleFile) throw new Error('Generated project is missing app/build.gradle');
  const source = readFileSync(gradleFile, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const number = (pattern: RegExp, field: string) => Number(requiredMatch(source, pattern, field));
  return {
    applicationId: requiredMatch(source, /\bapplicationId\s*(?:=\s*)?["']([^"']+)["']/, 'applicationId'),
    compileSdk: number(/\bcompileSdk(?:Version)?\s*(?:=\s*)?(\d+)/, 'compileSdk'),
    targetSdk: number(/\btargetSdk(?:Version)?\s*(?:=\s*)?(\d+)/, 'targetSdk'),
    minSdk: number(/\bminSdk(?:Version)?\s*(?:=\s*)?(\d+)/, 'minSdk'),
    versionCode: number(/\bversionCode\s*(?:=\s*)?(\d+)/, 'versionCode'),
    versionName: requiredMatch(source, /\bversionName\s*(?:=\s*)?["']([^"']+)["']/, 'versionName'),
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

export function verifyGeneratedProject(projectRoot: string): GeneratedProjectMetadata {
  const actual = parseGeneratedProject(projectRoot);
  for (const [field, expected] of Object.entries(initialProjectMetadata)) {
    const received = actual[field as keyof GeneratedProjectMetadata];
    if (JSON.stringify(received) !== JSON.stringify(expected)) {
      throw new Error(`Generated project ${field} must be ${JSON.stringify(expected)} (received ${JSON.stringify(received)})`);
    }
  }
  return actual;
}

function sha256File(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
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

function defaultBundletoolJar(): string {
  return process.env.BUNDLETOOL_JAR ?? path.join(homedir(), '.cache', 'bundletool', bundletoolFilename);
}

export function verifyAab(aabPath: string, options: VerifyAabOptions = {}): AabMetadata {
  if (!existsSync(aabPath)) throw new Error('Android App Bundle does not exist');
  const bundletoolJar = options.bundletoolJar ?? defaultBundletoolJar();
  if (!existsSync(bundletoolJar)) throw new Error(`Bundletool ${bundletoolFilename} is required`);

  const projectMetadata = options.expectedVersionCode === undefined || options.expectedVersionName === undefined
    ? parseGeneratedProject(options.projectRoot ?? path.resolve('android'))
    : undefined;
  const expectedVersionCode = options.expectedVersionCode ?? projectMetadata?.versionCode;
  const expectedVersionName = options.expectedVersionName ?? projectMetadata?.versionName;
  if (!Number.isInteger(expectedVersionCode) || Number(expectedVersionCode) <= 0) {
    throw new Error('Expected AAB versionCode must be a positive integer');
  }
  if (!expectedVersionName) throw new Error('Expected AAB versionName must be non-empty');

  const hash = (options.hashFile ?? sha256File)(bundletoolJar);
  if (hash.toLowerCase() !== bundletoolSha256) {
    throw new Error(`Bundletool SHA-256 must match the pinned ${bundletoolFilename} digest`);
  }

  const run = options.run ?? ((command, args) => {
    const result = spawnSync(command, [...args], { encoding: 'utf8', windowsHide: true });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  const java = options.javaBin ?? 'java';
  const jarsigner = options.jarsignerBin ?? 'jarsigner';
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

  const signature = run(jarsigner, ['-verify', '-verbose', '-certs', aabPath]);
  const signatureOutput = `${signature.stdout}\n${signature.stderr}`;
  if (
    signature.status !== 0 ||
    !/\bjar verified\./i.test(signatureOutput) ||
    /\b(?:unsigned|not signed|signer error|signature (?:invalid|error))\b/i.test(signatureOutput)
  ) {
    throw new Error('AAB signature verification failed or the bundle is unsigned');
  }
  return metadata;
}

function main(): void {
  const aabFlag = process.argv.indexOf('--aab');
  if (aabFlag !== -1) {
    const aabArgument = process.argv[aabFlag + 1];
    if (!aabArgument || aabArgument.startsWith('--')) {
      console.error('Usage: android-verify.ts --aab <bundle> [--expected-version-code <positive-integer>]');
      process.exitCode = 1;
      return;
    }
    const expectedFlag = process.argv.indexOf('--expected-version-code');
    const expectedArgument = expectedFlag === -1 ? undefined : process.argv[expectedFlag + 1];
    const expectedVersionCode = expectedArgument === undefined ? undefined : Number(expectedArgument);
    if (expectedArgument !== undefined && (!Number.isInteger(expectedVersionCode) || Number(expectedVersionCode) <= 0)) {
      console.error('--expected-version-code must be a positive integer');
      process.exitCode = 1;
      return;
    }
    try {
      const metadata = verifyAab(path.resolve(aabArgument), { expectedVersionCode });
      console.log(`Android App Bundle: PASS (${metadata.packageName}, version ${metadata.versionCode})`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
    return;
  }
  const projectFlag = process.argv.indexOf('--project');
  if (projectFlag === -1 || !process.argv[projectFlag + 1]) {
    console.error('Usage: android-verify.ts --project <generated-project>');
    process.exitCode = 1;
    return;
  }
  try {
    const metadata = verifyGeneratedProject(path.resolve(process.argv[projectFlag + 1]));
    console.log(`Generated Android project: PASS (${metadata.applicationId}, version ${metadata.versionCode})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
