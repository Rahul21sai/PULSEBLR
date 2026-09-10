// Shaping a stored event into what an MCP client receives. PURE.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY ROW CARRIES `url`, AND THAT IS THE ENTIRE POINT OF THE SERVER. An assistant that can
// describe an event but not send someone to it has produced a dead end; the canonical URL is the
// distribution mechanic, so it is a required field on the row type rather than an optional extra,
// and `buildEventUrl` is the one place it is constructed.
//
// IT IS BUILT FROM `canonicalOrigin()` (i.e. `NEXTAUTH_URL`), NEVER FROM THE REQUEST HOST. `auth.ts`
// sets `trustHost: true`, so `Host` is attacker-controllable — and a URL from this server does not
// merely redirect a browser once, it gets pasted into a chat transcript and forwarded. That is the
// same reasoning `lib/canonical-origin.ts` gives for QR codes, and it applies here for the same
// reason: the artefact outlives the request.
//
// EVERY DATE IS RENDERED IN IST AS WELL AS ISO. The ISO instant is what a client should compute
// with; the IST string is what it should show, because this is a Bengaluru product and a model
// running on a UTC server would otherwise put a 21:00 IST event on the previous day. `lib/format.ts`
// owns that formatting and is pinned to Asia/Kolkata — nothing here formats a date itself.
//
// PAYLOADS ARE KEPT SMALL ON PURPOSE. Descriptions in this corpus run to several KB of markdown, and
// an MCP result lands directly in a model's context window. The list rows carry no description at
// all and `get_event` truncates and strips markdown, so a ten-row answer costs a few hundred tokens
// rather than tens of thousands.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { absoluteUrl } from '../canonical-origin';
import {
  dayLabelIST,
  istDaysSpanned,
  locationLabel,
  priceLabel,
  stripMarkdown,
  timeIST,
} from '../format';
import { truncate } from '../scrapers/core/text';

/** How much of a description `get_event` will return. */
const DESCRIPTION_CHARS = 1200;

/**
 * The fields the tools project out of Mongo. Written as one interface with everything optional so a
 * list projection and a full document both satisfy it — the same reasoning `SeoEvent` gives.
 */
export interface StoredEvent {
  _id: unknown;
  title: string;
  slug?: string | null;
  description?: string | null;
  organizer?: string | null;
  category?: string[] | null;
  tags?: string[] | null;
  format: 'online' | 'offline' | 'hybrid';
  hasFood?: string | null;
  isFree?: boolean | null;
  price?: number | null;
  priceMax?: number | null;
  currency?: string | null;
  soldOut?: boolean | null;
  venue?: string | null;
  address?: string | null;
  area?: string | null;
  city?: string | null;
  onlineLink?: string | null;
  imageUrl?: string | null;
  startDateTime: Date | string;
  endDateTime?: Date | string | null;
  applyLink?: string | null;
  registrationDeadline?: Date | string | null;
  attendeeCount?: number | null;
  capacity?: number | null;
  companies?: string[] | null;
  connectionScore?: number | null;
  source?: string | null;
  sourceUrl?: string | null;
  seenInSources?: string[] | null;
  visibility?: string | null;
  createdByUserId?: string | null;
}

export interface McpEventRow {
  id: string;
  title: string;
  /** The canonical PulseBLR page for this event. Always present — see the module header. */
  url: string;
  /** ISO instant, for computing with. */
  startsAt: string;
  /** Human, in IST, for showing. */
  startsAtIST: string;
  endsAt?: string;
  /** Set when the event covers more than one IST day, so a single time is not the whole answer. */
  spansDays?: number;
  format: 'online' | 'offline' | 'hybrid';
  isOnline: boolean;
  venue?: string;
  area?: string;
  city: string;
  /** One-line location, the same string the website's cards show. */
  location: string;
  price: string;
  isFree: boolean;
  /**
   * 0-100. PulseBLR's own signal for "will I leave with useful contacts" — deterministic, not a
   * popularity count. See `lib/events/connection-score.ts`.
   */
  connectionScore: number;
  /**
   * A coarse band over the score.
   *
   * Both are returned because they answer different questions and each is misleading alone. The
   * number is a RANKING signal, not a measurement — the website deliberately renders it as three
   * bars rather than printing "83", because printing a figure implies a precision it does not have.
   * A model handed only the number will quote it; handed only the band it cannot order two events.
   */
  connectionRating: 'high' | 'moderate' | 'low';
  categories: string[];
  organizer?: string;
  /** Canonical company names this event is attributable to, resolved from the host. */
  companies?: string[];
  attendeeCount?: number;
  /** Where to register, when the source gave one. May be off-site. */
  registerUrl?: string;
  source?: string;
  sourceUrl?: string;
}

export interface McpEventDetail extends McpEventRow {
  description?: string;
  address?: string;
  tags?: string[];
  capacity?: number;
  registrationDeadline?: string;
  hasFood?: string;
  soldOut?: boolean;
  imageUrl?: string;
  /** Every platform that has reported this same event — provenance, after cross-source dedup. */
  seenInSources?: string[];
}

/** The canonical page for an event id. The ONLY place this URL shape is written. */
export function buildEventUrl(id: string): string {
  return absoluteUrl(`/events/${id}`);
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function rate(score: number): McpEventRow['connectionRating'] {
  if (score >= 70) return 'high';
  if (score >= 40) return 'moderate';
  return 'low';
}

/** Drop empty strings and empty arrays so a row carries only fields that say something. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function list(value: string[] | null | undefined): string[] | undefined {
  const items = (value ?? []).map(v => v?.trim()).filter((v): v is string => Boolean(v));
  return items.length > 0 ? items : undefined;
}

export function toMcpEventRow(event: StoredEvent): McpEventRow {
  const id = String(event._id);
  const startsAt = iso(event.startDateTime) ?? new Date(0).toISOString();
  const endsAt = iso(event.endDateTime);
  const spanned = event.endDateTime ? istDaysSpanned(event.startDateTime, event.endDateTime) : 0;
  const score = typeof event.connectionScore === 'number' ? event.connectionScore : 0;
  const isFree = event.isFree !== false;

  const row: McpEventRow = {
    id,
    title: event.title,
    url: buildEventUrl(id),
    startsAt,
    // A multi-day event has no single meaningful time, and printing one is how the website's time
    // rail once made a three-day conference read as ending before it began.
    startsAtIST:
      spanned > 0
        ? `${dayLabelIST(event.startDateTime)} onward (IST)`
        : `${dayLabelIST(event.startDateTime)} · ${timeIST(event.startDateTime)} IST`,
    format: event.format,
    isOnline: event.format === 'online',
    city: text(event.city) ?? 'Bengaluru',
    location: locationLabel({
      format: event.format,
      venue: event.venue,
      area: event.area,
      city: event.city,
    }),
    price: priceLabel({
      isFree,
      price: event.price,
      priceMax: event.priceMax,
      currency: event.currency,
    }),
    isFree,
    connectionScore: score,
    connectionRating: rate(score),
    categories: list(event.category) ?? [],
  };

  if (endsAt) row.endsAt = endsAt;
  if (spanned > 0) row.spansDays = spanned;
  if (text(event.venue)) row.venue = text(event.venue);
  if (text(event.area)) row.area = text(event.area);
  if (text(event.organizer)) row.organizer = text(event.organizer);
  if (list(event.companies)) row.companies = list(event.companies);
  if (typeof event.attendeeCount === 'number') row.attendeeCount = event.attendeeCount;
  // `onlineLink` is the join URL for an online event, which is the register-equivalent when the
  // source published no separate apply link.
  const register = text(event.applyLink) ?? text(event.onlineLink);
  if (register) row.registerUrl = register;
  if (text(event.source)) row.source = text(event.source);
  if (text(event.sourceUrl)) row.sourceUrl = text(event.sourceUrl);

  return row;
}

export function toMcpEventDetail(event: StoredEvent): McpEventDetail {
  const detail: McpEventDetail = toMcpEventRow(event);

  const description = text(event.description);
  if (description) {
    // Stripped, not rendered. A description is untrusted third-party text scraped from a page we do
    // not control, and `lib/format.ts` documents why this app flattens markdown rather than
    // rendering it. For an MCP client the markdown is also pure noise in a context window.
    detail.description = truncate(stripMarkdown(description).replace(/\s+/g, ' '), DESCRIPTION_CHARS);
  }
  if (text(event.address)) detail.address = text(event.address);
  if (list(event.tags)) detail.tags = list(event.tags);
  if (typeof event.capacity === 'number') detail.capacity = event.capacity;
  const deadline = iso(event.registrationDeadline);
  if (deadline) detail.registrationDeadline = deadline;
  if (text(event.hasFood) && event.hasFood !== 'unknown') detail.hasFood = text(event.hasFood);
  if (event.soldOut === true) detail.soldOut = true;
  if (text(event.imageUrl)) detail.imageUrl = text(event.imageUrl);
  if (list(event.seenInSources)) detail.seenInSources = list(event.seenInSources);

  return detail;
}

/**
 * A one-line summary of a row, for the human-readable half of a tool result.
 *
 * WHY THERE IS A HUMAN HALF AT ALL. An MCP tool result carries `content` (what every client renders
 * and every model reads) and optionally `structuredContent` (what a programmatic client parses).
 * Returning only JSON works but wastes the model's attention on braces; returning only prose loses
 * the ids and URLs. Both are returned, from this one function and `toMcpEventRow`, so they cannot
 * describe different events.
 */
export function summariseRow(row: McpEventRow, index: number): string {
  const bits = [
    `${index + 1}. ${row.title}`,
    `   ${row.startsAtIST} · ${row.location} · ${row.price}`,
    `   connections: ${row.connectionScore}/100 (${row.connectionRating})${
      row.categories.length > 0 ? ` · ${row.categories.join(', ')}` : ''
    }`,
    `   ${row.url}`,
  ];
  return bits.join('\n');
}
