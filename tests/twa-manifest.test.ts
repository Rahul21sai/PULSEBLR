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

  it('keeps the literal canonical share target and permanent TWA icon URLs', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = read<Record<string, unknown>>('android/twa-manifest.json');

    expect(web.share_target).toEqual({
      action: '/add-event',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    });
    expect(twa.shareTarget).toEqual({
      action: 'https://pulseblr-u9f1.vercel.app/add-event',
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      params: { title: 'title', text: 'text', url: 'url' },
    });
    expect(twa.iconUrl).toBe('https://pulseblr-u9f1.vercel.app/icon-512.png');
    expect(twa.maskableIconUrl).toBe('https://pulseblr-u9f1.vercel.app/icon-maskable-512.png');
  });

  it('reports a missing Calendar shortcut as a user-visible integration break', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    twa.shortcuts = (twa.shortcuts as Array<{ url: string }>).filter(item => !item.url.endsWith('/calendar'));
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));
  });

  it('rejects jointly missing or non-array shortcut contracts', () => {
    const missingWeb = structuredClone(read<Record<string, unknown>>('public/manifest.json'));
    const missingTwa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    delete missingWeb.shortcuts;
    delete missingTwa.shortcuts;
    expect(validateWebAndTwaParity(missingWeb, missingTwa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));

    const invalidWeb = structuredClone(read<Record<string, unknown>>('public/manifest.json'));
    const invalidTwa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    invalidWeb.shortcuts = {};
    invalidTwa.shortcuts = {};
    expect(validateWebAndTwaParity(invalidWeb, invalidTwa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));
  });

  it('requires all five shortcuts even when both manifests drift together', () => {
    const web = structuredClone(read<Record<string, unknown>>('public/manifest.json'));
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    web.shortcuts = (web.shortcuts as unknown[]).slice(0, 4);
    twa.shortcuts = (twa.shortcuts as unknown[]).slice(0, 4);
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));
  });

  it('reports malformed shortcut URLs without throwing', () => {
    const web = structuredClone(read<Record<string, unknown>>('public/manifest.json'));
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    (web.shortcuts as Array<Record<string, unknown>>)[0].url = Symbol('not-a-url');
    (twa.shortcuts as Array<Record<string, unknown>>)[1].url = 'https://[';
    expect(() => validateWebAndTwaParity(web, twa)).not.toThrow();
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'shortcut-parity' }));
  });

  it('rejects shortcuts outside the permanent production origin', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    (twa.shortcuts as Array<{ url: string }>)[0].url = 'https://untrusted.example/scan';
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
    (twa.shareTarget as { action: string }).action = 'https://pulseblr-u9f1.vercel.app/wrong';
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'share-target' }));
  });

  it.each([
    ['endpoint', (web: Record<string, unknown>, twa: Record<string, unknown>) => {
      (web.share_target as { action: string }).action = '/wrong';
      (twa.shareTarget as { action: string }).action = 'https://pulseblr-u9f1.vercel.app/wrong';
    }],
    ['method', (web: Record<string, unknown>, twa: Record<string, unknown>) => {
      (web.share_target as { method: string }).method = 'get';
      (twa.shareTarget as { method: string }).method = 'get';
    }],
    ['parameters', (web: Record<string, unknown>, twa: Record<string, unknown>) => {
      (web.share_target as { params: Record<string, string> }).params = { title: 'event', text: 'text', url: 'url' };
      (twa.shareTarget as { params: Record<string, string> }).params = { title: 'event', text: 'text', url: 'url' };
    }],
  ])('rejects synchronized canonical share-target %s drift', (_label, mutate) => {
    const web = structuredClone(read<Record<string, unknown>>('public/manifest.json'));
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    mutate(web, twa);
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'share-target' }));
  });

  it('reports empty and malformed share targets without throwing', () => {
    const web = structuredClone(read<Record<string, unknown>>('public/manifest.json'));
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    web.share_target = {};
    twa.shareTarget = {};
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'share-target' }));

    (web.share_target as Record<string, unknown>).action = Symbol('not-a-url');
    (twa.shareTarget as Record<string, unknown>).action = 'https://[';
    expect(() => validateWebAndTwaParity(web, twa)).not.toThrow();
    expect(validateWebAndTwaParity(web, twa)).toContainEqual(expect.objectContaining({ code: 'share-target' }));
  });

  it('accepts share-target params with the same entries in a different order', () => {
    const web = read<Record<string, unknown>>('public/manifest.json');
    const twa = structuredClone(read<Record<string, unknown>>('android/twa-manifest.json'));
    (twa.shareTarget as { params: Record<string, string> }).params = {
      url: 'url',
      text: 'text',
      title: 'title',
    };
    expect(validateWebAndTwaParity(web, twa)).not.toContainEqual(expect.objectContaining({ code: 'share-target' }));
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
