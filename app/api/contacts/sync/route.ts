import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Folder, { folderSlug } from '@/lib/models/Folder';
import { requireUser } from '@/lib/api-auth';
import { contactToDTO, findOwnedFolder, upsertContact } from '@/lib/contacts/service';
import { isSchemaRejection } from '@/lib/tracker/validate';
import { ITEM_REFUSALS, type ItemRefusal } from '@/lib/scan/failure';
import type { ContactInput } from '@/lib/contacts/types';

/**
 * Drain the offline outbox in one request.
 *
 * Called when the network comes back, when the app regains focus, on boot, and from the
 * "Sync now" button. The client keeps every queued record in IndexedDB until this endpoint
 * confirms it, so the contract has to be precise:
 *
 *   - FOLDERS ARE PROCESSED FIRST, because a contact captured offline may reference a folder
 *     that also only exists offline. `folderMap` returns clientId → real id so the client
 *     can rewrite its local rows.
 *   - EVERY ITEM GETS ITS OWN RESULT. One bad record must not fail the batch and strand 40
 *     good contacts; the client removes only the entries that were confirmed.
 *   - REPLAYS ARE SUCCESS, NOT CONFLICT. `upsertContact` is idempotent on `clientId`, so
 *     re-sending an already-synced record returns `created: false` and the client can safely
 *     drop it. Anything else and a flaky network duplicates people.
 *   - EVERY REFUSAL SAYS WHETHER IT IS FINAL. An item result carries `permanent` and, where
 *     there is one, a `refusal` code from `lib/scan/failure.ts`. Without it the client cannot
 *     tell "the folder you scanned into has been deleted" (true forever) from "the database
 *     blinked" (true for a second), so it treated both as retryable and a doomed record sat
 *     in the queue for good under a banner promising it would upload on its own. The client
 *     must never have to infer this by string-matching the `error` text — see the note in
 *     `lib/scan/failure.ts` about mirrored constants drifting.
 *
 * Nothing here is destructive: it only creates.
 */

/** Enough for a very busy conference day; beyond this, something is wrong. */
const MAX_ITEMS = 500;

interface QueuedFolder {
  clientId: string;
  name: string;
  eventDate?: string;
  venue?: string;
  note?: string;
}

interface ItemResult {
  clientId: string;
  ok: boolean;
  id?: string;
  /** True when this record was already on the server — a replay, not a failure. */
  duplicate?: boolean;
  error?: string;
  /**
   * Whether re-sending this exact record could ever succeed. `true` means it cannot, so the
   * client should stop counting it as "uploading shortly" and show the user what to do about
   * it. Absent on a success.
   */
  permanent?: boolean;
  /** A code from `ITEM_REFUSALS`, so the client renders copy rather than parsing prose. */
  refusal?: ItemRefusal;
}

/** A refusal on the merits: one code, one message, and `permanent` set once in one place. */
function refuse(clientId: string, refusal: ItemRefusal): ItemResult {
  return { clientId, ok: false, permanent: true, refusal, error: ITEM_REFUSALS[refusal] };
}

/**
 * A thrown error, classified — and deliberately NOT quoted back to the caller.
 *
 * A Mongoose ValidationError or CastError is the server rejecting the record's SHAPE, which no
 * amount of retrying repairs, so it is permanent — exactly as the tracker write paths treat
 * those same two error names. Anything else (a dropped Atlas connection, a replica-set
 * election) is the server having a bad moment, so the record stays retryable.
 *
 * `error.message` is NOT forwarded. On a ValidationError it reads
 * "Contact validation failed: name: Path `name` is required", which hands back the model name
 * and the schema path — the free reconnaissance the tracker routes had to stop leaking, and
 * this endpoint takes anonymous-shaped input from an offline queue, so it is the same hazard.
 * The real wording goes to the server log, where it is useful and not published.
 */
function fromThrown(clientId: string, error: unknown, context: string): ItemResult {
  const permanent = isSchemaRejection(error);
  console.error(`[contacts/sync] ${context} ${clientId} failed:`, error);
  return {
    clientId,
    ok: false,
    permanent,
    error: permanent
      ? 'The server could not accept this record as it stands.'
      : 'The server could not be reached for this record.',
  };
}

export async function POST(request: NextRequest) {
  const gate = await requireUser();
  if ('response' in gate) return gate.response;

  try {
    await connectDB();
    const body = await request.json().catch(() => ({}));

    const queuedFolders: QueuedFolder[] = Array.isArray(body.folders) ? body.folders : [];
    const queuedContacts: ContactInput[] = Array.isArray(body.contacts) ? body.contacts : [];

    if (queuedFolders.length + queuedContacts.length > MAX_ITEMS) {
      return NextResponse.json(
        { error: `Too many items in one sync (max ${MAX_ITEMS})` },
        { status: 413 }
      );
    }

    /* ── Folders first ──────────────────────────────────────────────────── */
    const folderMap: Record<string, string> = {};
    const folderResults: ItemResult[] = [];
    /**
     * clientId → was that folder's failure final?
     *
     * A contact whose folder is in this same batch inherits the folder's verdict. Without
     * this, a folder that failed on a momentary database fault would mark every person
     * belonging to it as permanently broken — punishing the contacts for a blip upstream of
     * them, which is the opposite of what the queue is for.
     */
    const folderFailures = new Map<string, boolean>();

    for (const queued of queuedFolders) {
      const clientId = typeof queued?.clientId === 'string' ? queued.clientId.trim() : '';
      const name = typeof queued?.name === 'string' ? queued.name.trim() : '';
      if (!clientId) {
        folderResults.push(refuse('(missing)', 'missing-client-id'));
        continue;
      }
      if (!name) {
        folderFailures.set(clientId, true);
        folderResults.push(refuse(clientId, 'missing-name'));
        continue;
      }

      try {
        const existing = await Folder.findOne({ userId: gate.userId, clientId });
        if (existing) {
          folderMap[clientId] = String(existing._id);
          folderResults.push({ clientId, ok: true, id: String(existing._id), duplicate: true });
          continue;
        }

        // A folder with this NAME may already exist — created online before the offline copy
        // synced. Adopt it rather than failing: the user meant one folder, not two.
        const byName = await Folder.findOne({ userId: gate.userId, slug: folderSlug(name) });
        if (byName) {
          if (!byName.clientId) {
            byName.clientId = clientId;
            await byName.save();
          }
          folderMap[clientId] = String(byName._id);
          folderResults.push({ clientId, ok: true, id: String(byName._id), duplicate: true });
          continue;
        }

        const eventDate = queued.eventDate ? new Date(queued.eventDate) : undefined;
        const created = await Folder.create({
          userId: gate.userId,
          clientId,
          name,
          venue: queued.venue,
          note: queued.note,
          eventDate: eventDate && !Number.isNaN(eventDate.getTime()) ? eventDate : undefined,
        });
        folderMap[clientId] = String(created._id);
        folderResults.push({ clientId, ok: true, id: String(created._id) });
      } catch (error) {
        const result = fromThrown(clientId, error, 'folder');
        folderFailures.set(clientId, result.permanent === true);
        folderResults.push(result);
      }
    }

    /* ── Then contacts ──────────────────────────────────────────────────── */
    const contactResults: ItemResult[] = [];
    const saved = [];
    // Folders are looked up once each rather than per contact — a hall full of scans is
    // typically one folder repeated 50 times.
    const folderCache = new Map<string, string | null>();

    for (const queued of queuedContacts) {
      const clientId = typeof queued?.clientId === 'string' ? queued.clientId.trim() : '';
      if (!clientId) {
        contactResults.push(refuse('(missing)', 'missing-client-id'));
        continue;
      }
      if (typeof queued.name !== 'string' || !queued.name.trim()) {
        contactResults.push(refuse(clientId, 'missing-name'));
        continue;
      }

      // Either a real folder id, or the clientId of a folder created in this same batch.
      const targetId =
        (queued.folderClientId && folderMap[queued.folderClientId]) || queued.folderId || '';
      if (!targetId) {
        // Its folder was in this batch and failed. Inherit that verdict rather than issuing
        // one of our own: if the folder can be retried, so can the person in it.
        if (queued.folderClientId && folderFailures.has(queued.folderClientId)) {
          const folderIsFinal = folderFailures.get(queued.folderClientId) === true;
          contactResults.push(
            folderIsFinal
              ? refuse(clientId, 'no-folder')
              : {
                  clientId,
                  ok: false,
                  permanent: false,
                  error: 'Waiting for its folder to upload first.',
                }
          );
          continue;
        }
        contactResults.push(refuse(clientId, 'no-folder'));
        continue;
      }

      try {
        if (!folderCache.has(targetId)) {
          const folder = await findOwnedFolder(gate.userId, targetId);
          folderCache.set(targetId, folder ? String(folder._id) : null);
        }
        const resolved = folderCache.get(targetId);
        if (!resolved) {
          contactResults.push(refuse(clientId, 'folder-not-found'));
          continue;
        }

        const { contact, created } = await upsertContact(gate.userId, resolved, {
          ...queued,
          clientId,
        });
        saved.push(contactToDTO(contact.toObject()));
        contactResults.push({
          clientId,
          ok: true,
          id: String(contact._id),
          duplicate: !created,
        });
      } catch (error) {
        contactResults.push(fromThrown(clientId, error, 'contact'));
      }
    }

    const all = [...folderResults, ...contactResults];
    return NextResponse.json({
      folderMap,
      folders: folderResults,
      contacts: contactResults,
      saved,
      synced: contactResults.filter(r => r.ok).length,
      failed: all.filter(r => !r.ok).length,
      /** Broken out so a client can distinguish "retry later" from "needs a human". */
      blocked: all.filter(r => !r.ok && r.permanent === true).length,
    });
  } catch (error) {
    console.error('Error syncing contacts:', error);
    // No `details`. The only thing it ever carried was the Mongoose wording this endpoint now
    // deliberately keeps server-side; the real message is in the log line above.
    return NextResponse.json({ error: 'Failed to sync' }, { status: 500 });
  }
}
