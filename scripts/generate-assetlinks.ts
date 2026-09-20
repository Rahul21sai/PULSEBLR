import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssetLinks, expectedAssetLinkFingerprints } from '../lib/digital-asset-links';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const assetLinksFile = path.join(repositoryRoot, 'public', '.well-known', 'assetlinks.json');

export function generateAssetLinksJson(environment: NodeJS.ProcessEnv): string {
  return `${JSON.stringify(createAssetLinks(expectedAssetLinkFingerprints(environment)), null, 2)}\n`;
}

export function shouldWriteAssetLinks(args: readonly string[]): boolean {
  return args.includes('--write');
}

async function main(): Promise<void> {
  try {
    const json = generateAssetLinksJson(process.env);
    if (shouldWriteAssetLinks(process.argv.slice(2))) {
      mkdirSync(path.dirname(assetLinksFile), { recursive: true });
      writeFileSync(assetLinksFile, json, 'utf8');
      return;
    }
    process.stdout.write(json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
