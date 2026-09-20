import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCTION_ORIGIN, assertWebAndTwaParity } from '../lib/mobile-release-contract';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const requiredHtml = ['/', '/scan', '/card', '/tracker', '/calendar', '/add-event', '/privacy', '/delete-account'];
const requiredPng = ['/icon-192.png', '/icon-512.png', '/icon-maskable-512.png'];

export interface ProductionOriginPreflightResult {
  checked: number;
  urls: string[];
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(repositoryRoot, file), 'utf8')) as Record<string, unknown>;
}

function assertDirectResponse(url: string, response: Response, mediaTypes: readonly string[]): void {
  if (response.headers.has('location')) {
    throw new Error(`${url} returned a redirect Location header`);
  }
  if (response.status !== 200) {
    throw new Error(`${url} must return status 200 (received ${response.status})`);
  }
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (!contentType || !mediaTypes.includes(contentType)) {
    throw new Error(`${url} must return Content-Type ${mediaTypes.join(' or ')}`);
  }
}

export async function preflightProductionOrigin(
  fetchImpl: typeof fetch = fetch,
): Promise<ProductionOriginPreflightResult> {
  const checkedInTwaManifest = readJson('android/twa-manifest.json');
  const urls: string[] = [];
  const request = async (route: string, mediaTypes: readonly string[]): Promise<Response> => {
    const url = new URL(route, PRODUCTION_ORIGIN).href;
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store' });
    assertDirectResponse(url, response, mediaTypes);
    urls.push(url);
    return response;
  };

  const manifestResponse = await request('/manifest.json', ['application/manifest+json', 'application/json']);
  let remoteManifest: Record<string, unknown>;
  try {
    remoteManifest = await manifestResponse.json() as Record<string, unknown>;
  } catch {
    throw new Error(`${PRODUCTION_ORIGIN}/manifest.json did not contain valid JSON`);
  }
  assertWebAndTwaParity(remoteManifest, checkedInTwaManifest);

  for (const route of requiredHtml) await request(route, ['text/html']);
  for (const route of requiredPng) await request(route, ['image/png']);

  return { checked: urls.length, urls };
}

async function main(): Promise<void> {
  try {
    const result = await preflightProductionOrigin();
    for (const url of result.urls) console.log(url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
