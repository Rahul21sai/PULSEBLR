import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTH_COOKIE_SUFFIXES, COOKIES, DEVICE_STORAGE, UNLISTED_KEYS } from '../app/cookies/inventory';
import CookiesPage from '../app/cookies/page';
import IntakeForm from '../app/f/[token]/IntakeForm';
import LoginPage from '../app/login/page';
import PrivacyPage from '../app/privacy/page';
import TermsPage from '../app/terms/page';
import { isProtectedPath } from '../lib/protected-routes';

/*
 * The legal surface, pinned two ways.
 *
 * 1. EXISTENCE AND REACHABILITY. Play needs /privacy and /delete-account reachable signed-out, and
 *    the sign-in screen now promises /terms. A legal page behind a sign-in wall is a link to a login
 *    prompt, which is the same as not having the page.
 *
 * 2. DRIFT. /cookies names every cookie and every piece of on-device storage. That list is only
 *    worth publishing while it is TRUE, and nothing on the page can notice when it stops being true:
 *    a new localStorage key, a changed Auth.js cookie, an analytics SDK. So these tests read the
 *    source and the installed @auth/core and fail in both directions — a thing the code sets that
 *    the page does not name, and a thing the page names that the code no longer sets.
 */

const ROOT = join(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const textOf = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, ' ');

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('next-auth/react', () => ({
  signIn: vi.fn(),
  useSession: () => ({ data: null, status: 'unauthenticated', update: vi.fn() }),
}));

afterEach(() => delete process.env.PULSEBLR_SUPPORT_EMAIL);

const LEGAL = [
  { path: '/privacy', Page: PrivacyPage },
  { path: '/terms', Page: TermsPage },
  { path: '/cookies', Page: CookiesPage },
] as const;

function render(Page: () => ReactElement): string {
  process.env.PULSEBLR_SUPPORT_EMAIL = 'support@example.test';
  return renderToStaticMarkup(createElement(Page));
}

describe('legal pages exist, are public, and link to each other', () => {
  for (const { path, Page } of LEGAL) {
    it(`${path} is a public page with the support contact and links to the other two`, () => {
      expect(existsSync(join(ROOT, 'app', path.slice(1), 'page.tsx'))).toBe(true);
      expect(isProtectedPath(path)).toBe(false);

      const html = render(Page);
      expect(html).toContain('mailto:support@example.test');
      for (const other of LEGAL) expect(html).toContain(`href="${other.path}"`);
    });
  }

  it('settings and account deletion link to the terms and cookie pages', () => {
    for (const file of ['app/settings/page.tsx', 'app/delete-account/page.tsx']) {
      const source = read(file);
      expect(source, file).toContain('href="/terms"');
      expect(source, file).toContain('href="/cookies"');
    }
  });

  it('the sign-in screen states the agreement and links both documents', () => {
    const html = renderToStaticMarkup(createElement(LoginPage));
    expect(textOf(html)).toMatch(/By continuing, you agree to the Terms and Privacy Policy/);
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });
});

describe('terms of use say what the product actually does', () => {
  const text = () => textOf(render(TermsPage));

  it('covers the points the owner asked for', () => {
    const t = text();
    expect(t).toMatch(/free/i);
    expect(t).toMatch(/does not guarantee that any listing is accurate/i);
    expect(t).toMatch(/Check the original page before you register, pay or travel/i);
    expect(t).toMatch(/belong to their owners/i);
    expect(t).toMatch(/scrape, crawl or bulk-download/i);
    expect(t).toMatch(/sign-up link/i);
    expect(t).toMatch(/impersonate/i);
    expect(t).toMatch(/You own what you put into PulseBLR/i);
    expect(t).toMatch(/laws of India/i);
    expect(t).toMatch(/Courts in Bengaluru, Karnataka/i);
  });

  it('states there is nothing to refund, and whose refund terms apply to tickets', () => {
    const t = text();
    expect(t).toMatch(/sells nothing/i);
    expect(t).toMatch(/nothing to refund/i);
    expect(t).toMatch(/refund and cancellation terms apply/i);
  });

  it('invents no legal entity the owner has not supplied', () => {
    for (const page of [TermsPage, PrivacyPage, CookiesPage]) {
      const t = textOf(render(page));
      expect(t).not.toMatch(/Private Limited|Pvt\.? Ltd|\bLLP\b|\bCIN\b|GSTIN|Registered office/i);
      expect(t).not.toMatch(/lawyer|attorney|legally reviewed/i);
    }
  });
});

describe('privacy policy carries the DPDP notice elements', () => {
  it('itemises, names rights, a grievance route, retention and children', () => {
    const t = textOf(render(PrivacyPage));
    expect(t).toMatch(/Digital Personal Data Protection Act, 2023/);
    expect(t).toMatch(/Correct it/);
    expect(t).toMatch(/Erase it/);
    expect(t).toMatch(/Withdraw consent/);
    expect(t).toMatch(/Nominate someone/);
    expect(t).toMatch(/Data Protection Board of India/);
    expect(t).toMatch(/Nothing expires automatically/);
    expect(t).toMatch(/under 18/);
    expect(t).toMatch(/user-agent/);
    expect(t).toMatch(/fonts\.googleapis\.com/);
    expect(t).toMatch(/does not copy them to its servers/);
    expect(t).toMatch(/Anthropic/);
  });
});

describe('the public sign-up form tells a stranger where their details go', () => {
  it('names the recipient and links the privacy section before the submit button', () => {
    const html = renderToStaticMarkup(createElement(IntakeForm, { token: 't', folderName: 'Folder' }));
    const notice = html.indexOf('data-intake-notice');
    expect(notice).toBeGreaterThan(-1);
    expect(notice).toBeLessThan(html.indexOf('type="submit"'));
    expect(textOf(html)).toMatch(/Only the person who shared this link receives what you enter/);
    expect(html).toContain('href="/privacy#contacts"');
  });
});

describe('/cookies matches the cookies Auth.js actually sets', () => {
  const cookieSource = read('node_modules/@auth/core/lib/utils/cookie.js');
  const providerSource = read('node_modules/@auth/core/lib/utils/providers.js');

  it('every suffix the page claims is a real Auth.js cookie', () => {
    const real = new Set([...cookieSource.matchAll(/authjs\.([a-z._-]+)`/g)].map(m => m[1]));
    expect(real.size).toBeGreaterThan(4);
    for (const suffix of AUTH_COOKIE_SUFFIXES) expect(real, suffix).toContain(suffix);
  });

  it('lists exactly one row per suffix, with the production prefix Auth.js uses', () => {
    expect(COOKIES.map(c => c.name).sort()).toEqual(
      AUTH_COOKIE_SUFFIXES.map(s => `${s === 'csrf-token' ? '__Host-' : '__Secure-'}authjs.${s}`).sort()
    );
    expect(cookieSource).toMatch(/\$\{useSecureCookies \? "__Host-" : ""\}authjs\.csrf-token/);
    expect(cookieSource).toMatch(/cookiePrefix = useSecureCookies \? "__Secure-" : ""/);
  });

  it('PKCE only: Google sets no checks, so no state or nonce cookie is ever set', () => {
    // Auth.js defaults `checks` to PKCE and adds `state` only for a redirect proxy.
    expect(providerSource).toMatch(/const checks = c\.checks \?\? \["pkce"\]/);
    expect(read('node_modules/@auth/core/providers/google.js')).not.toMatch(/\bchecks\s*:/);
    const auth = read('auth.ts');
    expect(auth).not.toMatch(/\bchecks\s*:/);
    expect(auth).not.toMatch(/\bcookies\s*:/); // a custom cookie config would rename everything
    expect(auth).not.toMatch(/redirectProxyUrl/);
    expect(AUTH_COOKIE_SUFFIXES).not.toContain('state');
  });
});

/* ── On-device storage ─────────────────────────────────────────────────────────────────────── */

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap(name => {
    const full = join(ROOT, dir, name);
    const rel = relative(ROOT, full).replace(/\\/g, '/');
    if (statSync(full).isDirectory()) return sourceFiles(rel);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [rel] : [];
  });
}

/** Rough comment strip: enough that a comment MENTIONING localStorage is not a storage site. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** Every file that touches browser storage, and the key it uses. A new one must be added here AND to the page. */
const STORAGE_SITES: Record<string, string> = {
  'app/components/InstallPrompt.tsx': 'pblr-install-dismissed',
  'lib/scan/outbox.ts': 'pulseblr-outbox',
  'app/layout.tsx': 'sw-cleaned',
};

// Reads every source file under app/ and lib/. Under a full parallel suite that took 9 s once,
// past vitest's 5 s default, so these get an explicit budget rather than a flaky timeout.
describe('/cookies matches the on-device storage the code uses', { timeout: 60_000 }, () => {
  const files = [...sourceFiles('app'), ...sourceFiles('lib'), 'auth.ts', 'proxy.ts'].filter(f =>
    existsSync(join(ROOT, f))
  );

  it('every file that touches storage is known, and uses a key the page lists', () => {
    const touching = files.filter(f => /\b(localStorage|sessionStorage)\s*\.|\bindexedDB\s*\./.test(code(read(f))));
    expect(touching.sort()).toEqual(Object.keys(STORAGE_SITES).sort());

    const listed = new Set(DEVICE_STORAGE.map(d => d.name));
    for (const [file, key] of Object.entries(STORAGE_SITES)) {
      expect(read(file), file).toContain(`'${key}'`);
      expect(listed.has(key) || key in UNLISTED_KEYS, key).toBe(true);
    }
  });

  it('every non-cache row on the page is still used by the code', () => {
    const used = new Set(Object.values(STORAGE_SITES));
    for (const row of DEVICE_STORAGE.filter(d => d.kind !== 'Cache storage')) {
      expect(used, row.name).toContain(row.name);
    }
  });

  it('the cache names match the service worker', () => {
    const sw = read('public/sw.js');
    const prefixes = [...sw.matchAll(/const \w+_CACHE = `(pulseblr-[a-z]+)-\$\{VERSION\}`/g)].map(m => m[1]);
    expect(prefixes.length).toBe(3);
    const row = DEVICE_STORAGE.find(d => d.kind === 'Cache storage');
    expect(row?.name.split(', ').map(n => n.replace(/-\*$/, '')).sort()).toEqual(prefixes.sort());
  });

  it('no code sets a cookie of its own', () => {
    for (const f of files) {
      const c = code(read(f));
      expect(c, f).not.toMatch(/document\.cookie\s*=|cookies\(\)\s*\.set|\.cookies\.set\(/);
    }
  });
});

describe('the "no tracking" claim stays true', { timeout: 60_000 }, () => {
  it('no analytics, advertising or session-replay dependency or tag', () => {
    const pkg = JSON.parse(read('package.json')) as Record<string, Record<string, string>>;
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const tracker = /analytics|gtag|google-tag|posthog|sentry|mixpanel|segment|amplitude|hotjar|clarity|plausible|umami|datadog|logrocket|fullstory|admob|adsense|facebook|pixel/i;
    expect(deps.filter(d => tracker.test(d))).toEqual([]);

    const tagHosts = /googletagmanager\.com|google-analytics\.com|doubleclick\.net|connect\.facebook\.net|plausible\.io|posthog\.com|clarity\.ms/;
    for (const f of [...sourceFiles('app'), 'public/sw.js']) {
      expect(read(f), f).not.toMatch(tagHosts);
    }
  });
});
