import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createAssetLinks,
  normalizeSha256Fingerprint,
  validateAssetLinks,
  verifyProductionAssetLinks,
} from '../lib/digital-asset-links';
import { diagnoseAssetLinks } from '../scripts/diag-assetlinks';
import { runAssetLinksGenerator } from '../scripts/generate-assetlinks';

const upload = 'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA';
const play = 'BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB';
const environment = { PB_UPLOAD_SHA256: upload, PB_PLAY_SHA256: play };

function response(body: string, options: ResponseInit = {}): Response {
  return new Response(body, { headers: { 'content-type': 'application/json' }, ...options });
}

describe('Digital Asset Links contract', () => {
  it('normalizes lowercase compact SHA-256 into Android colon notation', () => {
    expect(normalizeSha256Fingerprint('aa'.repeat(32))).toBe(upload);
  });

  it('creates one Android statement with deduplicated upload and Play fingerprints', () => {
    const statements = createAssetLinks([upload, play, upload]);
    expect(statements).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: 'app.pulseblr.twa',
        sha256_cert_fingerprints: [upload, play],
      },
    }]);
    expect(validateAssetLinks(statements, [upload, play])).toEqual([]);
  });

  it('rejects the wrong package, a malformed certificate, or a missing expected fingerprint', () => {
    expect(() => normalizeSha256Fingerprint('not-a-certificate')).toThrow(/SHA-256/);
    const statements = createAssetLinks([upload]);
    (statements[0].target as { package_name: string }).package_name = 'com.example.other';
    expect(validateAssetLinks(statements, [upload, play]).map(issue => issue.code)).toEqual(expect.arrayContaining(['package-id', 'fingerprints']));
  });
});

describe('Digital Asset Links operational tooling', () => {
  it('only writes for exactly one --write argument and requires an upload fingerprint', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'pulseblr-assetlinks-'));
    const outputFile = path.join(directory, 'assetlinks.json');
    try {
      expect(() => runAssetLinksGenerator(['--write', 'unexpected'], environment, outputFile)).toThrow(/Usage/);
      expect(() => runAssetLinksGenerator(['--write', '--write'], environment, outputFile)).toThrow(/Usage/);
      expect(existsSync(outputFile)).toBe(false);

      const preview = runAssetLinksGenerator([], environment, outputFile);
      expect(preview.wrote).toBe(false);
      expect(preview.json).toMatch(/^\[\n  \{/);
      expect(existsSync(outputFile)).toBe(false);

      expect(() => runAssetLinksGenerator(['--write'], {}, outputFile)).toThrow(/PB_UPLOAD_SHA256/);
      expect(existsSync(outputFile)).toBe(false);

      const written = runAssetLinksGenerator(['--write'], environment, outputFile);
      expect(written.wrote).toBe(true);
      expect(readFileSync(outputFile, 'utf8')).toBe(`${written.json}`);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses a manual direct fetch and returns secret-safe diagnostic output', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl: typeof fetch = async (_url, init) => {
      capturedInit = init;
      return response(JSON.stringify(createAssetLinks([upload, play])));
    };

    const message = await diagnoseAssetLinks(environment, fetchImpl);

    expect(capturedInit).toMatchObject({ redirect: 'manual', cache: 'no-store' });
    expect(message).toBe('Digital Asset Links: PASS');
    expect(message).not.toContain(upload);
    expect(message).not.toContain(play);
  });

  it('refuses diagnostic execution without the upload fingerprint before fetching', async () => {
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return response('[]');
    };

    await expect(diagnoseAssetLinks({}, fetchImpl)).rejects.toThrow(/PB_UPLOAD_SHA256/);
    expect(calls).toBe(0);
  });

  it.each([
    ['a redirect status', response('[]', { status: 302, headers: { location: 'https://elsewhere.example' } }), /redirect Location/],
    ['a Location header on a 200 response', response('[]', { headers: { 'content-type': 'application/json', location: 'https://elsewhere.example' } }), /redirect Location/],
    ['a non-200 response', response('[]', { status: 404 }), /status 200/],
    ['a non-JSON content type', response('[]', { headers: { 'content-type': 'text/plain' } }), /Content-Type application\/json/],
    ['malformed JSON', response('not JSON'), /valid JSON/],
  ])('rejects %s from the remote asset-links endpoint', async (_caseName, remoteResponse, expectedError) => {
    const fetchImpl: typeof fetch = async () => remoteResponse;
    await expect(verifyProductionAssetLinks([upload], fetchImpl)).rejects.toThrow(expectedError);
  });
});
