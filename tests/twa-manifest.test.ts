import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ANDROID_PACKAGE_ID,
  PRODUCTION_ORIGIN,
  assertWebAndTwaParity,
  validateWebAndTwaParity,
} from '../lib/mobile-release-contract';

const root = path.resolve(import.meta.dirname, '..');
const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(root, file), 'utf8')) as T;

describe('PulseBLR mobile release contract', () => {
  it('keeps the immutable package and origin identities', () => {
    const twa = read<Record<string, unknown>>('android/twa-manifest.json');
    expect(ANDROID_PACKAGE_ID).toBe('app.pulseblr.twa');
    expect(PRODUCTION_ORIGIN).toBe('https://pulseblr-u9f1.vercel.app');
    expect(twa.packageId).toBe('app.pulseblr.twa');
    expect(twa.host).toBe('pulseblr-u9f1.vercel.app');
  });

  it('accepts the checked-in web and TWA manifests as one five-shortcut product', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = read<Record<string, unknown>>('android/twa-manifest.json');
    expect(() => assertWebAndTwaParity(web, twa)).not.toThrow();
    expect((twa.shortcuts as Array<{ url: string }>).map(item => new URL(item.url).pathname)).toEqual([
      '/scan', '/card', '/', '/tracker', '/calendar',
    ]);
  });

  it('reports a missing Calendar shortcut as a user-visible integration break', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    twa.shortcuts = (twa.shortcuts as Array<{ url: string }>).filter(item => !item.url.endsWith('/calendar'));
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));
  });

  it.each([
    ['packageId', 'com.example.other', 'package-id'],
    ['themeColor', '#000000', 'theme-color'],
    ['orientation', 'landscape', 'orientation'],
    ['minSdkVersion', 23, 'min-sdk'],
  ])('reports invalid %s', (field, value, code) => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    twa[field] = value;
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code }));
  });

  it('rejects share-target drift', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    (twa.shareTarget as { action: string }).action = `${PRODUCTION_ORIGIN}/wrong`;
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'share-target' }));
  });

  it('keeps the first release reproducible without committing signing material', () => {
    const twa = read<{
      enableNotifications: boolean;
      appVersionCode: number;
      appVersion: string;
      signingKey: { path: string; alias: string };
      fingerprints: unknown[];
    }>('android/twa-manifest.json');

    expect(twa.enableNotifications).toBe(true);
    expect(twa.appVersionCode).toBe(1);
    expect(twa.appVersion).toBe('1');
    expect(path.isAbsolute(twa.signingKey.path)).toBe(false);
    expect(twa.signingKey.alias).toBe('android');
    expect(twa.fingerprints).toEqual([]);
  });
});
