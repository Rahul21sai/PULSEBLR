// Probe whether named Bengaluru company communities exist as Meetup groups.
//
// WHY: recon showed company MARKETING pages (Red Hat, GitLab, Docker, Google Cloud,
// Databricks, Confluent) publish zero structured event data, so scraping them is a
// dead end. The communities those companies actually run on Meetup DO publish ICS
// feeds — so verifying handles here and seeding them into SEED_MEETUP_GROUPS is the
// route that works.
//
// Luma is deliberately NOT probed by slug. `api.lu.ma/calendar/get-page?url=<handle>`
// returned 404 for all 36 candidates tried, which means the guessed endpoint shape is
// wrong rather than that those calendars are absent — so a slug probe here would
// produce misleading negatives. Luma host calendars are discovered properly from the
// city discover feed instead (see lib/scrapers/adapters/luma.ts).
//
// Read-only, no DB access. Run: node scripts/probe-company-handles.mjs

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function fetchIcs(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: String(err).slice(0, 60) };
  }
}

/**
 * Candidate slugs for company-run Bengaluru communities.
 * Add to this list and re-run to extend coverage; anything that returns 200 is
 * safe to paste into SEED_MEETUP_GROUPS.
 */
const MEETUP_SLUGS = [
  'postman-bangalore', 'razorpay-engineering', 'bangalore-mongodb-user-group',
  'elastic-bangalore', 'gitlab-bangalore', 'redis-bangalore', 'confluent-bangalore',
  'databricks-bangalore', 'snowflake-bangalore', 'hashicorp-user-group-bangalore',
  'jetbrains-bengaluru', 'docker-bangalore', 'grafana-and-friends-bengaluru',
  'bangalore-kubernetes-meetup', 'cncf-bengaluru', 'aws-user-group-bengaluru',
  'microsoft-azure-bangalore', 'google-cloud-bengaluru', 'salesforce-bangalore',
  'servicenow-bangalore', 'uipath-bangalore', 'thoughtworks-bangalore',
];

async function main() {
  console.log(`\nProbing ${MEETUP_SLUGS.length} candidate Meetup group ICS feeds\n`);

  const found = [];
  for (const slug of MEETUP_SLUGS) {
    const res = await fetchIcs(`https://www.meetup.com/${slug}/events/ical/`);
    const vevents = (res.text.match(/BEGIN:VEVENT/g) || []).length;
    const ok = res.status === 200;
    // A group with 0 VEVENTs is healthy — it just has nothing scheduled right now.
    console.log(
      `  ${ok ? 'FOUND' : '  -  '} ${slug.padEnd(38)} HTTP ${res.status} vevents=${vevents}`
    );
    if (ok) found.push(slug);
  }

  console.log(`\n${found.length}/${MEETUP_SLUGS.length} exist. Paste into SEED_MEETUP_GROUPS:`);
  console.log(JSON.stringify(found, null, 2));
}

main();
