import connectDB from '../mongodb';
import TrackerEntry from '../models/TrackerEntry';
import Contact from '../models/Contact';
import Event from '../models/Event';
import { DEFAULT_TARGET_COMPANIES } from '../models/User';
import { contactKeyTier } from '../scan/contact-key';
import type { IConnection } from '../models/TrackerEntry';

/**
 * Career intelligence: who owes a follow-up, who you keep running into, and the numbers on
 * the dashboard.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────
 * WHAT CHANGED AND WHY. Person identity used to be a free-text name, used two incompatible
 * ways, and both were wrong:
 *
 *   - `detectRepeatConnections()` keyed on `connection.name.toLowerCase().trim()`, so two
 *     different people called Rahul at one event collapsed into one person, and the same
 *     person entered twice with different spellings became two.
 *   - `markFollowUpComplete()` matched `c.name === connectionName` — exact, case-sensitive,
 *     first match wins — so the Done button silently no-opped forever on the SECOND person
 *     with a given name. `ConnectionSchema` is `{ _id: false }`, so there was nothing better
 *     to address them by.
 *
 * Both now work off `Contact`, which has a real `_id` and a derived `contactKey` that prefers
 * a scanned LinkedIn slug — a globally unique identifier for a human being. "Have I met this
 * person before?" is an index lookup rather than a string comparison.
 *
 * LEGACY DATA IS STILL READ. Until `scripts/migrate-connections-to-contacts.ts` has run, some
 * people live in `TrackerEntry.connections[]`. Every function here unions both sources and
 * tags each result with `source`, so nothing disappears mid-migration and the dashboard needs
 * no flag day. Once migrated, the legacy branch simply returns nothing.
 * ─────────────────────────────────────────────────────────────────────────────────────
 */

/**
 * A person whose follow-up is due.
 *
 * `eventTitle` and `connection` keep the shape `app/dashboard/page.tsx` already renders;
 * `source` and `contactId` are additive, so the dashboard can address a contact precisely
 * while older callers keep working.
 */
export interface PendingFollowUp {
  source: 'contact' | 'tracker';
  /** Set when `source` is 'contact' — the precise row to complete. */
  contactId?: string;
  /** Set when `source` is 'tracker' — legacy addressing, by entry plus name. */
  trackerEntryId?: string;
  eventTitle: string;
  connection: {
    name: string;
    role?: string;
    company?: string;
    linkedin?: string;
    context?: string;
    followUpAt: Date;
  };
  /** True when the date has passed, false when it is merely coming up. */
  overdue: boolean;
}

/** Someone recorded at two or more events. */
export interface RepeatConnection {
  name: string;
  details?: {
    role?: string;
    company?: string;
    linkedin?: string;
  };
  eventCount: number;
  eventIds: string[];
  /** The identity this grouping was based on, and how strong it is. */
  contactKey?: string;
  matchedOn?: 'linkedin' | 'email' | 'phone' | 'name' | 'unknown';
  /** Where you met them, in order. */
  places?: string[];
}

/**
 * The clientIds a migration would have given these tracker entries' connections.
 *
 * WHY THIS IS NEEDED. Reading both stores keeps data visible mid-migration, but after
 * `migrate-connections-to-contacts.ts` runs, a person exists in BOTH — and naively unioning them
 * counts one person twice. Measured against a real fixture: a migrated connection appeared twice
 * in the follow-ups strip (so twice in the digest email), and `detectRepeatConnections` reported
 * "met at 2 events" for somebody met once, because the two branches identified the same event by
 * two different ids.
 *
 * The migration writes the deterministic clientId `migrated:<entryId>:<index>`, so the overlap is
 * exactly computable rather than guessed at from names. One query, and the legacy row is
 * suppressed wherever its Contact counterpart exists.
 */
async function migratedClientIds(
  userId: string,
  entries: Array<{ _id: unknown; connections?: unknown[] }>
): Promise<Set<string>> {
  const candidates: string[] = [];
  for (const entry of entries) {
    const count = entry.connections?.length ?? 0;
    for (let index = 0; index < count; index++) {
      candidates.push(`migrated:${String(entry._id)}:${index}`);
    }
  }
  if (!candidates.length) return new Set();

  const found = await Contact.find({ userId, clientId: { $in: candidates } })
    .select('clientId')
    .lean();
  return new Set(found.map(c => c.clientId));
}

export interface PendingFollowUpOptions {
  /**
   * Also include follow-ups due within the next N days.
   *
   * THE TWO WINDOWS USED TO DISAGREE, which is why this is an explicit parameter: this function
   * selected `followUpAt <= now` (OVERDUE) while the email digest selected `now … now+3 days`
   * (UPCOMING), so an overdue follow-up reached the dashboard but never the inbox and
   * `diag-tracker-flow.ts` had to backdate its fixture to test anything. Default 0 preserves the
   * overdue-only behaviour that the dashboard and that script expect; the digest passes 3.
   */
  includeUpcomingDays?: number;
}

/**
 * Everyone whose follow-up is due (and optionally, coming up), newest deadline first.
 */
export async function getPendingFollowUps(
  userId: string,
  options: PendingFollowUpOptions = {}
): Promise<PendingFollowUp[]> {
  await connectDB();

  const now = new Date();
  const horizon = options.includeUpcomingDays
    ? new Date(now.getTime() + options.includeUpcomingDays * 24 * 3600 * 1000)
    : now;

  const out: PendingFollowUp[] = [];

  /* ── Contacts ─────────────────────────────────────────────────────────── */
  // `$ne: null` is required as well as `$lte`: in BSON sort order null compares BELOW a date,
  // so a null followUpAt would otherwise match `$lte` and every contact without a reminder
  // would appear as due.
  const contacts = await Contact.find({
    userId,
    followUpAt: { $ne: null, $lte: horizon },
    followedUp: { $ne: true },
  })
    .populate('folderId')
    .sort({ followUpAt: 1 })
    .lean();

  for (const contact of contacts) {
    // A folder is denormalised and cannot dangle the way an Event reference can, but the
    // populate is still null-guarded — a deleted folder should not 500 the dashboard.
    const folder = contact.folderId as unknown as { name?: string } | null;
    out.push({
      source: 'contact',
      contactId: String(contact._id),
      eventTitle: folder?.name ?? 'Unknown event',
      connection: {
        name: contact.name,
        role: contact.role ?? undefined,
        company: contact.company ?? undefined,
        linkedin: contact.linkedin ?? undefined,
        context: contact.note ?? undefined,
        followUpAt: contact.followUpAt!,
      },
      overdue: contact.followUpAt! <= now,
    });
  }

  /* ── Legacy tracker subdocuments ──────────────────────────────────────── */
  const entries = await TrackerEntry.find({
    userId,
    // `$elemMatch` matters: without it two DIFFERENT array elements can each satisfy one bound,
    // so an entry matches while nothing in it is actually in window.
    connections: {
      $elemMatch: { followUpAt: { $ne: null, $lte: horizon }, followedUp: { $ne: true } },
    },
  })
    .populate('eventId')
    .lean();

  // Suppress any legacy connection that has already become a Contact, or the same person is
  // listed twice — once from each store — and the digest emails them twice.
  const migrated = await migratedClientIds(userId, entries);

  for (const entry of entries) {
    // `pruneStale()` deletes events 7 days past on every scrape without touching tracker
    // entries, so a dangling eventId is NORMAL. Reading `.title` off it unguarded used to 500
    // this endpoint, /api/phase6/stats and the digest.
    const event = entry.eventId as unknown as { title?: string } | null;

    const connections = entry.connections as IConnection[];
    for (let index = 0; index < connections.length; index++) {
      const connection = connections[index];
      if (migrated.has(`migrated:${String(entry._id)}:${index}`)) continue;
      if (!connection.followUpAt || connection.followedUp) continue;
      if (connection.followUpAt > horizon) continue;

      out.push({
        source: 'tracker',
        trackerEntryId: String(entry._id),
        eventTitle: event?.title ?? 'Unknown event',
        connection: {
          name: connection.name,
          role: connection.role,
          company: connection.company,
          linkedin: connection.linkedin,
          context: connection.context,
          followUpAt: connection.followUpAt,
        },
        overdue: connection.followUpAt <= now,
      });
    }
  }

  return out.sort((a, b) => a.connection.followUpAt.getTime() - b.connection.followUpAt.getTime());
}

/**
 * Mark a follow-up done, by contact id.
 *
 * The precise version, and the reason `Contact` is a collection: it addresses ONE row, so a
 * second person with the same name is no longer unreachable.
 */
export async function completeContactFollowUp(userId: string, contactId: string) {
  await connectDB();
  // Ownership in the filter, never fetch-then-compare.
  const contact = await Contact.findOne({ _id: contactId, userId });
  if (!contact) throw new Error('Contact not found');
  contact.followedUp = true;
  // `.save()` rather than an update, so `pre('validate')` runs — see lib/models/Contact.ts.
  await contact.save();
  return contact;
}

/**
 * Mark a legacy follow-up done, by tracker entry plus name.
 *
 * Kept for the pre-migration rows and for `scripts/diag-tracker-flow.ts`, which posts this
 * shape. It carries the original defect — the first name match wins — and cannot be fixed
 * without an id on the subdocument, which is exactly why contacts moved to their own
 * collection.
 */
export async function markFollowUpComplete(
  trackerEntryId: string,
  connectionName: string,
  userId: string
) {
  await connectDB();

  const entry = await TrackerEntry.findOne({ _id: trackerEntryId, userId });
  if (!entry) throw new Error('Tracker entry not found');

  const connection = entry.connections.find(c => c.name === connectionName);
  if (!connection) throw new Error('Connection not found');

  connection.followedUp = true;
  await entry.save();

  return entry;
}

/**
 * People recorded at two or more events.
 *
 * Grouped by `contactKey`, so when a LinkedIn slug is present the match is exact rather than a
 * lowercased-name guess. `matchedOn` reports which tier did the matching, so the UI can be
 * more confident about `linkedin` than about `name`.
 */
export async function detectRepeatConnections(userId: string): Promise<RepeatConnection[]> {
  await connectDB();

  interface Group {
    key: string;
    name: string;
    details: { role?: string; company?: string; linkedin?: string };
    eventIds: Set<string>;
    places: Set<string>;
  }
  const groups = new Map<string, Group>();

  function add(
    key: string,
    name: string,
    details: { role?: string; company?: string; linkedin?: string },
    eventId: string | null,
    place: string | null
  ) {
    if (!key) return;
    let group = groups.get(key);
    if (!group) {
      group = { key, name, details, eventIds: new Set(), places: new Set() };
      groups.set(key, group);
    }
    // Fill gaps from later sightings without overwriting what we already knew — the same
    // merge-never-blank rule event ingestion uses.
    group.details.role ||= details.role;
    group.details.company ||= details.company;
    group.details.linkedin ||= details.linkedin;
    if (eventId) group.eventIds.add(eventId);
    if (place) group.places.add(place);
  }

  const contacts = await Contact.find({ userId }).populate('folderId').lean();
  for (const contact of contacts) {
    const folder = contact.folderId as unknown as
      | { _id?: unknown; name?: string; eventId?: unknown }
      | null;
    add(
      contact.contactKey,
      contact.name,
      {
        role: contact.role ?? undefined,
        company: contact.company ?? undefined,
        linkedin: contact.linkedin ?? undefined,
      },
      /**
       * Identify the EVENT, preferring the folder's linked event id over the folder's own id.
       *
       * Both matter. Using the folder id alone made a migrated contact and its legacy twin look
       * like two different events (a false "met at 2 events"), and it would also count two
       * folders created for the same event as two events. Falling back to the folder id keeps
       * this working for the common case where the event was never in the corpus at all.
       */
      folder?.eventId ? String(folder.eventId) : folder?._id ? String(folder._id) : null,
      folder?.name ?? null
    );
  }

  // Legacy rows keep the old name-based key, tagged as such by `contactKeyTier`.
  const entries = await TrackerEntry.find({ userId, 'connections.0': { $exists: true } })
    .populate('eventId')
    .lean();
  // Skip anything already migrated — otherwise one person met once is reported as a repeat.
  const migrated = await migratedClientIds(userId, entries);

  for (const entry of entries) {
    const event = entry.eventId as unknown as { _id?: unknown; title?: string } | null;
    const connections = entry.connections as IConnection[];
    for (let index = 0; index < connections.length; index++) {
      const connection = connections[index];
      if (migrated.has(`migrated:${String(entry._id)}:${index}`)) continue;
      const name = connection.name?.trim();
      if (!name) continue;
      add(
        `nm:${name.toLowerCase()}`,
        name,
        {
          role: connection.role,
          company: connection.company,
          linkedin: connection.linkedin,
        },
        event?._id ? String(event._id) : String(entry._id),
        event?.title ?? null
      );
    }
  }

  return Array.from(groups.values())
    .filter(group => group.eventIds.size >= 2)
    .map(group => ({
      name: group.name,
      details: group.details,
      eventCount: group.eventIds.size,
      eventIds: Array.from(group.eventIds),
      contactKey: group.key,
      matchedOn: contactKeyTier(group.key),
      places: Array.from(group.places),
    }))
    .sort((a, b) => b.eventCount - a.eventCount);
}

/**
 * Event-level target-company detection, used by the scraper at ingest.
 *
 * This is a GLOBAL judgement about a shared event corpus, made where there is no signed-in
 * user, so it reads the default list rather than anybody's preferences. Per-user target
 * companies live on `User.targetCompanies` and are read by
 * `lib/contacts/service.ts#getTargetCompanies`.
 *
 * `getTargetCompanies()`, `addTargetCompany()` and `removeTargetCompany()` were REMOVED rather
 * than kept: the getter returned the module array by reference, so the adder mutated a
 * process-global shared by every user of the deployment, and the remover discarded its own
 * result. All three were uncalled.
 */
export function isTargetCompanyEvent(
  organizer: string | undefined,
  description: string
): boolean {
  if (!organizer && !description) return false;

  const searchText = `${organizer || ''} ${description}`.toLowerCase();
  return DEFAULT_TARGET_COMPANIES.some(company => searchText.includes(company.toLowerCase()));
}

/** Does the description mention a recruiter or hiring team? */
export function hasRecruiterMention(description: string): boolean {
  const recruiterKeywords = [
    'recruiter',
    'recruitment',
    'talent',
    'hiring',
    'careers',
    'job',
    'opportunity',
    'hr team',
    'human resources',
  ];

  const lowerDesc = description.toLowerCase();
  return recruiterKeywords.some(keyword => lowerDesc.includes(keyword));
}

/** Dashboard numbers. */
export async function getStats(userId: string) {
  await connectDB();

  const now = new Date();
  const thisMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    totalEvents,
    eventsThisMonth,
    trackedEvents,
    attendedEvents,
    contactCount,
    legacyConnectionCount,
    folderCount,
    targetCompanyContacts,
    pendingFollowUps,
    targetCompanyEvents,
  ] = await Promise.all([
    Event.countDocuments(),
    Event.countDocuments({ createdAt: { $gte: thisMonth } }),
    TrackerEntry.countDocuments({ userId }),
    TrackerEntry.countDocuments({ userId, status: 'Attended' }),
    // A plain count now, instead of an $unwind aggregate over a subdocument array.
    Contact.countDocuments({ userId }),
    TrackerEntry.aggregate([
      { $match: { userId } },
      { $unwind: '$connections' },
      { $count: 'total' },
    ]).then(res => res[0]?.total || 0),
    Contact.distinct('folderId', { userId }).then(ids => ids.length),
    Contact.countDocuments({ userId, isTargetCompany: true }),
    getPendingFollowUps(userId).then(list => list.length),
    Event.countDocuments({ isTargetCompany: true }),
  ]);

  return {
    totalEvents,
    eventsThisMonth,
    trackedEvents,
    attendedEvents,
    // Kept under the original name so existing dashboard code keeps working, and now counting
    // both sources during the migration window.
    totalConnections: contactCount + legacyConnectionCount,
    totalContacts: contactCount,
    folderCount,
    targetCompanyContacts,
    pendingFollowUps,
    targetCompanyEvents,
  };
}
