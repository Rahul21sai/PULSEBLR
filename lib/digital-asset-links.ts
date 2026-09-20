import { ANDROID_PACKAGE_ID, PRODUCTION_ORIGIN, type ReleaseContractIssue } from './mobile-release-contract';

const REQUIRED_RELATION = 'delegate_permission/common.handle_all_urls';

export type AssetLinkStatement = {
  relation: string[];
  target: {
    namespace: string;
    package_name: string;
    sha256_cert_fingerprints: string[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeSha256Fingerprint(fingerprint: string): string {
  const compact = fingerprint.match(/^[0-9a-fA-F]{64}$/)
    ? fingerprint
    : fingerprint.match(/^(?:[0-9a-fA-F]{2}:){31}[0-9a-fA-F]{2}$/)
      ? fingerprint.replaceAll(':', '')
      : undefined;

  if (!compact) throw new Error('Fingerprint must be a SHA-256 certificate fingerprint');
  return compact.toUpperCase().match(/.{2}/g)!.join(':');
}

function uniqueFingerprints(fingerprints: readonly string[]): string[] {
  return [...new Set(fingerprints.map(normalizeSha256Fingerprint))];
}

export function createAssetLinks(fingerprints: readonly string[]): AssetLinkStatement[] {
  const normalized = uniqueFingerprints(fingerprints);
  if (!normalized.length) throw new Error('At least one SHA-256 certificate fingerprint is required');

  return [{
    relation: [REQUIRED_RELATION],
    target: {
      namespace: 'android_app',
      package_name: ANDROID_PACKAGE_ID,
      sha256_cert_fingerprints: normalized,
    },
  }];
}

function sameFingerprintSet(actual: unknown, expected: readonly string[]): boolean {
  if (!Array.isArray(actual) || !actual.every(value => typeof value === 'string')) return false;
  try {
    const normalizedActual = uniqueFingerprints(actual);
    const normalizedExpected = uniqueFingerprints(expected);
    return normalizedActual.length === actual.length &&
      normalizedActual.length === normalizedExpected.length &&
      normalizedActual.every(fingerprint => normalizedExpected.includes(fingerprint));
  } catch {
    return false;
  }
}

export function validateAssetLinks(statements: unknown, expectedFingerprints: readonly string[]): ReleaseContractIssue[] {
  const issues: ReleaseContractIssue[] = [];
  if (!Array.isArray(statements) || statements.length !== 1 || !isRecord(statements[0])) {
    return [{ code: 'statement', message: 'assetlinks.json must contain exactly one Android statement' }];
  }

  const statement = statements[0];
  const target = isRecord(statement.target) ? statement.target : undefined;
  if (!Array.isArray(statement.relation) || statement.relation.length !== 1 || statement.relation[0] !== REQUIRED_RELATION) {
    issues.push({ code: 'relation', message: `relation must be exactly ${REQUIRED_RELATION}` });
  }
  if (target?.namespace !== 'android_app') {
    issues.push({ code: 'namespace', message: 'target namespace must be android_app' });
  }
  if (target?.package_name !== ANDROID_PACKAGE_ID) {
    issues.push({ code: 'package-id', message: `target package must be ${ANDROID_PACKAGE_ID}` });
  }
  if (!sameFingerprintSet(target?.sha256_cert_fingerprints, expectedFingerprints)) {
    issues.push({ code: 'fingerprints', message: 'certificate fingerprints must exactly match the expected fingerprint set' });
  }
  return issues;
}

export function expectedAssetLinkFingerprints(environment: NodeJS.ProcessEnv): string[] {
  const upload = environment.PB_UPLOAD_SHA256;
  if (!upload) throw new Error('PB_UPLOAD_SHA256 is required');
  const play = environment.PB_PLAY_SHA256;
  return play ? [upload, play] : [upload];
}

export const PRODUCTION_ASSET_LINKS_URL = new URL('/.well-known/assetlinks.json', PRODUCTION_ORIGIN).href;

export async function verifyProductionAssetLinks(
  expectedFingerprints: readonly string[],
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const response = await fetchImpl(PRODUCTION_ASSET_LINKS_URL, { redirect: 'manual', cache: 'no-store' });
  if (response.headers.has('location')) throw new Error(`${PRODUCTION_ASSET_LINKS_URL} returned a redirect Location header`);
  if (response.status !== 200) throw new Error(`${PRODUCTION_ASSET_LINKS_URL} must return status 200 (received ${response.status})`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new Error(`${PRODUCTION_ASSET_LINKS_URL} must return Content-Type application/json`);

  let statements: unknown;
  try {
    statements = await response.json();
  } catch {
    throw new Error(`${PRODUCTION_ASSET_LINKS_URL} did not contain valid JSON`);
  }
  const issues = validateAssetLinks(statements, expectedFingerprints);
  if (issues.length) throw new Error(issues.map(issue => `${issue.code}: ${issue.message}`).join('\n'));
}
