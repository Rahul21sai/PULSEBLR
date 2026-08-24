/**
 * The CLIENT-side shapes for folders and contacts.
 *
 * Separate from the Mongoose interfaces for the reason `lib/event-types.ts` documents:
 * dates arrive over JSON as ISO **strings**, not `Date`. Typing them `Date` compiles fine
 * and then every `.getTime()` throws at runtime. This file also has no mongoose import, so
 * client components can import it freely.
 *
 * Keep in sync with `lib/models/Folder.ts` and `lib/models/Contact.ts`.
 */
import type { CapturedVia } from '../scan/types';

export type { CapturedVia };

export interface FolderDTO {
  _id: string;
  name: string;
  slug: string;
  eventId?: string | null;
  eventDate?: string | null;
  venue?: string | null;
  note?: string | null;
  intakeEnabled: boolean;
  /** Present only when intake is on — it is a capability, so it is not sent otherwise. */
  intakeToken?: string | null;
  intakeExpiresAt?: string | null;
  archivedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Denormalised for the folder list. Server-computed. */
  contactCount?: number;
  /** How many contacts in this folder still need a follow-up. Server-computed. */
  pendingFollowUps?: number;
}

export interface ContactDTO {
  _id: string;
  folderId: string;
  clientId: string;
  name: string;
  headline?: string | null;
  role?: string | null;
  company?: string | null;
  linkedin?: string | null;
  linkedinSlug?: string | null;
  x?: string | null;
  github?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  note?: string | null;
  /** The literal decoded QR string, kept verbatim and never overwritten. */
  rawPayload?: string | null;
  tags: string[];
  followUpAt?: string | null;
  followedUp: boolean;
  capturedVia: CapturedVia;
  scannedAt: string;
  contactKey: string;
  companies: string[];
  isTargetCompany: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Set by the client only, never stored: this row is in the offline outbox and has not
   * reached the server yet. Lets the table show it with an "unsynced" marker instead of
   * pretending it is saved.
   */
  pending?: boolean;
}

/** The editable fields a capture card or the table's inline editor may write. */
export interface ContactInput {
  clientId: string;
  folderId?: string;
  /** Set instead of `folderId` when the folder itself was created offline. */
  folderClientId?: string;
  name: string;
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
  followUpAt?: string | null;
  followedUp?: boolean;
  capturedVia?: CapturedVia;
  rawPayload?: string;
  scannedAt?: string;
}

/** The per-user shareable card, as the owner sees it. */
export interface MyCardDTO {
  displayName?: string | null;
  headline?: string | null;
  company?: string | null;
  role?: string | null;
  linkedin?: string | null;
  x?: string | null;
  github?: string | null;
  website?: string | null;
  email?: string | null;
  phone?: string | null;
  revealPhone: boolean;
  enabled: boolean;
  /** Absolute URL the QR encodes. Built server-side from NEXTAUTH_URL. */
  url?: string | null;
}

/** What an anonymous visitor to `/c/<token>` is allowed to see. */
export interface PublicCardDTO {
  displayName: string;
  headline?: string | null;
  company?: string | null;
  role?: string | null;
  linkedin?: string | null;
  x?: string | null;
  github?: string | null;
  website?: string | null;
  email?: string | null;
  /** Only present when the owner turned `revealPhone` on. */
  phone?: string | null;
}
