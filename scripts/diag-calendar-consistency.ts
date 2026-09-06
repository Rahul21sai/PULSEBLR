/**
 * Do the calendar's DOTS and its DAY PANEL agree, day by day, for a whole month?
 *
 * `/calendar` answers one question through two different endpoints. The grid gets per-day counts
 * from `GET /api/events/calendar`, a Mongo aggregation; clicking a square gets documents from
 * `GET /api/events`. Two endpoints answering the same question is the exact shape
 * `lib/events/query.ts` exists to police — "a filter that behaves differently between the list and
 * the counts next to the filters is a bug users notice immediately".
 *
 * They already share `buildEventFilter()`, so no dimension can drift silently — except the one
 * thing the aggregation does that the list does not: EXPANDING a multi-day event onto every day it
 * runs. That expansion is bounded, the bound must match the list's `spanning` lookback, and the two
 * are not the same number. This script is the assertion that they line up.
 *
 * WHAT IT CAUGHT, which is why it exists rather than being a unit test. `SPAN_FLOOR_DAYS` is a
 * LOOKBACK — the list admits an event to day D if it started on or after `D - SPAN_FLOOR_DAYS`, so
 * an event starting on S appears for S through S + SPAN_FLOOR_DAYS: fifteen days inclusive, not
 * fourteen. The aggregation capped its expansion at fourteen. Measured over September 2026 against
 * the live corpus: 29 days agreed and 20 September did not, dot 4 against panel 5. One event was
 * responsible — `AI Agents Workshop`, dated 2026-09-06 → 2026-10-06, a 31-day range that only the
 * cap keeps off the whole grid.
 *
 * A ONE-DAY, ONE-EVENT DISCREPANCY IS WHY THIS IS A SCRIPT AND NOT A CALCULATION. Both bounds look
 * correct in isolation and both read as "fourteen days" in prose; only running every day of a real
 * month against real data shows the seam. An aggregate would have hidden it too — 29 of 30 days
 * matching is a 97% agreement rate, which reads as noise rather than as an off-by-one.
 *
 * The two failure directions are NOT equally bad, so they are reported separately:
 *   · dot > panel — a square advertises events and the panel says "Nothing scheduled this day".
 *     Worse: it reads as data being hidden, and it is the shape `canViewEvent`'s always-404 rule
 *     exists to avoid presenting.
 *   · dot < panel — the panel lists an event the square never counted. A wrong number, not a
 *     contradiction, but it means the grid under-reports how busy a day is.
 *
 * Read-only: it makes GET requests and writes nothing. Needs a dev server; no sign-in, because both
 * endpoints are public and the anonymous view is the one nearly every visitor gets.
 *
 *   npx tsx scripts/diag-calendar-consistency.ts               # current IST month
 *   npx tsx scripts/diag-calendar-consistency.ts 2026-09       # a specific month
 *   PB_BASE=http://localhost:3201 npx tsx scripts/diag-calendar-consistency.ts 2026-09 2026-10
 *
 * Exits non-zero on any mismatch.
 */

const CAL_BASE = process.env.PB_BASE || 'http://localhost:3000';

/** Today's IST month, without importing the app's formatters — this script talks HTTP only. */
function currentIstMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

function daysIn(monthKey: string): number {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * The day-panel request, byte-for-byte what `app/calendar/page.tsx` sends.
 *
 * Duplicating the parameter list is the one bit of copying here, and it is deliberate: the point is
 * to catch the page and the aggregation disagreeing, so importing a shared helper for both sides
 * would make the script agree with itself instead of with the product. If you change the page's
 * fetch, change this to match — a silent divergence here is the script going blind, not passing.
 */
async function panelFor(dayKey: string) {
  const params = new URLSearchParams({
    from: new Date(`${dayKey}T00:00:00.000+05:30`).toISOString(),
    to: new Date(`${dayKey}T23:59:59.999+05:30`).toISOString(),
    limit: '100',
    includePast: 'true',
    includeOngoing: 'false',
    spanning: 'true',
    techOnly: 'true',
    sort: 'soonest',
  });
  const res = await fetch(`${CAL_BASE}/api/events?${params}`);
  if (!res.ok) throw new Error(`GET /api/events for ${dayKey} → HTTP ${res.status}`);
  const data = await res.json();
  const rows: Array<{ title: string; startDateTime: string }> = data.events ?? [];
  return { total: data.pagination?.total ?? rows.length, rows };
}

async function countsFor(monthKey: string) {
  const res = await fetch(`${CAL_BASE}/api/events/calendar?month=${monthKey}&techOnly=true`);
  if (!res.ok) throw new Error(`GET /api/events/calendar?month=${monthKey} → HTTP ${res.status}`);
  return res.json() as Promise<{
    days: Record<string, number>;
    total: number;
    daysWithEvents: number;
  }>;
}

async function checkMonth(monthKey: string): Promise<number> {
  const counts = await countsFor(monthKey);
  const bucketSum = Object.values(counts.days).reduce((a, b) => a + b, 0);

  console.log(`\n── ${monthKey} ────────────────────────────────────────────────`);
  console.log(
    `month total ${counts.total} distinct events · ${counts.daysWithEvents} days with any · ` +
      `${bucketSum} day-slots occupied`
  );
  /**
   * `total` MUST NOT equal the bucket sum once anything is multi-day, and saying so here is the
   * check on the header copy. The page reads "N events across M days"; if the route ever summed its
   * own buckets for N, a month with one three-day conference would report three events.
   */
  if (bucketSum > counts.total) {
    console.log(
      `  → ${bucketSum - counts.total} extra day-slots come from multi-day events. ` +
        `Correct: the header's event count is a separate countDocuments, not this sum.`
    );
  }

  let dotHigher = 0;
  let panelHigher = 0;

  for (let d = 1; d <= daysIn(monthKey); d++) {
    const key = `${monthKey}-${String(d).padStart(2, '0')}`;
    const dot = counts.days[key] ?? 0;
    const panel = await panelFor(key);
    if (dot === panel.total) continue;

    if (dot > panel.total) {
      dotHigher++;
      console.log(
        `  FAIL ${key}  dot ${dot} > panel ${panel.total} — squares advertise events the panel cannot show`
      );
    } else {
      panelHigher++;
      console.log(
        `  FAIL ${key}  dot ${dot} < panel ${panel.total} — the panel lists events the square never counted`
      );
      // Name the culprits: the rows whose start is on another day are the span-bound suspects.
      for (const r of panel.rows) {
        const startKey = new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Asia/Kolkata',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date(r.startDateTime));
        if (startKey !== key) {
          console.log(`         carried over from ${startKey}: ${r.title.slice(0, 58)}`);
        }
      }
    }
  }

  const bad = dotHigher + panelHigher;
  console.log(
    bad === 0
      ? `  OK — all ${daysIn(monthKey)} days agree`
      : `  ${bad} of ${daysIn(monthKey)} days disagree (${dotHigher} dot-high, ${panelHigher} panel-high)`
  );
  return bad;
}

(async () => {
  const months = process.argv.slice(2).filter(a => /^\d{4}-\d{2}$/.test(a));
  if (months.length === 0) months.push(currentIstMonth());

  console.log(`Calendar dot/panel consistency · ${CAL_BASE}`);

  let bad = 0;
  try {
    for (const m of months) bad += await checkMonth(m);
  } catch (err) {
    console.error(`\nFAILED to reach the server: ${(err as Error).message}`);
    console.error('Start a dev server, or set PB_BASE to one that is running.');
    process.exit(2);
  }

  console.log(bad === 0 ? '\nPASS' : `\nFAIL — ${bad} day(s) disagree`);
  process.exit(bad === 0 ? 0 : 1);
})();
