#!/usr/bin/env tsx
/**
 * READ-ONLY recon: company EVENT MICROSITES and open-source event sites.
 *
 * The insight driving this: companies rarely publish events on their main marketing
 * site (round-2 recon confirmed aws.amazon.com/events, redhat.com/en/events,
 * docker.com/events all yield ZERO structured events). Instead they stand up a
 * dedicated event property — aws-experience.com, aws.amazon.com/events/summits,
 * developer.microsoft.com/reactor, cloudonair, nvidia GTC — and those often DO
 * expose a real JSON API or JSON-LD, because they need it for their own front end.
 *
 * This probe asks, for each candidate: what status, what payload shape, does it
 * contain event-shaped records, and does it mention Bengaluru/Bangalore/India?
 *
 * Run: npx tsx scripts/probe-event-microsites.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

interface Candidate {
  group: string;
  label: string;
  url: string;
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
}

const CANDIDATES: Candidate[] = [
  // ── AWS: the user's own examples ─────────────────────────────────────────
  { group: 'aws', label: 'aws-experience amer/smb', url: 'https://aws-experience.com/amer/smb/events' },
  { group: 'aws', label: 'aws-experience apj', url: 'https://aws-experience.com/apj/events' },
  { group: 'aws', label: 'aws-experience apj india', url: 'https://aws-experience.com/apj/india/events' },
  { group: 'aws', label: 'aws summits', url: 'https://aws.amazon.com/events/summits/' },
  { group: 'aws', label: 'aws summits india', url: 'https://aws.amazon.com/events/summits/india/' },
  { group: 'aws', label: 'aws events find api', url: 'https://aws.amazon.com/api/dirs/items/search?item.directoryId=amer-events&sort_by=item.additionalFields.startDateTime&size=50' },
  { group: 'aws', label: 'aws events dir apac', url: 'https://aws.amazon.com/api/dirs/items/search?item.directoryId=apac-events&size=50' },

  // ── Microsoft ────────────────────────────────────────────────────────────
  { group: 'microsoft', label: 'MS Reactor events api', url: 'https://developer.microsoft.com/en-us/reactor/api/search/sessions/?pageSize=50&pageIndex=0' },
  { group: 'microsoft', label: 'MS Reactor list', url: 'https://developer.microsoft.com/en-us/reactor/?search=&location=Bengaluru' },
  { group: 'microsoft', label: 'MS events home', url: 'https://events.microsoft.com/en-us/allevents/' },
  { group: 'microsoft', label: 'MS build', url: 'https://build.microsoft.com/en-US/home' },

  // ── Google ───────────────────────────────────────────────────────────────
  { group: 'google', label: 'Google Cloud events', url: 'https://cloud.google.com/events' },
  { group: 'google', label: 'Google IO', url: 'https://io.google/2026/' },
  { group: 'google', label: 'GDG chapters api (bevy)', url: 'https://gdg.community.dev/api/event_slim/?fields=title,start_date,url&status=Published&order_by=-start_date' },

  // ── NVIDIA / hardware ────────────────────────────────────────────────────
  { group: 'hardware', label: 'NVIDIA GTC sessions', url: 'https://www.nvidia.com/gtc/sessions/' },
  { group: 'hardware', label: 'NVIDIA events india', url: 'https://www.nvidia.com/en-in/events/' },
  { group: 'hardware', label: 'Arm events', url: 'https://www.arm.com/company/events' },

  // ── Open source foundations & communities ────────────────────────────────
  { group: 'opensource', label: 'CNCF events api', url: 'https://www.cncf.io/wp-json/wp/v2/cncf_event?per_page=50' },
  { group: 'opensource', label: 'CNCF community (bevy)', url: 'https://community.cncf.io/api/search/event/?q=bengaluru' },
  { group: 'opensource', label: 'Linux Foundation events', url: 'https://events.linuxfoundation.org/' },
  { group: 'opensource', label: 'LF wp-json events', url: 'https://events.linuxfoundation.org/wp-json/wp/v2/pages?per_page=20' },
  { group: 'opensource', label: 'Apache events', url: 'https://www.apache.org/events/current-event.html' },
  { group: 'opensource', label: 'FOSS United', url: 'https://fossunited.org/events' },
  { group: 'opensource', label: 'FOSS United api', url: 'https://fossunited.org/api/method/frappe.client.get_list?doctype=FOSS%20Meetup&limit_page_length=50' },
  { group: 'opensource', label: 'FOSSAsia', url: 'https://eventyay.com/api/v1/events' },
  { group: 'opensource', label: 'PyCon India', url: 'https://in.pycon.org/2026/' },
  { group: 'opensource', label: 'Hasgeek all', url: 'https://hasgeek.com/' },
  { group: 'opensource', label: 'Kubernetes community days', url: 'https://www.cncf.io/kubernetes-community-days/' },
  { group: 'opensource', label: 'GitHub events (Bevy)', url: 'https://github.community.dev/api/search/event/?q=bengaluru' },
  { group: 'opensource', label: 'Mozilla community', url: 'https://community.mozilla.org/en/events/' },
  { group: 'opensource', label: 'Wikimedia events', url: 'https://meta.wikimedia.org/wiki/Events' },

  // ── Bevy tenants: same engine as GDG, used by many dev-rel teams ─────────
  { group: 'bevy', label: 'bevy: mongodb', url: 'https://mongodb.community.dev/api/search/event/?q=bengaluru' },
  { group: 'bevy', label: 'bevy: postman', url: 'https://postman.community.dev/api/search/event/?q=bengaluru' },
  { group: 'bevy', label: 'bevy: hashicorp', url: 'https://hashicorp.community.dev/api/search/event/?q=bengaluru' },
  { group: 'bevy', label: 'bevy: elastic', url: 'https://elastic.community.dev/api/search/event/?q=bengaluru' },
  { group: 'bevy', label: 'bevy: databricks', url: 'https://databricks.community.dev/api/search/event/?q=bengaluru' },
  { group: 'bevy', label: 'bevy: snowflake', url: 'https://usergroups.snowflake.com/api/search/event/?q=bengaluru' },
  { group: 'bevy', label: 'bevy: developers.events', url: 'https://developers.events/all-events.json' },
];

interface Finding {
  group: string;
  label: string;
  url: string;
  status: number | string;
  bytes: number;
  contentType: string;
  signals: string[];
  mentionsIndia: boolean;
  sample?: string;
}

function detect(text: string, contentType: string): { signals: string[]; sample?: string } {
  const signals: string[] = [];
  let sample: string | undefined;

  // JSON-LD Event nodes
  let ldEvents = 0;
  for (const m of text.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      ldEvents += (JSON.stringify(JSON.parse(m[1].trim())).match(/"@type"\s*:\s*"[A-Za-z]*Event"/g) || []).length;
    } catch { /* ignore */ }
  }
  if (ldEvents > 0) signals.push(`jsonld:${ldEvents}events`);

  if (/BEGIN:VEVENT/.test(text)) signals.push(`ics:${(text.match(/BEGIN:VEVENT/g) || []).length}`);
  if (text.includes('__NEXT_DATA__')) signals.push('__NEXT_DATA__');
  if (/<item>/i.test(text)) signals.push(`rss:${(text.match(/<item>/gi) || []).length}`);

  if (contentType.includes('json')) {
    try {
      const parsed = JSON.parse(text);
      const json = JSON.stringify(parsed);
      const dateKeys = ['start_date', 'startDate', 'start_at', 'startDateTime', 'start_date_iso', 'startTime', 'date']
        .filter(k => json.includes(`"${k}"`));
      if (dateKeys.length) signals.push(`json-dates:${dateKeys.slice(0, 3).join('|')}`);
      const count = Array.isArray(parsed)
        ? parsed.length
        : (parsed.results?.length ?? parsed.items?.length ?? parsed.data?.length ?? parsed.entries?.length);
      if (typeof count === 'number') signals.push(`records:${count}`);
      sample = `keys=${(Array.isArray(parsed) ? Object.keys(parsed[0] || {}) : Object.keys(parsed)).slice(0, 10).join(',')}`;
    } catch {
      signals.push('json-parse-failed');
    }
  }

  if (signals.length === 0) sample = text.slice(0, 120).replace(/\s+/g, ' ');
  return { signals, sample };
}

async function probe(c: Candidate): Promise<Finding> {
  try {
    const res = await fetch(c.url, {
      method: c.method || 'GET',
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...(c.headers || {}),
      },
      body: c.body ? JSON.stringify(c.body) : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const contentType = (res.headers.get('content-type') || '').split(';')[0];
    const text = await res.text();
    const { signals, sample } = detect(text, contentType);
    return {
      group: c.group,
      label: c.label,
      url: c.url,
      status: res.status,
      bytes: text.length,
      contentType,
      signals,
      mentionsIndia: /bengaluru|bangalore|india/i.test(text),
      sample,
    };
  } catch (err) {
    return {
      group: c.group,
      label: c.label,
      url: c.url,
      status: 'ERR',
      bytes: 0,
      contentType: '-',
      signals: [],
      mentionsIndia: false,
      sample: err instanceof Error ? err.message.slice(0, 70) : String(err),
    };
  }
}

async function main() {
  console.log(`\nProbing ${CANDIDATES.length} company event microsites and open-source sites\n`);

  const findings: Finding[] = [];
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < CANDIDATES.length) findings.push(await probe(CANDIDATES[cursor++]));
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  findings.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));

  let lastGroup = '';
  for (const f of findings) {
    if (f.group !== lastGroup) {
      console.log(`\n── ${f.group.toUpperCase()} ${'─'.repeat(Math.max(0, 56 - f.group.length))}`);
      lastGroup = f.group;
    }
    const ok = typeof f.status === 'number' && f.status < 400;
    const mark = ok ? (f.signals.length ? 'YES ' : ' -  ') : 'FAIL';
    console.log(
      `${mark} [${String(f.status).padEnd(5)}] ${f.label.padEnd(30)} ${String(f.bytes).padStart(8)}B ` +
        `${f.mentionsIndia ? 'IN' : '  '} ${f.signals.join(' ') || '(no event signals)'}`
    );
    if (f.sample) console.log(`         ↳ ${f.sample.slice(0, 150)}`);
  }

  const usable = findings.filter(
    f => typeof f.status === 'number' && f.status < 400 && f.signals.length > 0
  );
  console.log(`\n${usable.length}/${findings.length} returned machine-readable event data.`);
  console.log('Of those, mentioning India/Bengaluru:');
  for (const f of usable.filter(x => x.mentionsIndia)) {
    console.log(`   ${f.group.padEnd(11)} ${f.label.padEnd(30)} ${f.url}`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
