#!/usr/bin/env tsx
/**
 * THE PRE-DEMO CHECK: is what a visitor sees right now fit to be shown to a room?
 *
 * Every other diagnostic here answers a question about the CORPUS. This one answers a question
 * about the SCREEN, because those are different questions and this repo's most expensive lesson
 * is the gap between them: tech precision measured 98% while the top of the default feed was
 * board games and a jamming night. A count is not a ranking, and the user sees the ranking.
 *
 * So the centrepiece is section 2 — the first twenty rows of the default feed, printed with
 * enough fact per row (score, days out, format, area, cover, organiser, source) that the owner
 * can judge them BY EYE thirty seconds before walking on stage. The script does not try to
 * replace that judgement. It flags only what a predicate can decide without an opinion.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──────────────────────────────────────────────────────────
 * It does not re-derive tech precision (`diag-tech-fp.ts` owns that), tag quality
 * (`diag-tagquality.ts`), or the off-city backlog (`diag-offcity.ts`). Duplicating them here
 * would produce a second, drifting copy of each answer. It calls the PRODUCT's own predicates —
 * `buildEventFilter`, `buildSort`, `offCityReason`, `normalizeTitleForMatch`, `connectionScore` —
 * imported, never mirrored, so a weight change or a gazetteer edit moves this report too.
 *
 * ── WHY IT EXITS NON-ZERO ONLY ON FIVE THINGS ─────────────────────────────────────────────────
 * A pre-demo check that cries wolf gets ignored, which is worse than not having one. It fails
 * only where the demo itself would visibly break or lie:
 *   1. the first page is empty or nearly so       — nothing to show
 *   2. an off-city row is ON the first page        — a Bengaluru product showing Pune, on screen
 *   3. two rows on the first page are the same event — the dedup story is part of the pitch
 *   4. the corpus has not been written to in 72h   — "live" feed that is not
 *   5. the ranking is stale (stored score drifts)  — the ranking IS the product
 * Everything else prints as WARN and returns 0. An LLM outage is a WARN on purpose: the keyword
 * floor is documented to keep the pipeline running, and a demo does not tag anything live.
 *
 * Read-only. No writes, no DB mutation. One outbound request per configured LLM tier unless
 * `--no-net`; the cover probe is opt-in because it is the only slow part.
 *
 * Run: npx tsx scripts/diag-demo-readiness.ts
 *      npx tsx scripts/diag-demo-readiness.ts --covers    # + probe cover URLs (slow, ~30s)
 *      npx tsx scripts/diag-demo-readiness.ts --no-net    # skip every outbound request
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';
import { buildEventFilter, buildSort } from '../lib/events/query';
import { offCityReason } from '../lib/scrapers/core/geo';
import { normalizeTitleForMatch } from '../lib/scrapers/core/text';
import { connectionScore } from '../lib/events/connection-score';

const PROBE_COVERS = process.argv.includes('--covers');
const NO_NET = process.argv.includes('--no-net');

/** How many rows of the feed count as "the first page" for judging purposes. */
const FIRST_PAGE = 20;
/** Hours without a single new document before the feed stops being credibly live. */
const STALE_HOURS = 72;
/**
 * Days out past which a row on the first page is worth a second look.
 *
 * NOT a defect on its own — GIDS is legitimately in April and legitimately scores 100, and
 * `connections` sort is supposed to put a great event above a mediocre sooner one. It is printed
 * so the owner decides whether a marquee conference seven months out belongs above next week.
 */
const FAR_FUTURE_DAYS = 120;

const IST = 'Asia/Kolkata';
const ist = (d: Date | undefined | null): string =>
  d ? new Date(d).toLocaleString('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' }) : '—';
const istDay = (d: Date | undefined | null): string =>
  d ? new Date(d).toLocaleDateString('en-IN', { timeZone: IST, day: '2-digit', month: 'short' }) : '—';

const pad = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));

interface Problem {
  severity: 'BLOCK' | 'WARN';
  what: string;
  evidence: string;
}
const problems: Problem[] = [];
const block = (what: string, evidence: string) => problems.push({ severity: 'BLOCK', what, evidence });
const warn = (what: string, evidence: string) => problems.push({ severity: 'WARN', what, evidence });

function heading(n: number, title: string) {
  console.log(`\n${'─'.repeat(94)}\n${n}. ${title}\n${'─'.repeat(94)}`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 1. Is the corpus fresh?
// ───────────────────────────────────────────────────────────────────────────────────────────────
async function checkFreshness(now: Date) {
  heading(1, 'CORPUS FRESHNESS — is the feed credibly live?');

  const [newest] = await Event.find({}, { createdAt: 1, title: 1, source: 1 })
    .sort({ createdAt: -1 })
    .limit(1)
    .lean();
  const [touched] = await Event.find({ lastSeenAt: { $ne: null } }, { lastSeenAt: 1 })
    .sort({ lastSeenAt: -1 })
    .limit(1)
    .lean();

  const newestAt = newest?.createdAt ? new Date(newest.createdAt) : null;
  const ageH = newestAt ? (now.getTime() - newestAt.getTime()) / 3_600_000 : Infinity;

  const day = new Date(now.getTime() - 24 * 3_600_000);
  const [created24, seen24, keyword24] = await Promise.all([
    Event.countDocuments({ createdAt: { $gte: day } }),
    Event.countDocuments({ lastSeenAt: { $gte: day } }),
    // tagConfidence exactly 0.6 is the keyword floor's fingerprint (see diag-recent-writes.ts).
    Event.countDocuments({ createdAt: { $gte: day }, tagConfidence: 0.6 }),
  ]);

  console.log(`  now (IST)                 ${ist(now)}`);
  console.log(`  newest document           ${ist(newestAt)}   (${ageH === Infinity ? 'never' : ageH.toFixed(1) + ' h ago'})`);
  console.log(`  newest lastSeenAt         ${ist(touched?.lastSeenAt as Date | undefined)}`);
  console.log(`  created in last 24 h      ${created24}`);
  console.log(`  re-seen  in last 24 h     ${seen24}`);
  console.log(
    `  of the new ones, keyword-tagged (tagConfidence 0.6): ${keyword24}` +
      (created24 > 0 ? ` of ${created24} (${Math.round((keyword24 / created24) * 100)}%)` : '')
  );

  if (ageH > STALE_HOURS) {
    block(
      'The corpus has not been written to in over 72 h',
      `newest document is ${ageH.toFixed(0)} h old — the daily cron has not landed, so "live feed" is not true`
    );
  } else if (ageH > 30) {
    warn(
      'No new documents in over 30 h',
      `newest document is ${ageH.toFixed(1)} h old — one cron run appears to have been missed`
    );
  }
  if (created24 > 0 && keyword24 === created24) {
    warn(
      'Every document written in the last 24 h carries the keyword-tagging fingerprint',
      `${keyword24}/${created24} at tagConfidence 0.6 — the LLM tier contributed nothing to the newest rows`
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 2. The first page — what a visitor actually sees
// ───────────────────────────────────────────────────────────────────────────────────────────────
interface Row {
  _id: unknown;
  title?: string;
  organizer?: string;
  source?: string;
  format?: string;
  area?: string;
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  imageUrl?: string;
  startDateTime?: Date;
  connectionScore?: number;
  clusterKey?: string;
  category?: string[];
  companies?: string[];
  hasFood?: string;
  isFree?: boolean;
  price?: number;
  attendeeCount?: number;
  capacity?: number;
  isTechEvent?: boolean;
  visibility?: string;
}

async function checkFirstPage(now: Date): Promise<Row[]> {
  heading(2, `THE FIRST PAGE — top ${FIRST_PAGE} of the default feed, signed out`);
  console.log('  the app\'s own filter and sort: techOnly=true, includeOngoing, sort=connections, viewer=null\n');

  // buildEventFilter + buildSort, not a hand-rolled query: this must be the same narrowing and
  // the same ordering the home page gets, or the report is about a feed nobody sees.
  const filter = buildEventFilter({ techOnly: true, includeOngoing: true }, null);
  const rows = (await Event.find(filter)
    .sort(buildSort('connections', false))
    .limit(FIRST_PAGE)
    .lean()) as unknown as Row[];

  const totalTech = await Event.countDocuments(filter);
  console.log(`  ${totalTech} upcoming tech events match; showing the first ${rows.length}\n`);

  if (rows.length === 0) {
    block('The default feed is EMPTY', 'buildEventFilter({techOnly, includeOngoing}) matched 0 documents');
    return rows;
  }
  if (rows.length < 10) {
    block('The default feed has fewer than 10 rows', `${rows.length} matched — the landing page will look broken`);
  }

  console.log(
    `  ${'#'.padEnd(3)}${'score'.padEnd(6)}${'when'.padEnd(9)}${'d+'.padEnd(5)}${'fmt'.padEnd(9)}` +
      `${'cover'.padEnd(6)}${'source'.padEnd(11)}${pad('area / venue', 24)}${pad('organiser', 22)}title`
  );

  const seenCluster = new Map<string, string[]>();
  const seenTitle = new Map<string, string[]>();
  const flags: string[] = [];
  let driftCount = 0;
  const driftRows: string[] = [];

  rows.forEach((e, i) => {
    const days = e.startDateTime
      ? Math.round((new Date(e.startDateTime).getTime() - now.getTime()) / 86_400_000)
      : NaN;
    const place = e.area || e.venue || (e.format === 'online' ? '(online)' : '—');
    const cover = e.imageUrl ? 'yes' : 'NO';

    console.log(
      `  ${String(i + 1).padEnd(3)}${String(e.connectionScore ?? '—').padEnd(6)}` +
        `${istDay(e.startDateTime).padEnd(9)}${(Number.isFinite(days) ? `${days}d` : '—').padEnd(5)}` +
        `${pad(e.format ?? '—', 9)}${cover.padEnd(6)}${pad(e.source ?? '—', 11)}` +
        `${pad(place, 24)}${pad(e.organizer ?? '—', 22)}${e.title ?? '—'}`
    );

    // ── off-city, judged by the ingest gate's OWN predicate. Description is not passed, exactly
    //    as the gate does not pass it — see OffCityInput's comment on why.
    const off = offCityReason({
      title: e.title,
      venue: e.venue,
      address: e.address,
      city: e.city,
      lat: e.lat,
      lng: e.lng,
    });
    if (off) {
      flags.push(`      row ${i + 1}: OFF-CITY — ${off.city} (from ${off.field}) — "${e.title}"`);
      block(
        `An off-city event is on the FIRST PAGE at rank ${i + 1}`,
        `"${e.title}" — offCityReason says ${off.city} from the '${off.field}' field, score ${e.connectionScore}`
      );
    }
    // A city field naming somewhere else, even when the gate spares the row on Bengaluru
    // evidence, still renders on the card. Worth seeing; not a blocker.
    if (e.city && !/beng|bang|blr|karnataka/i.test(e.city)) {
      flags.push(`      row ${i + 1}: city field reads "${e.city}" — "${e.title}"`);
      warn(
        `Row ${i + 1} of the first page carries a non-Bengaluru city field`,
        `"${e.title}" — city="${e.city}" (gate spares it on other Bengaluru evidence, but the value can render)`
      );
    }

    if (!e.imageUrl) flags.push(`      row ${i + 1}: NO COVER — renders as a monogram — "${e.title}"`);

    if (Number.isFinite(days) && days > FAR_FUTURE_DAYS) {
      flags.push(`      row ${i + 1}: ${days} days out — above everything happening this week`);
    }

    // ── the same event twice, by the product's two identities
    if (e.clusterKey) {
      const at = seenCluster.get(e.clusterKey) ?? [];
      at.push(`${i + 1}`);
      seenCluster.set(e.clusterKey, at);
    }
    const norm = normalizeTitleForMatch(e.title ?? '');
    if (norm) {
      const at = seenTitle.get(norm) ?? [];
      at.push(`${i + 1}`);
      seenTitle.set(norm, at);
    }

    // ── is the stored ranking still what the scorer would produce?
    const recomputed = connectionScore({
      format: e.format,
      hasFood: e.hasFood,
      attendeeCount: e.attendeeCount,
      capacity: e.capacity,
      category: e.category,
      companies: e.companies,
      organizer: e.organizer,
      title: e.title,
      isFree: e.isFree,
      price: e.price,
    });
    if (typeof e.connectionScore === 'number' && recomputed !== e.connectionScore) {
      driftCount += 1;
      driftRows.push(`row ${i + 1} ${e.connectionScore}→${recomputed} "${String(e.title).slice(0, 44)}"`);
      flags.push(
        `      row ${i + 1}: SCORE DRIFT stored ${e.connectionScore} vs recomputed ${recomputed} — "${e.title}"`
      );
    }
  });

  // ── ONE blocker for the whole page, not one per row. The fix is a single command, and four
  //    near-identical entries in a pre-flight verdict is how a check gets ignored.
  if (driftCount > 0) {
    block(
      `The ranking on the first page is STALE — ${driftCount} of ${rows.length} rows`,
      `${driftRows.join('; ')} — the stored score no longer matches what the scorer returns for the ` +
        `stored fields, so the feed is ordered on numbers that are out of date. Fix: npx tsx scripts/backfill-connection-score.ts`
    );
  }

  // ── A TRUE duplicate shares the product's cross-source identity: normalised title + IST day.
  //    That is exactly `clusterKey`, so same-clusterKey is the unambiguous case.
  for (const [key, at] of seenCluster) {
    if (at.length > 1) {
      block(
        'Two rows on the FIRST PAGE are the same event',
        `rows ${at.join(' and ')} share clusterKey "${key}"`
      );
    }
  }
  /**
   * SAME NORMALISED TITLE, DIFFERENT DAY — a WARN, never a blocker, and the distinction was worth
   * getting right. `normalizeTitleForMatch` strips "meetup", "bangalore" and friends as noise, so a
   * monthly series legitimately collapses to one string: seven "Python Meetup" rows normalise to
   * "python" and are seven genuinely different events. Calling that a duplicate would be false.
   *
   * It is still worth printing, because a READER cannot see the date difference at a glance when
   * four rows carry the same title and the same monogram — it reads as a duplication bug whether or
   * not it is one. That is a presentation finding, so it is reported as one.
   */
  for (const [norm, at] of seenTitle) {
    if (at.length > 1) {
      warn(
        `${at.length} rows on the first page share the title shape "${norm}"`,
        `rows ${at.join(', ')} — distinct events (different days) but they READ as duplicates, ` +
          `especially where none has a cover image`
      );
    }
  }

  // ── The duplicate that matters most is the one whose twin is OFF this page: a hand-entered event
  //    beside the scraped original. `clusterKey` cannot catch it because a manual event's key is
  //    owner-namespaced by design (see CLAUDE.md §12), so this asks the question the key cannot.
  const dayOf = (d?: Date) =>
    d ? new Date(d).toLocaleDateString('en-CA', { timeZone: IST }) : '';
  // Fetched ONCE. The same query inside the loop is twenty full scans of the tech feed, which is
  // how a check that has to finish in under a minute stops finishing in under a minute.
  const allTech = (await Event.find(filter, { title: 1, startDateTime: 1, source: 1, connectionScore: 1 })
    .lean()) as unknown as Row[];
  /**
   * CONTAINMENT, NOT EQUALITY — and this is the whole reason the check exists.
   *
   * Equality on the normalised title is what `clusterKey` already does, so it finds nothing new. The
   * duplicate that actually reaches the feed is the pair whose titles differ by a SUFFIX, because a
   * hand-entered event is typed with the host appended: measured on this corpus,
   *   "build coding agents hands workshop person"  [bevy]
   *   "build coding agents hands workshop person uipath"  [manual]
   * are the same event on the same IST day, and one is a strict prefix of the other. `clusterKey`
   * cannot match them for two independent reasons — the extra token, and the owner-namespacing a
   * manual event's key carries on purpose — so nothing in the repo currently sees this pair.
   *
   * The 16-character floor is what keeps it honest: without it, short shared prefixes collide and
   * the check reports every "Python Meetup" against every other. A diagnostic heuristic, deliberately
   * not promoted into the product's identity logic — merging on a prefix would be a data-loss bug.
   */
  const MIN_PREFIX = 16;
  const byDay = new Map<string, Array<{ row: Row; norm: string }>>();
  for (const o of allTech) {
    const day = dayOf(o.startDateTime);
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push({ row: o, norm: normalizeTitleForMatch(o.title ?? '') });
  }
  for (const [i, e] of rows.entries()) {
    const norm = normalizeTitleForMatch(e.title ?? '');
    if (!norm || norm.length < MIN_PREFIX) continue;
    const sameDay = byDay.get(dayOf(e.startDateTime)) ?? [];
    const match = sameDay.find(
      o =>
        String(o.row._id) !== String(e._id) &&
        o.norm.length >= MIN_PREFIX &&
        (o.norm.startsWith(norm) || norm.startsWith(o.norm))
    );
    const twin = match?.row;
    if (twin) {
      warn(
        `Row ${i + 1} of the first page is in the feed TWICE`,
        `"${e.title}" [${e.source}, score ${e.connectionScore}] and "${twin.title}" ` +
          `[${twin.source}, score ${twin.connectionScore}] are the same event on the same IST day. ` +
          `A hand-entered event's clusterKey is owner-namespaced, so ingest cannot merge them.`
      );
    }
  }

  if (flags.length) {
    console.log('\n  things to look at on this page:');
    flags.forEach(f => console.log(f));
  } else {
    console.log('\n  nothing flagged on the first page.');
  }

  const noCover = rows.filter(e => !e.imageUrl).length;
  if (noCover > FIRST_PAGE / 2) {
    warn(
      'More than half the first page has no cover image',
      `${noCover}/${rows.length} render as a category monogram — covers are the only colour in the design`
    );
  }
  return rows;
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 3. Covers across the whole tech feed
// ───────────────────────────────────────────────────────────────────────────────────────────────
async function checkCovers() {
  heading(3, 'COVER IMAGES — the only colour in the design');

  const filter = buildEventFilter({ techOnly: true, includeOngoing: true }, null);
  const rows = (await Event.find(filter, { imageUrl: 1, title: 1 }).lean()) as unknown as Row[];
  const withUrl = rows.filter(e => e.imageUrl);
  const without = rows.length - withUrl.length;

  console.log(`  upcoming tech events          ${rows.length}`);
  console.log(`  no imageUrl at all            ${without}  (${Math.round((without / Math.max(1, rows.length)) * 100)}%) → monogram fallback`);
  console.log(`  has an imageUrl               ${withUrl.length}`);

  const byHost = new Map<string, number>();
  for (const e of withUrl) {
    let host = 'unparseable';
    try {
      host = new URL(String(e.imageUrl)).host;
    } catch {
      /* keep 'unparseable' */
    }
    byHost.set(host, (byHost.get(host) ?? 0) + 1);
  }
  console.log('\n  cover host distribution:');
  [...byHost.entries()]
    .sort((a, b) => b[1] - a[1])
    .forEach(([host, n]) => console.log(`     ${String(n).padStart(4)}  ${host}`));

  const unparseable = byHost.get('unparseable') ?? 0;
  if (unparseable > 0) {
    warn('Some cover URLs do not parse', `${unparseable} imageUrl values are not valid URLs — each renders as a monogram`);
  }

  if (!PROBE_COVERS || NO_NET) {
    console.log('\n  (pass --covers to probe whether these URLs actually serve an image; skipped)');
    return;
  }

  // WHY A CONTENT-TYPE PROBE MAPS ONTO THE BROWSER FAILURE. A cross-origin <img> whose response
  // is not an image type is refused by Opaque Response Blocking (ERR_BLOCKED_BY_ORB) — so a host
  // answering 200 with text/html for a dead cover fails in the browser and looks fine to curl
  // unless the type is read. A non-2xx is the simpler case. Both end at the monogram, which is
  // handled, so this is a quality measure and never a blocker.
  const sample = withUrl.slice(0, 60);
  console.log(`\n  probing ${sample.length} cover URLs (content-type + status)…`);
  let ok = 0;
  const bad: string[] = [];
  const CONC = 8;
  for (let i = 0; i < sample.length; i += CONC) {
    await Promise.all(
      sample.slice(i, i + CONC).map(async e => {
        const url = String(e.imageUrl);
        try {
          const res = await fetch(url, {
            method: 'GET',
            headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0 (pulseblr cover probe)' },
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
          });
          const type = res.headers.get('content-type') ?? '';
          if (res.ok && /^image\//i.test(type)) ok += 1;
          else bad.push(`     ${String(res.status).padStart(3)} ${pad(type || '(no type)', 26)} ${new URL(url).host}  "${e.title}"`);
        } catch (err) {
          bad.push(`     ERR ${pad(String((err as Error).name), 26)} ${(() => { try { return new URL(url).host; } catch { return '?'; } })()}  "${e.title}"`);
        }
      })
    );
  }
  console.log(`  serve a real image: ${ok}/${sample.length}`);
  if (bad.length) {
    console.log('  would fall back to a monogram in the browser:');
    bad.forEach(b => console.log(b));
    warn(
      'Some cover URLs do not serve an image',
      `${bad.length} of ${sample.length} probed — each degrades to a monogram (EventCover onError handles it, so no broken-image icon)`
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 4. Do the marquee events show?
// ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * BY NAME, because a rising total does not prove the right things are present — the same rule
 * `diag-flagship-events.ts` is built on. These are the names an audience in Bengaluru would
 * recognise, so an absence here is the absence a viewer would notice.
 */
const MARQUEE = [
  'IndiaFOSS',
  'Great International Developer Summit',
  'Bengaluru Tech Summit',
  'droidcon',
  'Open Source India',
  'Rootconf',
  'Fifth Elephant',
];

async function checkMarquee() {
  heading(4, 'MARQUEE EVENTS — present, and visible in the default feed?');

  const techFilter = buildEventFilter({ techOnly: true, includeOngoing: true }, null);
  let missing = 0;
  let hidden = 0;

  for (const name of MARQUEE) {
    const rx = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const anyRow = (await Event.find(
      { title: rx, $or: [{ startDateTime: { $gte: new Date() } }, { endDateTime: { $gte: new Date() } }] },
      { title: 1, startDateTime: 1, isTechEvent: 1, visibility: 1, deletedAt: 1, source: 1 }
    )
      .sort({ startDateTime: 1 })
      .lean()) as unknown as Row[];

    if (anyRow.length === 0) {
      missing += 1;
      console.log(`  —      ${pad(name, 38)} no upcoming event  ← supply, not a bug`);
      continue;
    }
    // In the DEFAULT feed means: matches the same filter the landing page uses.
    const inFeed = await Event.countDocuments({ ...techFilter, title: rx });
    if (inFeed > 0) {
      const first = anyRow[0];
      console.log(
        `  IN     ${pad(name, 38)} ${istDay(first.startDateTime)}  ${inFeed} row(s) in the default feed  [${first.source}]`
      );
    } else {
      hidden += 1;
      console.log(`  HIDDEN ${pad(name, 38)} ${anyRow.length} row(s) stored but NONE in the default feed`);
      warn(
        `"${name}" is in the corpus but not in the default feed`,
        `${anyRow.length} upcoming row(s); isTechEvent=${anyRow.map(r => r.isTechEvent).join(',')} — a recall bug, not a supply gap`
      );
    }
    if (anyRow.length > 1) {
      const keys = new Set(anyRow.map(r => normalizeTitleForMatch(r.title ?? '')));
      if (keys.size < anyRow.length) {
        warn(
          `"${name}" appears more than once with the same normalised title`,
          anyRow.map(r => `[${r.source}] "${r.title}"`).join('  ·  ') + ' — a visible duplicate if both rank'
        );
      }
    }
  }
  console.log(`\n  hidden (recall bugs): ${hidden}   absent (supply): ${missing}`);
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
// 5. LLM tiers
// ───────────────────────────────────────────────────────────────────────────────────────────────
async function checkLlm() {
  heading(5, 'LLM TIERS — does anything above the keyword floor answer?');

  const ica = { key: process.env.ICA_API_KEY, base: process.env.ICA_BASE_URL, model: process.env.ICA_MODEL };
  const nvidia = { key: process.env.NVIDIA_API_KEY, model: process.env.NVIDIA_MODEL };
  const anthropic = process.env.ANTHROPIC_API_KEY;

  console.log(`  IBM ICA        key ${ica.key ? 'set' : 'UNSET'}   model ${ica.model ?? '—'}`);
  console.log(`  NVIDIA NIM     key ${nvidia.key ? 'set' : 'UNSET'}   model ${nvidia.model ?? '—'}`);
  console.log(`  Anthropic      key ${anthropic ? 'set' : 'UNSET'}`);

  if (NO_NET) {
    console.log('\n  (--no-net: not probed. Run scripts/check-llm.ts for the end-to-end tagging check.)');
    return;
  }

  let live = 0;
  if (ica.key && ica.base) {
    try {
      const res = await fetch(`${ica.base.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${ica.key}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (res.ok) {
        live += 1;
        console.log(`  → ICA /models     ${res.status} OK`);
      } else {
        console.log(`  → ICA /models     ${res.status} ${(await res.text()).slice(0, 120)}`);
      }
    } catch (err) {
      console.log(`  → ICA /models     ${(err as Error).name}`);
    }
  }
  if (nvidia.key) {
    try {
      const res = await fetch('https://integrate.api.nvidia.com/v1/models', {
        headers: { Authorization: `Bearer ${nvidia.key}` },
        signal: AbortSignal.timeout(12_000),
      });
      const body = res.ok ? ((await res.json()) as { data?: Array<{ id: string }> }) : null;
      const listed = body?.data?.some(m => m.id === nvidia.model);
      console.log(`  → NVIDIA /models  ${res.status}${res.ok ? `, configured model ${listed ? 'IS' : 'is NOT'} listed` : ''}`);
      if (res.ok && listed) live += 1;
    } catch (err) {
      console.log(`  → NVIDIA /models  ${(err as Error).name}`);
    }
  }

  if (live === 0) {
    warn(
      'No LLM tier answered — tagging is on the keyword floor',
      'the floor is documented to keep the pipeline running, and a demo tags nothing live, so this is not a demo blocker'
    );
  } else if (live === 1) {
    warn(
      'Exactly one LLM tier is reachable — there is no second net',
      'if it fails mid-scrape the pipeline silently drops to keyword tagging'
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const started = Date.now();
  await connectDB();
  const now = new Date();

  console.log('='.repeat(94));
  console.log('PULSEBLR — PRE-DEMO READINESS');
  console.log('what a visitor sees right now, judged on the screen rather than on the totals');
  console.log('='.repeat(94));

  await checkFreshness(now);
  await checkFirstPage(now);
  await checkCovers();
  await checkMarquee();
  await checkLlm();

  heading(6, 'VERDICT');
  const blockers = problems.filter(p => p.severity === 'BLOCK');
  const warns = problems.filter(p => p.severity === 'WARN');

  if (blockers.length === 0 && warns.length === 0) {
    console.log('  CLEAR — nothing found that would show badly on stage.');
  }
  if (blockers.length) {
    console.log(`\n  WOULD BREAK THE DEMO (${blockers.length}):`);
    blockers.forEach((p, i) => console.log(`   ${i + 1}. ${p.what}\n        ${p.evidence}`));
  }
  if (warns.length) {
    console.log(`\n  WORTH KNOWING (${warns.length}):`);
    warns.forEach((p, i) => console.log(`   ${i + 1}. ${p.what}\n        ${p.evidence}`));
  }
  console.log(`\n  ${((Date.now() - started) / 1000).toFixed(1)}s`);

  await mongoose.disconnect();
  process.exit(blockers.length > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('\ndiag-demo-readiness FAILED to run:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
