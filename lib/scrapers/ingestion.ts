import connectDB from '../mongodb';
import Event, { IEvent } from '../models/Event';
import Source from '../models/Source';
import { NormalizedEvent } from './normalizer';
import { resolveCompanies } from '../companies/resolve';

export interface IngestionResult {
  total: number;
  inserted: number;
  /** Existing documents whose fields we improved. */
  updated: number;
  /** Same-source repeats that needed no change. */
  duplicates: number;
  /** Collapsed because another source already had the same event. */
  crossSourceMerged: number;
  errors: number;
  errorDetails: string[];
}

export interface SourceHealth {
  eventCount: number;
  error?: string;
}

/**
 * Most categories any event may carry. Matches what the tagger emits, so a
 * document with more than this can only be a leftover from an earlier merge rule.
 */
const MAX_CATEGORIES = 3;

/** The subset of a Source document the digest reports on. */
export interface UnhealthySource {
  name: string;
  url?: string;
  lastError?: string;
  consecutiveEmptyScrapes: number;
  lastEventCount?: number;
}

/**
 * Update or create a source record, recording scrape health so silent breakage
 * becomes observable (and shows up in the daily digest):
 *  - lastEventCount           events this source returned this run
 *  - consecutiveEmptyScrapes  rises while a source returns nothing; resets on any
 *  - lastError / lastErrorAt  most recent failure, cleared on a clean scrape
 *
 * Fail-open: a DB hiccup here is logged, never fatal to the scrape.
 */
export async function updateSource(
  name: string,
  type: string,
  url: string,
  health?: SourceHealth
): Promise<void> {
  try {
    await connectDB();

    const update: Record<string, unknown> = {
      name,
      type,
      url,
      lastScrapedAt: new Date(),
      $setOnInsert: { enabled: true, scrapeFrequency: 'daily' },
    };

    if (health) {
      const existing = (await Source.findOne({ name, url })
        .select('consecutiveEmptyScrapes')
        .lean()) as { consecutiveEmptyScrapes?: number } | null;
      const prevEmpty = existing?.consecutiveEmptyScrapes ?? 0;

      update.lastEventCount = health.eventCount;
      update.consecutiveEmptyScrapes = health.eventCount > 0 ? 0 : prevEmpty + 1;

      if (health.error) {
        update.lastError = health.error.slice(0, 500);
        update.lastErrorAt = new Date();
      } else {
        update.lastError = undefined;
        update.lastErrorAt = undefined;
      }
    }

    await Source.findOneAndUpdate({ name, url }, update, {
      upsert: true,
      returnDocument: 'after',
    });
  } catch (error) {
    console.warn(
      `Could not record source health for ${name}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Fields that a later sighting is allowed to fill in or improve.
 *
 * Merge policy: never blank out a value we already have, and only overwrite when
 * the incoming value is strictly better. This is what makes multi-source coverage
 * additive — Meetup's ICS has the date but no image, Meetup's find page has the
 * image, Luma has guest counts. Whichever arrives second must upgrade the record
 * rather than clobber it.
 */
function mergeInto(existing: IEvent, incoming: NormalizedEvent): boolean {
  let changed = false;

  const fillIfEmpty: Array<keyof NormalizedEvent & keyof IEvent> = [
    'imageUrl', 'venue', 'address', 'area', 'city', 'organizer', 'hostAvatarUrl',
    'onlineLink', 'applyLink', 'timezone', 'currency', 'sourceEventId', 'slug',
  ];
  for (const field of fillIfEmpty) {
    const next = incoming[field];
    if (next !== undefined && next !== null && next !== '' && !existing[field]) {
      (existing as unknown as Record<string, unknown>)[field] = next;
      changed = true;
    }
  }

  const numericFillIfEmpty: Array<keyof NormalizedEvent & keyof IEvent> = [
    'lat', 'lng', 'endDateTime', 'registrationDeadline', 'capacity',
  ];
  for (const field of numericFillIfEmpty) {
    const next = incoming[field];
    if (next !== undefined && next !== null && existing[field] === undefined) {
      (existing as unknown as Record<string, unknown>)[field] = next;
      changed = true;
    }
  }

  // A longer description is a better description (title-placeholder → real copy).
  if (incoming.description.length > existing.description.length + 20) {
    existing.description = incoming.description;
    changed = true;
  }

  // Attendee counts only ever grow; take the max so a stale low read can't undo a
  // higher one recorded earlier in the same day.
  if (
    incoming.attendeeCount !== undefined &&
    incoming.attendeeCount > (existing.attendeeCount ?? -1)
  ) {
    existing.attendeeCount = incoming.attendeeCount;
    changed = true;
  }

  // Sold-out is sticky-forward: it can flip either way as tickets release.
  if (incoming.soldOut !== undefined && incoming.soldOut !== existing.soldOut) {
    existing.soldOut = incoming.soldOut;
    changed = true;
  }

  // Paid beats unknown-free: a source that actually knows the price wins.
  if (incoming.price !== undefined && existing.price === undefined) {
    existing.price = incoming.price;
    existing.priceMax = incoming.priceMax;
    existing.isFree = false;
    changed = true;
  }

  // ── Taxonomy merge, gated on tagging confidence ───────────────────────────
  //
  // Observed failure: a `--no-llm` run merged KEYWORD categories into events that
  // already had good LLM tags, and because the merge was a blind union, the vague
  // keyword buckets stuck permanently (Networking/Meetup jumped from 114 to 202
  // events). Union is right for equally-trustworthy passes and wrong when one pass
  // knows less than the other, so confidence decides:
  //
  //   incoming > existing  → replace (the better pass wins outright)
  //   incoming ≈ existing  → union, capped at 3
  //   incoming < existing  → keep what we have
  //
  const existingConfidence = existing.tagConfidence ?? 0.6;
  const incomingConfidence = incoming.tagConfidence ?? 0.6;
  const EPSILON = 0.05;

  if (incomingConfidence > existingConfidence + EPSILON) {
    if (existing.category.join('|') !== incoming.category.join('|')) {
      existing.category = incoming.category;
      changed = true;
    }
    if (existing.isTechEvent !== incoming.isTechEvent) {
      existing.isTechEvent = incoming.isTechEvent;
      changed = true;
    }
    existing.tagConfidence = incomingConfidence;
  } else if (incomingConfidence >= existingConfidence - EPSILON) {
    const mergedCategories = [
      ...new Set([...existing.category, ...incoming.category]),
    ].slice(0, MAX_CATEGORIES);
    if (mergedCategories.length !== existing.category.length) {
      existing.category = mergedCategories;
      changed = true;
    }
  }
  // Lower confidence: leave category / isTechEvent / tagConfidence untouched.

  // Unconditional cap. The confidence gate above deliberately skips the category
  // branch when the incoming pass knows less — which also meant a legacy document
  // carrying 4+ categories (from before the union was capped) could never be
  // trimmed, because every subsequent low-confidence sighting left it alone.
  // Enforcing the invariant here makes it hold regardless of which branch ran.
  if (existing.category.length > MAX_CATEGORIES) {
    existing.category = existing.category.slice(0, MAX_CATEGORIES);
    changed = true;
  }

  /*
   * Companies are RECOMPUTED from the merged document, not unioned into it.
   *
   * They used to union, on the reasoning that "a second source naming a co-host is new
   * information, and the resolver only emits names it could actually justify". The first half is
   * true. The second half is only true AT THE MOMENT OF WRITING, and union is forever:
   *
   *   · enrichment REPLACES descriptions on most runs (Meetup's ICS carries none at all), so a
   *     name justified by text that no longer exists survives permanently;
   *   · tightening a registry entry's `strength` from distinctive to ambiguous — which is the
   *     documented remedy for a false positive — cannot undo the rows it already produced.
   *
   * Measured: `Docker` was attributed to "Meetup new people/seekers of SriVidya Tradition",
   * hosted by "srividya personal spiritua", with the string "docker" appearing in NO field of the
   * document (scripts/diag-company-leak.ts). Exactly the harm `strength` exists to prevent, from a
   * direction `strength` cannot defend against.
   *
   * Recomputing is the right shape because `companies` is PURELY DERIVED from fields on this same
   * document, and resolveCompanies() is local and cheap — no network, no LLM. That makes the field
   * self-correcting: it follows the text and the registry instead of accumulating history. It is
   * also what scripts/backfill-companies.ts already does, so ingest and the backfill now agree
   * rather than the backfill existing to clean up after ingest.
   *
   * Co-hosts are NOT lost: the merge above has already taken the best organizer, title, venue and
   * tags from both sightings, so the resolver sees strictly more evidence than either source did
   * alone. What is dropped is only what the merged text can no longer justify.
   */
  const recomputed = resolveCompanies({
    organizer: existing.organizer,
    title: existing.title,
    venue: existing.venue,
    tags: existing.tags,
  }).slice(0, 6);
  const previous = (existing.companies || []).join('|');
  if (recomputed.join('|') !== previous) {
    existing.companies = recomputed;
    changed = true;
  }

  const mergedTags = [...new Set([...(existing.tags || []), ...incoming.tags])].slice(0, 12);
  if (mergedTags.length !== (existing.tags || []).length) {
    existing.tags = mergedTags;
    changed = true;
  }

  // Provenance: record every platform that reported this event.
  const sources = [...new Set([...(existing.seenInSources || []), ...incoming.seenInSources])];
  if (sources.length !== (existing.seenInSources || []).length) {
    existing.seenInSources = sources;
    changed = true;
  }

  // Food/format only upgrade away from the "don't know" value.
  if (existing.hasFood === 'unknown' && incoming.hasFood !== 'unknown') {
    existing.hasFood = incoming.hasFood;
    changed = true;
  }

  return changed;
}

/**
 * Ingest normalized events.
 *
 * Three-way match per event:
 *   1. dedupHash    — the exact same listing from the same source → merge/refresh.
 *   2. sourceEventId — same platform id but the organiser edited title/time →
 *                      update in place instead of creating a ghost duplicate.
 *   3. clusterKey   — the same event from a DIFFERENT source → merge into the
 *                      existing card so the feed shows it once.
 * No match ⇒ insert.
 */
export async function ingestEvents(events: NormalizedEvent[]): Promise<IngestionResult> {
  await connectDB();

  const result: IngestionResult = {
    total: events.length,
    inserted: 0,
    updated: 0,
    duplicates: 0,
    crossSourceMerged: 0,
    errors: 0,
    errorDetails: [],
  };

  // Within-run collapse: the same event can arrive from several adapters in one
  // run, and two inserts would race on the unique dedupHash index.
  const seenThisRun = new Set<string>();

  for (const event of events) {
    try {
      if (seenThisRun.has(event.clusterKey)) {
        // Already handled this logical event this run — still merge so the second
        // sighting's extra fields (image, price) aren't lost.
        const existing = await Event.findOne({ clusterKey: event.clusterKey });
        if (existing && mergeInto(existing, event)) {
          existing.lastSeenAt = new Date();
          await existing.save();
          result.updated++;
        } else {
          result.duplicates++;
        }
        continue;
      }

      let existing = await Event.findOne({ dedupHash: event.dedupHash });
      let matchedBy: 'hash' | 'sourceId' | 'cluster' | null = existing ? 'hash' : null;

      if (!existing && event.sourceEventId) {
        existing = await Event.findOne({
          source: event.source,
          sourceEventId: event.sourceEventId,
        });
        if (existing) matchedBy = 'sourceId';
      }

      if (!existing) {
        existing = await Event.findOne({ clusterKey: event.clusterKey });
        if (existing) matchedBy = 'cluster';
      }

      if (existing) {
        const changed = mergeInto(existing, event);

        // A source-id match means the organiser edited the listing; the incoming
        // title/time are authoritative for that platform's own record.
        if (matchedBy === 'sourceId') {
          if (existing.title !== event.title || +existing.startDateTime !== +event.startDateTime) {
            existing.title = event.title;
            existing.startDateTime = event.startDateTime;
            existing.dedupHash = event.dedupHash;
            existing.clusterKey = event.clusterKey;
            await existing.save();
            result.updated++;
            seenThisRun.add(event.clusterKey);
            continue;
          }
        }

        existing.lastSeenAt = new Date();
        await existing.save();

        // Count a cluster match as a cross-source merge whether or not it also
        // changed fields. Reporting it as a plain "update" hid the dedup entirely
        // — the first run showed "0 merged" while genuinely collapsing duplicates.
        if (matchedBy === 'cluster') result.crossSourceMerged++;
        else if (changed) result.updated++;
        else result.duplicates++;

        seenThisRun.add(event.clusterKey);
        continue;
      }

      await Event.create(event);
      result.inserted++;
      seenThisRun.add(event.clusterKey);
    } catch (error: unknown) {
      const err = error as { code?: number; message?: string };
      // A duplicate-key race means another path already inserted it — benign.
      if (err.code === 11000) {
        result.duplicates++;
        continue;
      }
      result.errors++;
      const message = `Failed to ingest "${event.title}": ${err.message || String(error)}`;
      result.errorDetails.push(message);
      console.error(message);
    }
  }

  return result;
}

/**
 * Events created since a date — used by the daily digest.
 *
 * `.lean()` returns plain objects rather than hydrated documents, so the cast is
 * the accurate description of what callers get: the same fields, no methods.
 */
export async function getNewEventsSince(since: Date): Promise<IEvent[]> {
  await connectDB();
  return Event.find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .lean() as unknown as Promise<IEvent[]>;
}

/** Events whose registration deadline is approaching. */
export async function getEventsWithDeadlineSoon(daysAhead = 3): Promise<IEvent[]> {
  await connectDB();
  const now = new Date();
  const future = new Date(now.getTime() + daysAhead * 24 * 3600 * 1000);
  return Event.find({ registrationDeadline: { $gte: now, $lte: future } })
    .sort({ registrationDeadline: 1 })
    .lean() as unknown as Promise<IEvent[]>;
}

/**
 * Sources that look unhealthy, for the daily digest.
 * Disabled sources are excluded — the user silenced those on purpose.
 */
export async function getUnhealthySources(emptyThreshold = 3): Promise<UnhealthySource[]> {
  await connectDB();
  return Source.find({
    enabled: true,
    $or: [
      { consecutiveEmptyScrapes: { $gte: emptyThreshold } },
      { lastError: { $exists: true, $ne: null } },
    ],
  })
    .sort({ consecutiveEmptyScrapes: -1 })
    .lean() as unknown as UnhealthySource[];
}
