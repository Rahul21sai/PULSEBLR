import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

interface ChildResult {
  status: number | null;
}

export interface BubblewrapSpawnOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  stdio: 'inherit';
}

export interface BubblewrapUpdateOptions {
  repositoryRoot?: string;
  env?: Record<string, string | undefined>;
  run?: (command: string, args: readonly string[], options: BubblewrapSpawnOptions) => ChildResult;
}

export function runBubblewrapUpdate(options: BubblewrapUpdateOptions = {}): number {
  const repositoryRoot = options.repositoryRoot ?? process.cwd();
  const env = options.env ?? process.env;
  const cli = path.join(repositoryRoot, 'node_modules', '@bubblewrap', 'cli', 'bin', 'bubblewrap.js');
  const run = options.run ?? ((command, args, spawnOptions) => spawnSync(command, [...args], {
    ...spawnOptions,
    env: spawnOptions.env as NodeJS.ProcessEnv,
  }));
  const child = run(process.execPath, [cli, 'update', '--skipVersionUpgrade'], {
    cwd: path.join(repositoryRoot, 'android'),
    env,
    stdio: 'inherit',
  });
  return child.status === 0 ? 0 : (child.status ?? 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runBubblewrapUpdate();
}
