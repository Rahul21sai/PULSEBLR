#!/usr/bin/env tsx
/**
 * The gate before a Luma calendar is seeded, applied to the ONE candidate the
 * events.heapheaphurray.com audit produced.
 *
 * The audit reduced that whole site to a single actionable gap: "JumpStart Bharat: Bengaluru"
 * (https://lu.ma/9ozcbva9) sits on Luma calendar `cal-uoe6JLx8HnATkBp`, which we have never
 * discovered. Everything else it lists is either already in our corpus or in another city.
 *
 * This repo's rule for adding a seed is explicit and worth honouring: verify with the PRODUCTION
 * mechanism that the calendar returns UPCOMING events before adding it. Two candidates from an
 * earlier seed round (Sela x Google Cloud, kipi.ai) returned zero and were deliberately left out.
 * Seeding a dead handle costs a request every run forever and makes the source-health report
 * noisier, which is how real signals get ignored.
 *
 * The second question is just as important: how many of its events are actually in BENGALURU?
 * A calendar can be busy and still be worthless here — the geo gate would drop everything, and
 * `LUMA_SEED_CALENDARS` already documents two global calendars kept only for their BLR chapter.
 * That is a deliberate trade, not an accident, so it should be a deliberate decision here too.
 *
 * Read-only. Fetches Luma's public calendar API, writes nothing.
 *
 * Run: npx tsx scripts/verify-hhh-calendar.ts
 */
import './load-env';

const API = 'https://api.lu.ma';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Candidates, with why each is a candidate. */
const CANDIDATES = [
  { handle: 'cal-uoe6JLx8HnATkBp', label: 'JumpStart Bharat', why: 'the single genuine gap the audit found' },
  // Harvested from the same audit: hosts of their Bengaluru events that we do NOT know as
  // calendars, even though the events themselves reached us via the city discover feed. A
  // discover-feed sighting is luck of the day's ranking; a seed is scraped every run.
  { handle: 'cal-ZEzAGxvFU094YU2', label: 'AIBoomi', why: 'host of AIBoomi Expert Hours (we have the event, not the calendar)' },
  { handle: 'cal-3aH7Cvqdyre9u3j', label: 'Founders Running Club', why: 'host of Founders Running Club Bengaluru' },
];

interface LumaItem {
  event?: {
    name?: string;
    start_at?: string;
    geo_address_json?: { city?: string; address?: string; full_address?: string } | null;
    timezone?: string;
  };
}

async function getItems(calendarApiId: string) {
  const url =
    `${API}/calendar/get-items?calendar_api_id=${encodeURIComponent(calendarApiId)}` +
    `&period=future&pagination_limit=50`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { status: res.status, items: [] as LumaItem[], error: `HTTP ${res.status}` };
    const body = (await res.json()) as { entries?: LumaItem[]; items?: LumaItem[] };
    return { status: res.status, items: body.entries ?? body.items ?? [] };
  } catch (err) {
    return { status: 0, items: [] as LumaItem[], error: err instanceof Error ? err.message : String(err) };
  }
}

const BLR = /bengaluru|bangalore/i;

async function main() {
  for (const c of CANDIDATES) {
    console.log(`════ ${c.label}  (${c.handle})`);
    console.log(`     why: ${c.why}`);

    const r = await getItems(c.handle);
    if (r.status !== 200) {
      console.log(`     ${r.status} ${'error' in r ? r.error : ''} → DO NOT SEED (endpoint does not answer)\n`);
      continue;
    }

    const upcoming = r.items.filter(i => i.event?.name && i.event?.start_at);
    const blr = upcoming.filter(i => {
      const e = i.event!;
      const geo = e.geo_address_json;
      return BLR.test(`${e.name ?? ''} ${geo?.city ?? ''} ${geo?.address ?? ''} ${geo?.full_address ?? ''}`);
    });

    console.log(`     upcoming events: ${upcoming.length}   of which Bengaluru: ${blr.length}`);

    for (const i of upcoming.slice(0, 10)) {
      const e = i.event!;
      const city = e.geo_address_json?.city ?? '—';
      const isBlr = blr.includes(i);
      console.log(
        `       ${isBlr ? 'BLR ' : '    '} ${String(e.start_at ?? '').slice(0, 10)}  ${String(e.name).slice(0, 48).padEnd(48)} ${String(city).slice(0, 18)}`
      );
    }
    if (upcoming.length > 10) console.log(`       … ${upcoming.length - 10} more`);

    // The decision, stated by the same rule the existing seeds were held to.
    let verdict: string;
    if (upcoming.length === 0) {
      verdict = 'DO NOT SEED — zero upcoming events, same as the two rejected in the earlier round.';
    } else if (blr.length === 0) {
      verdict =
        'DO NOT SEED unless a BLR chapter is expected — busy but nothing in Bengaluru, so the geo ' +
        'gate would drop all of it and we would pay a request per run for nothing.';
    } else if (blr.length === upcoming.length) {
      verdict = `SEED — ${blr.length}/${upcoming.length} upcoming events are Bengaluru. Pure win.`;
    } else {
      verdict =
        `SEED — ${blr.length} of ${upcoming.length} upcoming are Bengaluru; the geo gate drops the ` +
        'rest. Costs one request per run, which is the same trade already documented for the two ' +
        'global calendars in LUMA_SEED_CALENDARS.';
    }
    console.log(`     → ${verdict}\n`);
  }

  console.log('Add anything that passes to LUMA_SEED_CALENDARS in lib/scrapers/adapters/luma.ts.');
  console.log('Seeds are persisted and scraped EVERY run, so coverage compounds from here.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
