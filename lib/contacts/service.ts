/**
 * Shared server-side logic for folders and contacts.
 *
 * Every route goes through here so that three invariants cannot drift between endpoints:
 *
 *   1. OWNERSHIP IS A QUERY FILTER, never a fetch-then-compare. `findOne({ _id, userId })`.
 *      A miss returns the same 404 as a genuinely missing row, so whether somebody else's
 *      folder exists is not observable.
 *
 *   2. EVERY CONTACT WRITE USES `findOne` + assign + `.save()`. The `contactKey` hook is
 *      `pre('validate')`, and `pre('validate')` does NOT run on `findOneAndUpdate` —
 *      `runValidators` invokes Mongoose's separate update-validator helper, not document
 *      middleware. Using `findOneAndUpdate` here would silently skip key derivation.
 *
 *   3. DERIVED FIELDS ARE COMPUTED IN ONE PLACE. `companies` and `isTargetCompany` are
 *      recomputed on every write, and `scripts/backfill-contact-companies.ts` calls the
 *      same function — so a registry edit can be applied to stored rows without guessing
 *      what the code did on the day each row was written.
 */
import mongoose from 'mongoose';
import connectDB from '../mongodb';
import Contact, { IContact, CAPTURED_VIA } from '../models/Contact';
import Folder, { IFolder } from '../models/Folder';
import User, { DEFAULT_TARGET_COMPANIES } from '../models/User';
import { resolveCompanies } from '../companies/resolve';
import { coerceLinkedInInput } from '../scan/linkedin';
// Re-exported so existing importers keep working; it lives apart so `auth.ts` can use it
// without dragging in the company registry.
import { ensureUser } from '../user-record';
import type { CapturedVia } from '../scan/types';
import type { ContactDTO, ContactInput, FolderDTO } from './types';

export { connectDB };
export { ensureUser };

/* ────────────────────────────── target companies ────────────────────────────── */

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The user's target-company list, falling back to the default seed.
 *
 * Replaces `getTargetCompanies()` in `lib/helpers/phase6.ts`, which returned a module-level
 * array BY REFERENCE — so `addTargetCompany()` mutated a process-global shared by every
 * user of the deployment, and `removeTargetCompany()` discarded its own result. All three
 * were uncalled, so this replaces rather than extends them.
 */
export async function getTargetCompanies(userId: string): Promise<string[]> {
  const user = await User.findOne({ googleId: userId }).select('targetCompanies').lean();
  const list = user?.targetCompanies;
  return list?.length ? list : [...DEFAULT_TARGET_COMPANIES];
}

/**
 * Does this person work somewhere on the target list?
 *
 * Matched with word boundaries against the fields the PERSON supplied about themselves —
 * `company`, `role` and `headline`. That is a materially different situation from the
 * event-attribution problem the registry's `strength` field exists for: a bare "Intel" in
 * an event description means nothing, but "Intel" in the company field of a contact means
 * they said they work at Intel.
 */
export function matchesTargetCompany(
  fields: { company?: string | null; role?: string | null; headline?: string | null },
  targetCompanies: readonly string[]
): boolean {
  const haystack = [fields.company, fields.role, fields.headline]
    .filter(Boolean)
    .join(' ');
  if (!haystack) return false;

  return targetCompanies.some(name => {
    if (!name) return false;
    return new RegExp(`(?<![A-Za-z0-9])${escapeRegex(name)}(?![A-Za-z0-9])`, 'i').test(haystack);
  });
}

/**
 * Recompute the two derived fields from stored fields alone.
 *
 * Exported so the backfill script and the write path cannot disagree.
 */
export function deriveContactMeta(
  fields: {
    company?: string | null;
    role?: string | null;
    headline?: string | null;
    tags?: string[] | null;
  },
  targetCompanies: readonly string[]
): { companies: string[]; isTargetCompany: boolean } {
  return {
    // `organizer` is the registry's strongest field, and a contact's stated employer is
    // exactly that kind of claim. `headline` goes in `title`, which the resolver restricts
    // to distinctive names only.
    companies: resolveCompanies({
      organizer: fields.company ?? null,
      title: fields.headline ?? null,
      tags: fields.tags ?? null,
    }),
    isTargetCompany: matchesTargetCompany(fields, targetCompanies),
  };
}

/* ────────────────────────────── serialisation ────────────────────────────── */

type Lean<T> = T & { _id: mongoose.Types.ObjectId };

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function folderToDTO(
  folder: Lean<Partial<IFolder>>,
  counts?: { contactCount?: number; pendingFollowUps?: number }
): FolderDTO {
  const intakeLive = Boolean(
    folder.intakeEnabled &&
      folder.intakeToken &&
      (!folder.intakeExpiresAt || folder.intakeExpiresAt.getTime() > Date.now())
  );

  return {
    _id: String(folder._id),
    name: folder.name ?? '',
    slug: folder.slug ?? '',
    eventId: folder.eventId ? String(folder.eventId) : null,
    eventDate: iso(folder.eventDate),
    venue: folder.venue ?? null,
    note: folder.note ?? null,
    intakeEnabled: Boolean(folder.intakeEnabled),
    // The token is a CAPABILITY: it is only sent while intake is actually live, so a
    // disabled or expired folder does not leak a working write credential into a response.
    intakeToken: intakeLive ? folder.intakeToken ?? null : null,
    intakeExpiresAt: iso(folder.intakeExpiresAt),
    archivedAt: iso(folder.archivedAt),
    createdAt: iso(folder.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(folder.updatedAt) ?? new Date(0).toISOString(),
    contactCount: counts?.contactCount,
    pendingFollowUps: counts?.pendingFollowUps,
  };
}

export function contactToDTO(contact: Lean<Partial<IContact>>): ContactDTO {
  return {
    _id: String(contact._id),
    folderId: String(contact.folderId),
    clientId: contact.clientId ?? '',
    name: contact.name ?? '',
    headline: contact.headline ?? null,
    role: contact.role ?? null,
    company: contact.company ?? null,
    linkedin: contact.linkedin ?? null,
    linkedinSlug: contact.linkedinSlug ?? null,
    x: contact.x ?? null,
    github: contact.github ?? null,
    website: contact.website ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
    note: contact.note ?? null,
    // The literal decoded QR string, sent back so the promise that a payload is never silently
    // dropped is observable rather than merely intended — and so an unrecognised format can be
    // re-parsed later from data the client already has.
    rawPayload: contact.rawPayload ?? null,
    tags: contact.tags ?? [],
    followUpAt: iso(contact.followUpAt),
    followedUp: Boolean(contact.followedUp),
    capturedVia: contact.capturedVia ?? 'manual',
    scannedAt: iso(contact.scannedAt) ?? new Date(0).toISOString(),
    contactKey: contact.contactKey ?? '',
    companies: contact.companies ?? [],
    isTargetCompany: Boolean(contact.isTargetCompany),
    createdAt: iso(contact.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(contact.updatedAt) ?? new Date(0).toISOString(),
  };
}

/* ────────────────────────────── folders ────────────────────────────── */

export function isValidId(id: string): boolean {
  return mongoose.Types.ObjectId.isValid(id);
}

/** A folder the user owns, or null. Never reveals that somebody else's folder exists. */
export async function findOwnedFolder(userId: string, id: string) {
  if (!isValidId(id)) return null;
  return Folder.findOne({ _id: id, userId });
}

/**
 * Every folder with its contact and pending-follow-up counts.
 *
 * Counts come from one aggregate rather than N queries, so the list stays a single round
 * trip however many folders there are.
 */
export async function listFolders(userId: string, includeArchived = false): Promise<FolderDTO[]> {
  const filter: Record<string, unknown> = { userId };
  if (!includeArchived) filter.archivedAt = { $exists: false };

  const folders = await Folder.find(filter).sort({ eventDate: -1, updatedAt: -1 }).lean();
  if (!folders.length) return [];

  const stats = await Contact.aggregate<{
    _id: mongoose.Types.ObjectId;
    contactCount: number;
    pendingFollowUps: number;
  }>([
    { $match: { userId, folderId: { $in: folders.map(f => f._id) } } },
    {
      $group: {
        _id: '$folderId',
        contactCount: { $sum: 1 },
        pendingFollowUps: {
          $sum: {
            $cond: [
              { $and: [{ $ne: ['$followUpAt', null] }, { $ne: ['$followedUp', true] }] },
              1,
              0,
            ],
          },
        },
      },
    },
  ]);

  const byId = new Map(stats.map(s => [String(s._id), s]));
  return folders.map(folder =>
    folderToDTO(folder as Lean<IFolder>, {
      contactCount: byId.get(String(folder._id))?.contactCount ?? 0,
      pendingFollowUps: byId.get(String(folder._id))?.pendingFollowUps ?? 0,
    })
  );
}

/* ────────────────────────────── contacts ────────────────────────────── */

/**
 * The fields a client may write, with the type each must actually be.
 *
 * `undefined` means "clear this field" — see `pickWritable`.
 */
export interface ContactWritable {
  name?: string;
  headline?: string;
  role?: string;
  company?: string;
  linkedin?: string;
  linkedinSlug?: string;
  x?: string;
  github?: string;
  website?: string;
  email?: string;
  phone?: string;
  note?: string;
  tags?: string[];
  followUpAt?: Date | null;
  followedUp?: boolean;
  capturedVia?: CapturedVia;
  rawPayload?: string;
  scannedAt?: Date;
}

/** Trimmed, length-capped string, or undefined when absent/blank. */
function str(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

const TEXT_FIELDS: Array<[keyof ContactWritable, number]> = [
  ['name', 200],
  ['headline', 300],
  ['role', 200],
  ['company', 200],
  ['x', 120],
  ['github', 120],
  ['website', 500],
  ['email', 200],
  ['phone', 60],
  ['note', 4000],
  ['rawPayload', 4000],
];

/**
 * Copy ONLY allowed fields, coercing each to the type the schema expects.
 *
 * This is a trust boundary, not a convenience. Request bodies reach it directly, so without
 * per-field coercion a client could send `tags: "oops"` or `followedUp: "yes"` and have
 * Mongoose cast or reject it in ways the rest of the code does not expect.
 *
 * PATCH semantics: a field ABSENT from the body is left untouched; a field sent as `null` or
 * `''` is CLEARED. That is what a form naturally submits when the user empties an input, and
 * without it a note or follow-up date could be added but never removed. Only the PATCH path
 * uses the clearing behaviour — `upsertContact` only ever creates.
 */
export function pickWritable(body: Record<string, unknown>): ContactWritable {
  const out: ContactWritable = {};

  for (const [field, max] of TEXT_FIELDS) {
    if (!(field in body)) continue;
    (out as Record<string, unknown>)[field] = str(body[field], max);
  }

  /**
   * A LinkedIn value is canonicalised AND its slug extracted here, so that adding someone's
   * LinkedIn after the fact upgrades `contactKey` from `nm:` to `li:` — the case the
   * recomputing hook exists for. Accepts a pasted URL or a bare handle.
   */
  if ('linkedin' in body) {
    const raw = str(body.linkedin, 500);
    const ref = raw ? coerceLinkedInInput(raw) : null;
    out.linkedin = ref?.url ?? raw;
    // Only overwrite the slug when we actually resolved one; a non-profile LinkedIn URL
    // must not blank an existing good slug.
    if (ref?.slug) out.linkedinSlug = ref.slug;
    else if (!raw) out.linkedinSlug = undefined;
  } else if ('linkedinSlug' in body) {
    out.linkedinSlug = str(body.linkedinSlug, 200)?.toLowerCase();
  }

  if ('tags' in body) {
    out.tags = Array.isArray(body.tags)
      ? body.tags
          .filter((t): t is string => typeof t === 'string')
          .map(t => t.trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];
  }

  if ('followUpAt' in body) {
    const value = body.followUpAt;
    if (value === null || value === '') {
      out.followUpAt = null;
    } else if (typeof value === 'string' || value instanceof Date) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) out.followUpAt = parsed;
    }
  }

  if (typeof body.followedUp === 'boolean') out.followedUp = body.followedUp;

  if (
    typeof body.capturedVia === 'string' &&
    (CAPTURED_VIA as readonly string[]).includes(body.capturedVia)
  ) {
    out.capturedVia = body.capturedVia as CapturedVia;
  }

  if (typeof body.scannedAt === 'string') {
    const parsed = new Date(body.scannedAt);
    if (!Number.isNaN(parsed.getTime())) out.scannedAt = parsed;
  }

  return out;
}

export interface UpsertResult {
  contact: IContact;
  /** False when an identical `clientId` already existed — a replayed offline scan. */
  created: boolean;
}

/**
 * Create a contact, idempotently on `clientId`.
 *
 * THE IDEMPOTENCY CONTRACT: a replayed POST returns the EXISTING document with
 * `created: false`, and the caller answers 200 rather than 409. The scanner writes to
 * IndexedDB first and may post the same record several times on a flaky conference
 * network; treating a replay as a conflict would either duplicate the person or make the
 * client believe the write failed.
 *
 * A replay deliberately does NOT overwrite: by the time it lands the user may have
 * corrected the name in the UI, and the queued copy is the older truth.
 */
export async function upsertContact(
  userId: string,
  folderId: mongoose.Types.ObjectId | string,
  input: ContactInput
): Promise<UpsertResult> {
  const existing = await Contact.findOne({ userId, clientId: input.clientId });
  if (existing) return { contact: existing, created: false };

  const targets = await getTargetCompanies(userId);
  const fields = pickWritable(input as unknown as Record<string, unknown>);
  const meta = deriveContactMeta(
    {
      company: fields.company ?? null,
      role: fields.role ?? null,
      headline: fields.headline ?? null,
      tags: fields.tags ?? null,
    },
    targets
  );

  // `followUpAt: null` is the PATCH path's "clear this" signal and has no meaning on a
  // create — there is nothing to clear — so it is dropped rather than written as null.
  const { followUpAt, ...rest } = fields;

  // `.create()` runs document middleware, so the `contactKey` hook fires.
  const contact = await Contact.create({
    ...rest,
    ...(followUpAt ? { followUpAt } : {}),
    userId,
    folderId,
    clientId: input.clientId,
    ...meta,
  });

  return { contact, created: true };
}

/**
 * Apply an edit to a contact the user owns.
 *
 * Loaded and `.save()`d rather than updated in place, so `pre('validate')` runs and
 * `contactKey` is recomputed when the name, email, phone or LinkedIn slug changes.
 */
export async function updateOwnedContact(
  userId: string,
  id: string,
  body: Record<string, unknown>
): Promise<IContact | null> {
  if (!isValidId(id)) return null;

  const contact = await Contact.findOne({ _id: id, userId });
  if (!contact) return null;

  const fields = pickWritable(body);
  for (const [key, value] of Object.entries(fields)) {
    // `followUpAt: null` and `followedUp: false` must be able to clear a value, so null is
    // assigned through rather than skipped — `pickWritable` has already dropped blanks.
    (contact as unknown as Record<string, unknown>)[key] = value;
  }

  if (
    contact.isModified('company') ||
    contact.isModified('role') ||
    contact.isModified('headline') ||
    contact.isModified('tags')
  ) {
    const targets = await getTargetCompanies(userId);
    const meta = deriveContactMeta(contact, targets);
    contact.companies = meta.companies;
    contact.isTargetCompany = meta.isTargetCompany;
  }

  await contact.save();
  return contact;
}
