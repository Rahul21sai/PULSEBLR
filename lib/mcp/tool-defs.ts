// The tool catalogue: names, descriptions and JSON Schemas. PURE — no mongoose, no handlers.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// WHY THE DEFINITIONS ARE SPLIT FROM THE HANDLERS. `tools/list` is the only thing a client sees
// before it decides whether to call anything, so the descriptions here are the product's entire
// pitch inside Claude — and they must be assertable without a database. This module is imported by
// `tests/mcp-tools.test.ts` directly; `lib/mcp/handlers.ts` holds the half that touches Mongo.
//
// A TOOL DESCRIPTION IS A PROMPT, NOT DOCUMENTATION. The model reads it to decide which tool to
// call and with what. So each one states what the tool is FOR, what it will and will not return,
// and the two non-obvious facts about this corpus that a model cannot infer: that everything is
// Bengaluru-only, and that results are ranked by connection potential rather than by date.
//
// THE ENUMS ARE GENERATED FROM THE APP'S OWN CONSTANTS, never retyped. `MCP_CATEGORIES` comes from
// `lib/event-types.ts` and `MCP_AREAS` from the geo gazetteer, so a category added to the taxonomy
// or an area added to the gazetteer appears here with no edit. A hand-copied list here would go
// stale silently — nothing fails when a schema merely omits a valid value, the model just never
// asks for it.
//
// ── THERE ARE TWO FAMILIES NOW, AND THIS FILE OWNS THE LINE BETWEEN THEM ─────────────────────
// `PUBLIC_TOOL_DEFS` (below) needs no credential and is what v1 shipped. `PERSONAL_TOOL_DEFS`
// (`personal-tool-defs.ts`) reads one user's own records and must never appear in an unauthenticated
// `tools/list`. `toolsFor()` is the only function that decides which a caller sees, and
// `isPersonalTool()` the only one that decides whether a call needs a credential — both derived from
// set membership rather than from a naming convention, because `who_did_i_meet_at` already breaks the
// convention a `my_` prefix check would rely on.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import {
  MCP_AREAS,
  MCP_CATEGORIES,
  MCP_FORMATS,
  MCP_SORTS,
  MCP_WHEN,
  RESULT_LIMITS,
  TOPIC_LIMITS,
} from './args';
import { PERSONAL_TOOL_DEFS, PERSONAL_TOOL_NAMES } from './personal-tool-defs';

export { PERSONAL_TOOL_DEFS, PERSONAL_TOOL_NAMES };

/** JSON Schema, loose enough to be honest about what we hand-write. */
export type JsonSchema = Record<string, unknown>;

export interface McpToolDef {
  name: string;
  /** Human label for a client's tool picker. */
  title: string;
  description: string;
  inputSchema: JsonSchema;
  /**
   * Declared so a client that parses `structuredContent` knows the shape.
   *
   * Kept DELIBERATELY LOOSE — top-level keys named, nothing `required`, nested rows unconstrained.
   * A strict client validates `structuredContent` against this, and an over-specified schema turns
   * every added field into a validation failure at the client rather than an ignored extra.
   */
  outputSchema: JsonSchema;
  /**
   * Read-only, no side effects — stated so a client can auto-approve these.
   *
   * `openWorldHint` is a `boolean` rather than the literal `true` it used to be, because the two tool
   * families genuinely differ: the public tools read an open-ended external corpus that changes under
   * the caller, the authenticated ones read a closed set of the caller's own records. See
   * `personal-tool-defs.ts`.
   */
  annotations: { readOnlyHint: true; openWorldHint: boolean; idempotentHint: true };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: true, idempotentHint: true } as const;

const limitSchema = (bounds: { default: number; max: number }, what: string): JsonSchema => ({
  type: 'integer',
  minimum: 1,
  maximum: bounds.max,
  default: bounds.default,
  description: `How many ${what} to return. Defaults to ${bounds.default}, capped at ${bounds.max}. Values above the cap are clamped, not rejected.`,
});

const whenSchema: JsonSchema = {
  type: 'string',
  enum: [...MCP_WHEN],
  description:
    'A named date window, resolved in India Standard Time: today, tomorrow, weekend (the coming Sat–Sun), week (next 7 days) or month (next 31 days). Ignore this and use dateFrom/dateTo for an explicit range.',
};

const eventRowSchema: JsonSchema = {
  type: 'object',
  description:
    'One event. `url` is the canonical PulseBLR page — always send the user there rather than paraphrasing.',
};

/**
 * The tools ANY caller may see and use. No credential, no session, no per-user data.
 *
 * Renamed from `TOOL_DEFS` when the authenticated set arrived, deliberately rather than by keeping an
 * alias: "the tool defs" stopped being an unambiguous phrase the moment there were two families, and
 * a name that no longer says which set it means is how a `tools/list` ends up advertising a personal
 * tool to an anonymous caller. Every reader of this module now has to say which set it wants.
 */
export const PUBLIC_TOOL_DEFS: readonly McpToolDef[] = [
  {
    name: 'search_events',
    title: 'Search Bengaluru tech events',
    description:
      'Search upcoming software and hardware engineering events in Bengaluru, India — meetups, ' +
      'conferences, hackathons, workshops and community events. Filter by keyword, topic, ' +
      'neighbourhood, date window, online/in-person and free/paid.\n\n' +
      'Results are ranked by CONNECTION POTENTIAL by default, not by date: a deterministic 0-100 ' +
      'score for how likely someone is to leave with useful professional contacts, which rewards ' +
      'in-person events with a real venue and a company host and penalises webinars, paid-course ' +
      'funnels and certification sessions. Pass sort="soonest" if the user asked what is on next ' +
      'rather than what is worth going to.\n\n' +
      'Scope worth stating plainly: Bengaluru only, and software/hardware engineering only — ' +
      'concerts, treks and general business networking are excluded by design, so an empty result ' +
      'means "no tech events match", not "nothing is happening". Every row carries the canonical ' +
      'event URL.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          maxLength: 200,
          description:
            'Free-text search over title, organiser, venue and tags (and descriptions for terms of 4+ characters). Matches from the START of a word, so "kub" finds Kubernetes but "rust" never matches "trust".',
        },
        category: {
          type: 'array',
          items: { type: 'string', enum: [...MCP_CATEGORIES] },
          description:
            'Narrow to one or more topics or gathering kinds. The first nine values are what an event is ABOUT; the rest are what KIND of gathering it is, and the two are independent — a Kubernetes meetup is both Cloud/DevOps and Meetup.',
        },
        area: {
          type: 'array',
          items: { type: 'string', enum: [...MCP_AREAS] },
          description:
            'Bengaluru neighbourhoods. Use events_near instead when the question is about commute — this filter does not imply in-person.',
        },
        when: whenSchema,
        dateFrom: {
          type: 'string',
          description:
            'Earliest start, as YYYY-MM-DD (interpreted as IST midnight) or a full ISO timestamp.',
        },
        dateTo: {
          type: 'string',
          description:
            'Latest start, as YYYY-MM-DD (INCLUSIVE of that whole IST day) or a full ISO timestamp.',
        },
        format: {
          type: 'string',
          enum: [...MCP_FORMATS],
          description: 'offline is in-person, hybrid is both.',
        },
        free: {
          type: 'boolean',
          description: 'true for free events only, false for paid only. Omit for both.',
        },
        sort: {
          type: 'string',
          enum: [...MCP_SORTS],
          description:
            'connections (default) ranks by connection potential; soonest is chronological; popular uses attendee counts where a source published them; newest is most recently added; relevance applies to a multi-word query. Defaults to relevance when `query` is set.',
        },
        limit: limitSchema(RESULT_LIMITS, 'events'),
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        events: { type: 'array', items: eventRowSchema },
        returned: { type: 'integer' },
        totalMatching: { type: 'integer' },
        sort: { type: 'string' },
        filters: { type: 'object' },
      },
    },
    annotations: READ_ONLY,
  },

  {
    name: 'get_event',
    title: 'Get one Bengaluru event in full',
    description:
      'Full detail for a single event: description, exact venue and address, price, capacity, ' +
      'registration deadline, registration link, attributed companies and the platforms it was ' +
      'found on. Takes the event `id` from a search result (a full PulseBLR event URL is also ' +
      'accepted) or a `slug`.\n\n' +
      'Unlike search, this will also return an event that has already happened and one outside the ' +
      'engineering scope, because the caller already has its identifier. It returns "not found" ' +
      'for anything that is not a public event.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description:
            'The 24-character event id from a search result, or a full PulseBLR event URL ending in one.',
        },
        slug: { type: 'string', description: 'The event slug, if you have one instead of an id.' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { event: eventRowSchema } },
    annotations: READ_ONLY,
  },

  {
    name: 'events_near',
    title: 'Events in a Bengaluru neighbourhood',
    description:
      'Upcoming engineering events in one or more named Bengaluru areas, ranked by connection ' +
      'potential. This is the right tool when the constraint is COMMUTE rather than topic — in a ' +
      'city where a 12 km cross-town trip on a weeknight is an hour each way, the neighbourhood ' +
      'decides attendance more often than the subject does.\n\n' +
      'Online events are excluded structurally: an area is resolved from the venue and address, so ' +
      'an event with no physical location has none. Hybrid events ARE included, because there is a ' +
      'room you can go to. Call it with no arguments once to see the list of valid areas in the ' +
      'error message, or read the enum in this schema.',
    inputSchema: {
      type: 'object',
      properties: {
        area: {
          type: 'array',
          items: { type: 'string', enum: [...MCP_AREAS] },
          description:
            'One or more Bengaluru areas. Pass several when the user could reasonably reach any of them — Koramangala, HSR Layout and Indiranagar are neighbours; Whitefield and Rajajinagar are opposite ends of the city.',
        },
        when: whenSchema,
        limit: limitSchema(RESULT_LIMITS, 'events'),
      },
      required: ['area'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        areas: { type: 'array', items: { type: 'string' } },
        events: { type: 'array', items: eventRowSchema },
        returned: { type: 'integer' },
        totalMatching: { type: 'integer' },
      },
    },
    annotations: READ_ONLY,
  },

  {
    name: 'trending_topics',
    title: 'What Bengaluru engineering events are about right now',
    description:
      'What the upcoming Bengaluru engineering calendar is actually about, counted from the ' +
      'categories stored on every event. Use it to orient before searching — to answer "what is ' +
      'the scene like at the moment", to pick a sensible `category` for search_events, or to tell ' +
      'a saturated topic from a thin one.\n\n' +
      'These are MEASURED COUNTS over real upcoming events, not editorial picks or a popularity ' +
      'ranking. An event carries several categories, so the counts sum to more than the number of ' +
      'events. Defaults to the next month.',
    inputSchema: {
      type: 'object',
      properties: {
        when: whenSchema,
        limit: limitSchema(TOPIC_LIMITS, 'topics'),
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string' },
        totalEvents: { type: 'integer' },
        topics: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              events: { type: 'integer' },
              shareOfUpcoming: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
    annotations: READ_ONLY,
  },
] as const;

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE PARTITION — which tools a given caller may see
   ══════════════════════════════════════════════════════════════════════════════════════════ */

export const PUBLIC_TOOL_NAMES: readonly string[] = PUBLIC_TOOL_DEFS.map(t => t.name);

/** Every tool that exists, in listing order: public first, then the authenticated ones. */
export const ALL_TOOL_DEFS: readonly McpToolDef[] = [...PUBLIC_TOOL_DEFS, ...PERSONAL_TOOL_DEFS];

/**
 * Does this tool return data belonging to one user?
 *
 * DERIVED FROM THE PERSONAL SET, NEVER FROM THE NAME. The obvious alternative — a
 * `name.startsWith('my_')` test — would be a rule the next tool breaks: `who_did_i_meet_at` already
 * does not start with `my_`, and a `follow_ups_owed` or `contacts_at` would not either. Membership of
 * a list is checkable; a naming convention is a hope. `tests/mcp-auth.test.ts` asserts the two sets
 * are disjoint and that their union is everything, which is what makes "personal" total rather than
 * best-effort.
 */
export function isPersonalTool(name: string): boolean {
  return PERSONAL_TOOL_NAMES.includes(name);
}

/**
 * The tools to advertise to a caller.
 *
 * The parameter is `hasIdentity: boolean` rather than the identity itself, so this module stays PURE
 * and knows nothing about tokens — and so the one decision it makes is impossible to get subtly wrong
 * by reading the wrong field off an identity object.
 *
 * FALSE IS THE SAFE DEFAULT AND IT IS THE DEFAULT. A call site that forgets the argument advertises
 * the public four, which loses a feature; the opposite default would leak the existence and schema of
 * the personal tools to every anonymous caller and, worse, invite a client to call them. Compare
 * `buildEventFilter`, whose viewer is REQUIRED and positional precisely because ITS safe direction is
 * the one an omission does not give you — an absent viewer there would have to mean "no restriction".
 * Same principle, opposite mechanics: make the omission harmless where you can, and impossible where
 * you cannot.
 */
export function toolsFor(hasIdentity = false): readonly McpToolDef[] {
  return hasIdentity ? ALL_TOOL_DEFS : PUBLIC_TOOL_DEFS;
}

/**
 * Find a tool by name across BOTH sets.
 *
 * Deliberately identity-blind: `dispatch` needs to tell "no such tool" (`-32602`) apart from "that
 * tool needs a credential" (`-32001`), and collapsing them into "unknown tool" for an anonymous
 * caller would answer a client whose token has just been revoked with a lie about the server's
 * capabilities. The existence of these tools is public — they are documented on `/mcp` and named in
 * this file — so hiding it buys nothing and costs a debuggable error message.
 */
export function findToolDef(name: string): McpToolDef | undefined {
  return ALL_TOOL_DEFS.find(t => t.name === name);
}
