export const PRODUCTION_ORIGIN = 'https://pulseblr-u9f1.vercel.app';
export const ANDROID_PACKAGE_ID = 'app.pulseblr.twa';
export const REQUIRED_ANDROID_SDK = 36;
export const MIN_ANDROID_SDK = 21;
export const CANONICAL_SHARE_TARGET = {
  action: `${PRODUCTION_ORIGIN}/add-event`,
  method: 'GET',
  enctype: 'application/x-www-form-urlencoded',
  params: { title: 'title', text: 'text', url: 'url' },
} as const;

export interface ReleaseContractIssue {
  code: string;
  message: string;
}

type WebManifest = {
  theme_color?: string;
  background_color?: string;
  display?: string;
  orientation?: string;
  icons?: unknown;
  shortcuts?: unknown;
  share_target?: unknown;
};
type TwaManifest = {
  packageId?: string;
  host?: string;
  themeColor?: string;
  backgroundColor?: string;
  display?: string;
  orientation?: string;
  minSdkVersion?: number;
  appVersionCode?: number;
  appVersion?: string;
  iconUrl?: string;
  maskableIconUrl?: string;
  shortcuts?: unknown;
  shareTarget?: unknown;
};

const REQUIRED_SHORTCUT_PATHS = ['/scan', '/card', '/', '/tracker', '/calendar'];
const PRODUCTION_URL = new URL(PRODUCTION_ORIGIN);
const CANONICAL_ICON_URL = `${PRODUCTION_ORIGIN}/icon-512.png`;
const CANONICAL_MASKABLE_ICON_URL = `${PRODUCTION_ORIGIN}/icon-maskable-512.png`;
const CANONICAL_SHORTCUT_ICON_URL = `${PRODUCTION_ORIGIN}/icon-192.png`;

type ResolvedUrl = { href: string; origin: string; pathname: string };
type ValidShortcut = { name: string; shortName: string; url: ResolvedUrl };
type ValidShareTarget = {
  action: ResolvedUrl;
  method: string;
  enctype: string;
  params: Record<string, string>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveProductionUrl(value: unknown): ResolvedUrl | undefined {
  if (!nonEmptyString(value)) return undefined;

  try {
    const url = new URL(value, PRODUCTION_ORIGIN);
    if (url.origin !== PRODUCTION_URL.origin) return undefined;
    return { href: url.toString(), origin: url.origin, pathname: url.pathname };
  } catch {
    return undefined;
  }
}

function parseShortcut(value: unknown): ValidShortcut | undefined {
  if (!isRecord(value) || !nonEmptyString(value.name)) return undefined;
  const shortName = value.shortName ?? value.short_name;
  if (!nonEmptyString(shortName)) return undefined;
  const url = resolveProductionUrl(value.url);
  return url ? { name: value.name, shortName, url } : undefined;
}

function parseShortcuts(value: unknown): ValidShortcut[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const shortcuts = value.map(parseShortcut);
  return shortcuts.every((shortcut): shortcut is ValidShortcut => shortcut !== undefined) ? shortcuts : undefined;
}

function purposeIncludes(value: unknown, purpose: string): boolean {
  return nonEmptyString(value) && value.trim().split(/\s+/).includes(purpose);
}

function isCanonicalWebIcon(value: unknown, expectedUrl: string, purpose: string): boolean {
  if (!isRecord(value)) return false;
  const src = resolveProductionUrl(value.src);
  return src?.href === expectedUrl &&
    value.sizes === '512x512' &&
    value.type === 'image/png' &&
    purposeIncludes(value.purpose, purpose);
}

function hasCanonicalWebIcons(value: unknown): boolean {
  return Array.isArray(value) &&
    value.some(icon => isCanonicalWebIcon(icon, CANONICAL_ICON_URL, 'any')) &&
    value.some(icon => isCanonicalWebIcon(icon, CANONICAL_MASKABLE_ICON_URL, 'maskable'));
}

function webShortcutHasCanonicalIcon(value: unknown): boolean {
  if (!isRecord(value) || !Array.isArray(value.icons) || value.icons.length !== 1) return false;
  const icon = value.icons[0];
  if (!isRecord(icon)) return false;
  const src = resolveProductionUrl(icon.src);
  return src?.href === CANONICAL_SHORTCUT_ICON_URL && icon.sizes === '192x192' && icon.type === 'image/png';
}

function twaShortcutHasCanonicalIcon(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return resolveProductionUrl(value.chosenIconUrl)?.href === CANONICAL_SHORTCUT_ICON_URL;
}

function parseParams(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value) || !Object.values(value).every(item => typeof item === 'string')) return undefined;
  return value as Record<string, string>;
}

function parseShareTarget(value: unknown): ValidShareTarget | undefined {
  if (!isRecord(value)) return undefined;
  const action = resolveProductionUrl(value.action);
  const params = parseParams(value.params);
  if (!action || !nonEmptyString(value.method) || !nonEmptyString(value.enctype) || !params) return undefined;
  return { action, method: value.method, enctype: value.enctype, params };
}

function sameParams(left: Record<string, string>, right: Readonly<Record<string, string>>): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.hasOwn(right, key) && left[key] === right[key]);
}

function isCanonicalShareTarget(target: ValidShareTarget | undefined): boolean {
  return Boolean(target) &&
    target?.action.href === CANONICAL_SHARE_TARGET.action &&
    target?.method === CANONICAL_SHARE_TARGET.method &&
    target?.enctype === CANONICAL_SHARE_TARGET.enctype &&
    sameParams(target?.params ?? {}, CANONICAL_SHARE_TARGET.params);
}

export function validateWebAndTwaParity(web: WebManifest, twa: TwaManifest): ReleaseContractIssue[] {
  const issues: ReleaseContractIssue[] = [];
  const add = (condition: boolean, code: string, message: string) => {
    if (!condition) issues.push({ code, message });
  };

  add(twa.packageId === ANDROID_PACKAGE_ID, 'package-id', `packageId must be ${ANDROID_PACKAGE_ID}`);
  add(twa.host === PRODUCTION_URL.host, 'host', `host must be ${PRODUCTION_URL.host}`);
  add(twa.themeColor === web.theme_color, 'theme-color', 'theme colors must match');
  add(twa.backgroundColor === web.background_color, 'background-color', 'background colors must match');
  add(twa.display === web.display, 'display', 'display modes must match');
  add(twa.orientation === web.orientation, 'orientation', 'orientations must match');
  add(twa.minSdkVersion === MIN_ANDROID_SDK, 'min-sdk', `minSdkVersion must be ${MIN_ANDROID_SDK}`);
  add(Number.isInteger(twa.appVersionCode) && Number(twa.appVersionCode) > 0, 'version-code', 'appVersionCode must be a positive integer');
  add(typeof twa.appVersion === 'string' && twa.appVersion.length > 0, 'version-name', 'appVersion must be non-empty');

  const webShortcuts = parseShortcuts(web.shortcuts);
  const twaShortcuts = parseShortcuts(twa.shortcuts);
  const shortcutsMatch = webShortcuts !== undefined && twaShortcuts !== undefined &&
    webShortcuts.length === REQUIRED_SHORTCUT_PATHS.length &&
    twaShortcuts.length === REQUIRED_SHORTCUT_PATHS.length &&
    webShortcuts.every((shortcut, index) =>
      shortcut.url.pathname === REQUIRED_SHORTCUT_PATHS[index] &&
      twaShortcuts[index].url.pathname === REQUIRED_SHORTCUT_PATHS[index] &&
      shortcut.name === twaShortcuts[index].name &&
      shortcut.shortName === twaShortcuts[index].shortName,
    );
  add(shortcutsMatch, 'shortcut-parity', 'web and Android must define the exact five permanent-origin shortcuts in order');
  add(hasCanonicalWebIcons(web.icons), 'web-icons', 'web manifest must expose the approved any-purpose and maskable PNG icons');
  add(
    Array.isArray(web.shortcuts) && Array.isArray(twa.shortcuts) &&
      web.shortcuts.length === REQUIRED_SHORTCUT_PATHS.length &&
      twa.shortcuts.length === REQUIRED_SHORTCUT_PATHS.length &&
      web.shortcuts.every(webShortcutHasCanonicalIcon) &&
      twa.shortcuts.every(twaShortcutHasCanonicalIcon),
    'shortcut-icons',
    'every web and Android shortcut must use the approved permanent-origin icon-192.png',
  );

  const webShare = parseShareTarget(web.share_target);
  const twaShare = parseShareTarget(twa.shareTarget);
  add(
    isCanonicalShareTarget(webShare) && isCanonicalShareTarget(twaShare),
    'share-target',
    `web and Android share targets must each be ${CANONICAL_SHARE_TARGET.method} ${CANONICAL_SHARE_TARGET.action}`,
  );
  add(twa.iconUrl === CANONICAL_ICON_URL, 'icon-url', 'Android icon URL must use the permanent origin');
  add(twa.maskableIconUrl === CANONICAL_MASKABLE_ICON_URL, 'maskable-icon-url', 'Android maskable icon URL must use the permanent origin');

  return issues;
}

export function assertWebAndTwaParity(web: WebManifest, twa: TwaManifest): void {
  const issues = validateWebAndTwaParity(web, twa);
  if (issues.length) throw new Error(issues.map(issue => `${issue.code}: ${issue.message}`).join('\n'));
}
