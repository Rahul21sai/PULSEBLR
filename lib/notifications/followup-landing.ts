/**
 * What the morning-after screen (`/follow-ups/[folderId]`) is sent, as a pure projection.
 *
 * `GET /api/folders/[id]` already returns a folder and its contacts, and was the obvious thing to
 * reuse. It is NOT reused, for two reasons that are each sufficient:
 *
 *   · It does not carry `personId`, and drafting is keyed on the Person (`/api/people/[id]/draft`,
 *     which assembles the material through `selectDraftFields`). Without it the screen cannot draft.
 *   · It carries far more than this screen needs — phone, the private note, tags, the raw QR payload.
 *     A screen opened from a lock-screen notification should receive the least it can work with.
 *     The note in particular reaches this screen only through the draft endpoint's own preview, which
 *     is the ONE definition of "what will be sent to the model".
 *
 * So this is an allowlist, like `DRAFT_FIELDS`: a field added to `Contact` does not appear here until
 * somebody adds it to `toFollowUpContactView` on purpose.
 */

/** A contact row as the route reads it (`.lean()`), structurally so this file needs no mongoose. */
export interface FollowUpContactRow {
  _id: unknown;
  folderId?: unknown;
  personId?: unknown;
  name?: string | null;
  role?: string | null;
  company?: string | null;
  linkedin?: string | null;
  linkedinSlug?: string | null;
  email?: string | null;
  followedUp?: boolean | null;
  scannedAt?: Date | string | null;
}

export interface FollowUpContactView {
  id: string;
  /** Null when the contact has not been attached to a Person yet — it can be marked done, not drafted. */
  personId: string | null;
  name: string;
  role: string | null;
  company: string | null;
  /** Only ever an https linkedin.com URL. See `safeLinkedinUrl`. */
  linkedin: string | null;
  /** Only ever a plain address safe to put after `mailto:`. See `safeEmail`. */
  email: string | null;
  followedUp: boolean;
}

export interface FollowUpFolderRow {
  _id: unknown;
  name?: string | null;
  eventDate?: Date | string | null;
  venue?: string | null;
}

export interface FollowUpLanding {
  folder: { id: string; name: string; eventDate: string | null; venue: string | null };
  contacts: FollowUpContactView[];
  pendingCount: number;
}

const HEX24 = /^[0-9a-fA-F]{24}$/;

function idString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return HEX24.test(text) ? text : null;
}

/**
 * A LinkedIn link safe to put in an `href`, or null.
 *
 * Every contact field came from a QR code SOMEBODY ELSE generated, so `linkedin` is attacker-chosen
 * text and a `javascript:` value there is stored XSS against the one person who scanned it. Accepted:
 * http(s) on `linkedin.com` or a subdomain, returned upgraded to https. Otherwise rebuilt from the
 * parsed vanity slug when that is a plain slug, which is what `parseScanPayload` stores for every
 * LinkedIn QR (`/in/<slug>?fromQR=1`, CLAUDE.md §9).
 */
export function safeLinkedinUrl(linkedin: string | null | undefined, slug?: string | null): string | null {
  if (linkedin) {
    try {
      const url = new URL(linkedin.trim());
      const host = url.hostname.toLowerCase();
      if (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password &&
        (host === 'linkedin.com' || host.endsWith('.linkedin.com'))
      ) {
        url.protocol = 'https:';
        return url.href;
      }
    } catch {
      // Fall through to the slug.
    }
  }
  if (slug && /^[a-z0-9][a-z0-9_-]{0,99}$/i.test(slug.trim())) {
    return `https://www.linkedin.com/in/${slug.trim().toLowerCase()}`;
  }
  return null;
}

/**
 * An address safe to put after `mailto:`, or null.
 *
 * Deliberately narrower than RFC 5322: no characters that would start a `mailto:` header section
 * (`?`, `&`, `#`), no whitespace or control characters, no second `@`. A real address that uses one of
 * those loses only the prefilled email button; the draft can still be copied.
 */
export function safeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const text = email.trim();
  if (text.length > 254) return null;
  return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(text) ? text.toLowerCase() : null;
}

export function toFollowUpContactView(row: FollowUpContactRow): FollowUpContactView {
  return {
    id: String(row._id),
    personId: idString(row.personId),
    name: (row.name ?? '').trim() || 'Unnamed contact',
    role: row.role?.trim() || null,
    company: row.company?.trim() || null,
    linkedin: safeLinkedinUrl(row.linkedin, row.linkedinSlug),
    email: safeEmail(row.email),
    followedUp: row.followedUp === true,
  };
}

/**
 * The whole response. Still-to-do people first, in the order they were met, then the finished ones —
 * the screen is a to-do list, and a done item at the top is clutter.
 */
export function buildFollowUpLanding(
  folder: FollowUpFolderRow,
  contacts: FollowUpContactRow[]
): FollowUpLanding {
  const at = (row: FollowUpContactRow) => {
    const ms = row.scannedAt ? new Date(row.scannedAt).getTime() : NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  const sorted = [...contacts].sort(
    (a, b) =>
      Number(a.followedUp === true) - Number(b.followedUp === true) ||
      at(a) - at(b) ||
      String(a._id).localeCompare(String(b._id))
  );
  const views = sorted.map(toFollowUpContactView);
  const eventDate = folder.eventDate ? new Date(folder.eventDate) : null;
  return {
    folder: {
      id: String(folder._id),
      name: (folder.name ?? '').trim() || 'Untitled folder',
      eventDate: eventDate && !Number.isNaN(eventDate.getTime()) ? eventDate.toISOString() : null,
      venue: folder.venue?.trim() || null,
    },
    contacts: views,
    pendingCount: views.filter(view => !view.followedUp).length,
  };
}
