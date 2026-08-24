import { NextRequest, NextResponse } from 'next/server';
import connectDB from '@/lib/mongodb';
import Folder, { folderSlug } from '@/lib/models/Folder';
import { requireUser } from '@/lib/api-auth';
import { contactToDTO, findOwnedFolder, upsertContact } from '@/lib/contacts/service';
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

    for (const queued of queuedFolders) {
      const clientId = typeof queued?.clientId === 'string' ? queued.clientId.trim() : '';
      const name = typeof queued?.name === 'string' ? queued.name.trim() : '';
      if (!clientId || !name) {
        folderResults.push({ clientId: clientId || '(missing)', ok: false, error: 'clientId and name are required' });
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
        folderResults.push({
          clientId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
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
        contactResults.push({ clientId: '(missing)', ok: false, error: 'clientId is required' });
        continue;
      }
      if (typeof queued.name !== 'string' || !queued.name.trim()) {
        contactResults.push({ clientId, ok: false, error: 'A name is required' });
        continue;
      }

      // Either a real folder id, or the clientId of a folder created in this same batch.
      const targetId =
        (queued.folderClientId && folderMap[queued.folderClientId]) || queued.folderId || '';
      if (!targetId) {
        contactResults.push({ clientId, ok: false, error: 'No folder for this contact' });
        continue;
      }

      try {
        if (!folderCache.has(targetId)) {
          const folder = await findOwnedFolder(gate.userId, targetId);
          folderCache.set(targetId, folder ? String(folder._id) : null);
        }
        const resolved = folderCache.get(targetId);
        if (!resolved) {
          contactResults.push({ clientId, ok: false, error: 'Folder not found' });
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
        contactResults.push({
          clientId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const failed = [...folderResults, ...contactResults].filter(r => !r.ok).length;
    return NextResponse.json({
      folderMap,
      folders: folderResults,
      contacts: contactResults,
      saved,
      synced: contactResults.filter(r => r.ok).length,
      failed,
    });
  } catch (error) {
    console.error('Error syncing contacts:', error);
    return NextResponse.json(
      {
        error: 'Failed to sync',
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    );
  }
}
