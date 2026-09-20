export const PRODUCTION_ORIGIN = 'https://pulseblr-u9f1.vercel.app';
export const ANDROID_PACKAGE_ID = 'app.pulseblr.twa';
export const REQUIRED_ANDROID_SDK = 36;
export const MIN_ANDROID_SDK = 21;

export interface ReleaseContractIssue {
  code: string;
  message: string;
}

type Shortcut = { name: string; short_name?: string; shortName?: string; url: string };
type WebManifest = {
  theme_color?: string;
  background_color?: string;
  display?: string;
  orientation?: string;
  shortcuts?: Shortcut[];
  share_target?: { action?: string; method?: string; enctype?: string; params?: Record<string, string> };
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
  shortcuts?: Shortcut[];
  shareTarget?: { action?: string; method?: string; enctype?: string; params?: Record<string, string> };
};

export function validateWebAndTwaParity(web: WebManifest, twa: TwaManifest): ReleaseContractIssue[] {
  const issues: ReleaseContractIssue[] = [];
  const add = (condition: boolean, code: string, message: string) => {
    if (!condition) issues.push({ code, message });
  };

  add(twa.packageId === ANDROID_PACKAGE_ID, 'package-id', `packageId must be ${ANDROID_PACKAGE_ID}`);
  add(twa.host === new URL(PRODUCTION_ORIGIN).host, 'host', `host must be ${new URL(PRODUCTION_ORIGIN).host}`);
  add(twa.themeColor === web.theme_color, 'theme-color', 'theme colors must match');
  add(twa.backgroundColor === web.background_color, 'background-color', 'background colors must match');
  add(twa.display === web.display, 'display', 'display modes must match');
  add(twa.orientation === web.orientation, 'orientation', 'orientations must match');
  add(twa.minSdkVersion === MIN_ANDROID_SDK, 'min-sdk', `minSdkVersion must be ${MIN_ANDROID_SDK}`);
  add(Number.isInteger(twa.appVersionCode) && Number(twa.appVersionCode) > 0, 'version-code', 'appVersionCode must be a positive integer');
  add(typeof twa.appVersion === 'string' && twa.appVersion.length > 0, 'version-name', 'appVersion must be non-empty');

  const webPaths = (web.shortcuts ?? []).map(item => new URL(item.url, PRODUCTION_ORIGIN).pathname);
  const twaPaths = (twa.shortcuts ?? []).map(item => new URL(item.url, PRODUCTION_ORIGIN).pathname);
  add(JSON.stringify(twaPaths) === JSON.stringify(webPaths), 'shortcut-parity', 'web and Android shortcuts must have identical ordered paths');

  const webShare = web.share_target;
  const twaShare = twa.shareTarget;
  add(
    Boolean(webShare && twaShare) &&
      new URL(twaShare?.action ?? '', PRODUCTION_ORIGIN).toString() === new URL(webShare?.action ?? '', PRODUCTION_ORIGIN).toString() &&
      twaShare?.method === webShare?.method &&
      twaShare?.enctype === webShare?.enctype &&
      JSON.stringify(twaShare?.params) === JSON.stringify(webShare?.params),
    'share-target',
    'web and Android share targets must match',
  );
  add(twa.iconUrl === `${PRODUCTION_ORIGIN}/icon-512.png`, 'icon-url', 'Android icon URL must use the permanent origin');
  add(twa.maskableIconUrl === `${PRODUCTION_ORIGIN}/icon-maskable-512.png`, 'maskable-icon-url', 'Android maskable icon URL must use the permanent origin');

  return issues;
}

export function assertWebAndTwaParity(web: WebManifest, twa: TwaManifest): void {
  const issues = validateWebAndTwaParity(web, twa);
  if (issues.length) throw new Error(issues.map(issue => `${issue.code}: ${issue.message}`).join('\n'));
}
