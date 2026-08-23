#!/usr/bin/env tsx
/**
 * Does "Import from Link" actually work?
 *
 * This matters more than it looks. Four independent probes have now shown that Bengaluru's
 * hardware events are not on any scrapable platform, and that the city's cultural events are
 * not on Eventbrite while the platforms carrying them are blocked or shell-rendered. Those
 * are limits of the outside world, not of the crawler.
 *
 * Which makes the paste-a-URL path the real answer for everything a crawler cannot reach: an
 * IEEE chapter page, a company microsite, a mailing-list announcement. If it extracts well,
 * the ceiling becomes a workflow instead of a wall. If it does not, the workaround is
 * theoretical and should not be offered as one.
 *
 * Signs in through the dev-only provider because POST /api/scrape-url requires a session —
 * it makes the server fetch a caller-supplied URL, so it is gated.
 *
 * Needs a dev server with DEV_LOGIN=true. No DB writes.
 *
 * Run: npx tsx scripts/diag-import-from-link.ts
 */
import './load-env';

const BASE = process.env.PULSEBLR_BASE_URL || 'http://localhost:3000';
const EMAIL = (process.env.ADMIN_EMAILS || '').split(',')[0]?.trim() || 'admin@example.com';

/** URLs standing in for the classes of page a crawler cannot reach. */
const TARGETS: Array<{ label: string; url: string }> = [
  { label: 'Luma event (known-good baseline)', url: 'https://luma.com/agenticsummit' },
  { label: 'Meetup event page', url: 'https://www.meetup.com/bangpypers/events/' },
  { label: 'HasGeek project', url: 'https://hasgeek.com/fifthelephant/dpdp-round-table/' },
  { label: 'FOSS United chapter event', url: 'https://fossunited.org/c/bengaluru/july-2026' },
  { label: 'IEEE Bangalore Section', url: 'https://ieeebangalore.org/' },
  { label: 'Konfhub event', url: 'https://konfhub.com/explore' },
];

class Session {
  private jar = new Map<string, string>();

  private absorb(res: Response) {
    const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      if (i > 0) this.jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}) {
    const res = await fetch(BASE + path, {
      ...init,
      headers: {
        ...(init.headers || {}),
        ...(this.jar.size ? { Cookie: [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ') } : {}),
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(45000),
    });
    this.absorb(res);
    return res;
  }

  async signIn(email: string) {
    const { csrfToken } = (await (await this.fetch('/api/auth/csrf')).json()) as { csrfToken: string };
    await this.fetch('/api/auth/callback/dev-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, csrfToken, callbackUrl: BASE, json: 'true' }).toString(),
    });
    const session = (await (await this.fetch('/api/auth/session')).json()) as { user?: { id?: string } };
    return !!session?.user?.id;
  }
}

async function main() {
  const s = new Session();
  if (!(await s.signIn(EMAIL))) {
    console.log('Could not sign in. Is DEV_LOGIN=true and the server running?');
    process.exit(1);
  }
  console.log(`Signed in as ${EMAIL}\n`);

  const FIELDS = ['title', 'startDateTime', 'endDateTime', 'venue', 'organizer', 'description', 'format'] as const;

  for (const t of TARGETS) {
    const res = await s.fetch('/api/scrape-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: t.url }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      event?: Record<string, unknown> | null;
      error?: string;
    };

    const ev = data.event;
    const filled = ev ? FIELDS.filter(f => ev[f] !== undefined && ev[f] !== null && ev[f] !== '') : [];

    console.log(`${t.label}`);
    console.log(`   HTTP ${res.status}  ${ev ? `${filled.length}/${FIELDS.length} fields` : `no event${data.error ? ` (${data.error})` : ''}`}`);
    if (ev) {
      console.log(`   title  ${String(ev.title ?? '-').slice(0, 62)}`);
      console.log(`   start  ${String(ev.startDateTime ?? '-')}`);
      console.log(`   venue  ${String(ev.venue ?? '-').slice(0, 46)}`);
      console.log(`   filled ${filled.join(', ') || 'none'}`);
    }
    console.log('');
  }

  console.log('JUDGEMENT: title + startDateTime is the minimum for this to save a user real');
  console.log('typing. Everything else is a bonus. A page that yields only a title still beats');
  console.log('an empty form, but should not be described as "auto-fill".');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
