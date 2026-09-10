/**
 * Two questions the control room has to answer before it hands anybody a delete button.
 *
 *   1. WHAT IS WRONG with the corpus — the candidates a feed-quality panel lists.
 *   2. WHAT HAPPENS IF I ACT on one — the impact preview, and specifically whether a USER has
 *      tracked the event or built a folder for it.
 *
 * They live together because they are the same object seen twice: every row the first half surfaces
 * is a proposed target for the second half to judge. Splitting them would put the detection and the
 * consequence in different files and invite a panel that lists candidates without pricing them.
 *
 * ── EVERYTHING HERE IS PURE ─────────────────────────────────────────────────────────────────
 *
 * No mongoose, no network, no `Date.now()` that is not passed in. The routes do the querying and
 * hand the rows in; these functions only decide. That is what lets `tests/admin-impact.test.ts`
 * pin the referrer rules — the ones that decide whether a delete is allowed — with no database, and
 * it is the same arrangement as `lib/events/admin-validate.ts` and `lib/tracker/validate.ts`.
 *
 * ── THE REFERRER RULES ARE `cleanup-*.ts`'s, NOT A SECOND OPINION ───────────────────────────
 *
 * `scripts/cleanup-non-bengaluru.ts` already established what protects a row, and this reproduces
 * its conclusions rather than re-deriving them:
 *
 *   · a `TrackerEntry` means a person decided to attend. Human action outranks a heuristic.
 *   · a `Folder` is STRONGER: it means they scanned the people they met there.
 *   · a hand-entered event (`createdByUserId` present) is excluded from bulk cleanups entirely —
 *     the user typed it in, there is no upstream to re-create it from, and their event may
 *     legitimately be in another city.
 *   · nothing is REPOINTED on a delete. That is `cleanup-duplicate-clusters.ts`'s job and it only
 *     works because a surviving twin exists to point at. A lone delete has no twin, so a dangling
 *     soft reference is the correct outcome — `pruneStale()` creates them on every scrape — and the
 *     row is spared outright instead.
 */

import { TECH_FLAG_CATEGORIES } from '../event-types';

/* ═══════════════════════════════ 1. What is wrong ═══════════════════════════════ */

/**
 * Signatures of a course advert rather than an event.
 *
 * Lifted from `scripts/diag-coaching-leak.ts`, which found "Free DevOps Demo Class in Electronic
 * City" and friends sitting inside the tech feed. Every entry is a PHRASE, never a bare word:
 * `course`, `training` and `demo` all appear innocently in real event copy ("a crash course in Rust
 * internals" is a talk), and a bare-word list is how `\bpm\b` came to tag a fifth of the corpus
 * `Product/Design`. The negative cases in the test file are the important half.
 *
 * Why these matter more than their count: the product exists to find events worth attending TO MAKE
 * PROFESSIONAL CONNECTIONS, and a sales session puts you in an audience being sold to — the exact
 * opposite. `connectionScore` penalises them, but a penalty only helps if the sort reaches them.
 */
export const COURSE_ADVERT_PATTERNS: readonly RegExp[] = [
  /\b(free|paid)\s+(demo|trial)\s+(class|session|lecture)/i,
  /\bdemo\s+class\b/i,
  /\b(training|coaching)\s+(institute|centre|center|academy)\b/i,
  /\bplacement\s+(assistance|guarantee|support)\b/i,
  /\b100%\s+(placement|job)\b/i,
  /\b(certification|certificate)\s+(course|program|programme|training)\b/i,
  /\bbatch\s+(starting|starts|start)\b/i,
  /\benroll\s+now\b/i,
  /\bjob\s+guarantee\b/i,
  /\b(get|become)\s+\w+\s+certified\b/i,
  /\bcrash\s+course\b/i,
  /\blive\s+project\s+training\b/i,
];

/** Which advert signatures a piece of copy matches. Empty means it reads as a real event. */
export function courseAdvertSignals(text: string): string[] {
  if (!text) return [];
  return COURSE_ADVERT_PATTERNS.filter(re => re.test(text)).map(re => String(re));
}

export function looksLikeCourseAdvert(text: string): boolean {
  return courseAdvertSignals(text).length > 0;
}

/**
 * The app's TWO definitions of "tech", and which way they disagree.
 *
 * `isTechEvent` is what `techOnly` filters on; membership of `TECH_FLAG_CATEGORIES` is what the
 * categories imply. The keyword floor derives one from the other so it cannot drift — the LLM sets
 * both independently, so it can.
 *
 * The two directions are NOT the same problem and must never be averaged into one number:
 *   · `hidden`    — tech categories but the flag is off. RECALL loss: the event exists, is right,
 *                   and no reader can reach it. This is how `IndiaFOSS 2026` disappeared.
 *   · `unbacked`  — flagged tech with nothing tech in its categories. PRECISION risk: it is in the
 *                   feed on the strength of a flag no category supports.
 */
export type TechDisagreement = 'none' | 'hidden' | 'unbacked';

export function techDisagreement(event: {
  isTechEvent?: boolean | null;
  category?: readonly string[] | null;
}): TechDisagreement {
  const hasTechCategory = (event.category ?? []).some(c => TECH_FLAG_CATEGORIES.has(c));
  const flagged = event.isTechEvent === true;
  if (flagged && !hasTechCategory) return 'unbacked';
  if (!flagged && hasTechCategory) return 'hidden';
  return 'none';
}

/**
 * Collapse rows into duplicate-cluster groups.
 *
 * A group is two or more stored documents sharing a `clusterKey`, which means the feed shows the
 * same event twice. Hand-entered events are excluded by the CALLER's query, not filtered here, for
 * the reason `cleanup-duplicate-clusters.ts` gives: their keys are owner-namespaced, so either
 * outcome of collapsing one is data loss — the user's private row deleted, or the public row
 * deleted in favour of one only its owner can see.
 *
 * Rows with no key are NOT a group. They are a different fault (a document written before the
 * `pre('validate')` hook existed, usually by the cron running an older default branch) with a
 * different fix, and lumping them in would report one problem as another.
 */
export function groupDuplicateClusters<T extends { clusterKey?: string | null }>(
  rows: readonly T[]
): Array<{ clusterKey: string; rows: T[] }> {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.clusterKey;
    if (!key) continue;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([clusterKey, group]) => ({ clusterKey, rows: group }))
    .sort((a, b) => b.rows.length - a.rows.length);
}

/* ═══════════════════════════════ 2. What happens if I act ═══════════════════════════════ */

/**
 * How much a proposed action costs.
 *
 * `blocked` is the only one that refuses. It is reserved for the case where acting would destroy
 * something no scrape and no undo can rebuild, and where the operator has a cheaper alternative —
 * so it always comes with an instruction, never a bare no.
 */
export type ImpactSeverity = 'safe' | 'caution' | 'blocked';

export interface ImpactWarning {
  /** Stable id, so the UI can style one kind of warning without matching on prose. */
  code:
    | 'tracked-by-users'
    | 'has-folders'
    | 'folder-has-contacts'
    | 'hand-entered'
    | 'spotlit'
    | 'pending-review'
    | 'returns-on-next-scrape'
    | 'discovery-state-lost'
    | 'source-producing';
  /** What it means for the operator, in their language. Never a schema path. */
  message: string;
  /** Does this warning on its own make the action refuse? */
  blocking: boolean;
}

export interface ImpactReport {
  severity: ImpactSeverity;
  /** True when an undo can put things back exactly as they were. */
  reversible: boolean;
  /** One sentence for the confirm dialog's headline. */
  headline: string;
  warnings: ImpactWarning[];
  /** Counts the dialog shows as numbers rather than prose. */
  counts: { trackerEntries: number; folders: number; contacts: number };
}

export interface EventImpactInput {
  event: {
    title?: string | null;
    createdByUserId?: string | null;
    visibility?: string | null;
    spotlightAt?: string | Date | null;
    source?: string | null;
  };
  /** `TrackerEntry` rows pointing at this event — from the same query the cleanups run. */
  trackerEntries: readonly { userId?: string | null }[];
  /** `Folder` rows pointing at this event. */
  folders: readonly { name?: string | null; userId?: string | null }[];
  /** Contacts inside those folders. A folder with people in it is the strongest signal here. */
  contacts: number;
}

/**
 * Judge deleting one event.
 *
 * The order of the warnings is the order they matter in, and the severity is decided by the
 * strongest one — a delete that would take somebody's scanned contacts with it is not made safer by
 * also being a scraped row that would come back.
 */
export function classifyEventDelete(input: EventImpactInput): ImpactReport {
  const warnings: ImpactWarning[] = [];
  const trackerEntries = input.trackerEntries.length;
  const folders = input.folders.length;
  const contacts = input.contacts;

  if (folders > 0 && contacts > 0) {
    warnings.push({
      code: 'folder-has-contacts',
      message:
        `${contacts} ${contacts === 1 ? 'person' : 'people'} were scanned into ` +
        `${folders === 1 ? 'a folder' : `${folders} folders`} for this event. Deleting the event ` +
        'leaves those folders pointing at nothing — the people are kept, the event they were met ' +
        'at is not.',
      blocking: true,
    });
  } else if (folders > 0) {
    warnings.push({
      code: 'has-folders',
      message:
        `${folders === 1 ? 'A user has' : `${folders} users have`} a scan folder for this event. ` +
        'A folder means they went, or meant to.',
      blocking: true,
    });
  }

  if (trackerEntries > 0) {
    const users = new Set(input.trackerEntries.map(t => String(t.userId ?? ''))).size;
    warnings.push({
      code: 'tracked-by-users',
      message:
        `${users === 1 ? 'One user has' : `${users} users have`} saved this event to their tracker. ` +
        'It disappears from their board with no error — the entry is dropped when the event it ' +
        'points at is gone.',
      blocking: true,
    });
  }

  if (input.event.createdByUserId) {
    warnings.push({
      code: 'hand-entered',
      message:
        'A user typed this event in by hand. No scrape can bring it back, and their event may ' +
        'legitimately be somewhere the gazetteer would reject.',
      blocking: true,
    });
  } else {
    warnings.push({
      code: 'returns-on-next-scrape',
      message:
        'A scraped event. If its source still lists it, the next run stores it again — so this is ' +
        'a correction that lasts until the next scrape, not a permanent removal.',
      blocking: false,
    });
  }

  if (input.event.visibility === 'pending') {
    warnings.push({
      code: 'pending-review',
      message:
        'This is a submission awaiting review. Decide it in Submissions — approving or keeping it ' +
        'private is the reversible move; deleting it discards somebody\'s work.',
      blocking: true,
    });
  }

  if (input.event.spotlightAt) {
    warnings.push({
      code: 'spotlit',
      message: 'Pinned to the home page Spotlight, so this is currently on the front page.',
      blocking: false,
    });
  }

  const blocked = warnings.some(w => w.blocking);
  return {
    // Nothing here is ever `safe` in the sense of costless — a delete is a delete — so `safe` means
    // "no human has acted on this row" and `caution` is the floor for anything with a warning.
    severity: blocked ? 'blocked' : warnings.some(w => !w.blocking) ? 'caution' : 'safe',
    // Reversible via the audit log's whole-document snapshot, which reuses the same `_id` — so the
    // tracker entries and folders above become live again on a restore. That is what makes the
    // blocking warnings a "are you sure" rather than a refusal the operator cannot pass.
    reversible: true,
    headline: blocked
      ? 'A user has acted on this event'
      : warnings.length > 0
        ? 'Safe to remove, with one thing to know'
        : 'Nothing references this event',
    warnings,
    counts: { trackerEntries, folders, contacts },
  };
}

/** Judge deleting a `Source` row. Disabling is nearly always the right action instead. */
export function classifySourceDelete(input: {
  source: { name?: string | null; kind?: string | null; lastEventCount?: number | null };
}): ImpactReport {
  const warnings: ImpactWarning[] = [
    {
      code: 'discovery-state-lost',
      message:
        'Deleting a source destroys persisted discovery state that took several scrapes to build ' +
        'and does not come back on its own. Disabling it keeps the record and stops it being ' +
        'fetched — that is almost always what you want.',
      blocking: false,
    },
  ];

  const producing = (input.source.lastEventCount ?? 0) > 0;
  if (producing) {
    warnings.push({
      code: 'source-producing',
      message:
        `This source returned ${input.source.lastEventCount} events on its last run. It is working.`,
      blocking: true,
    });
  }

  return {
    severity: producing ? 'blocked' : 'caution',
    reversible: true,
    headline: producing ? 'This source is currently producing events' : 'Disabling is the reversible move',
    warnings,
    counts: { trackerEntries: 0, folders: 0, contacts: 0 },
  };
}

/**
 * Roll several per-row reports into one, for a bulk action.
 *
 * The severity is the WORST of the batch, never an average: one row that would take a user's
 * scanned contacts with it is the whole story, and averaging is how a bulk delete gets waved
 * through on the strength of the rows that were fine.
 */
export function summariseBulkImpact(reports: readonly ImpactReport[]): ImpactReport {
  if (reports.length === 0) {
    return {
      severity: 'safe',
      reversible: true,
      headline: 'Nothing selected',
      warnings: [],
      counts: { trackerEntries: 0, folders: 0, contacts: 0 },
    };
  }

  const counts = reports.reduce(
    (acc, r) => ({
      trackerEntries: acc.trackerEntries + r.counts.trackerEntries,
      folders: acc.folders + r.counts.folders,
      contacts: acc.contacts + r.counts.contacts,
    }),
    { trackerEntries: 0, folders: 0, contacts: 0 }
  );

  const blockedCount = reports.filter(r => r.severity === 'blocked').length;
  // Deduplicated by code: the same warning repeated 40 times is noise, and the count is already
  // carried separately.
  const seen = new Set<string>();
  const warnings: ImpactWarning[] = [];
  for (const r of reports) {
    for (const w of r.warnings) {
      if (seen.has(w.code)) continue;
      seen.add(w.code);
      warnings.push(w);
    }
  }

  return {
    severity: blockedCount > 0 ? 'blocked' : reports.some(r => r.severity === 'caution') ? 'caution' : 'safe',
    reversible: reports.every(r => r.reversible),
    headline:
      blockedCount > 0
        ? `${blockedCount} of ${reports.length} ${blockedCount === 1 ? 'row has' : 'rows have'} been acted on by a user`
        : `${reports.length} ${reports.length === 1 ? 'row' : 'rows'}, none referenced by anybody`,
    warnings,
    counts,
  };
}

/* ═══════════════════════════════ 3. Loading the evidence ═══════════════════════════════ */

/**
 * The referrer queries, run against the database.
 *
 * DYNAMIC IMPORTS, for the same reason `recordAudit` uses them: everything above this line is pure
 * and is unit-tested with no mongoose in the module graph. A static model import here would drag a
 * registered mongoose model into a suite whose entire declared scope (`vitest.config.mts`) is that
 * it touches neither a database nor the network.
 *
 * The queries themselves are `cleanup-non-bengaluru.ts`'s, deliberately:
 *
 *     TrackerEntry.find({ eventId: { $in: ids } }, { eventId: 1, userId: 1 })
 *     Folder.find({ eventId: { $in: ids } },       { eventId: 1, name: 1, userId: 1 })
 *
 * ONE round trip per collection for the whole batch, never one per row — a bulk preview over 40
 * candidates otherwise costs 120 queries and the dialog takes long enough that people stop reading
 * it. Contacts are counted with a single `$group` over the folders found, then mapped back through
 * the folder, because "how many people did somebody scan at this event" is the number that decides
 * whether a delete is worth blocking and it is one hop further out than the folder itself.
 */
export async function fetchEventImpacts(
  ids: readonly string[]
): Promise<Map<string, ImpactReport>> {
  const out = new Map<string, ImpactReport>();
  if (ids.length === 0) return out;

  const [{ default: Event }, { default: TrackerEntry }, { default: Folder }, { default: Contact }] =
    await Promise.all([
      import('@/lib/models/Event'),
      import('@/lib/models/TrackerEntry'),
      import('@/lib/models/Folder'),
      import('@/lib/models/Contact'),
    ]);

  const [events, tracked, foldered] = await Promise.all([
    Event.find(
      { _id: { $in: ids } },
      { title: 1, createdByUserId: 1, visibility: 1, spotlightAt: 1, source: 1 }
    ).lean(),
    TrackerEntry.find({ eventId: { $in: ids } }, { eventId: 1, userId: 1 }).lean(),
    Folder.find({ eventId: { $in: ids } }, { eventId: 1, name: 1, userId: 1 }).lean(),
  ]);

  // Contacts per folder, in one aggregate, then folded back onto the event the folder points at.
  const folderIds = foldered.map(f => f._id);
  const perFolder = folderIds.length
    ? await Contact.aggregate<{ _id: unknown; n: number }>([
        { $match: { folderId: { $in: folderIds } } },
        { $group: { _id: '$folderId', n: { $sum: 1 } } },
      ])
    : [];
  const contactsByFolder = new Map(perFolder.map(r => [String(r._id), r.n]));

  const trackedByEvent = new Map<string, Array<{ userId?: string | null }>>();
  for (const t of tracked) {
    const key = String(t.eventId);
    const bucket = trackedByEvent.get(key);
    if (bucket) bucket.push({ userId: t.userId });
    else trackedByEvent.set(key, [{ userId: t.userId }]);
  }

  const foldersByEvent = new Map<string, Array<{ name?: string | null; userId?: string | null }>>();
  const contactsByEvent = new Map<string, number>();
  for (const f of foldered) {
    const key = String(f.eventId);
    const bucket = foldersByEvent.get(key);
    if (bucket) bucket.push({ name: f.name, userId: f.userId });
    else foldersByEvent.set(key, [{ name: f.name, userId: f.userId }]);
    contactsByEvent.set(key, (contactsByEvent.get(key) ?? 0) + (contactsByFolder.get(String(f._id)) ?? 0));
  }

  for (const e of events) {
    const key = String(e._id);
    out.set(
      key,
      classifyEventDelete({
        event: {
          title: e.title,
          createdByUserId: e.createdByUserId ?? null,
          visibility: e.visibility ?? null,
          spotlightAt: e.spotlightAt ?? null,
          source: e.source ?? null,
        },
        trackerEntries: trackedByEvent.get(key) ?? [],
        folders: foldersByEvent.get(key) ?? [],
        contacts: contactsByEvent.get(key) ?? 0,
      })
    );
  }

  return out;
}
