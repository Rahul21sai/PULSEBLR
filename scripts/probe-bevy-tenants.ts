#!/usr/bin/env tsx
/**
 * Which company/community event platforms are Bevy tenants?
 *
 * Bevy is the highest-leverage route to company event pages that we have evidence
 * for. Unlike corporate marketing sites — 19 of the 20 pages in
 * `COMPANY_EVENT_PAGES` yield nothing, because they are JS-rendered shells with no
 * schema.org markup — a Bevy tenant exposes a real JSON endpoint
 * (`/api/search/event`) that returns structured, city-filterable events.
 *
 * This probe tests candidate hosts and reports which are genuinely Bevy, how many
 * total events they publish, and how many mention Bengaluru. Read-only, no DB.
 *
 * Run: npx tsx scripts/probe-bevy-tenants.ts
 */
import './load-env';

/** Candidate hosts. Bevy tenants use a few naming conventions, so all are tried. */
const CANDIDATES = [
  // Already in the adapter — included as controls, so a change in the probe's own
  // logic shows up as these four breaking rather than as a silent false negative.
  'https://gdg.community.dev',
  'https://community.cncf.io',
  'https://usergroups.snowflake.com',
  'https://community.uipath.com',

  // Data / infra companies known to run community programmes.
  'https://community.mongodb.com',
  'https://events.mongodb.com',
  'https://community.hashicorp.com',
  'https://community.temporal.io',
  'https://community.airbyte.com',
  'https://community.grafana.com',
  'https://community.databricks.com',
  'https://community.confluent.io',
  'https://community.elastic.co',
  'https://community.neo4j.com',
  'https://community.datastax.com',
  'https://community.redis.com',
  'https://community.cockroachlabs.com',
  'https://community.dremio.com',
  'https://community.starburst.io',
  'https://community.clickhouse.com',

  // Dev-tool / platform companies.
  'https://community.postman.com',
  'https://community.gitlab.com',
  'https://community.docker.com',
  'https://community.sonarsource.com',
  'https://community.jfrog.com',
  'https://community.twilio.com',
  'https://community.auth0.com',
  'https://community.vonage.com',

  // Open-source foundations and programmes — directly serves the open-source ask.
  'https://community.linuxfoundation.org',
  'https://community.apache.org',
  'https://community.openinfra.dev',
  'https://community.pytorch.org',
  'https://community.tensorflow.org',

  // Indian tech companies.
  'https://community.razorpay.com',
  'https://community.zoho.com',
  'https://community.freshworks.com',
  'https://community.postman.com',
];

const BLR = /bengaluru|bangalore/i;

interface Probe {
  host: string;
  ok: boolean;
  status?: number;
  total?: number;
  blr?: number;
  note?: string;
  sampleBlr?: string[];
}

async function probe(host: string): Promise<Probe> {
  const url = `${host}/api/search/event?result_types=upcoming_event&country_code=IN&per_page=100`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; PulseBLR/1.0)',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });

    if (!res.ok) return { host, ok: false, status: res.status };

    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('json')) {
      return { host, ok: false, status: res.status, note: `non-JSON (${ct.split(';')[0]})` };
    }

    const body = (await res.json()) as {
      results?: Array<Record<string, unknown>>;
      count?: number;
    };
    const rows = body.results || [];
    // A Bevy response has `results` with event-shaped rows; anything else is a
    // generic API that happens to answer this path.
    if (!Array.isArray(rows)) return { host, ok: false, status: res.status, note: 'no results[]' };

    const blrRows = rows.filter(r => BLR.test(JSON.stringify(r)));
    return {
      host,
      ok: true,
      status: res.status,
      total: body.count ?? rows.length,
      blr: blrRows.length,
      sampleBlr: blrRows.slice(0, 3).map(r => String(r.title || r.name || '?').slice(0, 54)),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { host, ok: false, note: msg.slice(0, 46) };
  }
}

async function main() {
  const unique = [...new Set(CANDIDATES)];
  console.log(`Probing ${unique.length} candidate Bevy tenants…\n`);

  const results: Probe[] = [];
  // Modest concurrency: these are third-party hosts and this is a survey, not a load test.
  const CONCURRENCY = 6;
  let cursor = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < unique.length) {
        const host = unique[cursor++];
        results.push(await probe(host));
      }
    })
  );

  const live = results.filter(r => r.ok).sort((a, b) => (b.blr || 0) - (a.blr || 0));
  const dead = results.filter(r => !r.ok);

  console.log(`── BEVY TENANTS (${live.length}) ──`);
  for (const r of live) {
    console.log(
      `  ${String(r.blr).padStart(3)} BLR / ${String(r.total).padStart(4)} IN   ${r.host}`
    );
    for (const s of r.sampleBlr || []) console.log(`        · ${s}`);
  }

  console.log(`\n── NOT BEVY (${dead.length}) ──`);
  for (const r of dead) {
    console.log(`  ${String(r.status ?? '---').padStart(4)}  ${r.host}  ${r.note || ''}`);
  }

  const worth = live.filter(r => (r.blr || 0) > 0);
  console.log(
    `\nVERDICT: ${live.length} live tenant(s), ${worth.length} with Bengaluru events.`
  );
  if (worth.length) {
    console.log('Add to BEVY_HOSTS in lib/scrapers/adapters/bevy.ts:');
    for (const r of worth) console.log(`  '${r.host}',`);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
