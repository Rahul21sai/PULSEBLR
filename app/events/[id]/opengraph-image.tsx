import { ImageResponse } from 'next/og';
import mongoose from 'mongoose';

import connectDB from '@/lib/mongodb';
import Event from '@/lib/models/Event';
import { isIndexableEvent } from '@/lib/events/seo';
import { fullDateIST, timeIST } from '@/lib/format';

/**
 * The share card for an event — GENERATED, never the scraped cover.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY IT IS GENERATED. Three reasons, and the first is measured rather than aesthetic:
 *
 *   1. The click-through crawl recorded 39 cover images REFUSING cross-origin embedding —
 *      `ERR_BLOCKED_BY_RESPONSE.NotSameSite` and `ERR_BLOCKED_BY_ORB` from the Snowflake,
 *      ClickHouse and Meetup CDNs. An `og:image` pointing at one of those does not show a broken
 *      image, it shows NOTHING: the app rendering the preview drops the card silently, so the
 *      failure is invisible to us and total for the reader.
 *   2. Scraped covers are frequently event posters whose text is illegible at card size.
 *   3. A generated card is consistent and branded, which is the entire point of a shared link.
 *
 * WHY IT DOES NOT NAME A NON-PUBLIC EVENT. This URL is unauthenticated by construction — a crawler
 * has no cookies — and it is derivable from the event id, which is not a secret. So it applies the
 * same gate as the page's JSON-LD, through the same predicate: for anything carrying a `visibility`
 * value, the card renders the generic PulseBLR panel with no title, date or venue on it. That is
 * strictly better than an auth check here, because an auth check would still leak to anyone holding
 * the URL, and it means the private-event rule cannot be bypassed by fetching the image directly.
 *
 * A MISSING OR MALFORMED ID ALSO GETS THE GENERIC CARD, not a 404. A 404 here renders as no preview
 * at all in every messaging app, which looks like the link itself is broken.
 *
 * FONTS. `ImageResponse` cannot use system fonts — satori needs an embedded font file, and it does
 * not read woff2 (which is all Google Fonts serves for Inter) or resolve a variable font to a
 * requested weight. `next/og` already ships and loads a real font file for exactly this purpose
 * (`node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf`, registered as its default at
 * weight 400), so this template uses it and no `fonts` option is passed. Committing a second TTF
 * would buy one bold weight for ~300 KB of binary in the repo; the card takes its hierarchy from
 * size, case and colour instead. DO NOT add `fontWeight: 700` to anything below — with a
 * single-weight face it changes nothing and reads as a bug when someone later "fixes" it.
 *
 * No remote images either — same runtime constraint, and the same reason as (1) above.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

export const alt = 'Event on PulseBLR';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

/**
 * Greyscale, one accent — the same rule `app/globals.css` holds the rest of the product to.
 *
 * LITERAL HEXES ON PURPOSE - DO NOT CONVERT THESE TO var(). Satori (next/og) resolves no CSS
 * custom properties, so a token here would paint nothing. INK / MUTED / HAIRLINE / BLUE mirror
 * --ink / --ink-2 / --rule / --accent; read their current values from the palette block in
 * app/globals.css and re-sync by hand. The hexes are deliberately not repeated in prose here:
 * a colour copied into a comment is a snapshot that goes stale and then gets believed.
 */
const INK = '#121417';
const MUTED = '#55595F';
const HAIRLINE = '#E4E2DC';
const BLUE = '#12513C';

interface CardEvent {
  title: string;
  startDateTime: Date;
  venue?: string | null;
  area?: string | null;
  city?: string | null;
  format: 'online' | 'offline' | 'hybrid';
  organizer?: string | null;
  isFree: boolean;
}

async function loadCardEvent(id: string): Promise<CardEvent | null> {
  if (!mongoose.Types.ObjectId.isValid(id)) return null;

  await connectDB();
  const doc = await Event.findById(id)
    .select('title startDateTime venue area city format organizer isFree visibility')
    .lean();
  if (!doc) return null;

  // The gate. Same predicate as the page's `robots` and JSON-LD; see the header.
  if (!isIndexableEvent(doc)) return null;

  return {
    title: doc.title,
    startDateTime: doc.startDateTime,
    venue: doc.venue ?? null,
    area: doc.area ?? null,
    city: doc.city ?? null,
    format: doc.format,
    organizer: doc.organizer ?? null,
    isFree: doc.isFree,
  };
}

export default async function OpengraphImage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let event: CardEvent | null = null;
  try {
    event = await loadCardEvent(id);
  } catch (error) {
    // A database hiccup must degrade to the generic card, never to a 500. A failed OG image is an
    // absent preview on somebody's shared link, which is the one outcome this file exists to avoid.
    console.error('opengraph-image: failed to load event', error);
  }

  return new ImageResponse(
    event ? <EventCard event={event} /> : <GenericCard />,
    { ...size }
  );
}

/* ────────────────────────────────── templates ────────────────────────────────── */

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#FFFFFF',
        padding: '64px 72px',
        // A hairline at the top rather than a coloured band: one accent, rationed.
        borderTop: `10px solid ${INK}`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * EVERY TEXT NODE HERE IS A SINGLE PRE-BUILT STRING, and every container that holds more than one
 * child declares `display: 'flex'`. That is not style preference — satori throws
 * "Expected <div> to have explicit display" on any element with several children and no display,
 * and JSX like `{date} · {time} IST` is THREE children. The failure would only appear at runtime,
 * on a real share, as a missing preview card.
 */
function Wordmark() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 10,
          background: INK,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#FFFFFF',
          fontSize: 20,
        }}
      >
        P
      </div>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 24, color: INK, letterSpacing: -0.6 }}>PulseBLR</div>
        <div style={{ fontSize: 14, color: MUTED, letterSpacing: 1.4 }}>BENGALURU TECH EVENTS</div>
      </div>
    </div>
  );
}

function EventCard({ event }: { event: CardEvent }) {
  const where =
    event.format === 'online'
      ? 'Online'
      : event.venue || event.area || event.city || 'Bengaluru';

  // Long titles are the norm from Meetup and Eventbrite. Cut at a word boundary so the card never
  // ends mid-word, and drop the size for the long ones so three lines still fit the panel.
  const title = clamp(event.title, 96);
  const titleSize = title.length > 62 ? 56 : title.length > 40 ? 66 : 76;

  const when = `${fullDateIST(event.startDateTime).toUpperCase()} · ${timeIST(event.startDateTime)} IST`;
  const footer = [clamp(where, 40), event.organizer ? clamp(event.organizer, 34) : null]
    .filter(Boolean)
    .join('  ·  ');

  return (
    <Frame>
      <Wordmark />

      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 22, color: BLUE, letterSpacing: 1.6 }}>{when}</div>
        <div
          style={{
            marginTop: 18,
            fontSize: titleSize,
            lineHeight: 1.08,
            letterSpacing: -2,
            color: INK,
            // Satori has no `-webkit-line-clamp`; `clamp()` above is what bounds this.
            display: 'flex',
          }}
        >
          {title}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          paddingTop: 26,
          borderTop: `1px solid ${HAIRLINE}`,
          fontSize: 26,
          color: MUTED,
        }}
      >
        <div style={{ color: INK }}>{footer}</div>
        {event.isFree && <div style={{ color: BLUE }}>Free</div>}
      </div>
    </Frame>
  );
}

/**
 * The card for an event this URL must not describe: not found, not readable, or not public.
 *
 * It says nothing about whether the event exists, which is the same discretion the page's 404 keeps.
 */
function GenericCard() {
  return (
    <Frame>
      <Wordmark />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontSize: 72, lineHeight: 1.1, letterSpacing: -2.4, color: INK, display: 'flex' }}>
          Bengaluru software and hardware events, ranked by who you will meet.
        </div>
      </div>
      <div style={{ display: 'flex', paddingTop: 26, borderTop: `1px solid ${HAIRLINE}`, fontSize: 26, color: MUTED }}>
        pulseblr — the events worth your evening
      </div>
    </Frame>
  );
}

/** Cut at a word boundary, with an ellipsis. Never mid-word: a card is read at a glance. */
function clamp(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
