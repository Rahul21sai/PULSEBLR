import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertWebAndTwaParity } from '../lib/mobile-release-contract';

const root = path.resolve(import.meta.dirname, '..');

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(root, file), 'utf8')) as Record<string, unknown>;
}

try {
  assertWebAndTwaParity(
    readJson('public/manifest.json'),
    readJson('android/twa-manifest.json'),
  );
  console.log('Android manifest contract: PASS');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
