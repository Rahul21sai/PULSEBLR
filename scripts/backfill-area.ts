#!/usr/bin/env tsx
/**
 * Recompute `Event.area` for stored events from the fields they already carry.
 *
 * WHY THIS SCRIPT HAS TO EXIST. `Event.area` is written ONCE, at ingest, by
 * `lib/scrapers/normalizer.ts`. Widening the gazetteer in `lib/scrapers/core/geo.ts` therefore
 * changes nothing about a row already in the database — the improvement reaches only events
 * scraped afterwards. Measured 2026-09-10: the gazetteer had already been widened (commit
 * ef161d5) and 91 upcoming non-online rows were still sitting at `'Other'` holding the OLD
 * verdict, i.e. 11.7 points of coverage were sitting in the database unclaimed. Area is not
 * cosmetic — `lib/events/relevance.ts` weights `areaMatch: +22` / `areaMiss: -14`, its single
 * biggest term, and the "Near you" shelf is gated on this field.
 *
 * Same shape as `backfill-companies.ts` / `backfill-connection-score.ts`: the field is purely
 * derived from the same document by a pure, local, network-free function, so recomputing is
 * cheap and cannot disagree with the write path — **because it calls the write path's own
 * `resolveArea` with the write path's own inputs** rather than a copy. A backfill that mirrors
 * the value it recomputes eventually recomputes the mirror.
 *
 * ── THE DRY RUN IS THE CORPUS DELTA, and that is its main job ─────────────────────────────────
 *
 * It prints OLD → NEW for every row it would touch, grouped by transition. That is deliberately
 * the same instrument `diag-hardware-corpus-delta.ts` is: an aggregate cannot tell a real recall
 * win from an over-match, because both raise the resolved count. The transitions to read
 * hardest are NOT `Other → X` (that is the win) but **`X → Y`**, an event moving between two
 * named areas — one of the two labels was wrong, and a widened pattern that steals rows from a
 * correct entry looks identical to progress in the headline number.
 *
 * ── WHAT IT WILL NOT DO ──────────────────────────────────────────────────────────────────────
 *
 *  · **It never writes `area` on an online event**, and never clears one that is already null.
 *    `normalizer.ts` skips `resolveArea` entirely when `format === 'online'`, so `undefined` is
 *    the correct value there, not a gap to fill.
 *  · **It never overwrites a resolved area with `'Other'` or with nothing.** A row that resolves
 *    today and would not resolve now means the gazetteer got NARROWER for it — real, after the
 *    `agara` boundary fix — and silently downgrading data on a maintenance run is how a
 *    "cleanup" loses information. Those rows are REPORTED under DOWNGRADES and skipped; act on
 *    them deliberately with `--allow-downgrade` once you have read the list.
 *  · **It does not touch `createdByUserId` events differently, because it does not need to.**
 *    Unlike `cleanup-*.ts`, nothing here deletes and nothing here is editorial: `area` is derived
 *    from the venue string the user typed, so recomputing it is as correct for a hand-entered
 *    event as for a scraped one. (Contrast `spotlightAt`, which a human chose and no backfill
 *    may recompute.)
 *
 * Dry by default. `--apply` to write.
 *
 * Run: npx tsx scripts/backfill-area.ts             # dry, prints the full delta
 *      npx tsx scripts/backfill-area.ts --apply
 *      npx tsx scripts/backfill-area.ts --upcoming  # limit to events that still matter
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { resolveArea } from '../lib/scrapers/core/geo';
import mongoose from 'mongoose';

const APPLY = process.argv.includes('--apply');
const UPCOMING_ONLY = process.argv.includes('--upcoming');
const ALLOW_DOWNGRADE = process.argv.includes('--allow-downgrade');

interface Row {
  _id: mongoose.Types.ObjectId;
  title?: string;
  venue?: string;
  address?: string;
  city?: string;
  lat?: number;
  lng?: number;
  area?: string;
  format?: string;
  source?: string;
  startDateTime?: Date;
}

const label = (a: string | undefined): string => (a && a.trim() ? a : '(none)');
const isResolved = (a: string | undefined): boolean => !!a && a !== 'Other';

async function main() {
  await connectDB();

  const filter: Record<string, unknown> = UPCOMING_ONLY ? { startDateTime: { $gte: new Date() } } : {};
  const rows = (await Event.find(filter, {
    title: 1,
    venue: 1,
    address: 1,
    city: 1,
    lat: 1,
    lng: 1,
    area: 1,
    format: 1,
    source: 1,
    startDateTime: 1,
  }).lean()) as unknown as Row[];

  console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${rows.length} event(s) considered${UPCOMING_ONLY ? ' (upcoming only)' : ''}\n`);

  const changes: Array<{ row: Row; from: string; to: string }> = [];
  const downgrades: Array<{ row: Row; from: string; to: string }> = [];
  let unchanged = 0;

  for (const row of rows) {
    // EXACTLY the input normalizer.ts builds — including the online skip — so this cannot drift.
    const next =
      row.format === 'online'
        ? undefined
        : resolveArea({ venue: row.venue, address: row.address, city: row.city, lat: row.lat, lng: row.lng });

    if (label(next) === label(row.area)) {
      unchanged++;
      continue;
    }
    // Losing a resolved area is a downgrade — EXCEPT on an online event, where `undefined` is
    // the documented correct value rather than a gap. `normalizer.ts` skips resolveArea for
    // those, so clearing a stale area there is the rule being applied, not information lost.
    // (Measured: 8 rows titled "Virtual Event …" carry `venue: 'Indiranagar'` and an area.)
    if (isResolved(row.area) && !isResolved(next) && row.format !== 'online') {
      downgrades.push({ row, from: label(row.area), to: label(next) });
      continue;
    }
    changes.push({ row, from: label(row.area), to: label(next) });
  }

  // ── the delta, grouped by transition ──
  const byTransition = new Map<string, Array<{ row: Row; from: string; to: string }>>();
  for (const c of changes) {
    const key = `${c.from} → ${c.to}`;
    const group = byTransition.get(key) ?? [];
    group.push(c);
    byTransition.set(key, group);
  }
  const ranked = [...byTransition.entries()].sort((a, b) => b[1].length - a[1].length);

  console.log('═══ THE DELTA — every row named, grouped by transition ═══\n');
  for (const [transition, group] of ranked) {
    const reAssign = !transition.startsWith('Other →') && !transition.startsWith('(none) →');
    console.log(`── ${transition}   ${group.length} row(s)${reAssign ? '   ← RE-ASSIGNMENT, judge every one' : ''}`);
    for (const { row } of group) {
      console.log(`     ${String(row.title ?? '').slice(0, 62).padEnd(62)} [${row.source ?? '?'}]`);
      console.log(`        ${[row.venue, row.address, row.city].filter(Boolean).join(' | ').slice(0, 150) || '(no location strings)'}`);
    }
    console.log('');
  }

  if (downgrades.length) {
    console.log('═══ DOWNGRADES — SKIPPED unless --allow-downgrade ═══\n');
    console.log('These resolve today and would NOT resolve now, i.e. the gazetteer got narrower for');
    console.log('them. Read each before allowing it: a narrowing is sometimes the fix (a bounded');
    console.log('token no longer matching inside a longer word) and sometimes a regression.\n');
    for (const { row, from, to } of downgrades) {
      console.log(`  ${from} → ${to}   ${String(row.title ?? '').slice(0, 58)} [${row.source ?? '?'}]`);
      console.log(`        ${[row.venue, row.address, row.city].filter(Boolean).join(' | ').slice(0, 150) || '(no location strings)'}`);
    }
    console.log('');
  }

  const gained = changes.filter(c => !isResolved(c.from) && isResolved(c.to)).length;
  const reassigned = changes.filter(c => isResolved(c.from) && isResolved(c.to)).length;
  console.log('═══ SUMMARY ═══\n');
  console.log(`  unchanged                      ${unchanged}`);
  console.log(`  newly resolved (Other/none→X)  ${gained}`);
  console.log(`  re-assigned between areas      ${reassigned}   ← the ones that can be WRONG`);
  console.log(`  downgrades (skipped${ALLOW_DOWNGRADE ? ' — NO, ALLOWED' : '        '})   ${downgrades.length}`);
  console.log(`  total writes ${APPLY ? 'being made' : 'this would make'}    ${changes.length + (ALLOW_DOWNGRADE ? downgrades.length : 0)}`);

  if (!APPLY) {
    console.log('\n  DRY RUN — nothing was written. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const toWrite = ALLOW_DOWNGRADE ? [...changes, ...downgrades] : changes;
  let written = 0;
  for (const { row, to } of toWrite) {
    // `area` is a plain trimmed String with no derived-key hook behind it, so a targeted
    // updateOne is right here — no need for the findOne/assign/save dance `Contact` requires.
    await Event.updateOne(
      { _id: row._id },
      to === '(none)' ? { $unset: { area: '' } } : { $set: { area: to } }
    );
    written++;
  }
  console.log(`\n  wrote ${written} document(s).`);
  console.log('  Re-run scripts/diag-area-coverage.ts to confirm STORED now matches RECOMPUTED.');

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
