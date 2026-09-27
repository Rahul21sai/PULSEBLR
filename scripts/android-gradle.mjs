/**
 * Runs the generated project's Gradle wrapper for exactly one bundle task.
 *
 * Memory: the Bubblewrap template's gradle.properties sets org.gradle.jvmargs=-Xmx1536m, and with
 * --no-daemon Gradle forks a single-use build JVM with those args on top of the launcher JVM and
 * AAPT2. The development machine this runs on has had 1-3 GB free while browsers and tsc run
 * alongside, so the default can push it into swap or an OOM kill. The build JVM is therefore
 * bounded here by -D system properties, which take precedence over the project's gradle.properties
 * (Gradle's documented order: command line > GRADLE_USER_HOME > project). Both are overridable per
 * process, never written to disk:
 *   PULSEBLR_GRADLE_JVMARGS      default "-Xmx1024m -XX:MaxMetaspaceSize=512m"
 *   PULSEBLR_GRADLE_WORKERS_MAX  default 2
 *
 * bundleRelease is refused on a LOCAL-DEBUG project (android/pulseblr-local-debug.json): its icons
 * came from loopback, not the deployed origin, so it must never become a release candidate.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedTasks = new Set(['bundleDebug', 'bundleRelease']);

// Must equal LOCAL_DEBUG_MARKER in scripts/android-verify.ts (pinned by a test).
export const LOCAL_DEBUG_MARKER = 'pulseblr-local-debug.json';
export const DEFAULT_GRADLE_JVMARGS = '-Xmx1024m -XX:MaxMetaspaceSize=512m';
export const DEFAULT_GRADLE_WORKERS_MAX = '2';

/** @param {Record<string, string | undefined>} env */
export function gradleMemoryArgs(env) {
  const jvmArgs = env.PULSEBLR_GRADLE_JVMARGS ?? DEFAULT_GRADLE_JVMARGS;
  const workers = env.PULSEBLR_GRADLE_WORKERS_MAX ?? DEFAULT_GRADLE_WORKERS_MAX;
  if (!jvmArgs.trim() || /[\r\n"]/.test(jvmArgs) || !/-Xmx\d+[mMgG]\b/.test(jvmArgs)) {
    throw new Error('PULSEBLR_GRADLE_JVMARGS must be a single line containing an -Xmx bound');
  }
  if (!/^[1-9]\d{0,2}$/.test(workers)) {
    throw new Error('PULSEBLR_GRADLE_WORKERS_MAX must be a positive integer');
  }
  return [`-Dorg.gradle.jvmargs=${jvmArgs.trim()}`, `-Dorg.gradle.workers.max=${workers}`];
}

export function runGradle(task, options = {}) {
  if (!allowedTasks.has(task)) {
    throw new Error('Gradle task must be bundleDebug or bundleRelease');
  }
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileExists = options.fileExists ?? existsSync;
  const androidRoot = path.join(repositoryRoot, 'android');
  if (task === 'bundleRelease' && fileExists(path.join(androidRoot, LOCAL_DEBUG_MARKER))) {
    throw new Error(`Refusing bundleRelease: android/ holds a LOCAL-DEBUG project (${LOCAL_DEBUG_MARKER}); regenerate from the deployed origin`);
  }
  const memoryArgs = gradleMemoryArgs(env);
  // Absolute on Windows: with NoDefaultCurrentDirectoryInExePath=1 (set on the dev machine, and a
  // common hardening default) cmd.exe does not search the working directory, so a bare
  // `gradlew.bat` failed with "is not recognized" before Gradle ever started.
  const wrapper = platform === 'win32' ? `"${path.join(androidRoot, 'gradlew.bat')}"` : './gradlew';
  const run = options.run ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions));
  // On Windows the wrapper is a .bat run through a shell; quote the one argument with spaces.
  const args = platform === 'win32'
    ? ['--no-daemon', ...memoryArgs.map(arg => (/\s/.test(arg) ? `"${arg}"` : arg)), task]
    : ['--no-daemon', ...memoryArgs, task];
  const child = run(wrapper, args, {
    cwd: androidRoot,
    env,
    stdio: 'inherit',
    shell: platform === 'win32',
  });
  return child.status === 0 ? 0 : (child.status ?? 1);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('Usage: android-gradle.mjs <bundleDebug|bundleRelease>');
    process.exitCode = 1;
    return;
  }
  try {
    process.exitCode = runGradle(args[0]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
