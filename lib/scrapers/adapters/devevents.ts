// developers.events adapter — curated tech CONFERENCES worldwide.
//
// This is the highest-value tech source found. `developers.events/all-events.json`
// is a community-maintained, openly-licensed dataset of developer conferences:
// 6051 records, of which 171 are in India and 62 in Bengaluru. Verified live.
//
// It is the only source that reliably carries the BIG Bengaluru tech conferences —
// the ones worth travelling for and best for connections — which none of the
// meetup/city platforms list: DevOpsDays Bengaluru, KCD Bengaluru, KubeDay India,
// Open Source India, PGConf India, Kafka Summit Bangalore, GitHub Constellation,
// Great International Developer Summit, AWS Dev Day.
//
// WHY THIS INSTEAD OF SCRAPING COMPANY EVENT SITES:
// Company event microsites were probed and rejected. Every aws-experience.com path
// returns the same 1.6 KB Angular shell with no data, and every documented
// aws.amazon.com/api/dirs directoryId returns 0 items. NVIDIA, Arm, Google Cloud,
// Google I/O, Microsoft Build and Reactor all serve HTML with zero structured event
// data. Those companies' Bengaluru events reach us through three routes that DO
// work — their Meetup groups, their Luma calendars, and this conference dataset.
//
// SHAPE NOTES (measured):
//   date:    epoch-millis ARRAY — [start] for a single day, [start, end] for a range
//   city:    "Bangalore" (not "Bengaluru") — both spellings must be accepted
//   country: "India"
//   cfp:     object, often empty; presence means the call for papers is open
//   tags:    topic strings, useful as tagger hints

import { ScrapeResult } from '../core/types';
import { fetchJson } from '../core/http';
import { truncate } from '../core/text';

const DEVEVENTS_URL = 'https://developers.events/all-events.json';
const DEVEVENTS_SOURCE = 'devevents';

export const DEVEVENTS_SOURCE_URL = DEVEVENTS_URL;

interface DevEventRecord {
  name?: string;
  /** [startMs] or [startMs, endMs]. */
  date?: number[];
  hyperlink?: string;
  location?: string;
  city?: string;
  country?: string;
  misc?: string;
  cfp?: { link?: string; untilDate?: number } | Record<string, never>;
  status?: string;
  tags?: string[];
}

/** Bengaluru under either spelling; the dataset uses "Bangalore". */
const BLR_CITY = /^(bengaluru|bangalore)$/i;

function isBengaluru(record: DevEventRecord): boolean {
  if (BLR_CITY.test((record.city || '').trim())) return true;
  // Some records leave `city` blank and put it in the free-text location.
  return /\b(bengaluru|bangalore)\b/i.test(record.location || '');
}

export async function scrapeDevEvents(): Promise<ScrapeResult> {
  const startedAt = new Date();
  const result: ScrapeResult = {
    sourceId: 'devevents',
    label: 'developers.events — tech conferences',
    events: [],
    errors: [],
    startedAt,
    durationMs: 0,
  };

  try {
    // ~3.2 MB of JSON, so a generous timeout.
    const all = await fetchJson<DevEventRecord[]>(DEVEVENTS_URL, {
      timeoutMs: 45000,
      retries: 2,
    });

    if (!Array.isArray(all) || all.length === 0) {
      result.errors.push('developers.events returned no records');
      result.durationMs = Date.now() - startedAt.getTime();
      return result;
    }

    const now = Date.now();
    // The dataset is historical as well as forward-looking — most of the 62
    // Bengaluru records are past conferences from 2022-2024. Keep only what is
    // still ahead of us.
    const MAX_FUTURE_MS = 550 * 24 * 3600 * 1000;

    for (const record of all) {
      if (!record.name || !Array.isArray(record.date) || record.date.length === 0) continue;
      if (!isBengaluru(record)) continue;

      const startMs = record.date[0];
      const endMs = record.date.length > 1 ? record.date[1] : undefined;
      if (typeof startMs !== 'number' || !Number.isFinite(startMs)) continue;

      const effectiveEnd = typeof endMs === 'number' ? endMs : startMs;
      if (effectiveEnd < now) continue;
      if (startMs > now + MAX_FUTURE_MS) continue;

      const startDateTime = new Date(startMs);
      if (Number.isNaN(startDateTime.getTime())) continue;

      const url = record.hyperlink?.trim() || 'https://developers.events/';
      const cfpLink = (record.cfp as { link?: string } | undefined)?.link;

      const descriptionParts = [
        `${record.name} — a developer conference in ${record.city || 'Bengaluru'}.`,
      ];
      if (record.misc) descriptionParts.push(record.misc);
      if (cfpLink) descriptionParts.push(`Call for papers: ${cfpLink}`);

      result.events.push({
        title: record.name.trim(),
        description: truncate(descriptionParts.join(' '), 2000),
        sourceUrl: url,
        source: DEVEVENTS_SOURCE,
        // The dataset has no stable id, so name + start is the best available key.
        sourceEventId: `devevents-${record.name.trim().toLowerCase().replace(/\s+/g, '-')}-${startMs}`,
        organizer: record.name.trim(),
        venue: record.location || record.city || 'Bengaluru',
        city: 'Bengaluru',
        startDateTime,
        endDateTime: typeof endMs === 'number' ? new Date(endMs) : undefined,
        applyLink: url,
        // Conferences are the archetypal high-value networking event, and these are
        // multi-track multi-day gatherings. The tagger still classifies the topic.
        rawCategory: ['Summit/Conference'],
        rawFormat: 'offline',
        tags: (record.tags || []).filter(t => typeof t === 'string').slice(0, 10),
      });
    }

    if (result.events.length === 0) {
      result.errors.push(
        `no upcoming Bengaluru conferences among ${all.length} records (the dataset is mostly historical)`
      );
    }
  } catch (err) {
    result.errors.push(`fetch failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  result.durationMs = Date.now() - startedAt.getTime();
  return result;
}
