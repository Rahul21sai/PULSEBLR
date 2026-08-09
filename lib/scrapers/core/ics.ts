// iCalendar (RFC 5545) parsing.
//
// WHY THIS MATTERS: the old Meetup scraper enumerated event URLs from RSS and
// then fetched EVERY event page just to read its start date — roughly N+1 HTTP
// requests per group with a 400 ms politeness delay between each. Meetup also
// publishes `/<group>/events/ical/`, which carries DTSTART, DTEND, LOCATION,
// SUMMARY, DESCRIPTION and URL for every upcoming event in ONE request (verified
// live during recon). Parsing ICS therefore cuts Meetup from ~10 requests per
// group to 1, which is what makes scanning ~100 discovered groups feasible.
//
// We hand-roll the parse rather than use ical.js because we need only a handful
// of properties and hand-rolling avoids that library's timezone-registry setup.

import { RawEvent } from './types';
import { stripHtml, truncate } from './text';

/** Unfold RFC 5545 line continuations (a leading space/tab continues the line). */
function unfold(ics: string): string[] {
  const rawLines = ics.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const lines: string[] = [];
  for (const line of rawLines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
    } else {
      lines.push(line);
    }
  }
  return lines;
}

/** Unescape ICS TEXT values (\n, \, , \; , \\). */
function unescapeText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

interface IcsProperty {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): IcsProperty | null {
  const colon = line.indexOf(':');
  if (colon === -1) return null;

  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...paramParts] = head.split(';');

  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }

  return { name: name.toUpperCase(), params, value };
}

/**
 * Convert an ICS date-time to an absolute Date.
 *
 * Three forms appear in the wild:
 *   20260822T103000Z          — already UTC
 *   20260822T103000           — floating/local, interpreted in TZID (or IST)
 *   20260822                   — date only (VALUE=DATE)
 *
 * For the floating form we must apply the TZID offset ourselves. We only need
 * Indian feeds, so Asia/Kolkata (+05:30) is the default; other zones are handled
 * via Intl so a US-hosted online event still lands on the right instant.
 */
function parseIcsDate(prop: IcsProperty): Date | undefined {
  const raw = prop.value.trim();
  if (!raw) return undefined;

  // Date-only → treat as 19:00 local, same rationale as JSON-LD date-only values.
  if (/^\d{8}$/.test(raw)) {
    const [y, m, d] = [raw.slice(0, 4), raw.slice(4, 6), raw.slice(6, 8)];
    return new Date(`${y}-${m}-${d}T19:00:00+05:30`);
  }

  const match = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!match) {
    const fallback = new Date(raw);
    return Number.isNaN(fallback.getTime()) ? undefined : fallback;
  }

  const [, y, mo, d, h, mi, s, zulu] = match;
  if (zulu) return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`);

  const tzid = prop.params.TZID;
  const offset = tzid ? offsetForZone(tzid, `${y}-${mo}-${d}T${h}:${mi}:${s}`) : '+05:30';
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
}

/**
 * UTC offset string (e.g. "+05:30") for an IANA zone at a given wall time.
 * Falls back to IST if the zone is unknown to the runtime.
 */
function offsetForZone(timeZone: string, isoWallTime: string): string {
  try {
    const probe = new Date(`${isoWallTime}Z`);
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'longOffset',
    });
    const part = formatter
      .formatToParts(probe)
      .find(p => p.type === 'timeZoneName')?.value;
    // "GMT+05:30" → "+05:30"; plain "GMT" → UTC.
    const parsed = part?.replace('GMT', '').trim();
    if (!parsed) return '+00:00';
    return /^[+-]\d{2}:\d{2}$/.test(parsed) ? parsed : '+00:00';
  } catch {
    return '+05:30';
  }
}

export interface IcsParseOptions {
  source: string;
  /** Fallback URL when a VEVENT carries no URL property. */
  fallbackUrl: string;
  organizer?: string;
}

/** Parse an ICS document into RawEvents, skipping anything without title+date. */
export function rawEventsFromIcs(ics: string, opts: IcsParseOptions): RawEvent[] {
  const events: RawEvent[] = [];
  let current: Record<string, IcsProperty> | null = null;

  for (const line of unfold(ics)) {
    if (line.startsWith('BEGIN:VEVENT')) {
      current = {};
      continue;
    }
    if (line.startsWith('END:VEVENT')) {
      if (current) {
        const event = veventToRawEvent(current, opts);
        if (event) events.push(event);
      }
      current = null;
      continue;
    }
    if (!current) continue;

    const prop = parseLine(line);
    // Keep the FIRST occurrence of a property; Meetup repeats some keys.
    if (prop && !(prop.name in current)) current[prop.name] = prop;
  }

  return events;
}

function veventToRawEvent(
  props: Record<string, IcsProperty>,
  opts: IcsParseOptions
): RawEvent | null {
  const title = props.SUMMARY ? unescapeText(props.SUMMARY.value).trim() : '';
  const dtstart = props.DTSTART ? parseIcsDate(props.DTSTART) : undefined;
  if (!title || !dtstart) return null;

  // Meetup's ICS feeds include a placeholder VEVENT stamped at the Unix epoch.
  // It is not a real event; keeping it would pollute the feed with a 1970 entry.
  if (dtstart.getUTCFullYear() < 2000) return null;

  const status = props.STATUS?.value?.toUpperCase() || '';
  if (status === 'CANCELLED') return null;

  const description = props.DESCRIPTION ? unescapeText(props.DESCRIPTION.value) : '';
  const location = props.LOCATION ? unescapeText(props.LOCATION.value).trim() : '';
  const url = props.URL?.value?.trim() || opts.fallbackUrl;

  const isOnline = /online event|zoom|google meet|teams\.microsoft|virtual/i.test(
    `${location} ${description}`
  );

  return {
    title,
    description: truncate(stripHtml(description) || title, 4000),
    sourceUrl: url,
    source: opts.source,
    sourceEventId: props.UID?.value?.trim() || url,
    organizer: opts.organizer,
    venue: isOnline || !location ? undefined : location,
    address: isOnline ? undefined : location || undefined,
    onlineLink: isOnline ? url : undefined,
    startDateTime: dtstart,
    endDateTime: props.DTEND ? parseIcsDate(props.DTEND) : undefined,
    timezone: props.DTSTART?.params.TZID,
    rawFormat: isOnline ? 'online' : 'offline',
  };
}

/** Discover a calendar feed URL advertised in a page's <head>. */
export function findIcsLink(html: string, baseUrl: string): string | undefined {
  const match =
    html.match(/<link[^>]+type=["']text\/calendar["'][^>]*href=["']([^"']+)["']/i) ||
    html.match(/<link[^>]+href=["']([^"']+)["'][^>]*type=["']text\/calendar["']/i);
  if (!match) return undefined;
  try {
    return new URL(match[1], baseUrl).toString();
  } catch {
    return undefined;
  }
}
