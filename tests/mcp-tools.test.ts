import { describe, it, expect } from 'vitest';

import {
  JSON_RPC_ERRORS,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateProtocolVersion,
  parseIncoming,
} from '@/lib/mcp/protocol';
import {
  SERVER_INFO,
  dispatch,
  handleMcpPayload,
  type ToolOutcome,
  type ToolRunner,
} from '@/lib/mcp/server';
import { TOOL_DEFS, TOOL_NAMES, findToolDef } from '@/lib/mcp/tool-defs';
import {
  MCP_AREAS,
  MCP_CATEGORIES,
  RESULT_LIMITS,
  TOPIC_LIMITS,
  parseEventsNearArgs,
  parseGetEventArgs,
  parseSearchEventsArgs,
  parseTrendingTopicsArgs,
} from '@/lib/mcp/args';
import {
  planEventsNear,
  planGetEvent,
  planSearchEvents,
  planTrendingTopics,
} from '@/lib/mcp/query-plan';
import { buildEventUrl, toMcpEventDetail, toMcpEventRow } from '@/lib/mcp/serialize';
import { visibilityClause } from '@/lib/events/query';
import { OTHER_CATEGORY_NAMES } from '@/lib/event-types';

/**
 * The MCP server, tested where it can be tested honestly: as pure functions.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE IS FOR, AND WHY IT IS NOT A SET OF SMOKE TESTS. Three properties of this server
 * cannot be verified by reading a response from a running instance, because a correct-looking
 * response is exactly what all three failures produce:
 *
 *   1. PRIVATE EVENTS. A leak here shows up only if the test database happens to contain another
 *      user's private event AND it happens to match the filter. `lib/mcp/query-plan.ts` is pure and
 *      returns the filter itself, so the exclusion is asserted structurally instead — every plan is
 *      checked for both public visibility arms and for the ABSENCE of any owner arm. This is the
 *      section to read first if you are changing anything in `lib/mcp/`.
 *   2. NOSQL OPERATOR INJECTION. `{"slug": {"$ne": null}}` against a live server returns an event,
 *      which looks like the tool working. The only way to see the defect is to assert that the
 *      argument layer refuses a non-scalar before it can reach Mongo.
 *   3. THE IST DATE BOUNDARY. A bare `YYYY-MM-DD` parsed as UTC is half a day out, and every
 *      developer machine here is set to IST, so it passes by accident locally and is wrong on the
 *      server. Asserted against an explicit instant.
 *
 * The JSON-RPC surface is driven through `dispatch()` with a STUB tool runner, which is why
 * `lib/mcp/server.ts` takes the runner as a parameter rather than importing it — no database, no
 * server, no network, per `vitest.config.mts`'s scope.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────── helpers ────────────────────────────── */

/** Pull the visibility clause out of a built filter, wherever in `$and` it sits. */
function visibilityArms(filter: Record<string, unknown>): Array<Record<string, unknown>> {
  const and = (filter.$and ?? []) as Array<Record<string, unknown>>;
  for (const clause of and) {
    const arms = (clause.$or ?? []) as Array<Record<string, unknown>>;
    if (arms.some(arm => 'visibility' in arm)) return arms;
    // `planGetEvent` nests the whole filter one level deeper, so recurse.
    if (Array.isArray(clause.$and)) {
      const nested = visibilityArms(clause);
      if (nested.length > 0) return nested;
    }
  }
  return [];
}

/** Every key mentioned anywhere in a filter, at any depth. Used for absence assertions. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) allKeys(item, into);
    return into;
  }
  if (value && typeof value === 'object' && !(value instanceof RegExp) && !(value instanceof Date)) {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      into.add(key);
      allKeys(nested, into);
    }
  }
  return into;
}

function okSearch(raw: unknown) {
  const parsed = parseSearchEventsArgs(raw);
  if (!parsed.ok) throw new Error(`expected valid args, got: ${parsed.issues.join(' ')}`);
  return parsed.value;
}

const stubRunner: ToolRunner = async (name, args) => ({
  result: { content: [{ type: 'text', text: `ran ${name}` }], structuredContent: { args } },
});

function request(method: string, params?: unknown, id: string | number = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   1. PRIVATE-EVENT EXCLUSION — the property that matters most
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('every query excludes other users’ private and pending events', () => {
  /**
   * The three arms of `visibilityClause` are load-bearing in BOTH directions and this pins both:
   * the two public arms must be present (omitting `{$exists: false}` does not narrow the feed, it
   * EMPTIES it — ~1500 documents predate the field), and the owner arm must be absent (an
   * unauthenticated server has no owner to name, so its presence would mean a viewer id leaked in).
   */
  const plans: Array<[string, Record<string, unknown>]> = [
    ['search_events', planSearchEvents(okSearch({})).filter],
    ['events_near', planEventsNear({ area: ['Koramangala'], limit: 10 }).filter],
    ['trending_topics', planTrendingTopics({ limit: 12 }).filter],
    ['get_event', planGetEvent({ id: '68b1c0ffee0000000000dead' }).filter],
  ];

  for (const [name, filter] of plans) {
    it(`${name}: carries BOTH public visibility arms`, () => {
      const arms = visibilityArms(filter);
      expect(arms).toHaveLength(2);
      expect(arms).toEqual(
        expect.arrayContaining([{ visibility: 'public' }, { visibility: { $exists: false } }])
      );
    });

    it(`${name}: carries NO createdByUserId arm anywhere in the filter`, () => {
      expect(allKeys(filter).has('createdByUserId')).toBe(false);
    });
  }

  it('matches exactly what visibilityClause(null) produces — no local copy of the predicate', () => {
    // If someone hand-rolls a $match in lib/mcp, this is what stops it passing: the arms must be
    // byte-identical to the shared builder's, not merely similar.
    const anonymous = visibilityClause(null) as { $or: Array<Record<string, unknown>> };
    expect(visibilityArms(planSearchEvents(okSearch({})).filter)).toEqual(anonymous.$or);
  });

  it('a signed-in viewer WOULD get a third arm — proving the assertion above can fail', () => {
    // A control. Without it, "two arms" could be true because the clause is broken rather than
    // because the viewer is anonymous.
    const signedIn = visibilityClause('google-sub-123') as { $or: Array<Record<string, unknown>> };
    expect(signedIn.$or).toHaveLength(3);
    expect(signedIn.$or).toEqual(
      expect.arrayContaining([{ createdByUserId: 'google-sub-123' }])
    );
  });
});

describe('every discovery query is scoped to Bengaluru tech events', () => {
  it('search, events_near and trending_topics all pin isTechEvent', () => {
    expect(planSearchEvents(okSearch({})).filter.isTechEvent).toBe(true);
    expect(planEventsNear({ area: ['Whitefield'], limit: 5 }).filter.isTechEvent).toBe(true);
    expect(planTrendingTopics({ limit: 5 }).filter.isTechEvent).toBe(true);
  });

  it('get_event deliberately does NOT, because the caller already has the id', () => {
    const filter = planGetEvent({ slug: 'some-event' }).filter;
    expect(allKeys(filter).has('isTechEvent')).toBe(false);
  });

  it('the category enum omits the non-tech tail, which techOnly could never return', () => {
    for (const name of OTHER_CATEGORY_NAMES) {
      expect(MCP_CATEGORIES).not.toContain(name);
    }
    expect(MCP_CATEGORIES).toContain('AI/ML');
    expect(MCP_CATEGORIES).toContain('Hackathon');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   2. HOSTILE ARGUMENTS
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('NoSQL operator injection is refused at the argument layer', () => {
  /**
   * These end up in a Mongo value position, where an OBJECT is an OPERATOR rather than a value.
   * `{"slug": {"$ne": null}}` is not a slug that fails to match — it is "any event whose slug is not
   * null", i.e. hand back the first document. Nothing downstream defends against it: the shared
   * filter builder escapes a search TERM into a regex but does not typecheck what it was given.
   */
  const operators = [{ $ne: null }, { $gt: '' }, { $regex: '.*' }, ['$ne', null]];

  for (const payload of operators) {
    it(`get_event refuses slug = ${JSON.stringify(payload)}`, () => {
      const parsed = parseGetEventArgs({ slug: payload });
      expect(parsed.ok).toBe(false);
    });

    it(`search_events refuses query = ${JSON.stringify(payload)}`, () => {
      const parsed = parseSearchEventsArgs({ query: payload });
      expect(parsed.ok).toBe(false);
    });
  }

  it('an operator hidden inside a list element is refused too', () => {
    expect(parseSearchEventsArgs({ category: [{ $ne: null }] }).ok).toBe(false);
    expect(parseEventsNearArgs({ area: ['Koramangala', { $ne: null }] }).ok).toBe(false);
  });

  it('a valid scalar still passes — the guard is a typecheck, not a blanket refusal', () => {
    const parsed = parseGetEventArgs({ slug: 'react-bangalore-meetup-107' });
    expect(parsed.ok).toBe(true);
  });
});

describe('enum arguments are matched tolerantly but never invented', () => {
  it('accepts the exact value, the lowercase form and the published slug form', () => {
    for (const spelling of ['Cloud/DevOps', 'cloud/devops', 'cloud-devops']) {
      expect(okSearch({ category: spelling }).category).toEqual(['Cloud/DevOps']);
    }
  });

  it('accepts a comma-separated string, which is what models write half the time', () => {
    expect(okSearch({ category: 'AI/ML, Hackathon' }).category).toEqual(['AI/ML', 'Hackathon']);
  });

  it('names the valid values when a category is unknown, so the model can retry', () => {
    const parsed = parseSearchEventsArgs({ category: 'Quantum Basket Weaving' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.join(' ')).toContain('AI/ML');
    expect(parsed.issues.join(' ')).toContain('Quantum Basket Weaving');
  });

  it('area matching survives the spellings a model produces for HSR Layout', () => {
    for (const spelling of ['HSR Layout', 'hsr layout', 'hsr-layout']) {
      expect(parseEventsNearArgs({ area: spelling })).toEqual({
        ok: true,
        value: { area: ['HSR Layout'], when: undefined, limit: RESULT_LIMITS.default },
      });
    }
  });

  it('every area the gazetteer knows is accepted, so the schema cannot advertise a dead value', () => {
    for (const area of MCP_AREAS) {
      expect(parseEventsNearArgs({ area }).ok).toBe(true);
    }
  });
});

describe('numbers and booleans are coerced, because a model sends strings', () => {
  it('accepts "12" for limit and true/"true"/1 for free', () => {
    expect(okSearch({ limit: '12' }).limit).toBe(12);
    expect(okSearch({ free: 'true' }).free).toBe(true);
    expect(okSearch({ free: false }).free).toBe(false);
    expect(okSearch({ free: 1 }).free).toBe(true);
  });

  it('CLAMPS an over-large limit instead of refusing it', () => {
    // `limit: 500` is a model asking for more than we give, not a malformed request. An error there
    // costs a round trip to learn something the answer could have carried.
    expect(okSearch({ limit: 500 }).limit).toBe(RESULT_LIMITS.max);
    expect(okSearch({ limit: 0 }).limit).toBe(1);
    expect(okSearch({ limit: -3 }).limit).toBe(1);
  });

  it('trending_topics is capped at the size of the taxonomy, not at 50', () => {
    expect(parseTrendingTopicsArgs({ limit: 999 })).toEqual({
      ok: true,
      value: { when: undefined, limit: TOPIC_LIMITS.max },
    });
  });

  it('but a non-numeric limit IS an issue, rather than silently becoming the default', () => {
    expect(parseSearchEventsArgs({ limit: 'lots' }).ok).toBe(false);
  });

  it('defaults are applied when the argument is absent', () => {
    expect(okSearch({}).limit).toBe(RESULT_LIMITS.default);
    expect(okSearch({}).query).toBeUndefined();
  });
});

describe('dates resolve in IST, not UTC — the half-day bug', () => {
  it('a bare YYYY-MM-DD dateFrom is IST midnight', () => {
    // new Date('2026-09-12') is 00:00Z = 05:30 IST, which would silently shift a whole day's
    // results. This is the calendar day-panel defect (CLAUDE.md §7) in a different surface.
    const { dateFrom } = okSearch({ dateFrom: '2026-09-12' });
    expect(dateFrom?.toISOString()).toBe('2026-09-11T18:30:00.000Z');
  });

  it('a bare dateTo is INCLUSIVE of that IST day, so it advances one day', () => {
    // buildEventFilter treats `to` as an EXCLUSIVE bound, while a caller writing "2026-09-14" means
    // "through the 14th". Without the advance, the whole final day is silently dropped.
    const { dateTo } = okSearch({ dateTo: '2026-09-14' });
    expect(dateTo?.toISOString()).toBe('2026-09-14T18:30:00.000Z');
  });

  it('a full ISO timestamp is taken literally in both directions', () => {
    const { dateFrom, dateTo } = okSearch({
      dateFrom: '2026-09-12T10:00:00Z',
      dateTo: '2026-09-12T20:00:00Z',
    });
    expect(dateFrom?.toISOString()).toBe('2026-09-12T10:00:00.000Z');
    expect(dateTo?.toISOString()).toBe('2026-09-12T20:00:00.000Z');
  });

  it('refuses an unparseable date rather than quietly ignoring the filter', () => {
    expect(parseSearchEventsArgs({ dateFrom: 'next tuesday' }).ok).toBe(false);
  });

  it('refuses a reversed range, which would return zero rows and read as “nothing is on”', () => {
    const parsed = parseSearchEventsArgs({ dateFrom: '2026-09-20', dateTo: '2026-09-10' });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('dateTo');
  });

  it('an explicit dateFrom overrides a named window rather than being ignored by it', () => {
    const plan = planSearchEvents(okSearch({ when: 'month', dateFrom: '2026-09-12' }));
    const and = plan.filter.$and as Array<Record<string, unknown>>;
    const lower = and.find(c => 'startDateTime' in c) as
      | { startDateTime: { $gte: Date } }
      | undefined;
    expect(lower?.startDateTime.$gte.toISOString()).toBe('2026-09-11T18:30:00.000Z');
  });
});

describe('get_event requires exactly one identifier', () => {
  it('accepts a 24-character id', () => {
    expect(parseGetEventArgs({ id: '68b1c0ffee0000000000dead' })).toEqual({
      ok: true,
      value: { id: '68b1c0ffee0000000000dead' },
    });
  });

  it('accepts a full PulseBLR event URL, because that is what a model has to hand', () => {
    const parsed = parseGetEventArgs({
      id: 'https://pulseblr.example.com/events/68B1C0FFEE0000000000DEAD',
    });
    expect(parsed).toEqual({ ok: true, value: { id: '68b1c0ffee0000000000dead' } });
  });

  it('refuses an id that is not an ObjectId, so a bad id is an argument error not a cast throw', () => {
    expect(parseGetEventArgs({ id: 'not-an-id' }).ok).toBe(false);
    expect(parseGetEventArgs({ id: '68b1c0ffee0000000000dea' }).ok).toBe(false);
  });

  it('refuses neither, and refuses both', () => {
    expect(parseGetEventArgs({}).ok).toBe(false);
    expect(parseGetEventArgs({ id: '68b1c0ffee0000000000dead', slug: 'x' }).ok).toBe(false);
  });

  it('selects on _id or on slug accordingly, and nests rather than spreading', () => {
    // Nesting is what makes a future top-level key on the shared filter unable to clobber the
    // selector — or, worse, be clobbered BY it.
    const byId = planGetEvent({ id: '68b1c0ffee0000000000dead' }).filter;
    expect(byId.$and).toEqual([expect.anything(), { _id: '68b1c0ffee0000000000dead' }]);
    const bySlug = planGetEvent({ slug: 'gids-2026' }).filter;
    expect(bySlug.$and).toEqual([expect.anything(), { slug: 'gids-2026' }]);
  });
});

describe('events_near', () => {
  it('requires an area and says so with the list', () => {
    const parsed = parseEventsNearArgs({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.join(' ')).toContain('Koramangala');
  });

  it('accepts several areas, because neighbouring ones are one commute', () => {
    const parsed = parseEventsNearArgs({ area: ['Koramangala', 'HSR Layout', 'Indiranagar'] });
    expect(parsed.ok && parsed.value.area).toEqual(['Koramangala', 'HSR Layout', 'Indiranagar']);
  });

  it('filters on area and applies NO format filter — online is excluded structurally', () => {
    // An area is resolved from venue/address text, so an online event cannot carry one. Adding
    // `format: offline` would additionally drop HYBRID events, which have a room you can go to.
    const filter = planEventsNear({ area: ['Whitefield'], limit: 10 }).filter;
    expect(filter.area).toEqual({ $in: ['Whitefield'] });
    expect(allKeys(filter).has('format')).toBe(false);
  });
});

describe('sort defaults', () => {
  it('ranks by connections when there is no query — not chronologically', () => {
    // A chronological default measurably selects the worst quartile: online events post more often
    // and at shorter notice (CLAUDE.md §3). A model asking for ten events gets exactly one page, so
    // the ranking IS the answer.
    expect(planSearchEvents(okSearch({})).sort).toEqual({ connectionScore: -1, startDateTime: 1 });
  });

  it('switches to relevance when a multi-word query is present', () => {
    const plan = planSearchEvents(okSearch({ query: 'ai product meetup' }));
    expect(plan.hasTextSearch).toBe(true);
    expect(plan.sort).toEqual({ score: { $meta: 'textScore' }, startDateTime: 1 });
  });

  it('an explicit sort wins over both defaults', () => {
    expect(planSearchEvents(okSearch({ sort: 'soonest' })).sort).toEqual({ startDateTime: 1 });
  });

  it('a single-word query uses a regex, so hasTextSearch is false and no score is projected', () => {
    // Projecting textScore without $text is a Mongo error, so this flag is load-bearing rather
    // than informational.
    expect(planSearchEvents(okSearch({ query: 'kubernetes' })).hasTextSearch).toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   3. THE JSON-RPC / MCP SURFACE
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('initialize', () => {
  it('echoes a protocol version we support', async () => {
    for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
      const response = await dispatch(request('initialize', { protocolVersion: version }), stubRunner);
      expect(response && 'result' in response && (response.result as Record<string, unknown>).protocolVersion).toBe(
        version
      );
    }
  });

  it('falls back to our latest for an unknown or missing version rather than refusing', () => {
    // Refusing would break every client asking for a revision published after this file was
    // written — for a server nobody redeploys when a spec ships, that is the failure that matters.
    expect(negotiateProtocolVersion('2099-01-01')).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION);
    expect(negotiateProtocolVersion(42)).toBe(LATEST_PROTOCOL_VERSION);
  });

  it('advertises only the tools capability, and names the server', async () => {
    const response = await dispatch(request('initialize', {}), stubRunner);
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(result.serverInfo).toEqual(SERVER_INFO);
    expect(String(result.instructions)).toContain('Bengaluru');
  });
});

describe('tools/list', () => {
  it('lists exactly the four v1 tools', async () => {
    const response = await dispatch(request('tools/list'), stubRunner);
    const { tools } = (response as { result: { tools: typeof TOOL_DEFS } }).result;
    expect(tools.map(t => t.name)).toEqual([
      'search_events',
      'get_event',
      'events_near',
      'trending_topics',
    ]);
  });

  it('every tool declares a schema, an output schema and read-only annotations', () => {
    for (const tool of TOOL_DEFS) {
      expect(tool.inputSchema.type).toBe('object');
      expect(tool.outputSchema.type).toBe('object');
      expect(tool.annotations.readOnlyHint).toBe(true);
      // The description is the prompt the model reads to choose a tool. A one-liner is not enough
      // to carry the two facts it cannot infer: Bengaluru-only, and ranked rather than listed.
      expect(tool.description.length).toBeGreaterThan(120);
      expect(tool.title.length).toBeGreaterThan(0);
    }
  });

  it('every listed tool has a definition findable by name', () => {
    for (const name of TOOL_NAMES) expect(findToolDef(name)).toBeDefined();
    expect(findToolDef('my_people')).toBeUndefined();
  });

  it('no tool mentions a user’s own data — v1 is unauthenticated by construction', () => {
    // A tool named for private data on an endpoint that reads no session would return somebody
    // else's rows or nothing at all. This fails the day one is added without auth.
    const listed = TOOL_NAMES.join(' ');
    for (const forbidden of ['my_', 'who_did_i', 'follow_up', 'saved']) {
      expect(listed).not.toContain(forbidden);
    }
  });
});

describe('tools/call', () => {
  it('passes the arguments through to the runner and returns its result', async () => {
    const response = await dispatch(
      request('tools/call', { name: 'search_events', arguments: { query: 'kubernetes' } }),
      stubRunner
    );
    const result = (response as { result: { content: Array<{ text: string }> } }).result;
    expect(result.content[0].text).toBe('ran search_events');
  });

  it('rejects an unknown tool with -32602 and names what IS available', async () => {
    const response = await dispatch(request('tools/call', { name: 'drop_database' }), stubRunner);
    const error = (response as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(JSON_RPC_ERRORS.invalidParams);
    expect(error.message).toContain('search_events');
  });

  it('rejects a missing tool name', async () => {
    const response = await dispatch(request('tools/call', {}), stubRunner);
    expect((response as { error: { code: number } }).error.code).toBe(JSON_RPC_ERRORS.invalidParams);
  });

  it('converts a THROWING handler into -32603 and leaks nothing from the message', async () => {
    // A Mongoose error message names the model and the schema path — free reconnaissance, and the
    // exact leak the tracker write paths had to stop returning as `details: err.message`.
    const throwing: ToolRunner = async () => {
      throw new Error('Event validation failed: clusterKey: Path `clusterKey` is required.');
    };
    const response = await dispatch(request('tools/call', { name: 'get_event' }), throwing);
    const error = (response as { error: { code: number; message: string } }).error;
    expect(error.code).toBe(JSON_RPC_ERRORS.internal);
    expect(error.message).not.toContain('clusterKey');
    expect(error.message).not.toContain('Event validation');
  });

  it('a tool that ran and has a negative answer is a RESULT, not a protocol error', async () => {
    // Collapsing the two makes a client report the server as broken when the honest answer is "no".
    const negative: ToolRunner = async (): Promise<ToolOutcome> => ({
      result: { content: [{ type: 'text', text: 'No public event with that id.' }], isError: true },
    });
    const response = await dispatch(request('tools/call', { name: 'get_event' }), negative);
    expect(response && 'result' in response).toBe(true);
    expect((response as { result: { isError: boolean } }).result.isError).toBe(true);
  });
});

describe('protocol framing', () => {
  it('answers ping with an empty result', async () => {
    const response = await dispatch(request('ping'), stubRunner);
    expect((response as { result: unknown }).result).toEqual({});
  });

  it('returns -32601 for an unknown method', async () => {
    const response = await dispatch(request('completion/complete'), stubRunner);
    expect((response as { error: { code: number } }).error.code).toBe(JSON_RPC_ERRORS.methodNotFound);
  });

  it('answers resources/list and prompts/list with empty lists, not errors', async () => {
    // Clients probe these on connect even though we declare no such capability, and a -32601 there
    // renders as a red error on an otherwise healthy connection.
    const resources = await dispatch(request('resources/list'), stubRunner);
    expect((resources as { result: unknown }).result).toEqual({ resources: [] });
    const prompts = await dispatch(request('prompts/list'), stubRunner);
    expect((prompts as { result: unknown }).result).toEqual({ prompts: [] });
  });

  it('a NOTIFICATION receives no response at all', async () => {
    const response = await dispatch({ method: 'notifications/initialized' }, stubRunner);
    expect(response).toBeNull();
  });

  it('an unknown notification is also answered by silence, never by an error', async () => {
    expect(await dispatch({ method: 'notifications/from/the/future' }, stubRunner)).toBeNull();
  });
});

describe('payload handling', () => {
  it('a notification-only payload is 202 with an empty body', async () => {
    const result = await handleMcpPayload({ jsonrpc: '2.0', method: 'notifications/initialized' }, stubRunner);
    expect(result).toEqual({ status: 202, body: null });
  });

  it('a single request answers with a single object, not an array', async () => {
    const result = await handleMcpPayload(request('ping'), stubRunner);
    expect(Array.isArray(result.body)).toBe(false);
    expect(result.status).toBe(200);
  });

  it('a batch answers with an array, omitting the notifications', async () => {
    const result = await handleMcpPayload(
      [
        request('ping', undefined, 1),
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        request('tools/list', undefined, 2),
      ],
      stubRunner
    );
    const responses = result.body as Array<{ id: number }>;
    expect(responses).toHaveLength(2);
    expect(responses.map(r => r.id)).toEqual([1, 2]);
  });

  it('one malformed entry in a batch does not fail the others', async () => {
    const result = await handleMcpPayload([request('ping', undefined, 1), 'nonsense'], stubRunner);
    const responses = result.body as unknown as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);
    expect(responses[0]).toHaveProperty('result');
    expect(responses[1]).toHaveProperty('error');
  });

  it('rejects a wrong jsonrpc version while KEEPING the id, so the client can correlate', () => {
    const { entries } = parseIncoming({ jsonrpc: '1.0', id: 7, method: 'ping' });
    expect(entries[0]).toEqual({
      failure: expect.objectContaining({ id: 7, error: expect.objectContaining({ code: JSON_RPC_ERRORS.invalidRequest }) }),
    });
  });

  it('rejects id: null rather than treating it as a notification', () => {
    // MCP forbids a null id. Treating it as "no id" would leave a client waiting forever for a
    // response it was entitled to — the least debuggable outcome available.
    const { entries } = parseIncoming({ jsonrpc: '2.0', id: null, method: 'ping' });
    expect(entries[0]).toHaveProperty('failure');
  });

  it('rejects an empty batch and a non-object message', () => {
    expect(parseIncoming([]).entries[0]).toHaveProperty('failure');
    expect(parseIncoming(42).entries[0]).toHaveProperty('failure');
    expect(parseIncoming({ jsonrpc: '2.0', id: 1 }).entries[0]).toHaveProperty('failure');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   4. SERIALISATION — the canonical URL is the whole distribution mechanic
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('event rows', () => {
  const base = {
    _id: '68b1c0ffee0000000000dead',
    title: 'Bangalore Kubernetes Meetup #42',
    format: 'offline' as const,
    category: ['Cloud/DevOps', 'Meetup'],
    isFree: true,
    venue: 'Prestige Tech Park, Bengaluru, Bengaluru',
    area: 'Outer Ring Road',
    city: 'Bengaluru',
    organizer: 'CNCF Bangalore',
    startDateTime: new Date('2026-09-12T13:30:00Z'), // 19:00 IST
    connectionScore: 88,
    source: 'meetup',
    sourceUrl: 'https://www.meetup.com/x/events/1',
  };

  it('ALWAYS carries the canonical event URL', () => {
    const row = toMcpEventRow(base);
    expect(row.url).toBe(buildEventUrl('68b1c0ffee0000000000dead'));
    expect(row.url).toContain('/events/68b1c0ffee0000000000dead');
  });

  it('renders the time in IST, not the ambient zone', () => {
    // A server in UTC would otherwise put a 19:00 IST event on the previous day.
    expect(toMcpEventRow(base).startsAtIST).toContain('19:00 IST');
    expect(toMcpEventRow(base).startsAt).toBe('2026-09-12T13:30:00.000Z');
  });

  it('carries both the score and a coarse band, because each misleads alone', () => {
    const row = toMcpEventRow(base);
    expect(row.connectionScore).toBe(88);
    expect(row.connectionRating).toBe('high');
    expect(toMcpEventRow({ ...base, connectionScore: 45 }).connectionRating).toBe('moderate');
    expect(toMcpEventRow({ ...base, connectionScore: 2 }).connectionRating).toBe('low');
  });

  it('de-duplicates the repeated city segments sources publish in venue strings', () => {
    expect(toMcpEventRow(base).location).toBe('Prestige Tech Park, Bengaluru · Outer Ring Road');
  });

  it('says “onward” instead of a time for a multi-day event', () => {
    // Printing one time is how the website's time rail once made a three-day conference read as
    // ending before it began.
    const row = toMcpEventRow({
      ...base,
      endDateTime: new Date('2026-09-14T13:30:00Z'),
    });
    expect(row.spansDays).toBe(2);
    expect(row.startsAtIST).toContain('onward');
  });

  it('omits empty fields rather than sending nulls into a context window', () => {
    const row = toMcpEventRow({ ...base, venue: '', organizer: null, companies: [] });
    expect(row).not.toHaveProperty('venue');
    expect(row).not.toHaveProperty('organizer');
    expect(row).not.toHaveProperty('companies');
  });

  it('list rows never carry a description; the detail shape strips markdown and truncates', () => {
    expect(toMcpEventRow({ ...base, description: '# Hello' })).not.toHaveProperty('description');
    const detail = toMcpEventDetail({
      ...base,
      description: '## Agenda\n\n**Doors** at 18:30. Register [here](https://lu.ma/x).',
    });
    expect(detail.description).toBe('Agenda Doors at 18:30. Register here.');
    const long = toMcpEventDetail({ ...base, description: 'word '.repeat(600) });
    expect((long.description ?? '').length).toBeLessThan(1300);
  });

  it('prices free and paid events the way the site does', () => {
    expect(toMcpEventRow(base).price).toBe('Free');
    expect(toMcpEventRow({ ...base, isFree: false, price: 500 }).price).toBe('₹500');
    expect(toMcpEventRow({ ...base, isFree: false, price: 500, priceMax: 1500 }).price).toBe('₹500–1500');
  });
});
