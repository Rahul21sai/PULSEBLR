// The four AUTHENTICATED tool handlers. Touches Mongo, like `handlers.ts`.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// EVERY FUNCTION HERE TAKES `userId` AS ITS FIRST POSITIONAL, REQUIRED PARAMETER. That is not a style
// choice, it is the whole access-control mechanism, and `lib/people/query.ts` states the reason
// better than a comment here can: a key can be forgotten by omission, a positional argument cannot.
// There is no default, no `userId?`, and no code path that constructs a filter without one — so the
// class of bug where one call site forgets to scope a query and leaks every user's contacts is not
// expressible in this file.
//
// THE PERSON FILTER COMES FROM `buildPersonFilter`, NEVER HAND-ROLLED. It is the same builder
// `/api/people` uses and it puts `{ userId }` in as its first arm. CLAUDE.md §7 records what
// hand-rolling a `$match` cost twice already — `/api/events/calendar` and `/api/companies` each leaked
// private-event counts that way. An MCP tool is just another reader and gets no bespoke predicate.
//
// TWO QUERIES HERE ARE NOT FROM A BUILDER, and both are named rather than quietly excused:
//   · `who_did_i_meet_at` needs contacts across SEVERAL folders, and `buildContactFilter` takes one
//     `folderId`. So it is `{ userId, folderId: { $in: [...] } }` — `userId` first, and the ids came
//     from a `Folder.find({ userId })` a line earlier, so both halves are already scoped.
//   · `my_saved_events` reads `TrackerEntry`, for which no builder exists at all: `lib/tracker/` holds
//     only the pure validator and `GET /api/tracker` inlines its own `find`. Noted at that function.
//
// ── WHAT THESE RETURN AND WHAT THEY DELIBERATELY DO NOT ──────────────────────────────────────
// Contact rows here carry a name, employer, role, LinkedIn URL and the user's own note. They do NOT
// carry `email` or `phone`. That is a judgement worth stating: the user owns this data and is the
// caller, so there is no access-control reason to withhold it — but an MCP result lands in a model's
// context window and from there into a transcript that may be synced, exported or shared, and a phone
// number is the field CLAUDE.md already singles out as "the one field people regret publishing"
// (`User.card.revealPhone` exists for precisely this). A name and a LinkedIn URL is enough to act on
// every question these tools exist to answer; an address book dump is not needed for any of them. The
// app itself still shows and exports both.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import Contact from '../models/Contact';
import Event from '../models/Event';
import Folder from '../models/Folder';
import Person from '../models/Person';
import TrackerEntry from '../models/TrackerEntry';
import connectDB from '../mongodb';
import { canViewEvent } from '../events/visibility';
import { resolveWindow } from '../events/query';
import { repeatKeys } from '../contacts/query';
import { buildPersonFilter, buildPersonSort, REPEAT_MIN_EVENTS } from '../people/query';
import { canonicaliseTags, contactKeyEventCounts } from '../contacts/service';
import { getPendingFollowUps } from '../helpers/phase6';
import { dayLabelIST } from '../format';
import {
  parseMyFollowUpsArgs,
  parseMyPeopleArgs,
  parseMySavedEventsArgs,
  parseWhoDidIMeetAtArgs,
  type MyPeopleArgs,
} from './personal-args';
import { summariseRow, toMcpEventRow, type McpEventRow, type StoredEvent } from './serialize';
import { invalidArgs, toolResult, type ToolOutcome } from './server';

/** Same list projection the public tools use, plus the two fields `canViewEvent` re-decides on. */
const SAVED_EVENT_FIELDS = [
  '_id title slug organizer category format isFree price priceMax currency',
  'venue area city onlineLink startDateTime endDateTime applyLink attendeeCount',
  'companies connectionScore source sourceUrl',
  // Carried because `canViewEvent` reads all three and treats a field it was NOT GIVEN as the
  // permissive case — so an incomplete projection here does not throw and does not deny, it silently
  // returns true for everything. CLAUDE.md §14 records `POST /api/folders` shipping exactly that bug.
  'visibility createdByUserId deletedAt',
].join(' ');

/* ════════════════════════════════ my_people ════════════════════════════════ */

interface McpPersonRow {
  id: string;
  name: string;
  company?: string;
  role?: string;
  headline?: string;
  linkedin?: string;
  companies?: string[];
  tags?: string[];
  isTargetCompany?: boolean;
  /** How many DISTINCT events this person was met at. 2+ is the warm-contact signal. */
  metAtEvents: number;
  lastInteractionAt?: string;
  followUpDueAt?: string;
}

async function runMyPeople(userId: string, rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseMyPeopleArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);
  const args = parsed.value;

  await connectDB();

  /**
   * RESOLVE `company` AGAINST WHAT THIS USER ACTUALLY HAS, and say what they have when it misses.
   *
   * `buildPersonFilter` matches `companies` EXACTLY, and the stored values are canonical registry
   * names ("Razorpay"). A model asked "who do I know at razorpay" sends the user's spelling. Without
   * this step the flagship question of the whole feature returns zero rows and the model reports "you
   * do not know anyone at Razorpay" — a confident wrong answer, which is the failure mode CLAUDE.md
   * calls out for the calendar's "No events this month".
   *
   * `distinct` is scoped by `userId` and by the same merged-person exclusion the filter uses, so it
   * cannot enumerate anything the caller may not already see.
   */
  let company = args.company;
  let knownCompanies: string[] = [];
  if (company !== undefined) {
    knownCompanies = (await Person.distinct('companies', {
      userId,
      mergedInto: null,
    })) as string[];
    const wanted = company.toLowerCase();
    const matched =
      knownCompanies.find(c => c.toLowerCase() === wanted) ??
      knownCompanies.find(c => c.toLowerCase().includes(wanted));

    if (matched === undefined) {
      return toolResult(
        `No company matching "${company}" appears on anyone this user has met. ` +
          (knownCompanies.length > 0
            ? `The companies they DO have people at: ${knownCompanies.sort().join(', ')}. ` +
              'Note this is only what the employer registry could attribute — try the `query` ' +
              'argument for a free-text search over names, roles and headlines, or `tag` for the ' +
              "user's own labels."
            : 'No employer has been attributed to anyone they have met yet, so try `query` for a ' +
              'free-text search instead.'),
        { people: [], returned: 0, totalMatching: 0, knownCompanies: knownCompanies.sort() }
      );
    }
    company = matched;
  }

  /**
   * `tag` goes through the app's OWN canonicaliser rather than a local `toLowerCase()`.
   *
   * A tag is a facet KEY, not a label — CLAUDE.md §11 — and `canonicaliseTags` is what every write
   * path uses, so a tag typed offline and one typed here land in the same bucket. Lower-casing by hand
   * would work today and drift the first time canonicalisation gains a rule.
   */
  const tag = args.tag !== undefined ? canonicaliseTags(args.tag)[0] : undefined;

  const filter = buildPersonFilter(userId, {
    q: args.query,
    company,
    tag,
    targetOnly: args.targetOnly,
    followUpDue: args.followUpDue,
    repeatOnly: args.repeatOnly,
  });

  const sort = buildPersonSort(args.sort ?? (args.followUpDue ? 'followUp' : 'recent'));

  const [docs, totalMatching] = await Promise.all([
    Person.find(filter)
      .select(
        '_id displayName company role headline contactKeys tags companies isTargetCompany ' +
          'lastInteractionAt nextActionAt eventCount'
      )
      .sort(sort)
      .limit(args.limit)
      .lean(),
    Person.countDocuments(filter),
  ]);

  const people = docs.map(toPersonRow);
  const payload = {
    people,
    returned: people.length,
    totalMatching,
    filters: describePeopleFilters(args, company, tag),
  };

  if (people.length === 0) {
    return toolResult(
      'Nobody this user has recorded matches that. This is their own capture history — people ' +
        'scanned at events, added by hand, or self-registered — so an empty answer means they have ' +
        'not logged anyone matching, NOT that no such person exists. Try dropping a filter, or ' +
        'my_saved_events to see which events they actually attended.',
      payload
    );
  }

  const head =
    people.length < totalMatching
      ? `${people.length} of ${totalMatching} people match. Ask for a higher limit to see the rest.`
      : `${people.length} ${people.length === 1 ? 'person' : 'people'}.`;

  return toolResult(`${head}\n\n${people.map(summarisePerson).join('\n\n')}`, payload);
}

interface LeanPersonish {
  _id: unknown;
  displayName?: string | null;
  company?: string | null;
  role?: string | null;
  headline?: string | null;
  contactKeys?: string[] | null;
  tags?: string[] | null;
  companies?: string[] | null;
  isTargetCompany?: boolean | null;
  lastInteractionAt?: Date | string | null;
  nextActionAt?: Date | string | null;
  eventCount?: number | null;
}

function toPersonRow(person: LeanPersonish): McpPersonRow {
  const row: McpPersonRow = {
    id: String(person._id),
    name: person.displayName?.trim() || 'Unnamed',
    metAtEvents: typeof person.eventCount === 'number' ? person.eventCount : 0,
  };
  if (text(person.company)) row.company = text(person.company);
  if (text(person.role)) row.role = text(person.role);
  if (text(person.headline)) row.headline = text(person.headline);
  const linkedin = linkedinFromKeys(person.contactKeys);
  if (linkedin) row.linkedin = linkedin;
  if (person.companies?.length) row.companies = person.companies;
  if (person.tags?.length) row.tags = person.tags;
  if (person.isTargetCompany) row.isTargetCompany = true;
  const last = iso(person.lastInteractionAt);
  if (last) row.lastInteractionAt = last;
  const next = iso(person.nextActionAt);
  if (next) row.followUpDueAt = next;
  return row;
}

function summarisePerson(row: McpPersonRow, index: number): string {
  const affiliation = [row.role, row.company].filter(Boolean).join(' · ');
  const bits = [
    `${index + 1}. ${row.name}${affiliation ? ` — ${affiliation}` : ''}`,
    row.headline && row.headline !== affiliation ? `   ${row.headline}` : null,
    row.metAtEvents >= REPEAT_MIN_EVENTS ? `   met at ${row.metAtEvents} events` : null,
    row.tags?.length ? `   tags: ${row.tags.join(', ')}` : null,
    row.followUpDueAt ? `   follow-up due ${dayLabelIST(row.followUpDueAt)}` : null,
    row.linkedin ? `   ${row.linkedin}` : null,
  ];
  return bits.filter(Boolean).join('\n');
}

function describePeopleFilters(
  args: MyPeopleArgs,
  resolvedCompany: string | undefined,
  resolvedTag: string | undefined
): Record<string, unknown> {
  const applied: Record<string, unknown> = { limit: args.limit };
  if (args.query) applied.query = args.query;
  // The RESOLVED value, not the requested one, so a model can see that "razorpay" became "Razorpay".
  if (resolvedCompany) applied.company = resolvedCompany;
  if (resolvedTag) applied.tag = resolvedTag;
  if (args.targetOnly !== undefined) applied.targetOnly = args.targetOnly;
  if (args.followUpDue !== undefined) applied.followUpDue = args.followUpDue;
  if (args.repeatOnly !== undefined) applied.repeatOnly = args.repeatOnly;
  return applied;
}

/* ════════════════════════════ who_did_i_meet_at ════════════════════════════ */

async function runWhoDidIMeetAt(userId: string, rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseWhoDidIMeetAtArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);
  const { event: wanted, limit } = parsed.value;

  await connectDB();

  /**
   * MATCHING IS ON THE USER'S OWN FOLDER NAMES, NOT ON THE EVENT CORPUS, and that is the correct
   * primitive rather than a shortcut.
   *
   * CLAUDE.md §9 records that `Folder.eventId` is null for every folder created by hand, and that the
   * three in the database at the time it was written all were. So resolving the name against `Event`
   * first and following `eventId` would miss precisely the events worth asking about — the internal
   * company evening, the college fest, the thing announced only in a WhatsApp group. A folder is the
   * user's own record of "I met people here" and its NAME is what they typed. One hop, no dependency
   * on a link that is usually absent.
   *
   * The regex is built from an ESCAPED literal. `wanted` is caller-supplied and reaches a Mongo
   * `$regex`; unescaped, `.*(.*(.*` is a denial of service and `^` silently changes the semantics.
   * `args.ts`'s header calls this out as the one thing the public tools deliberately never do — here
   * it is unavoidable (partial name matching IS the feature), so it is escaped and length-capped at
   * 200 characters by `boundedString`.
   */
  const pattern = new RegExp(escapeRegex(wanted), 'i');

  const folders = await Folder.find({ userId, name: pattern })
    .select('_id name eventDate venue eventId archivedAt')
    .sort({ eventDate: -1, createdAt: -1 })
    .limit(10)
    .lean();

  if (folders.length === 0) {
    /**
     * NAME WHAT DOES EXIST instead of answering "nobody".
     *
     * "You met nobody at X" and "you have no folder called X" are different facts, and only the second
     * is true here. Listing the folder names turns a dead end into a retry — the same reasoning the
     * `company` miss above uses, and the reasoning CLAUDE.md gives for the calendar showing its
     * failures rather than rendering "No events this month".
     */
    const all = await Folder.find({ userId }).select('name').sort({ createdAt: -1 }).limit(40).lean();
    const names = all.map(f => f.name).filter(Boolean);
    return toolResult(
      names.length > 0
        ? `No event folder matching "${wanted}". This user has folders for: ${names.join(', ')}. ` +
            'Matching is a partial, case-insensitive match on those names, so try a distinctive word ' +
            'from one of them.'
        : `No event folder matching "${wanted}", and this user has no folders at all yet — so they ` +
            'have not captured anyone at an event. Folders are created when they move an event to ' +
            'Confirmed or Attended on their tracker, or by hand from the scan screen.',
      { folders: [], people: [], returned: 0, knownFolders: names }
    );
  }

  const folderIds = folders.map(f => f._id);
  const contacts = await Contact.find({ userId, folderId: { $in: folderIds } })
    .select('_id name role company headline linkedin linkedinSlug note tags followUpAt followedUp scannedAt folderId contactKey')
    .sort({ scannedAt: -1 })
    .limit(limit)
    .lean();

  /**
   * `metCount` comes from `contactKeyEventCounts`, the same aggregate `/people` uses, so "met at 3
   * events" means the same thing here as it does on the page. It counts DISTINCT EVENTS
   * (`folder.eventId ?? folder._id`) rather than folders — two folders for one event is not two
   * meetings, which is the bug the `??` in that function exists to prevent.
   */
  const counts = await contactKeyEventCounts(userId);
  const repeats = new Set(repeatKeys(counts));

  const folderName = new Map(folders.map(f => [String(f._id), f.name]));

  const people = contacts.map(c => {
    const row: Record<string, unknown> = {
      id: String(c._id),
      name: c.name,
      folder: folderName.get(String(c.folderId)) ?? null,
    };
    if (text(c.role)) row.role = text(c.role);
    if (text(c.company)) row.company = text(c.company);
    if (text(c.headline)) row.headline = text(c.headline);
    const linkedin = text(c.linkedin) ?? (c.linkedinSlug ? `https://www.linkedin.com/in/${c.linkedinSlug}` : undefined);
    if (linkedin) row.linkedin = linkedin;
    // `note` is "how we met" — the field that makes a follow-up message writable rather than generic.
    if (text(c.note)) row.howWeMet = text(c.note);
    if (c.tags?.length) row.tags = c.tags;
    if (c.followUpAt && !c.followedUp) row.followUpDueAt = iso(c.followUpAt);
    if (c.contactKey && repeats.has(c.contactKey)) {
      row.metAtEvents = counts.get(c.contactKey) ?? REPEAT_MIN_EVENTS;
    }
    const scanned = iso(c.scannedAt);
    if (scanned) row.metAt = scanned;
    return row;
  });

  const payload = {
    folders: folders.map(f => ({
      id: String(f._id),
      name: f.name,
      date: iso(f.eventDate) ?? null,
      venue: text(f.venue) ?? null,
      archived: Boolean(f.archivedAt),
    })),
    people,
    returned: people.length,
  };

  if (people.length === 0) {
    return toolResult(
      `The folder${folders.length === 1 ? '' : 's'} for "${wanted}" (${folders
        .map(f => f.name)
        .join(', ')}) ${folders.length === 1 ? 'exists' : 'exist'} but ${
        folders.length === 1 ? 'has' : 'have'
      } nobody in ${folders.length === 1 ? 'it' : 'them'} yet. An empty folder is normal — one is ` +
        'created automatically when an event is moved to Confirmed or Attended, before anybody has ' +
        'been scanned.',
      payload
    );
  }

  const lines = people.map((p, i) => {
    const affiliation = [p.role, p.company].filter(Boolean).join(' · ');
    return [
      `${i + 1}. ${p.name}${affiliation ? ` — ${affiliation}` : ''}`,
      p.howWeMet ? `   how you met: ${p.howWeMet}` : null,
      p.metAtEvents ? `   met at ${p.metAtEvents} events in total` : null,
      p.followUpDueAt ? `   follow-up due ${dayLabelIST(String(p.followUpDueAt))}` : null,
      p.linkedin ? `   ${p.linkedin}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return toolResult(
    `${people.length} ${people.length === 1 ? 'person' : 'people'} captured at ${folders
      .map(f => f.name)
      .join(', ')}.\n\n${lines.join('\n\n')}`,
    payload
  );
}

/* ════════════════════════════════ my_follow_ups ════════════════════════════════ */

async function runMyFollowUps(userId: string, rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseMyFollowUpsArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);
  const { includeUpcomingDays, limit } = parsed.value;

  /**
   * `getPendingFollowUps` opens its own connection and unions BOTH stores — the `Contact` collection
   * and the legacy `TrackerEntry.connections[]` array — while suppressing the overlap by the
   * deterministic `migrated:<entryId>:<index>` clientId. Reimplementing the query here would
   * reintroduce the exact defect CLAUDE.md §8 records: a migrated person appearing twice, once from
   * each store, and "met at 2 events" for somebody met once.
   */
  const all = await getPendingFollowUps(userId, { includeUpcomingDays });
  const shown = all.slice(0, limit);

  const followUps = shown.map(f => ({
    // `contactId` is what `POST /api/phase6/follow-ups` needs to mark this done, so it is worth
    // returning even though this server cannot perform the write.
    contactId: f.contactId ?? null,
    trackerEntryId: f.trackerEntryId ?? null,
    name: f.connection.name,
    role: f.connection.role ?? null,
    company: f.connection.company ?? null,
    linkedin: f.connection.linkedin ?? null,
    howWeMet: f.connection.context ?? null,
    event: f.eventTitle,
    // `connection.followUpAt` is a real `Date`, not an ISO string — `PendingFollowUp` is not a DTO.
    dueAt: f.connection.followUpAt.toISOString(),
    dueLabel: dayLabelIST(f.connection.followUpAt),
    overdue: f.overdue,
  }));

  const overdue = followUps.filter(f => f.overdue).length;
  const payload = {
    followUps,
    returned: followUps.length,
    totalMatching: all.length,
    overdue,
    horizonDays: includeUpcomingDays,
  };

  if (followUps.length === 0) {
    /**
     * EMPTY IS GOOD NEWS HERE, and the prose says so explicitly.
     *
     * Every other tool in this server treats an empty result as a dead end to be explained. This one
     * is the inverse: no outstanding follow-ups is the state the user wants, and a model handed a bare
     * "no results" will report it as a failure or start hunting. It is the same asymmetry that makes
     * the digest's deadline section guard on `length > 0` rather than rendering an empty heading.
     */
    return toolResult(
      includeUpcomingDays > 0
        ? `Nothing outstanding — no follow-ups are overdue or due in the next ${includeUpcomingDays} ` +
            'days. This is the good state, not an empty search result.'
        : 'Nothing overdue. Every follow-up this user has set is either done or still in the future — ' +
            'this is the good state, not an empty search result. Pass includeUpcomingDays to look ahead.',
      payload
    );
  }

  const head =
    overdue > 0
      ? `${overdue} overdue follow-up${overdue === 1 ? '' : 's'}${
          followUps.length > overdue ? ` and ${followUps.length - overdue} coming up` : ''
        }, soonest first.`
      : `${followUps.length} follow-up${followUps.length === 1 ? '' : 's'} coming up in the next ${includeUpcomingDays} days.`;

  const lines = followUps.map((f, i) => {
    const affiliation = [f.role, f.company].filter(Boolean).join(' · ');
    return [
      `${i + 1}. ${f.name}${affiliation ? ` — ${affiliation}` : ''}`,
      `   ${f.overdue ? 'OVERDUE since' : 'due'} ${f.dueLabel} · met at ${f.event}`,
      f.howWeMet ? `   how you met: ${f.howWeMet}` : null,
      f.linkedin ? `   ${f.linkedin}` : null,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return toolResult(`${head}\n\n${lines.join('\n\n')}`, payload);
}

/* ═══════════════════════════════ my_saved_events ═══════════════════════════════ */

/**
 * A public event row plus what THIS user did with it.
 *
 * A declared interface rather than `McpEventRow & Record<string, unknown>`: the index signature would
 * type-check any key at all, so a typo (`trackerStaus`) would compile and ship a field no client reads.
 */
interface McpSavedEventRow extends McpEventRow {
  /** Which column of the user's kanban board this sits in. */
  trackerStatus: string;
  /** The user's own private note on this event. Their data, and they are the caller. */
  myNotes?: string;
  appliedAt?: string;
  outcome?: string;
  /** True when the user typed this event in themselves — the ones no public search can find. */
  addedByMe?: boolean;
}

async function runMySavedEvents(userId: string, rawArgs: unknown): Promise<ToolOutcome> {
  const parsed = parseMySavedEventsArgs(rawArgs);
  if (!parsed.ok) return invalidArgs(parsed.issues);
  const args = parsed.value;

  await connectDB();

  /**
   * NO REUSABLE TRACKER QUERY EXISTS — `lib/tracker/` holds only the pure validator, and
   * `GET /api/tracker` inlines its own `find`. So this is the second implementation of that listing,
   * which is worth stating rather than hiding: the shape is copied deliberately (filter on `userId`,
   * populate `eventId`, sort by `updatedAt`), and the date window and visibility handling below are
   * this tool's own because the route has neither.
   */
  const filter: Record<string, unknown> = { userId };
  if (args.status) filter.status = { $in: args.status };

  /**
   * `model: Event` IS PASSED EXPLICITLY, not left to registration order.
   *
   * `populate('eventId')` resolves the ref by NAME, which throws `MissingSchemaError` if the `Event`
   * model has not been registered on the connection yet — the exact failure a dry run over zero rows
   * hid in `migrate-connections-to-contacts.ts` (CLAUDE.md, scripts table), where the populate was
   * never reached so the missing registration never surfaced. Handing the model object in makes the
   * import load-bearing in a way a reader can see, instead of an unused-looking import somebody tidies
   * away.
   */
  const entries = await TrackerEntry.find(filter)
    .populate({ path: 'eventId', model: Event, select: SAVED_EVENT_FIELDS })
    .sort({ updatedAt: -1 })
    .lean();

  const window = args.when ? resolveWindow(args.when) : null;
  const now = new Date();

  const rows: Array<{ entry: (typeof entries)[number]; event: StoredEvent }> = [];
  let dangling = 0;

  for (const entry of entries) {
    const event = entry.eventId as unknown as StoredEvent | null;

    /**
     * A DANGLING REF IS NORMAL, NOT AN ERROR. `pruneStale()` deletes events a week past on every
     * scrape without touching what references them, so `populate` legitimately returns null and
     * `app/tracker/page.tsx` drops those entries too. Counting them lets the prose say so instead of
     * silently returning fewer rows than the board shows.
     */
    if (!event) {
      dangling += 1;
      continue;
    }

    /**
     * RE-DECIDE VISIBILITY, even though these are the caller's OWN tracker entries.
     *
     * `POST /api/tracker` checks `canViewEvent` at the time of tracking, but that is a check made
     * once, in the past. An event can become unreadable afterwards: a `pending` submission that was
     * approved and later rejected reverts to its author's `private`, and an admin can soft-delete a
     * row at any time. Without this the tool would keep serving a private event belonging to somebody
     * else, to a caller whose only claim on it is a stale tracker entry — and `deletedAt` is checked
     * FIRST inside `canViewEvent`, so this also stops a deliberately removed event resurfacing here.
     */
    if (!canViewEvent(event, userId)) continue;

    const start = new Date(event.startDateTime as string | Date);
    if (!args.includePast && start.getTime() < now.getTime()) {
      // An event still running counts as upcoming, matching the feed's "upcoming includes in-progress"
      // rule — so only fall through when there is no end date to save it.
      const end = event.endDateTime ? new Date(event.endDateTime as string | Date) : null;
      if (!end || end.getTime() < now.getTime()) continue;
    }
    if (window) {
      if (start.getTime() < window.from.getTime() || start.getTime() >= window.to.getTime()) continue;
    }

    rows.push({ entry, event });
  }

  const totalMatching = rows.length;
  const saved: McpSavedEventRow[] = rows.slice(0, args.limit).map(({ entry, event }) => {
    const row: McpSavedEventRow = { ...toMcpEventRow(event), trackerStatus: String(entry.status) };
    if (text(entry.notes)) row.myNotes = text(entry.notes);
    const applied = iso(entry.appliedAt);
    if (applied) row.appliedAt = applied;
    if (text(entry.outcome)) row.outcome = text(entry.outcome);
    // Hand-entered events are the ones no public search can find, so they are worth marking.
    if (event.createdByUserId) row.addedByMe = event.createdByUserId === userId;
    return row;
  });

  const byStatus: Record<string, number> = {};
  for (const { entry } of rows) byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;

  const payload = { saved, returned: saved.length, totalMatching, byStatus, danglingEntries: dangling };

  if (saved.length === 0) {
    return toolResult(
      (args.status || args.when || !args.includePast
        ? 'Nothing on this user’s tracker matches those filters. '
        : 'This user’s tracker is empty. ') +
        (args.includePast
          ? ''
          : 'Note this returns UPCOMING events only unless includePast is set, so a full board of ' +
            'past events looks empty here. ') +
        'They save events from the feed on pulseblr.com; search_events will show what is on.',
      payload
    );
  }

  const head =
    saved.length < totalMatching
      ? `${saved.length} of ${totalMatching} saved events. Ask for a higher limit to see the rest.`
      : `${saved.length} saved event${saved.length === 1 ? '' : 's'}.`;

  const lines = saved.map((row, i) => {
    const base = summariseRow(row, i);
    const extras = [
      `   on your board as: ${row.trackerStatus}`,
      row.myNotes ? `   your note: ${row.myNotes}` : null,
    ]
      .filter(Boolean)
      .join('\n');
    return `${base}\n${extras}`;
  });

  const footer =
    dangling > 0
      ? `\n\n(${dangling} more tracker ${dangling === 1 ? 'entry' : 'entries'} point at events that ` +
        'have since been pruned from the corpus — normal about a week after an event finishes.)'
      : '';

  return toolResult(`${head}\n\n${lines.join('\n\n')}${footer}`, payload);
}

/* ────────────────────────────── wiring ────────────────────────────── */

/**
 * The personal handler table.
 *
 * Note the SIGNATURE: `(userId: string, args: unknown)`. There is no entry that can be invoked without
 * a user id, so `runPersonalTool` below cannot dispatch to one — which is the point of doing it this
 * way rather than reading an identity out of a shared context object.
 */
const PERSONAL_HANDLERS: Record<string, (userId: string, args: unknown) => Promise<ToolOutcome>> = {
  my_people: runMyPeople,
  who_did_i_meet_at: runWhoDidIMeetAt,
  my_follow_ups: runMyFollowUps,
  my_saved_events: runMySavedEvents,
};

export function isPersonalHandler(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(PERSONAL_HANDLERS, name);
}

/**
 * Run one personal tool. `userId` is required and positional; there is no overload without it.
 *
 * `dispatch` has already refused an anonymous caller before this is reached, so the guard is
 * unreachable in practice — which is exactly why it is here. Two independent mechanisms answering the
 * same question is the arrangement `get_event` uses (the filter AND `canViewEvent`), and CLAUDE.md §12
 * records that five id-addressable paths each needed their own guard with a sixth to be assumed. A
 * throw rather than a soft refusal, because reaching it means the dispatcher's partition has broken
 * and the correct outcome is a `-32603` with the detail in the server log, not a silent empty list.
 */
export async function runPersonalTool(
  name: string,
  userId: string | null | undefined,
  args: unknown
): Promise<ToolOutcome> {
  const handler = PERSONAL_HANDLERS[name];
  if (!handler) return { error: { code: -32602, message: `Unknown tool "${name}".` } };
  if (!userId) {
    throw new Error(
      `[mcp] "${name}" reached the personal runner with no userId — the dispatcher's auth partition ` +
        'has broken. No query was issued.'
    );
  }
  return handler(userId, args);
}

/* ────────────────────────────── small helpers ────────────────────────────── */

/** Drop empty strings so a row carries only fields that say something. Mirrors `serialize.ts`. */
function text(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function iso(value: Date | string | null | undefined): string | undefined {
  if (!value) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * A LinkedIn URL from a person's contact keys.
 *
 * `contactKey` is tier-prefixed (`li:` > `em:` > `ph:` > `nm:`), so the LinkedIn slug is recoverable
 * from the identity itself with no extra field. Only `li:` yields a URL — an `em:` key is an email
 * address and must not be turned into a profile guess.
 */
function linkedinFromKeys(keys: string[] | null | undefined): string | undefined {
  const key = (keys ?? []).find(k => k.startsWith('li:'));
  if (!key) return undefined;
  const slug = key.slice(3).trim();
  return slug ? `https://www.linkedin.com/in/${slug}` : undefined;
}

/**
 * Escape a string for literal use inside a RegExp.
 *
 * Needed because `who_did_i_meet_at` genuinely requires partial matching, which the public tools
 * deliberately avoid (see `args.ts`'s header on why `get_event`'s slug lookup is an exact match). An
 * unescaped caller string here is both a correctness bug (`.` matching any character) and a
 * denial-of-service (`(a+)+$` backtracking) on a query scoped to the caller's own collection.
 */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
