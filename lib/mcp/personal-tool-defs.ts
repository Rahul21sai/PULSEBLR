// The FOUR AUTHENTICATED tools: names, descriptions, schemas. PURE — no mongoose, no handlers.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THIS IS THE HALF OF THE PRODUCT NOBODY ELSE CAN COPY, so the descriptions say so in the terms a
// model needs. The events half is a commodity — a competitor gives aggregated Luma and Meetup
// listings away on a free tier, and CLAUDE.md records that `events.heapheaphurray.com` is a different
// SELECTION over the same supply rather than new supply. What is not a commodity is the record of who
// the user has actually met, because it exists only because they captured it. "Who do I know at
// Razorpay?", answered inside the assistant, has no substitute.
//
// ── WHY THESE ARE A SEPARATE MODULE FROM `tool-defs.ts` ──────────────────────────────────────
// Because the partition has to be visible to a reader, not merely true. `tool-defs.ts` composes the
// two sets and owns `toolsFor(identity)`; this file holds the ones that MUST NOT be listed to an
// anonymous caller. A reviewer asking "which tools need a credential" gets a file, not a grep.
//
// ── EVERY TOOL HERE IS `openWorldHint: false`, AND THE PUBLIC FOUR ARE `true` ─────────────────
// Not cosmetic. `openWorldHint` tells a client whether the tool reaches into an open-ended external
// domain (the whole Bengaluru event corpus, which changes under you) or a closed one (this user's own
// records, which change only when they change them). A client uses it to decide how freely to
// auto-approve and re-call. These are closed-domain reads of the caller's own data.
//
// ── NO TOOL HERE TAKES AN IDENTIFIER THAT SELECTS A PERSON'S DATA ────────────────────────────
// Not a user id, not an email, not a token, not an "as". Every schema below is `additionalProperties:
// false`, so a client cannot even smuggle one in and hope. Scoping comes from the verified token and
// is threaded as a required positional argument; a tool that accepted `userId` would be an
// authorisation bug with a schema blessing it.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  FOLLOW_UP_HORIZON,
  MCP_TRACKER_STATUSES,
  MY_PEOPLE_SORTS,
  PERSONAL_LIMITS,
} from './personal-args';
import { MCP_WHEN } from './args';
import type { JsonSchema, McpToolDef } from './tool-defs';

/** Closed-domain, read-only, safe to repeat. See the module header for `openWorldHint`. */
const PERSONAL_READ_ONLY = {
  readOnlyHint: true,
  openWorldHint: false,
  idempotentHint: true,
} as const;

const limitSchema = (what: string): JsonSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: PERSONAL_LIMITS.max,
  default: PERSONAL_LIMITS.default,
  description: `How many ${what} to return. Defaults to ${PERSONAL_LIMITS.default}, capped at ${PERSONAL_LIMITS.max}. Values above the cap are clamped, not rejected.`,
});

/**
 * The sentence every one of these descriptions carries.
 *
 * A model that does not know the data is scoped to the signed-in account will hedge — it will ask the
 * user which account, or caveat the answer. Saying it once per tool removes that, and saying it in the
 * same words each time means a client showing several tools side by side does not read as four
 * different privacy stories.
 */
const SCOPE_NOTE =
  'Returns ONLY the data belonging to the account whose PulseBLR access token is configured in this ' +
  'client. There is no argument that can select another account. Nothing here is public, and none of ' +
  'it came from scraping — it exists because this person recorded it.';

export const PERSONAL_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'my_people',
    title: 'People I have met',
    description:
      'Search the people this PulseBLR user has actually met and recorded — everyone captured by ' +
      'scanning a QR code at an event, added by hand, or self-registered at one of their folders. ' +
      'THIS IS THE TOOL FOR "who do I know at <company>", "who have I met who works on <topic>", ' +
      '"have I met this person before".\n\n' +
      'One row per HUMAN, not per capture: somebody met at three events is one person with ' +
      '`eventCount: 3`, because identity is keyed on their LinkedIn slug, email or phone rather than ' +
      'on a name that two people can share. Rows carry the company the registry could attribute, the ' +
      "user's own free-text tags, when they last interacted, and when a follow-up is due.\n\n" +
      'Two kinds of label exist and they are NOT interchangeable: `companies` is resolved against a ' +
      'registry of Bengaluru employers, so a name being there means it was justified; `tags` are typed ' +
      'by the user, for the long tail no registry covers. Filter on `company` for the former and `tag` ' +
      'for the latter.\n\n' +
      SCOPE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 200,
          description:
            "Free-text search over the person's name, company, role and headline. Matches anywhere in the value, so partial words work.",
        },
        company: {
          type: 'string',
          maxLength: 200,
          description:
            'One employer, matched case-insensitively against the companies this user actually has people at. If nothing matches, the result names the companies that DO have people, so you can retry with a real one rather than concluding they know nobody.',
        },
        tag: {
          type: 'string',
          maxLength: 200,
          description:
            "One of the user's own tags. Lower-cased and whitespace-collapsed before matching, so \"AI/ML\" and \"ai/ml\" are one tag.",
        },
        targetOnly: {
          type: 'boolean',
          description:
            'true to return only people at a company on this user\'s target list — the employers they are actively trying to reach.',
        },
        followUpDue: {
          type: 'boolean',
          description:
            'true to return only people with a follow-up date set and not yet marked done. Use my_follow_ups instead when the question is "what have I dropped" — that one is ordered by deadline and says how overdue each is.',
        },
        repeatOnly: {
          type: 'boolean',
          description:
            'true to return only people met at two or more DISTINCT events. These are the warm contacts — a second meeting is the strongest signal in this dataset.',
        },
        sort: {
          type: 'string',
          enum: [...MY_PEOPLE_SORTS],
          description:
            'recent (default) is by last interaction; met is by how many events you have met at, highest first; followUp is by deadline and should be paired with followUpDue; name, company and oldest are self-explanatory.',
        },
        limit: limitSchema('people'),
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        people: { type: 'array', items: { type: 'object' } },
        returned: { type: 'integer' },
        totalMatching: { type: 'integer' },
        filters: { type: 'object' },
      },
    },
    annotations: PERSONAL_READ_ONLY,
  },

  {
    name: 'who_did_i_meet_at',
    title: 'Who I met at one event',
    description:
      'The people this user captured at one specific event, looked up by the event or folder name — ' +
      '"who did I meet at IndiaFOSS", "who was I introduced to at the Razorpay evening".\n\n' +
      'Matching is a partial, case-insensitive match on the names of the folders this user has, so ' +
      '"fossunited" or "foss" will find "IndiaFOSS 2026". A folder is created for an event when the ' +
      'user moves it to Confirmed or Attended on their tracker, or by hand when they scan somebody at ' +
      'something the event corpus has never heard of — which is most of the interesting ones.\n\n' +
      'Each row carries how they met (a free-text note the user wrote at the time), the role and ' +
      'company where known, a LinkedIn URL where a QR supplied one, and whether a follow-up is still ' +
      'outstanding. If no folder matches, the result lists the folder names that exist rather than ' +
      'claiming the user met nobody.\n\n' +
      SCOPE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        event: {
          type: 'string',
          maxLength: 200,
          description:
            'The event or folder name, or any distinctive part of it. Case-insensitive and partial.',
        },
        limit: limitSchema('people'),
      },
      required: ['event'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        folders: { type: 'array', items: { type: 'object' } },
        people: { type: 'array', items: { type: 'object' } },
        returned: { type: 'integer' },
      },
    },
    annotations: PERSONAL_READ_ONLY,
  },

  {
    name: 'my_follow_ups',
    title: 'Follow-ups I owe people',
    description:
      'The follow-ups this user has set and not yet completed, soonest deadline first, each marked ' +
      'overdue or not. This is the "what have I dropped" tool.\n\n' +
      `By default it returns ONLY what is already overdue (\`includeUpcomingDays: ${FOLLOW_UP_HORIZON.default}\`), because that is the ` +
      'honest answer to that question. Pass a day count to also see what is coming — 3 is what the ' +
      'daily email digest uses, 7 for a weekly review.\n\n' +
      'Each row names the person, the event they were met at, and the note the user wrote about how ' +
      'they met — which is what makes a follow-up message writable rather than generic. Empty is a ' +
      'GOOD result here and should be reported as such: it means nothing is outstanding, not that the ' +
      'lookup failed.\n\n' +
      SCOPE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        includeUpcomingDays: {
          type: 'integer',
          minimum: 0,
          maximum: FOLLOW_UP_HORIZON.max,
          default: FOLLOW_UP_HORIZON.default,
          description: `How many days ahead to include as well as the overdue ones. 0 (the default) is overdue only. Capped at ${FOLLOW_UP_HORIZON.max}.`,
        },
        limit: limitSchema('follow-ups'),
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        followUps: { type: 'array', items: { type: 'object' } },
        returned: { type: 'integer' },
        overdue: { type: 'integer' },
        horizonDays: { type: 'integer' },
      },
    },
    annotations: PERSONAL_READ_ONLY,
  },

  {
    name: 'my_saved_events',
    title: 'Events I have saved or applied to',
    description:
      "This user's own event tracker — the events they saved, applied to, were shortlisted for, " +
      'confirmed or attended, with their private notes on each. Use it for "what am I going to this ' +
      'week", "what did I apply to", "what is on my list".\n\n' +
      'It is a kanban board, so `status` is the useful filter: ' +
      `${MCP_TRACKER_STATUSES.join(', ')}. Confirmed and Attended are the two that also create a ` +
      'folder for capturing people, so an event in either is one where who_did_i_meet_at may have ' +
      'something.\n\n' +
      'Upcoming only unless `includePast` is set, and each row carries the full event detail — venue, ' +
      'time in IST, price, and the canonical PulseBLR URL to send the user to. A saved event the user ' +
      'typed in themselves is included and marked, because those are the ones no public search can ' +
      'find.\n\n' +
      SCOPE_NOTE,
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'array',
          items: { type: 'string', enum: [...MCP_TRACKER_STATUSES] },
          description:
            'One or more board columns. Omit for every status. New and Interested are the saved-for-later end; Confirmed and Attended are the committed end.',
        },
        when: {
          type: 'string',
          enum: [...MCP_WHEN],
          description:
            'Narrow to a named date window, resolved in India Standard Time: today, tomorrow, weekend (the coming Sat-Sun), week (next 7 days) or month (next 31 days).',
        },
        includePast: {
          type: 'boolean',
          default: false,
          description:
            'true to include events that have already happened — needed for "what did I attend last month". Defaults to false.',
        },
        limit: limitSchema('saved events'),
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        saved: { type: 'array', items: { type: 'object' } },
        returned: { type: 'integer' },
        totalMatching: { type: 'integer' },
        byStatus: { type: 'object' },
      },
    },
    annotations: PERSONAL_READ_ONLY,
  },
] as const;

export const PERSONAL_TOOL_NAMES: readonly string[] = PERSONAL_TOOL_DEFS.map(t => t.name);
