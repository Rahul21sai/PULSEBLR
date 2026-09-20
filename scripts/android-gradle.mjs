import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const allowedTasks = new Set(['bundleDebug', 'bundleRelease']);

export function runGradle(task, options = {}) {
  if (!allowedTasks.has(task)) {
    throw new Error('Gradle task must be bundleDebug or bundleRelease');
  }
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const wrapper = platform === 'win32' ? 'gradlew.bat' : './gradlew';
  const run = options.run ?? ((command, args, spawnOptions) => spawnSync(command, args, spawnOptions));
  const child = run(wrapper, ['--no-daemon', task], {
    cwd: path.join(repositoryRoot, 'android'),
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
