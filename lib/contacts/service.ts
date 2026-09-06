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
import Folder, { IFolder, folderSlug } from '../models/Folder';
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

/** The most a single tag may be, and the most tags one contact may carry. */
export const MAX_TAG_LENGTH = 40;
export const MAX_TAGS_PER_CONTACT = 20;

/**
 * Canonicalise a tag list. PURE, exported, and the single definition every write path shares.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY CANONICALISATION IS NOT COSMETIC HERE. A tag is a FACET KEY: the People page groups and
 * filters on the exact stored string. So `"AI/ML"` and `"ai/ml"` are not a tidiness problem, they
 * are two facet entries for one idea, and the filter silently splits that person's cohort in half
 * with nothing on screen to suggest it happened. `['ibm', 'ibm']` inflates a per-tag count. And an
 * un-capped tag is an arbitrarily long string in a chip, which renders as a broken row.
 *
 * Lowercased on the way in rather than case-preserved. That loses `"IBM"` as a display form, and
 * it is still the right trade: the alternative is a first-seen-wins display map, which needs a
 * home, a migration, and a tie-break rule for the day two devices race — all to make a private
 * label look nicer. A tag is a filter, not a title.
 *
 * `pickWritable` is the only caller, which means scan, manual add, PATCH and the offline drain all
 * get the identical treatment — the property that matters, since a tag typed offline and synced
 * three hours later must land in the same facet bucket as one typed online.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export function canonicaliseTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    // Internal whitespace is collapsed, so "senior  sre" and "senior sre" are one tag.
    const tag = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS_PER_CONTACT) break;
  }
  return out;
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
    /**
     * ACCEPTED AND DELIBERATELY NOT USED for company resolution. Kept in the signature
     * because callers pass the whole contact and because removing it would read as an
     * oversight; see the warning below for why it must not be forwarded.
     */
    tags?: string[] | null;
  },
  targetCompanies: readonly string[]
): { companies: string[]; isTargetCompany: boolean } {
  return {
    /**
     * `organizer` is the registry's strongest field, and a contact's stated employer is
     * exactly that kind of claim. `headline` goes in `title`, which the resolver restricts
     * to distinctive names only.
     *
     * ─────────────────────────────────────────────────────────────────────────────────────
     * `tags` IS NOT PASSED, AND THAT IS THE WHOLE POINT — do not "fix" this by adding it back.
     *
     * It used to be `tags: fields.tags ?? null`, and that quietly defeated the feature user
     * tags exist for. `resolve.ts` scores a tag match at 60 with NO strength gate — above the
     * title branch's 50, which IS gated on `strength === 'distinctive'`. So for a contact, a
     * free-text label the user typed counted as *stronger* company evidence than an event
     * title, and every `ambiguous` name in the registry became reachable from it. Measured
     * against the real resolver:
     *
     *     ['embedded', 'arm'] → ['Arm']       ['shell']  → ['Shell']
     *     ['slice']           → ['slice']     ['target'] → ['Target']
     *     ['visa']            → ['Visa']      ['setu']   → ['Setu']
     *
     * A hardware engineer tagged `embedded, arm` was filed under the company Arm. This is the
     * same false-attribution class as the documented `Docker` → "SriVidya Tradition" leak,
     * arriving from the one direction `strength` cannot defend against.
     *
     * It is also self-defeating. Custom tags exist PRECISELY for employers the registry does
     * not know — that is the requirement they were built for — and forwarding them laundered
     * that free text back into the registry facet, so the one dimension meant to be
     * trustworthy became the one polluted by guesses.
     *
     * The two `tags` are not the same thing despite the shared name: on an Event they are
     * organiser-supplied topic tags harvested from the source, where the score of 60 is
     * reasonable. On a Contact they are one person's private labels. Severing them here is
     * the honest fix; gating the resolver on `distinctive` would only narrow the leak.
     *
     * Run `scripts/backfill-contact-companies.ts --apply` after changing this — stored rows
     * keep whatever the old rule gave them.
     * ─────────────────────────────────────────────────────────────────────────────────────
     */
    companies: resolveCompanies({
      organizer: fields.company ?? null,
      title: fields.headline ?? null,
      tags: null,
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

/** Tracker statuses that mean "I am going to this", and so should have a folder ready. */
export const FOLDER_ON_TRACKER_STATUS = ['Confirmed', 'Attended'] as const;

/**
 * Get or create this user's folder for a corpus event. Idempotent.
 *
 * WHY IT EXISTS. Folders were manual only, so confirming an event in the tracker and then
 * arriving to scan people meant creating the folder by hand at the door. Worse, nothing in the
 * product ever set `Folder.eventId` — every folder had it null — which made the
 * `folder.eventId ?? folder._id` branch in `detectRepeatConnections()` unreachable: two folders
 * for one event counted as two events. This is the path that finally populates it.
 *
 * THREE OUTCOMES, and the third is the one worth reading:
 *
 *   · already linked  — a folder with this `eventId` exists, so return it and touch nothing.
 *   · created         — the normal case.
 *   · ADOPTED         — a folder with the same NAME already exists, because the user made one by
 *     hand. `{ userId, slug }` is unique, so creating would throw E11000. Adopting it — linking
 *     the existing folder to the event — is strictly better than either failing or inventing
 *     "Databricks Hackathon (2)". The manual and automatic paths converge on one folder per event
 *     instead of racing to own it.
 *
 * Deliberately NOT transactional. The caller's primary action (a status change, a scan) must
 * succeed even if this does not, so every caller treats a throw as non-fatal.
 */
export async function ensureFolderForEvent(
  userId: string,
  event: {
    _id: mongoose.Types.ObjectId | string;
    title?: string;
    startDateTime?: Date | string;
    venue?: string | null;
    area?: string | null;
  }
): Promise<{ folder: IFolder; outcome: 'linked' | 'created' | 'adopted' }> {
  await connectDB();

  const existing = await Folder.findOne({ userId, eventId: event._id });
  if (existing) return { folder: existing, outcome: 'linked' };

  // Denormalised on purpose, matching the manual create path: `pruneStale()` deletes events a
  // week after they finish without touching referrers, so a folder that read its name through the
  // join would lose it. `eventId` is a soft link.
  const name = (event.title || '').trim() || 'Untitled event';
  const doc = {
    userId,
    name,
    eventId: event._id,
    eventDate: event.startDateTime ? new Date(event.startDateTime) : undefined,
    venue: event.venue || event.area || undefined,
  };

  try {
    return { folder: await Folder.create(doc), outcome: 'created' };
  } catch (error) {
    const err = error as { code?: number; keyPattern?: Record<string, unknown> };
    // Only the name clash is recoverable, and only by adopting. Anything else is a real failure
    // and belongs to the caller — see the { userId, clientId } story in CLAUDE.md §9 for why a
    // duplicate-key handler must check WHICH index it was.
    if (err.code === 11000 && err.keyPattern && 'slug' in err.keyPattern) {
      const byName = await Folder.findOne({ userId, slug: folderSlug(name) });
      if (byName) {
        if (!byName.eventId) {
          byName.eventId = event._id as mongoose.Types.ObjectId;
          if (!byName.eventDate && doc.eventDate) byName.eventDate = doc.eventDate;
          if (!byName.venue && doc.venue) byName.venue = doc.venue;
          await byName.save();
        }
        return { folder: byName, outcome: 'adopted' };
      }
    }
    throw error;
  }
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

/* ────────────────────────────── cross-folder reads ────────────────────────────── */

/**
 * `contactKey` → how many DISTINCT EVENTS that person was met at.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS RATHER THAN REUSING `detectRepeatConnections()`.
 *
 * That function is the dashboard's view and is wrong for this one in two structural ways. It
 * filters to `eventIds.size >= 2`, so it knows nothing about anybody met once and cannot answer
 * "met 1 time" versus "met 3 times" from a single call. And it returns names and keys with no
 * `Contact._id`, so badging rows would mean matching its output back to contacts BY NAME — which
 * is the exact defect the whole `contactKey` design exists to remove (two people called Rahul
 * collapsing into one, one Rahul spelled two ways splitting into two).
 *
 * THE EVENT IS `folder.eventId ?? folder._id`, NOT the folder. Keying on the folder alone counts
 * two folders for one event as two events — the same mistake `detectRepeatConnections` had to fix
 * — and since `ensureFolderForEvent()` now links folders to corpus events, the better branch is
 * finally reachable for folders created that way. Folders made by hand still have `eventId: null`
 * and fall back to their own id, which is correct: an unlinked folder is the only identity it has.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */
export async function contactKeyEventCounts(userId: string): Promise<Map<string, number>> {
  const rows = await Contact.aggregate<{ _id: string; count: number }>([
    { $match: { userId } },
    {
      $lookup: {
        from: 'folders',
        localField: 'folderId',
        foreignField: '_id',
        as: 'folder',
      },
    },
    {
      $addFields: {
        // `$ifNull` handles both a hand-made folder (eventId absent) and a DANGLING folderId —
        // `pruneStale()` deletes events on every scrape without touching what references them, and
        // a folder whose lookup returns nothing must still count as one event, not zero.
        eventKey: { $ifNull: [{ $arrayElemAt: ['$folder.eventId', 0] }, '$folderId'] },
      },
    },
    { $group: { _id: '$contactKey', events: { $addToSet: '$eventKey' } } },
    { $project: { count: { $size: '$events' } } },
  ]);

  return new Map(rows.filter(r => r._id).map(r => [r._id, r.count]));
}

/**
 * Attach the folder each person was met in.
 *
 * "Where did I meet them" is the single most valuable column on a combined list, and
 * `contactToDTO` emits only a bare `folderId`. The alternatives were both worse: N fetches of
 * `/api/folders/[id]`, or the client holding the folder list and joining by id — which breaks for
 * an ARCHIVED folder, because `listFolders()` excludes those by default, so people met at an
 * archived event would show no location at all.
 *
 * One `Folder.find` over the distinct ids on the page plus an in-memory join — the same
 * one-round-trip discipline `listFolders()` uses for its counts.
 */
export async function attachFolderNames(contacts: ContactDTO[]): Promise<ContactDTO[]> {
  const ids = [...new Set(contacts.map(c => c.folderId).filter(Boolean))];
  if (!ids.length) return contacts;

  const folders = await Folder.find({ _id: { $in: ids } })
    .select('name eventDate eventId')
    .lean();
  const byId = new Map(folders.map(f => [String(f._id), f]));

  return contacts.map(c => {
    const folder = byId.get(c.folderId);
    return {
      ...c,
      // Null rather than a placeholder when the folder is gone: a dangling reference is a normal
      // state here (see `pruneStale`), and inventing "Unknown folder" would hide that.
      folderName: folder?.name ?? null,
      folderEventDate: folder?.eventDate ? new Date(folder.eventDate).toISOString() : null,
    };
  });
}

/* ────────────────────────────── tag vocabulary ────────────────────────────── */

/**
 * Every tag this user can pick from: their stored vocabulary UNIONED with what is actually on
 * their contacts.
 *
 * Both halves are necessary and each covers a gap the other cannot:
 *
 *   - `User.contactTags` alone misses a tag that reached a contact without going through the
 *     vocabulary — an offline capture drained later, a contact imported by another route, or a
 *     tag applied before this field existed. Those tags are real and filterable, so a facet that
 *     omitted them would show a chip list that does not match the data.
 *   - `Contact.distinct('tags')` alone cannot represent a tag that has been CREATED but not yet
 *     applied to anybody, which is exactly the state right after somebody makes one — so a
 *     freshly created tag would vanish until it was used, which reads as the create button not
 *     working.
 *
 * `distinct` is used rather than an aggregate because it is served straight off the
 * `{ userId, tags, scannedAt }` index and returns a small set; per-tag COUNTS are a separate
 * question answered by the facet route, which needs them for one query anyway.
 */
export async function getContactTags(userId: string): Promise<string[]> {
  const [user, used] = await Promise.all([
    User.findOne({ googleId: userId }).select('contactTags').lean(),
    Contact.distinct('tags', { userId }) as Promise<string[]>,
  ]);

  const all = new Set<string>();
  for (const tag of canonicaliseTagVocabulary([...(user?.contactTags ?? []), ...used])) {
    all.add(tag);
  }
  return [...all].sort();
}

/**
 * Canonicalise a vocabulary list.
 *
 * Separate from `canonicaliseTags` only in its cap: a vocabulary is a whole list of labels, not the
 * handful on one person, so the 20-tag ceiling that is right for a contact would silently truncate
 * it. Everything else — trimming, whitespace collapse, lowercasing, dedupe, the 40-character cap —
 * is deliberately identical, because a vocabulary entry and the tag stored on a person must be the
 * same string or the facet splits.
 */
export function canonicaliseTagVocabulary(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, MAX_TAG_LENGTH);
    if (tag) seen.add(tag);
  }
  return [...seen].slice(0, MAX_TAG_VOCABULARY);
}

/** A generous ceiling on one user's tag vocabulary — high enough never to bite in real use. */
export const MAX_TAG_VOCABULARY = 300;

/**
 * Add tags to the user's vocabulary. Idempotent.
 *
 * `ensureUser()` rather than `findOne`: a valid session can legitimately have no `User` row —
 * `User.email` is unique, so the sign-in upsert throws E11000 whenever an email already exists
 * under a different googleId, and the dev provider hits that on every sign-in for an account that
 * has also used real Google. That is what made `/api/me/card` return 404 for a perfectly good
 * session, and creating a tag is not worth losing to the same hole.
 */
export async function addContactTags(userId: string, tags: unknown): Promise<string[]> {
  const incoming = canonicaliseTagVocabulary(tags);
  if (!incoming.length) return getContactTags(userId);

  const user = await ensureUser(userId);
  if (!user) return incoming;

  const merged = canonicaliseTagVocabulary([...(user.contactTags ?? []), ...incoming]);
  user.contactTags = merged;
  await user.save();
  return getContactTags(userId);
}

/**
 * Remove a tag from the vocabulary AND from every contact carrying it.
 *
 * Both halves, because doing only the first leaves the tag visible in the facet forever (it comes
 * back through the `distinct` union) while appearing to have been deleted — and doing only the
 * second leaves a vocabulary entry with nobody in it. There is no rename; that is the feature a
 * `Tag` collection would be for, and nothing has asked for it.
 */
export async function removeContactTag(userId: string, tag: string): Promise<void> {
  const [canonical] = canonicaliseTagVocabulary([tag]);
  if (!canonical) return;

  const user = await ensureUser(userId);
  if (user) {
    user.contactTags = (user.contactTags ?? []).filter(t => t !== canonical);
    await user.save();
  }

  // `updateMany` skips document middleware, which is normally forbidden on Contact because the
  // `contactKey` hook lives in `pre('validate')`. It is safe HERE and only here: `contactKey` is
  // derived from linkedinSlug/email/phone/name and `$pull` on `tags` cannot touch any of them, so
  // there is nothing for the hook to recompute. Doing this document-by-document would be hundreds
  // of round trips to remove one label.
  await Contact.updateMany({ userId, tags: canonical }, { $pull: { tags: canonical } });
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
    out.tags = canonicaliseTags(body.tags);
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
