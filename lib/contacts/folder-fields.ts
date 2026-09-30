import type { FieldVocabulary } from '@/lib/http/errors';

/**
 * What a folder create or edit can be refused on, in the caller's words (see lib/http/errors.ts).
 *
 * `slug` is derived from `name` by Folder's `pre('validate')` hook, so a refusal of it is the name's.
 * `archivedAt` is what the `archived` flag writes. Everything else on a Folder (`userId`, `clientId`,
 * `intakeToken`) is the server's and is never named to a caller.
 *
 * Shared by `POST /api/folders` and `PATCH /api/folders/[id]`, and it lives HERE rather than in
 * either route for two rules CLAUDE.md records: a route file may export only HTTP methods and segment
 * config (`next build` refuses anything else, `tsc` does not notice), and a route module must never
 * import another route module.
 */
export const FOLDER_FIELDS: FieldVocabulary = {
  rename: { slug: 'name', archivedAt: 'archived' },
  fields: ['name', 'note', 'venue', 'eventDate', 'eventId', 'archived'],
};
