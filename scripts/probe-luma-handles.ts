#!/usr/bin/env tsx
/**
 * READ-ONLY: which Luma calendar handles actually exist?
 *
 * `luma.com/<handle>` returns 200 with the calendar's api_id in __NEXT_DATA__ for a
 * real handle and 404 otherwise (verified: theproductfolks, lyzr, sarvam, basecamp
 * resolved; razorpay, aitinkerers, buildclubblr did not). So a handle list is
 * verifiable rather than guesswork — anything that returns 200 here can be seeded
 * as a source and will then be scraped every run.
 *
 * This complements city-feed discovery: the city feed only surfaces hosts that
 * happen to have an event in the current window, so a company whose next event is
 * two months out is invisible to it but visible here.
 *
 * Run: npx tsx scripts/probe-luma-handles.ts
 */
import './load-env';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

async function get(url: string): Promise<{ status: number; text: string }> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(18000),
    });
    return { status: res.status, text: await res.text() };
  } catch (err) {
    return { status: 0, text: err instanceof Error ? err.message : String(err) };
  }
}

/** First calendar api_id on the page, plus the calendar's name if findable. */
function readCalendar(html: string): { apiId?: string; name?: string; events?: number } {
  const id = html.match(/"api_id"\s*:\s*"(cal-[A-Za-z0-9]+)"/)?.[1];
  if (!id) return {};
  const at = html.indexOf(`"${id}"`);
  const window = html.slice(Math.max(0, at - 600), at + 600);
  const name = window.match(/"name"\s*:\s*"([^"]{2,60})"/)?.[1];
  const events = (html.match(/"api_id"\s*:\s*"evt-[A-Za-z0-9]+"/g) || []).length;
  return { apiId: id, name, events };
}

/**
 * Candidate handles: Bengaluru-active companies, their community brands, and the
 * communities that host company events. Luma handles are usually the brand name
 * lowercased and unspaced, so that's the pattern tried.
 */
const HANDLES = [
  // Company / product communities
  'razorpayrize', 'rize', 'zerodha', 'rainmatter', 'cred', 'swiggy', 'flipkart',
  'phonepe', 'meesho', 'groww', 'juspay', 'setu', 'zeta', 'slice', 'navi',
  'postman', 'postmanapi', 'hasura', 'browserstack', 'chargebee', 'freshworks',
  'zoho', 'atlan', 'whatfix', 'zluri', 'darwinbox', 'rippling',
  'sarvamai', 'krutrim', 'olakrutrim', 'lyzrai', 'fractal', 'musigma',
  'nvidiaindia', 'googlecloudindia', 'microsoftreactor', 'awsindia', 'awsugblr',
  'githubindia', 'gitlabindia', 'mongodbindia', 'databricksindia', 'snowflakeindia',
  'confluentindia', 'elasticindia', 'redisindia', 'grafanaindia', 'dockerindia',
  'salesforceindia', 'adobeindia', 'intuitindia', 'walmartglobaltech',
  // Communities and accelerators that publish company events
  'aitinkerersblr', 'aitinkerersbangalore', 'buildclub', 'thebuildclub',
  'papersweloveblr', 'papersweread', 'bengalurutechweek', 'bangaloretechsummit',
  'antlerindia', 'accelindia', 'peakxv', 'surge', 'blumeventures', 'lightspeedindia',
  'z47', 'arkamventures', 'ycombinator', 'foundersstartuphouse', 'founderstartuphouse',
  'startuphouse', 'draperstartuphouse', 'techsauce', 'headstart', 'tie', 'tiebangalore',
  'nasscom', 'iimb', 'iiscbangalore', 'devfolio', 'unstop', 'hasgeek',
  'cncfbengaluru', 'kcdbengaluru', 'gdgcloudbengaluru', 'gdgbangalore',
  'womentechmakers', 'wtmblr', 'pyconindia', 'bangpypers', 'pydatabangalore',
  'reactbangalore', 'blrdesign', 'designbengaluru', 'productfolks',
  'buildersclub', 'buildwithai', 'genaiblr', 'aiblr', 'blrai', 'aihouse',
  'techinasia', 'growthx', 'atomicwork', 'hackerhouse', 'nightowls',
];

async function main() {
  console.log(`\nProbing ${HANDLES.length} candidate Luma handles\n`);

  const found: Array<{ handle: string; apiId: string; name: string; events: number }> = [];

  // Modest concurrency: polite, and fast enough for ~100 handles.
  const CONCURRENCY = 6;
  let cursor = 0;
  async function worker() {
    while (cursor < HANDLES.length) {
      const handle = HANDLES[cursor++];
      const r = await get(`https://luma.com/${handle}`);
      if (r.status === 200) {
        const cal = readCalendar(r.text);
        if (cal.apiId) {
          found.push({
            handle,
            apiId: cal.apiId,
            name: cal.name || handle,
            events: cal.events || 0,
          });
          console.log(
            `  FOUND ${handle.padEnd(24)} ${cal.apiId}  "${(cal.name || '').slice(0, 30)}"  events~${cal.events}`
          );
          continue;
        }
      }
      console.log(`    --  ${handle.padEnd(24)} HTTP ${r.status}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  found.sort((a, b) => b.events - a.events);
  console.log(`\n${found.length}/${HANDLES.length} handles resolved to a real calendar.`);
  console.log('Seed these into LUMA_SEED_CALENDARS:\n');
  console.log(
    JSON.stringify(
      found.map(f => ({ handle: f.apiId, label: f.name })),
      null,
      2
    )
  );
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
