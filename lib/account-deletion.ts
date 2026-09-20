import type { ClientSession } from 'mongoose';
import connectDB from './mongodb';
import { canonicalOrigin } from './canonical-origin';
import AuditLog from './models/AuditLog';
import Contact from './models/Contact';
import DigestLog from './models/DigestLog';
import Event from './models/Event';
import Folder from './models/Folder';
import Interaction from './models/Interaction';
import McpToken from './models/McpToken';
import Person from './models/Person';
import PushSubscription from './models/PushSubscription';
import ReminderLog from './models/ReminderLog';
import TrackerEntry from './models/TrackerEntry';
import User from './models/User';

export const ACCOUNT_DELETION_CONFIRMATION = 'DELETE' as const;
export const DELETED_ACTOR_ID = 'deleted-account';
export const DELETED_ACTOR_EMAIL = 'deleted-account@redacted.invalid';

export type OwnedDeletionKind =
  | 'trackerEntries' | 'folders' | 'contacts' | 'people' | 'interactions'
  | 'mcpTokens' | 'pushSubscriptions' | 'reminderLogs' | 'digestLogs';

export type AccountDeletionCounts = Record<OwnedDeletionKind, number> & {
  events: number;
  eventAuditSnapshots: number;
  actorAuditRowsRedacted: number;
  users: number;
};

export interface AccountDeletionTransaction {
  findOwnedEventIds(userId: string): Promise<string[]>;
  deleteOwned(kind: OwnedDeletionKind, userId: string): Promise<number>;
  deleteOwnedEvents(userId: string): Promise<number>;
  deleteEventAuditSnapshots(eventIds: string[]): Promise<number>;
  redactActorAuditRows(userId: string): Promise<number>;
  deleteUser(userId: string): Promise<number>;
}

export interface AccountDeletionStore {
  runInTransaction<T>(work: (tx: AccountDeletionTransaction) => Promise<T>): Promise<T>;
}

export class AccountDeletionUnavailableError extends Error {
  constructor(cause: unknown) {
    super('Account deletion is temporarily unavailable', { cause });
    this.name = 'AccountDeletionUnavailableError';
  }
}

export function parseAccountDeletionConfirmation(body: unknown) {
  return typeof body === 'object' && body !== null &&
    (body as { confirmation?: unknown }).confirmation === ACCOUNT_DELETION_CONFIRMATION
    ? ({ ok: true } as const)
    : ({ ok: false, error: `Type ${ACCOUNT_DELETION_CONFIRMATION} to confirm account deletion.` } as const);
}

export function hasExactCanonicalOrigin(origin: string | null, expectedOrigin = canonicalOrigin()) {
  return origin === expectedOrigin;
}

const ownedKinds: OwnedDeletionKind[] = [
  'trackerEntries', 'folders', 'contacts', 'people', 'interactions',
  'mcpTokens', 'pushSubscriptions', 'reminderLogs', 'digestLogs',
];

export async function deleteAccountData(userId: string, store: AccountDeletionStore = mongooseDeletionStore()) {
  return store.runInTransaction(async tx => {
    const eventIds = await tx.findOwnedEventIds(userId);
    const counts = Object.fromEntries(ownedKinds.map(kind => [kind, 0])) as AccountDeletionCounts;
    counts.eventAuditSnapshots = await tx.deleteEventAuditSnapshots(eventIds);
    counts.actorAuditRowsRedacted = await tx.redactActorAuditRows(userId);
    for (const kind of ownedKinds) counts[kind] = await tx.deleteOwned(kind, userId);
    counts.events = await tx.deleteOwnedEvents(userId);
    counts.users = await tx.deleteUser(userId);
    return counts;
  });
}

function deletionCount(result: { deletedCount?: number | null }): number {
  return result.deletedCount ?? 0;
}

function mongooseTransaction(session: ClientSession): AccountDeletionTransaction {
  return {
    async findOwnedEventIds(userId) {
      const rows = await Event.find({ createdByUserId: userId }).select('_id').session(session).lean();
      return rows.map(row => String(row._id));
    },
    async deleteOwned(kind, userId) {
      switch (kind) {
        case 'trackerEntries': return deletionCount(await TrackerEntry.deleteMany({ userId }, { session }));
        case 'folders': return deletionCount(await Folder.deleteMany({ userId }, { session }));
        case 'contacts': return deletionCount(await Contact.deleteMany({ userId }, { session }));
        case 'people': return deletionCount(await Person.deleteMany({ userId }, { session }));
        case 'interactions': return deletionCount(await Interaction.deleteMany({ userId }, { session }));
        case 'mcpTokens': return deletionCount(await McpToken.deleteMany({ userId }, { session }));
        case 'pushSubscriptions': return deletionCount(await PushSubscription.deleteMany({ userId }, { session }));
        case 'reminderLogs': return deletionCount(await ReminderLog.deleteMany({ userId }, { session }));
        case 'digestLogs': return deletionCount(await DigestLog.deleteMany({ userId }, { session }));
      }
    },
    async deleteOwnedEvents(userId) {
      return deletionCount(await Event.deleteMany({ createdByUserId: userId }, { session }));
    },
    async deleteEventAuditSnapshots(eventIds) {
      if (eventIds.length === 0) return 0;
      return deletionCount(await AuditLog.deleteMany({
        targetType: 'event',
        $or: [{ targetId: { $in: eventIds } }, { targetIds: { $in: eventIds } }],
      }, { session }));
    },
    async redactActorAuditRows(userId) {
      const result = await AuditLog.updateMany(
        { $or: [{ actorId: userId }, { undoneBy: userId }] },
        [{
          $set: {
            actorId: { $cond: [{ $eq: ['$actorId', userId] }, DELETED_ACTOR_ID, '$actorId'] },
            actorEmail: { $cond: [{ $eq: ['$actorId', userId] }, DELETED_ACTOR_EMAIL, '$actorEmail'] },
            undoneBy: { $cond: [{ $eq: ['$undoneBy', userId] }, DELETED_ACTOR_ID, '$undoneBy'] },
          },
        }],
        { session },
      );
      return result.modifiedCount ?? 0;
    },
    async deleteUser(userId) {
      return deletionCount(await User.deleteMany({ googleId: userId }, { session }));
    },
  };
}

function mongooseDeletionStore(): AccountDeletionStore {
  return {
    async runInTransaction<T>(work: (tx: AccountDeletionTransaction) => Promise<T>): Promise<T> {
      let session: ClientSession | undefined;
      try {
        const db = await connectDB();
        session = await db.startSession();
        let value: T | undefined;
        await session.withTransaction(async () => {
          value = await work(mongooseTransaction(session));
        });
        if (value === undefined) throw new Error('Deletion transaction produced no result');
        return value;
      } catch (error) {
        throw new AccountDeletionUnavailableError(error);
      } finally {
        if (session) await session.endSession();
      }
    },
  };
}
