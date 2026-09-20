import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export interface AndroidSdkAvailability {
  platform36: boolean;
  buildTools36: boolean;
  platformTools: boolean;
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface ToolchainCheckOptions {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  fileExists?: (file: string) => boolean;
  run?: (command: string, args: readonly string[]) => CommandResult;
}

export interface AndroidToolchainPaths {
  javaHome: string;
  sdkRoot: string;
  java: string;
  platform: string;
  buildTools: string;
  platformTools: string;
}

export function validateJavaVersion(versionOutput: string): number {
  const match = /(?:openjdk|java) version\s+"(\d+)(?:[._][^"]*)?"/i.exec(versionOutput);
  if (!match) throw new Error('Unable to determine the Java version; JDK 17 is required');
  const major = Number(match[1]);
  if (major !== 17) throw new Error(`JDK 17 is required (detected Java ${major})`);
  return major;
}

export function validateAndroidSdk(availability: AndroidSdkAvailability): AndroidSdkAvailability {
  if (!availability.platform36) throw new Error('Android SDK platforms/android-36/android.jar is required');
  if (!availability.buildTools36) throw new Error('Android SDK build-tools/36.0.0/aapt2 is required');
  if (!availability.platformTools) throw new Error('Android SDK platform-tools/adb is required');
  return availability;
}

export function checkAndroidToolchain(options: ToolchainCheckOptions = {}): AndroidToolchainPaths {
  const env = options.env ?? process.env;
  const platformName = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;
  const run = options.run ?? ((command, args) => {
    const result = spawnSync(command, [...args], { encoding: 'utf8', windowsHide: true });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  });
  const javaHome = env.JAVA_HOME;
  if (!javaHome) throw new Error('JAVA_HOME is required');
  const sdkRoot = env.ANDROID_SDK_ROOT ?? env.ANDROID_HOME;
  if (!sdkRoot) throw new Error('ANDROID_SDK_ROOT is required (ANDROID_HOME is accepted as a compatibility alias)');

  const executableSuffix = platformName === 'win32' ? '.exe' : '';
  const java = path.join(javaHome, 'bin', `java${executableSuffix}`);
  const platform = path.join(sdkRoot, 'platforms', 'android-36', 'android.jar');
  const buildTools = path.join(sdkRoot, 'build-tools', '36.0.0', `aapt2${executableSuffix}`);
  const platformTools = path.join(sdkRoot, 'platform-tools', `adb${executableSuffix}`);
  if (!fileExists(java)) throw new Error('JAVA_HOME does not contain bin/java');

  const javaResult = run(java, ['-version']);
  if (javaResult.status !== 0) throw new Error('java -version failed');
  validateJavaVersion(`${javaResult.stdout}\n${javaResult.stderr}`);
  validateAndroidSdk({
    platform36: fileExists(platform),
    buildTools36: fileExists(buildTools),
    platformTools: fileExists(platformTools),
  });
  return { javaHome, sdkRoot, java, platform, buildTools, platformTools };
}

function main(): void {
  try {
    const paths = checkAndroidToolchain();
    console.log(`JAVA_HOME: ${paths.javaHome}`);
    console.log(`Android SDK: ${paths.sdkRoot}`);
    console.log(`Android platform: ${paths.platform}`);
    console.log(`Android build tools: ${paths.buildTools}`);
    console.log(`Android platform tools: ${paths.platformTools}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
