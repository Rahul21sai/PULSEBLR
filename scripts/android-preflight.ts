import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { PRODUCTION_ORIGIN, assertWebAndTwaParity } from '../lib/mobile-release-contract';
import { BUBBLEWRAP_ASSETS } from './android-verify';

const repositoryRoot = path.resolve(import.meta.dirname, '..');
const requiredHtml = new Map([
  ['/', 'home'],
  ['/scan', 'scan'],
  ['/card', 'card'],
  ['/tracker', 'tracker'],
  ['/calendar', 'calendar'],
  ['/add-event', 'add-event'],
  ['/privacy', 'privacy'],
  ['/delete-account', 'delete-account'],
]);
// Every PNG Bubblewrap downloads and embeds, from the one table that says so. A hand-kept copy here
// is how a new asset (the notification badge) gets checked at generation but never at preflight.
const requiredPng = BUBBLEWRAP_ASSETS.filter(asset => asset.contentType === 'image/png').map(asset => asset.route);

export interface ProductionOriginPreflightResult {
  checked: number;
  urls: string[];
}

export interface ProductionOriginPreflightOptions {
  expectedReleaseId: string;
  fetchImpl?: typeof fetch;
  repositoryRoot?: string;
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
  options: ProductionOriginPreflightOptions,
): Promise<ProductionOriginPreflightResult> {
  const expectedReleaseId = options.expectedReleaseId.toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedReleaseId)) {
    throw new Error('Expected deployed commit SHA is required and must contain exactly 40 hexadecimal characters');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const localRepositoryRoot = options.repositoryRoot ?? repositoryRoot;
  const checkedInTwaManifest = readJson('android/twa-manifest.json');
  const urls: string[] = [];
  const request = async (route: string, mediaTypes: readonly string[]): Promise<Response> => {
    const url = new URL(route, PRODUCTION_ORIGIN).href;
    const response = await fetchImpl(url, { redirect: 'manual', cache: 'no-store' });
    assertDirectResponse(url, response, mediaTypes);
    urls.push(url);
    return response;
  };

  const releaseResponse = await request('/api/release-identity', ['application/json']);
  if (!releaseResponse.headers.get('cache-control')?.toLowerCase().includes('no-store')) {
    throw new Error(`${PRODUCTION_ORIGIN}/api/release-identity must disable caching`);
  }
  let deployedRelease: unknown;
  try {
    deployedRelease = await releaseResponse.json();
  } catch {
    throw new Error(`${PRODUCTION_ORIGIN}/api/release-identity did not contain valid JSON`);
  }
  const deployedCommitSha = typeof deployedRelease === 'object' && deployedRelease !== null
    ? (deployedRelease as { commitSha?: unknown }).commitSha
    : undefined;
  if (deployedCommitSha !== expectedReleaseId) {
    throw new Error('Deployed commit SHA does not match the caller-supplied expected release');
  }

  const manifestResponse = await request('/manifest.json', ['application/manifest+json', 'application/json']);
  let remoteManifest: Record<string, unknown>;
  try {
    remoteManifest = await manifestResponse.json() as Record<string, unknown>;
  } catch {
    throw new Error(`${PRODUCTION_ORIGIN}/manifest.json did not contain valid JSON`);
  }
  assertWebAndTwaParity(remoteManifest, checkedInTwaManifest);

  for (const [route, marker] of requiredHtml) {
    const response = await request(route, ['text/html']);
    const body = await response.text();
    if (!body.includes(`data-pulseblr-route="${marker}"`)) {
      throw new Error(`${PRODUCTION_ORIGIN}${route} must contain the route-specific ${marker} marker`);
    }
  }
  for (const route of requiredPng) {
    const response = await request(route, ['image/png']);
    const localBytes = readFileSync(path.join(localRepositoryRoot, 'public', route.slice(1)));
    const remoteBytes = Buffer.from(await response.arrayBuffer());
    const localSha256 = createHash('sha256').update(localBytes).digest('hex');
    const remoteSha256 = createHash('sha256').update(remoteBytes).digest('hex');
    if (localSha256 !== remoteSha256) {
      throw new Error(`${PRODUCTION_ORIGIN}${route} bytes do not match the checked-in approved asset`);
    }
  }

  return { checked: urls.length, urls };
}

async function main(): Promise<void> {
  try {
    const result = await preflightProductionOrigin({
      expectedReleaseId: process.env.PULSEBLR_EXPECTED_RELEASE_COMMIT_SHA ?? '',
    });
    for (const url of result.urls) console.log(url);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
