import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createAssetLinks, expectedAssetLinkFingerprints, type AssetLinkEnvironment } from '../lib/digital-asset-links';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const assetLinksFile = path.join(repositoryRoot, 'public', '.well-known', 'assetlinks.json');

export function generateAssetLinksJson(environment: AssetLinkEnvironment): string {
  return `${JSON.stringify(createAssetLinks(expectedAssetLinkFingerprints(environment)), null, 2)}\n`;
}

export function shouldWriteAssetLinks(args: readonly string[]): boolean {
  if (!args.length) return false;
  if (args.length === 1 && args[0] === '--write') return true;
  throw new Error('Usage: generate-assetlinks.ts [--write]');
}

export function runAssetLinksGenerator(
  args: readonly string[],
  environment: AssetLinkEnvironment,
  outputFile: string = assetLinksFile,
): { json: string; wrote: boolean } {
  const write = shouldWriteAssetLinks(args);
  const json = generateAssetLinksJson(environment);
  if (write) {
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, json, 'utf8');
  }
  return { json, wrote: write };
}

async function main(): Promise<void> {
  try {
    const result = runAssetLinksGenerator(process.argv.slice(2), process.env as AssetLinkEnvironment);
    if (!result.wrote) process.stdout.write(result.json);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
