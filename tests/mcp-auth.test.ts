import { describe, it, expect } from 'vitest';

import { JSON_RPC_ERRORS } from '@/lib/mcp/protocol';
import {
  SERVER_INFO,
  dispatch,
  handleMcpPayload,
  instructionsFor,
  type ToolRunner,
} from '@/lib/mcp/server';
import {
  ALL_TOOL_DEFS,
  PERSONAL_TOOL_NAMES,
  PUBLIC_TOOL_NAMES,
  isPersonalTool,
  toolsFor,
  type McpToolDef,
} from '@/lib/mcp/tool-defs';
import {
  LAST_USED_REFRESH_MS,
  TOKEN_PREFIX,
  TOKEN_TTL_DAYS,
  expiryFromDays,
  hashMcpToken,
  isWellFormedToken,
  newMcpToken,
  parseAuthorizationHeader,
  shouldRefreshLastUsed,
  tokenHint,
  type McpIdentity,
} from '@/lib/mcp/identity';
import {
  FOLLOW_UP_HORIZON,
  MY_PEOPLE_SORTS,
  PERSONAL_LIMITS,
  parseMyFollowUpsArgs,
  parseMyPeopleArgs,
  parseMySavedEventsArgs,
  parseWhoDidIMeetAtArgs,
} from '@/lib/mcp/personal-args';
import { TRACKER_STATUSES } from '@/lib/tracker/validate';

/**
 * MCP v2's authenticated half, tested where it can be tested honestly: as pure functions.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * WHAT THIS SUITE EXISTS TO CATCH. Four properties, each of which fails in a way that LOOKS FINE from
 * a running server, which is why none of them is a smoke test:
 *
 *   1. A PERSONAL TOOL REACHABLE WITHOUT A CREDENTIAL. Against a live server this is invisible unless
 *      the test database happens to hold somebody else's contacts — and the anonymous caller would see
 *      an empty list, which reads as "you have met nobody" rather than as a broken guard. Asserted
 *      structurally instead: `dispatch` is driven with `identity = null` and every personal tool must
 *      come back with the unauthorized code, having never reached the runner.
 *   2. THE PUBLIC HALF REGRESSING INTO A 401. The opposite failure and just as bad — v1 clients and
 *      `scripts/diag-api-auth.ts` both depend on an anonymous `tools/list` answering 200. A test that
 *      only checked the refusals would pass on a server that refused everybody.
 *   3. A TOKEN THAT IS NOT ONE OF OURS BEING ACCEPTED, or a token that IS one being read out of the
 *      wrong header shape. Format, hashing and header parsing are all pure and all pinned below.
 *   4. THE ARGUMENT LAYER LETTING AN OBJECT THROUGH. `{"company": {"$ne": null}}` on a query scoped to
 *      one person's contacts returns SOMEBODY'S data and looks like the tool working.
 *
 * There is no database and no server here, exactly as `vitest.config.mts` requires. `dispatch` takes
 * both the runner AND the identity as parameters, which is what makes the whole authenticated surface
 * drivable in process — the same reasoning that put `runTool` behind a parameter in v1.
 *
 * ── WHAT THIS SUITE DOES **NOT** COVER, STATED SO NOBODY READS IT AS COMPLETE ────────────────
 * `resolveMcpIdentity` in `lib/mcp/auth.ts` needs Mongo, so its three DATABASE branches are NOT
 * asserted here: an unknown hash, an EXPIRED row, and the `lastUsedAt` refresh write. What IS asserted
 * is every pure input to those branches — `expiryFromDays`, `shouldRefreshLastUsed`,
 * `isWellFormedToken`, `parseAuthorizationHeader`, `hashMcpToken` — so the arithmetic and the parsing
 * cannot be wrong, while the three-line `if` that consumes them is verified only by reading.
 *
 * That is a real gap and the honest place for it is here rather than in a claim that sounds better. It
 * is the same boundary `vitest.config.mts` draws for the whole repo (pure functions only; anything with
 * a database behind it belongs to the `scripts/diag-*.ts` family), and the shape of the missing test is
 * a write-then-delete fixture in a diag script — an expired row and a deleted row, each asserted to be
 * refused. Not written, because this stream was not to run a server or write to the database.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/* ────────────────────────────── helpers ────────────────────────────── */

const IDENTITY: McpIdentity = {
  userId: 'google-sub-1001028',
  tokenId: '68b1c0ffee0000000000beef',
  scope: 'read',
  label: 'Claude Code on the laptop',
};

function request(method: string, params?: unknown, id: string | number = 1) {
  return { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
}

/** Records what it was called with, so "the runner was never reached" is assertable. */
function spyRunner() {
  const calls: Array<{ name: string; args: unknown; identity: McpIdentity | null }> = [];
  const runner: ToolRunner = async (name, args, identity) => {
    calls.push({ name, args, identity });
    return { result: { content: [{ type: 'text', text: `ran ${name}` }] } };
  };
  return { runner, calls };
}

function errorOf(response: unknown): { code: number; message: string } {
  const error = (response as { error?: { code: number; message: string } }).error;
  if (!error) throw new Error(`expected a JSON-RPC error, got: ${JSON.stringify(response)}`);
  return error;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   1. NO PERSONAL TOOL IS REACHABLE WITHOUT A VERIFIED IDENTITY — the property that matters most
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('a personal tool is unreachable without a verified identity', () => {
  /**
   * Driven over EVERY name in the personal set rather than over a hard-coded list of four, so a fifth
   * personal tool is covered the moment it is added. That is the difference between this suite and the
   * substring check it replaces in `tests/mcp-tools.test.ts`: adding a tool cannot outrun the test.
   */
  for (const name of PERSONAL_TOOL_NAMES) {
    it(`${name}: refused with the unauthorized code, and the runner is never reached`, async () => {
      const { runner, calls } = spyRunner();
      const response = await dispatch(request('tools/call', { name }), runner, null);

      expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.unauthorized);
      // THE IMPORTANT HALF. A refusal that still ran the handler would have already issued the query.
      expect(calls).toHaveLength(0);
    });

    it(`${name}: refused the same way when the ARGUMENTS are invalid — guard first, validate second`, async () => {
      /**
       * CLAUDE.md §6's ordering rule, as a test. If validation ran before the guard, a deliberately
       * broken body would come back `-32602` and tell an anonymous stranger that their payload parsed
       * and validated far enough to be judged. The body below is invalid for every one of these tools
       * (a non-scalar where a string is declared, a nonsense limit), so a `-32602` here is unambiguous.
       */
      const { runner, calls } = spyRunner();
      const response = await dispatch(
        request('tools/call', {
          name,
          arguments: { company: { $ne: null }, event: { $gt: '' }, limit: 'lots', status: 99 },
        }),
        runner,
        null
      );

      expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.unauthorized);
      expect(errorOf(response).code).not.toBe(JSON_RPC_ERRORS.invalidParams);
      expect(calls).toHaveLength(0);
    });

    it(`${name}: the refusal says how to fix it and names the free alternative`, async () => {
      const response = await dispatch(request('tools/call', { name }), spyRunner().runner, null);
      const { message } = errorOf(response);
      // Actionable, not merely negative — a model relaying this should be able to tell the user what
      // to do, and should not conclude the server is broken.
      expect(message).toContain('/settings');
      expect(message).toContain('Bearer');
      expect(message).toContain('search_events');
    });
  }

  it('the identity argument DEFAULTS to anonymous, so a call site that forgets it fails CLOSED', async () => {
    // `dispatch(message, runTool)` — two arguments, exactly as every v1 call site writes it.
    const { runner, calls } = spyRunner();
    const response = await dispatch(request('tools/call', { name: 'my_people' }), runner);
    expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.unauthorized);
    expect(calls).toHaveLength(0);
  });

  it('an UNKNOWN tool is -32602 for everyone, NOT the auth code', async () => {
    /**
     * The two must stay distinguishable in both directions. Answering "unknown tool" for a personal
     * tool would tell a client whose token just expired that the server no longer has the capability,
     * so it would stop offering it instead of prompting for auth. Answering "unauthorized" for a
     * genuine typo would make a misspelling indistinguishable from a permissions problem.
     */
    const response = await dispatch(request('tools/call', { name: 'my_secrets' }), spyRunner().runner, null);
    expect(errorOf(response).code).toBe(JSON_RPC_ERRORS.invalidParams);
  });

  it('an identified caller reaches the runner, and the identity is handed to it', async () => {
    // The control. Without it, every assertion above could be passing because nothing works at all.
    const { runner, calls } = spyRunner();
    const response = await dispatch(
      request('tools/call', { name: 'my_people', arguments: { company: 'Razorpay' } }),
      runner,
      IDENTITY
    );

    expect(response && 'result' in response).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('my_people');
    expect(calls[0].identity?.userId).toBe(IDENTITY.userId);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   2. tools/list IS PARTITIONED — a per-user tool never appears unauthenticated
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('an unauthenticated tools/list never advertises a per-user tool', () => {
  it('anonymous sees the public set and nothing else', async () => {
    const response = await dispatch(request('tools/list'), spyRunner().runner, null);
    const { tools } = (response as { result: { tools: McpToolDef[] } }).result;
    const names = tools.map(t => t.name);

    expect(names).toEqual([...PUBLIC_TOOL_NAMES]);
    for (const personal of PERSONAL_TOOL_NAMES) expect(names).not.toContain(personal);
    // Nothing in the anonymous listing may be a personal tool, however it is named or ordered.
    expect(names.some(isPersonalTool)).toBe(false);
  });

  it('the anonymous listing leaks no personal tool SCHEMA either, not just no name', () => {
    /**
     * A schema is disclosure too, in a small way — it names arguments like `targetOnly` and `repeatOnly`
     * that describe what the product records about people. More practically: a schema in the listing is
     * an invitation for the model to call the tool, which turns every anonymous session into a 401 the
     * user sees. Serialised and searched wholesale so a nested `properties` block cannot slip past a
     * name-only check.
     */
    const serialised = JSON.stringify(toolsFor(false));
    for (const personal of PERSONAL_TOOL_NAMES) expect(serialised).not.toContain(personal);
    expect(serialised).not.toContain('repeatOnly');
    expect(serialised).not.toContain('targetOnly');
  });

  it('identified sees both sets, public first', () => {
    const names = toolsFor(true).map(t => t.name);
    expect(names).toEqual([...PUBLIC_TOOL_NAMES, ...PERSONAL_TOOL_NAMES]);
    expect(names).toHaveLength(ALL_TOOL_DEFS.length);
  });

  it('toolsFor() with NO argument is the public set — the default direction is the safe one', () => {
    expect(toolsFor().map(t => t.name)).toEqual([...PUBLIC_TOOL_NAMES]);
  });

  it('no personal tool declares openWorldHint, and no public tool omits it', () => {
    for (const tool of ALL_TOOL_DEFS) {
      expect(tool.annotations.openWorldHint).toBe(!isPersonalTool(tool.name));
    }
  });

  it('no personal tool schema accepts a user identifier — there is nothing to pass', () => {
    /**
     * The schemas are `additionalProperties: false`, so an unknown key is refused by a validating
     * client anyway. This asserts the stronger thing: no such key is DECLARED, so there is no argument
     * a caller could legitimately send to select whose data it wants.
     */
    for (const tool of ALL_TOOL_DEFS.filter(t => isPersonalTool(t.name))) {
      const properties = Object.keys((tool.inputSchema.properties ?? {}) as Record<string, unknown>);
      for (const forbidden of ['userId', 'user', 'email', 'as', 'account', 'googleId', 'token']) {
        expect(properties).not.toContain(forbidden);
      }
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   3. THE PUBLIC HALF DID NOT REGRESS — v1's contract, re-asserted from the other side
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('the public half still works anonymously', () => {
  for (const name of PUBLIC_TOOL_NAMES) {
    it(`${name}: an anonymous call reaches the runner`, async () => {
      const { runner, calls } = spyRunner();
      const response = await dispatch(request('tools/call', { name }), runner, null);
      expect(response && 'result' in response).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0].identity).toBeNull();
    });
  }

  it('an anonymous tools/list is a 200 with a body, never a 401', async () => {
    /**
     * `scripts/diag-api-auth.ts` asserts exactly this against a live server and lists `POST /api/mcp`
     * under MUST_ALLOW. Pinned here as well because that script needs a dev server and this does not —
     * a contract worth keeping cannot depend on somebody remembering to run the slow check.
     */
    const result = await handleMcpPayload(request('tools/list'), spyRunner().runner, null);
    expect(result.status).toBe(200);
    expect(result.authRequired).toBeUndefined();
    expect(result.body).not.toBeNull();
  });

  it('an anonymous search_events is a 200', async () => {
    const result = await handleMcpPayload(
      request('tools/call', { name: 'search_events', arguments: { query: 'kubernetes' } }),
      spyRunner().runner,
      null
    );
    expect(result.status).toBe(200);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   4. HTTP STATUS AND THE BATCH EXCEPTION
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('an auth failure becomes an HTTP 401 — except in a batch', () => {
  it('a single personal call with no credential is 401 and asks for the challenge header', async () => {
    const result = await handleMcpPayload(
      request('tools/call', { name: 'my_follow_ups' }),
      spyRunner().runner,
      null
    );
    expect(result.status).toBe(401);
    // The route reads this to decide whether to send `WWW-Authenticate`, which is what makes a client
    // prompt for a credential rather than report a broken tool.
    expect(result.authRequired).toBe(true);
  });

  it('a MIXED batch stays 200, so its public half still answers', async () => {
    /**
     * The interesting case. `[search_events, my_people]` is legal from a client negotiating 2024-11-05
     * or 2025-03-26, and exactly one entry is unauthorised — one HTTP status cannot describe both.
     * Choosing 401 would discard a public answer the caller was entitled to.
     */
    const result = await handleMcpPayload(
      [request('tools/call', { name: 'search_events' }, 1), request('tools/call', { name: 'my_people' }, 2)],
      spyRunner().runner,
      null
    );

    expect(result.status).toBe(200);
    expect(result.authRequired).toBeUndefined();

    const responses = result.body as unknown as Array<Record<string, unknown>>;
    expect(responses).toHaveLength(2);
    expect(responses[0]).toHaveProperty('result');
    expect((responses[1] as { error: { code: number } }).error.code).toBe(JSON_RPC_ERRORS.unauthorized);
  });

  it('an all-personal BATCH also stays 200 — the status is about the transport, not the entries', async () => {
    const result = await handleMcpPayload(
      [request('tools/call', { name: 'my_people' }, 1), request('tools/call', { name: 'my_follow_ups' }, 2)],
      spyRunner().runner,
      null
    );
    expect(result.status).toBe(200);
    expect(result.authRequired).toBeUndefined();
  });

  it('an identified single call is 200, not 401', async () => {
    const result = await handleMcpPayload(
      request('tools/call', { name: 'my_people' }),
      spyRunner().runner,
      IDENTITY
    );
    expect(result.status).toBe(200);
    expect(result.authRequired).toBeUndefined();
  });

  it('a notification is still 202 with no body, credential or not', async () => {
    for (const identity of [null, IDENTITY]) {
      const result = await handleMcpPayload({ jsonrpc: '2.0', method: 'notifications/initialized' }, spyRunner().runner, identity);
      expect(result.status).toBe(202);
      expect(result.body).toBeNull();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   5. THE TOKEN ITSELF
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('token format and hashing', () => {
  it('is prefixed, base64url, and 48 characters', () => {
    const token = newMcpToken();
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(token).toHaveLength(TOKEN_PREFIX.length + 43);
    expect(token.slice(TOKEN_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(isWellFormedToken(token)).toBe(true);
  });

  it('never repeats — 200 tokens, 200 distinct values', () => {
    // Not a serious entropy test, which no unit test can be. It catches the one failure that HAS
    // happened to people: a seeded or time-derived generator that quietly returns the same value.
    const seen = new Set(Array.from({ length: 200 }, () => newMcpToken()));
    expect(seen.size).toBe(200);
  });

  it('hashes to 64 hex characters, deterministically, and the hash is not the token', () => {
    const token = newMcpToken();
    expect(hashMcpToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToken(token)).toBe(hashMcpToken(token));
    expect(hashMcpToken(token)).not.toContain(token.slice(TOKEN_PREFIX.length));
  });

  it('a one-character difference gives a completely different hash', () => {
    const token = newMcpToken();
    const nudged = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(hashMcpToken(nudged)).not.toBe(hashMcpToken(token));
  });

  it('the hint is the last four characters and nothing more', () => {
    const token = newMcpToken();
    expect(tokenHint(token)).toBe(token.slice(-4));
    expect(tokenHint(token)).toHaveLength(4);
  });

  it('refuses everything that is not one of ours, without needing a database', () => {
    const rejects = [
      '',
      'pblr_',
      TOKEN_PREFIX + 'short',
      // Right length, wrong prefix — the check must not be length alone.
      `xxxx_${'A'.repeat(43)}`,
      // Right prefix, one character short and one too long.
      TOKEN_PREFIX + 'A'.repeat(42),
      TOKEN_PREFIX + 'A'.repeat(44),
      // Right shape, but base64 rather than base64url: `+` and `/` must not pass.
      TOKEN_PREFIX + `${'A'.repeat(41)}+/`,
      // A padded value, which base64url never produces.
      TOKEN_PREFIX + `${'A'.repeat(42)}=`,
      // Foreign credentials, which are the realistic paste-into-the-wrong-field case.
      'sk-ant-api03-abcdefghijklmnop',
      'ya29.a0ARrdaM-google-access-token',
      // Case matters in the prefix.
      `PBLR_${'A'.repeat(43)}`,
    ];
    for (const bad of rejects) expect(isWellFormedToken(bad)).toBe(false);
  });
});

describe('the Authorization header parser', () => {
  it('reads a bearer token, case-insensitively on the scheme', () => {
    const token = newMcpToken();
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      expect(parseAuthorizationHeader(`${scheme} ${token}`)).toEqual({ token });
    }
  });

  it('tolerates the whitespace a hand-written config produces', () => {
    const token = newMcpToken();
    expect(parseAuthorizationHeader(`  Bearer   ${token}  `)).toEqual({ token });
    // A tab between scheme and credential is legal per RFC 9110.
    expect(parseAuthorizationHeader(`Bearer\t${token}`)).toEqual({ token });
  });

  it('ABSENT and EMPTY both mean anonymous, never a refusal', () => {
    /**
     * The distinction this whole design turns on. A client whose token environment variable is unset
     * sends an empty header, and answering that with a 401 would break a caller that only wanted the
     * public tools. Returning null here is what routes it to `anonymous`.
     */
    expect(parseAuthorizationHeader(null)).toBeNull();
    expect(parseAuthorizationHeader(undefined)).toBeNull();
    expect(parseAuthorizationHeader('')).toBeNull();
    expect(parseAuthorizationHeader('   ')).toBeNull();
    expect(parseAuthorizationHeader('\t')).toBeNull();
  });

  it('something PRESENTED and unusable is malformed, which is NOT anonymous', () => {
    // Each of these must produce a 401 rather than silently downgrading to public access — otherwise a
    // client with a broken credential keeps working, the personal tools quietly vanish, and nobody
    // learns why.
    for (const header of ['Basic dXNlcjpwYXNz', 'Token abc123', 'Bearer', 'Bearer   ', 'pblr_justthetoken']) {
      const parsed = parseAuthorizationHeader(header);
      expect(parsed).not.toBeNull();
      expect(parsed && 'malformed' in parsed).toBe(true);
    }
  });

  it('names the scheme it was given, so a misconfiguration is diagnosable', () => {
    const parsed = parseAuthorizationHeader('Basic dXNlcjpwYXNz');
    expect(parsed && 'malformed' in parsed && parsed.malformed).toContain('Basic');
  });
});

describe('expiry and last-used bookkeeping', () => {
  it('the default window is the documented one, and clamps at both ends', () => {
    const now = new Date('2026-09-11T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;

    expect(expiryFromDays(TOKEN_TTL_DAYS.default, now).getTime()).toBe(
      now.getTime() + TOKEN_TTL_DAYS.default * day
    );
    // Clamped rather than refused — the same choice `intValue` makes for `limit`, and for the same
    // reason: a caller asking for more than we will give is not a malformed request.
    expect(expiryFromDays(99999, now).getTime()).toBe(now.getTime() + TOKEN_TTL_DAYS.max * day);
    expect(expiryFromDays(0, now).getTime()).toBe(now.getTime() + TOKEN_TTL_DAYS.min * day);
    expect(expiryFromDays(-500, now).getTime()).toBe(now.getTime() + TOKEN_TTL_DAYS.min * day);
  });

  it('an expiry is ALWAYS in the future — there is no never-expires state to reach', () => {
    const now = new Date();
    for (const days of [-1, 0, 1, 90, 365, 10_000]) {
      expect(expiryFromDays(days, now).getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it('lastUsedAt refreshes when stale or never set, and not otherwise', () => {
    const now = new Date('2026-09-11T12:00:00Z');
    expect(shouldRefreshLastUsed(null, now)).toBe(true);
    expect(shouldRefreshLastUsed(undefined, now)).toBe(true);
    // Just used: no second write on the hot path.
    expect(shouldRefreshLastUsed(new Date(now.getTime() - 1000), now)).toBe(false);
    expect(shouldRefreshLastUsed(new Date(now.getTime() - LAST_USED_REFRESH_MS + 1), now)).toBe(false);
    expect(shouldRefreshLastUsed(new Date(now.getTime() - LAST_USED_REFRESH_MS - 1), now)).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   6. THE ARGUMENT LAYER — operator injection on a query scoped to private data
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('personal tool arguments refuse a Mongo operator in a value position', () => {
  /**
   * `{"company": {"$ne": null}}` is not a company that fails to match — Mongo reads an object in a
   * value position as an OPERATOR, so it is a query for "any person whose company is not null", i.e.
   * the first row in the collection. On these tools the collection is somebody's contacts. Against a
   * live server the result looks exactly like the tool working, which is why this is asserted here and
   * not by calling anything.
   */
  const operators: unknown[] = [
    { $ne: null },
    { $gt: '' },
    { $regex: '.*' },
    ['array', 'where', 'a', 'string', 'belongs'],
    { $where: 'return true' },
  ];

  for (const operator of operators) {
    it(`my_people refuses ${JSON.stringify(operator)} in company, query and tag`, () => {
      for (const field of ['company', 'query', 'tag']) {
        const parsed = parseMyPeopleArgs({ [field]: operator });
        expect(parsed.ok).toBe(false);
      }
    });

    it(`who_did_i_meet_at refuses ${JSON.stringify(operator)} in event`, () => {
      expect(parseWhoDidIMeetAtArgs({ event: operator }).ok).toBe(false);
    });
  }

  it('a nested operator inside an array element is refused too', () => {
    // The element-level check in `stringList`, not just the top-level one.
    expect(parseMySavedEventsArgs({ status: [{ $ne: null }] }).ok).toBe(false);
  });

  it('but a plain string is accepted, with no escaping applied at this layer', () => {
    const parsed = parseMyPeopleArgs({ company: 'Razorpay' });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.company).toBe('Razorpay');
  });
});

describe('my_people arguments', () => {
  it('defaults the limit and clamps an over-large one rather than refusing', () => {
    const parsed = parseMyPeopleArgs({});
    expect(parsed.ok && parsed.value.limit).toBe(PERSONAL_LIMITS.default);

    const big = parseMyPeopleArgs({ limit: 5000 });
    expect(big.ok && big.value.limit).toBe(PERSONAL_LIMITS.max);
  });

  it('accepts the boolean forms a model actually sends', () => {
    for (const [sent, expected] of [
      [true, true],
      ['true', true],
      ['yes', true],
      [1, true],
      [false, false],
      ['false', false],
      [0, false],
    ] as Array<[unknown, boolean]>) {
      const parsed = parseMyPeopleArgs({ targetOnly: sent });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.targetOnly).toBe(expected);
    }
  });

  it('accepts every declared sort and refuses one that is not', () => {
    for (const sort of MY_PEOPLE_SORTS) {
      const parsed = parseMyPeopleArgs({ sort });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.sort).toBe(sort);
    }
    expect(parseMyPeopleArgs({ sort: 'connectionScore' }).ok).toBe(false);
  });

  it('an unset boolean stays UNDEFINED, so "not asked" differs from "asked for false"', () => {
    // The distinction matters downstream: `buildPersonFilter` adds an arm for `targetOnly: true` and
    // must add nothing at all when the caller did not mention it.
    const parsed = parseMyPeopleArgs({});
    expect(parsed.ok && parsed.value.targetOnly).toBeUndefined();
    expect(parsed.ok && parsed.value.followUpDue).toBeUndefined();
    expect(parsed.ok && parsed.value.repeatOnly).toBeUndefined();
  });
});

describe('who_did_i_meet_at arguments', () => {
  it('requires an event name and says so once, not twice', () => {
    const parsed = parseWhoDidIMeetAtArgs({});
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0]).toContain('"event"');
    }
  });

  it('a non-scalar event yields ONE issue about its type, not a contradictory pair', () => {
    // Without the `issues.some(...)` guard in the parser this reported both "must be a string" and
    // "is required", which reads as the argument being simultaneously wrong and absent.
    const parsed = parseWhoDidIMeetAtArgs({ event: { $ne: null } });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues).toHaveLength(1);
  });

  it('trims, and accepts a partial name', () => {
    const parsed = parseWhoDidIMeetAtArgs({ event: '  IndiaFOSS  ' });
    expect(parsed.ok && parsed.value.event).toBe('IndiaFOSS');
  });
});

describe('my_follow_ups arguments', () => {
  it('defaults the horizon to ZERO — overdue only', () => {
    /**
     * The one numeric argument in this server whose default is not routed through `intValue`, because
     * that helper clamps to a minimum of 1 and 0 is the meaningful value here. A regression would
     * silently turn "what have I dropped" into "what have I dropped or is due tomorrow", which is a
     * different question with a longer answer.
     */
    const parsed = parseMyFollowUpsArgs({});
    expect(parsed.ok && parsed.value.includeUpcomingDays).toBe(0);
    expect(FOLLOW_UP_HORIZON.default).toBe(0);
  });

  it('accepts an explicit horizon and caps it', () => {
    expect(parseMyFollowUpsArgs({ includeUpcomingDays: 3 }).ok).toBe(true);
    const capped = parseMyFollowUpsArgs({ includeUpcomingDays: 9999 });
    expect(capped.ok && capped.value.includeUpcomingDays).toBe(FOLLOW_UP_HORIZON.max);
  });

  it('refuses a non-numeric horizon rather than silently substituting the default', () => {
    expect(parseMyFollowUpsArgs({ includeUpcomingDays: 'a week' }).ok).toBe(false);
  });
});

describe('my_saved_events arguments', () => {
  it('accepts the app’s own tracker statuses and nothing else', () => {
    for (const status of TRACKER_STATUSES) {
      const parsed = parseMySavedEventsArgs({ status: [status] });
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.status).toEqual([status]);
    }
    // The enum is generated from `TRACKER_STATUSES`, so this also pins that the two have not drifted.
    expect(parseMySavedEventsArgs({ status: ['Ghosted'] }).ok).toBe(false);
  });

  it('matches on case and on the slug form, because a model will send either', () => {
    const lower = parseMySavedEventsArgs({ status: 'shortlisted' });
    expect(lower.ok && lower.value.status).toEqual(['Shortlisted']);
    const comma = parseMySavedEventsArgs({ status: 'Confirmed, Attended' });
    expect(comma.ok && comma.value.status).toEqual(['Confirmed', 'Attended']);
  });

  it('defaults to UPCOMING only', () => {
    const parsed = parseMySavedEventsArgs({});
    expect(parsed.ok && parsed.value.includePast).toBe(false);
  });

  it('an explicit includePast: false is preserved, not coerced away', () => {
    const parsed = parseMySavedEventsArgs({ includePast: false });
    expect(parsed.ok && parsed.value.includePast).toBe(false);
    const on = parseMySavedEventsArgs({ includePast: true });
    expect(on.ok && on.value.includePast).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════
   7. WHAT THE SERVER TELLS A CLIENT ABOUT ITSELF
   ══════════════════════════════════════════════════════════════════════════════════════════ */

describe('initialize', () => {
  it('an anonymous handshake gets instructions that do NOT name the personal tools', async () => {
    /**
     * Describing four tools that are absent from the caller's own `tools/list` reads as a broken
     * server, and invites the model to call something it will be refused for.
     */
    const response = await dispatch(request('initialize', {}), spyRunner().runner, null);
    const result = (response as { result: Record<string, unknown> }).result;
    const instructions = String(result.instructions);

    expect(instructions).toContain('Bengaluru');
    for (const personal of PERSONAL_TOOL_NAMES) expect(instructions).not.toContain(personal);
  });

  it('an identified handshake names them, and says an empty answer is about the USER', async () => {
    const response = await dispatch(request('initialize', {}), spyRunner().runner, IDENTITY);
    const instructions = String((response as { result: Record<string, unknown> }).result.instructions);

    for (const personal of PERSONAL_TOOL_NAMES) expect(instructions).toContain(personal);
    // The public half is still there — the authenticated block is additive, not a replacement.
    expect(instructions).toContain('Bengaluru');
    // The framing that stops a model reporting "no results" for a good outcome.
    expect(instructions).toContain('nothing outstanding');
  });

  it('instructionsFor is a pure function of identity presence', () => {
    expect(instructionsFor(null)).toBe(instructionsFor(null));
    expect(instructionsFor(IDENTITY)).toContain(instructionsFor(null));
    expect(instructionsFor(IDENTITY).length).toBeGreaterThan(instructionsFor(null).length);
  });

  it('the server version says v2, so a client can tell which surface it reached', async () => {
    const response = await dispatch(request('initialize', {}), spyRunner().runner, null);
    const result = (response as { result: Record<string, unknown> }).result;
    expect(result.serverInfo).toEqual(SERVER_INFO);
    expect(SERVER_INFO.version.startsWith('2.')).toBe(true);
  });
});
