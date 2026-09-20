import { describe, expect, it } from 'vitest';
import {
  createAssetLinks,
  normalizeSha256Fingerprint,
  validateAssetLinks,
} from '../lib/digital-asset-links';

const upload = 'AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA:AA';
const play = 'BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB:BB';

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
