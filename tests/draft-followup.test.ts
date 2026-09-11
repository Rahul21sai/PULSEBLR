import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DRAFT_FIELDS,
  MAX_DRAFT_CHARS,
  MAX_NOTES,
  MIN_NOTE_CHARS,
  buildDraftPrompt,
  generateFollowupDraft,
  materialProblem,
  rateLimitedFrom,
  retryAfterMs,
  selectDraftFields,
  validateDraft,
} from '@/lib/llm/draft-followup';

/**
 * The day-after follow-up draft.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * THREE QUESTIONS, AND ONLY ONE OF THEM IS ABOUT WHETHER THE CODE WORKS.
 *
 *   1. WHAT LEFT THE MACHINE. This is the most privacy-sensitive LLM call in the app — one user's
 *      private notes about a named third party. So the decisive assertions read the bytes that were
 *      actually handed to `fetch` and check that nothing outside `DRAFT_FIELDS` is in them. Asserting
 *      against the return value of a prompt builder would pass while the transport quietly sent
 *      something else; asserting against the request body cannot.
 *
 *   2. WHETHER IT REFUSES. With no note there is nothing to write from, and the only thing a model
 *      could produce is "great to meet you at X" — a template the user cannot tell apart from a real
 *      draft. The test therefore pins that it refuses AND that it never reaches the network, because
 *      "refuses after sending the data" is not a refusal.
 *
 *   3. WHETHER GENERATING IS EVER MISTAKEN FOR SENDING. A draft that silently marks itself sent
 *      would take the person off the follow-up list without a message existing. `sent` is typed as
 *      the literal `false`, and this asserts the runtime value so the type is not the only guard.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * NO NETWORK AND NO DATABASE, matching this suite's scope. `fetch` is replaced with a stub that
 * records what it was given — the same instrument `scripts/diag-breaker-scope.ts` uses to prove
 * breaker behaviour without credentials, one layer lower.
 */

/* ── Fixtures ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * A person document STUFFED WITH THINGS THAT MUST NOT TRAVEL.
 *
 * Every extra key here is real: they are all fields that exist on `Person`, `Contact` or a DTO
 * somewhere in this app, so each is one careless spread away from a prompt. The strings are made
 * deliberately unmistakable so a substring assertion cannot pass by accident.
 */
const STUFFED = {
  // Allowlisted — these SHOULD travel.
  personName: 'Ananya Iyer',
  company: 'Razorpay',
  role: 'Staff Engineer',
  headline: 'Payments infrastructure',
  eventTitle: 'Bangalore Kubernetes Meetup #12',
  metAt: '2026-09-08T13:30:00.000Z',
  notes: ['Runs the payments gateway team. Asked for the etcd tuning writeup I mentioned.'],

  // NOT allowlisted — none of these may appear anywhere in the outbound request.
  email: 'SECRETEMAIL@example.invalid',
  phone: 'SECRETPHONE9876543210',
  linkedin: 'https://linkedin.example/in/SECRETSLUG',
  github: 'https://github.example/SECRETGITHUB',
  x: 'https://x.example/SECRETX',
  website: 'https://SECRETSITE.example',
  contactKey: 'li:SECRETCONTACTKEY',
  contactKeys: ['li:SECRETCONTACTKEY'],
  _id: 'SECRETOBJECTID0000000001',
  userId: 'SECRETUSERID',
  personId: 'SECRETPERSONID',
  clientId: 'SECRETCLIENTID',
  tags: ['SECRETTAG'],
  ownTags: ['SECRETOWNTAG'],
  companies: ['SECRETRESOLVEDCO'],
  isTargetCompany: true,
  nextActionAt: '2026-09-20T06:30:00.000Z',
  followUpAt: '2026-09-20T06:30:00.000Z',
  followedUp: false,
  rawPayload: 'BEGIN:VCARD SECRETVCARD END:VCARD',
} as Record<string, unknown>;

/** Every value above that must never appear in a prompt or a request body. */
const SECRETS = [
  'SECRETEMAIL',
  'SECRETPHONE',
  'SECRETSLUG',
  'SECRETGITHUB',
  'SECRETX',
  'SECRETSITE',
  'SECRETCONTACTKEY',
  'SECRETOBJECTID',
  'SECRETUSERID',
  'SECRETPERSONID',
  'SECRETCLIENTID',
  'SECRETTAG',
  'SECRETOWNTAG',
  'SECRETRESOLVEDCO',
  'SECRETVCARD',
];

/** A reply the model might plausibly return. Over `MIN_DRAFT_CHARS`, under `MAX_DRAFT_CHARS`. */
const GOOD_REPLY =
  'Hi Ananya, thanks for the conversation about your payments gateway team yesterday. ' +
  'Here is the etcd tuning writeup I promised. Happy to walk through the compaction settings ' +
  'if that would help your team.';

function icaResponse(content: string, status = 200) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Bodies handed to `fetch`, in order. One entry per outbound request. */
let sent: string[] = [];

function stubFetch(...responses: Array<() => Response>) {
  let call = 0;
  const spy = vi.fn(async (_url: string, init?: RequestInit) => {
    sent.push(String(init?.body ?? ''));
    const next = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return next();
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

const ENV_KEYS = ['ICA_API_KEY', 'ICA_BASE_URL', 'ICA_MODEL'] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  sent = [];
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
  process.env.ICA_API_KEY = 'test-key';
  process.env.ICA_BASE_URL = 'https://ica.example/v1/chat-models';
  process.env.ICA_MODEL = 'claude-sonnet-5';
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   1. THE REDACTION BOUNDARY
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('the field allowlist', () => {
  it('keeps exactly the allowlisted keys and drops everything else', () => {
    const material = selectDraftFields(STUFFED);
    // Asserted as a SET COMPARISON rather than key-by-key: a new field added to `DraftMaterial`
    // without a matching `DRAFT_FIELDS` entry (or the reverse) fails here, which is the drift this
    // pair exists to prevent.
    expect(Object.keys(material).sort()).toEqual([...DRAFT_FIELDS].sort());
  });

  it('never puts a non-allowlisted value into the prompt', () => {
    const prompt = buildDraftPrompt(selectDraftFields(STUFFED));
    for (const secret of SECRETS) {
      expect(prompt, `"${secret}" reached the prompt`).not.toContain(secret);
    }
  });

  it('does put the allowlisted values into the prompt', () => {
    // The other half of the boundary. A redaction test that only asserts absence passes trivially
    // for a builder that sends nothing at all, which would be a broken feature scoring full marks.
    const prompt = buildDraftPrompt(selectDraftFields(STUFFED));
    expect(prompt).toContain('Ananya Iyer');
    expect(prompt).toContain('Razorpay');
    expect(prompt).toContain('Staff Engineer');
    expect(prompt).toContain('Payments infrastructure');
    expect(prompt).toContain('Bangalore Kubernetes Meetup #12');
    expect(prompt).toContain('etcd tuning writeup');
  });

  it('omits a line entirely for an absent field rather than naming it empty', () => {
    const prompt = buildDraftPrompt(
      selectDraftFields({ personName: 'Dev', notes: ['Talked about RISC-V tapeout timelines.'] })
    );
    // "Their company:" with nothing after it invites a model to fill the gap.
    expect(prompt).not.toMatch(/company:/i);
    expect(prompt).not.toMatch(/met at:/i);
    expect(prompt).not.toMatch(/met on:/i);
  });

  it('normalises a blank field to absent instead of keeping an empty string', () => {
    const material = selectDraftFields({
      personName: '  Dev  ',
      company: '   ',
      role: '',
      notes: ['   ', 'Real note about the compiler work they are doing.', ''],
    });
    expect(material.personName).toBe('Dev');
    expect(material.company).toBeNull();
    expect(material.role).toBeNull();
    expect(material.notes).toEqual(['Real note about the compiler work they are doing.']);
  });

  it('caps the notes it forwards', () => {
    const many = Array.from({ length: 10 }, (_, i) => `Note number ${i} with enough words in it.`);
    expect(selectDraftFields({ personName: 'Dev', notes: many }).notes).toHaveLength(MAX_NOTES);
  });

  it('ignores a notes value that is not an array of strings', () => {
    // Defensive because the caller assembles `notes` from two collections; a stray null must not
    // become the string "null" in a prompt.
    expect(selectDraftFields({ personName: 'Dev', notes: 'not an array' }).notes).toEqual([]);
    expect(selectDraftFields({ personName: 'Dev', notes: [null, 7, {}] }).notes).toEqual([]);
  });

  it('sends nothing outside the allowlist on the wire either', async () => {
    // THE DECISIVE ONE. The assertions above test a pure builder; this reads the body actually
    // handed to `fetch`, which is what would leave the machine.
    stubFetch(() => icaResponse(GOOD_REPLY));
    const result = await generateFollowupDraft('viewer-1', STUFFED);

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    for (const secret of SECRETS) {
      expect(sent[0], `"${secret}" was sent to the model`).not.toContain(secret);
    }
    // The viewer's own id is a scope argument, not prompt material.
    expect(sent[0]).not.toContain('viewer-1');
    expect(sent[0]).toContain('Ananya Iyer');
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   2. REFUSING AN EMPTY NOTE
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('refusing to draft without a note', () => {
  const cases: Array<[string, unknown]> = [
    ['no notes key at all', undefined],
    ['an empty array', []],
    ['a whitespace-only note', ['   \n  ']],
    ['a note shorter than the floor', ['ok']],
    ['several notes that are all too short together', ['hi', 'yes']],
  ];

  for (const [label, notes] of cases) {
    it(`refuses ${label}`, () => {
      expect(materialProblem(selectDraftFields({ personName: 'Dev', notes }))).toBe('no-note');
    });
  }

  it('accepts a note that clears the floor', () => {
    const note = 'x'.repeat(MIN_NOTE_CHARS);
    expect(materialProblem(selectDraftFields({ personName: 'Dev', notes: [note] }))).toBeNull();
  });

  it('refuses a record with no name, separately from a missing note', () => {
    // Distinct problems get distinct answers because they have distinct fixes — the route turns one
    // into "add a note" and the other into "this record has no name yet".
    expect(
      materialProblem(selectDraftFields({ personName: '', notes: ['A long enough real note here.'] }))
    ).toBe('no-name');
  });

  it('refuses BEFORE any request is made', async () => {
    // A refusal that still posted the notes would not be a refusal. This is the assertion that makes
    // the privacy claim hold for the empty case: nothing left the machine.
    const spy = stubFetch(() => icaResponse(GOOD_REPLY));
    const result = await generateFollowupDraft('viewer-1', { personName: 'Dev', notes: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('no-material');
      expect(result.problem).toBe('no-note');
    }
    expect(spy).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });

  it('refuses without a viewer id', async () => {
    const spy = stubFetch(() => icaResponse(GOOD_REPLY));
    const result = await generateFollowupDraft('', STUFFED);
    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   3. A DRAFT IS NEVER SENT
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('a generated draft is never marked as sent', () => {
  it('reports sent: false on success', async () => {
    stubFetch(() => icaResponse(GOOD_REPLY));
    const result = await generateFollowupDraft('viewer-1', STUFFED);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sent).toBe(false);
      // Not merely falsy. `undefined` would also be falsy and would mean the field was never set,
      // which is a different and weaker claim than "this was explicitly not sent".
      expect(result.sent).not.toBeUndefined();
      expect(result.draft.length).toBeGreaterThan(0);
    }
  });

  it('still reports sent: false when the draft is regenerated', async () => {
    stubFetch(() => icaResponse(GOOD_REPLY));
    const first = await generateFollowupDraft('viewer-1', STUFFED);
    const second = await generateFollowupDraft('viewer-1', STUFFED);
    expect(first.ok && first.sent).toBe(false);
    expect(second.ok && second.sent).toBe(false);
  });

  it('returns the exact payload it sent, so the privacy claim is auditable', async () => {
    stubFetch(() => icaResponse(GOOD_REPLY));
    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The audit trail must be the thing that was sent, not a re-derivation of it.
      expect(sent[0]).toContain(JSON.stringify(result.payload.user).slice(1, -1));
      expect(result.payload.temperature).toBe(1);
      expect(result.payload.model).toBe('claude-sonnet-5');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   4. WHAT COMES BACK
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('validating the model reply', () => {
  it('accepts a plain message', () => {
    const result = validateDraft(GOOD_REPLY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.draft).toBe(GOOD_REPLY);
  });

  it('unwraps a fenced block', () => {
    const result = validateDraft('```\n' + GOOD_REPLY + '\n```');
    expect(result.ok && result.draft).toBe(GOOD_REPLY);
  });

  it('unwraps a language-tagged fence', () => {
    const result = validateDraft('```text\n' + GOOD_REPLY + '\n```');
    expect(result.ok && result.draft).toBe(GOOD_REPLY);
  });

  it('strips a preamble label line', () => {
    const result = validateDraft("Here is a draft follow-up message:\n\n" + GOOD_REPLY);
    expect(result.ok && result.draft).toBe(GOOD_REPLY);
  });

  it('strips a subject line the prompt forbade', () => {
    const result = validateDraft('Subject: Great meeting you\n\n' + GOOD_REPLY);
    expect(result.ok && result.draft).toBe(GOOD_REPLY);
  });

  it('strips surrounding quotes', () => {
    const result = validateDraft('"' + GOOD_REPLY + '"');
    expect(result.ok && result.draft).toBe(GOOD_REPLY);
  });

  const rejections: Array<[string, string | null | undefined, string]> = [
    ['nothing', '', 'empty'],
    ['whitespace', '   \n ', 'empty'],
    ['null', null, 'empty'],
    ['undefined', undefined, 'empty'],
    ['a one-liner too short to be a message', 'Hi Ananya, good to meet.', 'too-short'],
    ['an essay', 'a'.repeat(MAX_DRAFT_CHARS + 1), 'too-long'],
    ['a model refusal', "I'm sorry, I can't help with drafting messages to real people.", 'model-refusal'],
    ['an as-an-AI preamble', 'As an AI language model I cannot write this message for you.', 'model-refusal'],
  ];

  for (const [label, input, rejection] of rejections) {
    it(`rejects ${label}`, () => {
      const result = validateDraft(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection).toBe(rejection);
    });
  }

  it('does NOT reject an apology inside a legitimate message', () => {
    /*
     * THE IMPORTANT HALF. The refusal pattern is anchored at the start precisely so this passes —
     * "sorry I had to run" is normal follow-up wording, and an unanchored match would reject good
     * drafts. Same over-matching failure as the `\bpm\b` tagger regex that tagged a fifth of the
     * corpus `Product/Design`.
     */
    const apologetic =
      'Hi Ananya, good to meet you at the meetup. Sorry I had to leave before the last talk — ' +
      'here is the etcd writeup I promised. Shall I send over the compaction numbers too?';
    const result = validateDraft(apologetic);
    expect(result.ok).toBe(true);
  });

  it('turns an unusable reply into bad-response rather than a fabricated draft', async () => {
    stubFetch(() => icaResponse('   '));
    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('bad-response');
      expect(result.rejection).toBe('empty');
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   5. THROTTLING — ICA DELIVERS A 429 AS A 400
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('recognising a throttle', () => {
  it('treats a real 429 as a throttle', () => {
    expect(rateLimitedFrom(429, 'anything')).toBe(true);
  });

  it('treats ICA’s wrapped Bedrock 429 as a throttle', () => {
    // The exact body shape measured on 2026-09-10 and recorded in CLAUDE.md.
    const body =
      '{"detail":"litellm.RateLimitError: BedrockException - {\\"message\\":\\"Too many requests, ' +
      'please wait before trying again...\\"}. Received Model Group=claude-sonnet-5"}';
    expect(rateLimitedFrom(400, body)).toBe(true);
  });

  it('does NOT treat a genuine 400 as a throttle', () => {
    // The whole reason the match is narrow: a malformed request must fail fast, not retry four times.
    expect(rateLimitedFrom(400, '{"detail":"only temperature=1 is supported"}')).toBe(false);
    expect(rateLimitedFrom(400, '{"detail":"Model not found"}')).toBe(false);
  });

  it('does not treat other statuses as a throttle', () => {
    for (const status of [401, 403, 404, 500, 502, 503]) {
      expect(rateLimitedFrom(status, 'rate limit')).toBe(false);
    }
  });
});

describe('backing off', () => {
  it('honours a Retry-After in seconds, capped', () => {
    expect(retryAfterMs('2', 0)).toBe(2000);
    expect(retryAfterMs('600', 0)).toBe(8000);
  });

  it('honours a Retry-After HTTP date', () => {
    const at = new Date(Date.now() + 3000).toUTCString();
    const wait = retryAfterMs(at, 0);
    // Second-resolution date, so allow the rounding either way.
    expect(wait).toBeGreaterThan(1500);
    expect(wait).toBeLessThanOrEqual(8000);
  });

  it('grows exponentially with full jitter and stays inside the cap', () => {
    // `random` is injected so this is arithmetic rather than a statistical argument.
    expect(retryAfterMs(null, 0, () => 0)).toBe(500);
    expect(retryAfterMs(null, 0, () => 1)).toBe(1000);
    expect(retryAfterMs(null, 2, () => 0)).toBe(2000);
    expect(retryAfterMs(null, 2, () => 1)).toBe(4000);
    expect(retryAfterMs(null, 20, () => 1)).toBe(8000);
  });

  it('never returns a negative wait for a Retry-After date in the past', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(past, 0)).toBe(0);
  });
});

describe('the throttle loop', () => {
  it('retries a throttled request and succeeds', async () => {
    let call = 0;
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body ?? ''));
      call += 1;
      if (call === 1) {
        return new Response('{"detail":"litellm.RateLimitError: Too many requests"}', {
          status: 400,
          // 1s is the smallest honoured value, which keeps this inside the suite's 5s timeout.
          headers: { 'retry-after': '1' },
        });
      }
      return icaResponse(GOOD_REPLY);
    });
    vi.stubGlobal('fetch', spy);

    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-throttle error', async () => {
    const spy = vi.fn(async (_url: string, init?: RequestInit) => {
      sent.push(String(init?.body ?? ''));
      return new Response('{"detail":"Developer API key has expired"}', { status: 401 });
    });
    vi.stubGlobal('fetch', spy);

    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unavailable');
    // A rejected credential cannot heal on a retry, so exactly one request.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════════════
   6. DEGRADING HONESTLY
   ══════════════════════════════════════════════════════════════════════════════════════════════ */

describe('when no model is configured', () => {
  it('reports unavailable and makes no request', async () => {
    delete process.env.ICA_API_KEY;
    const spy = stubFetch(() => icaResponse(GOOD_REPLY));

    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toBe('unavailable');
    expect(spy).not.toHaveBeenCalled();
  });

  it('never synthesises a draft from a template', async () => {
    /*
     * THE LOAD-BEARING ASSERTION OF THE WHOLE FEATURE. There is no keyword floor for prose: a
     * template is not a degraded draft, it is a worse product wearing the same label, and the user
     * cannot tell which one they got. So a failure result must carry no draft at all.
     */
    delete process.env.ICA_BASE_URL;
    stubFetch(() => icaResponse(GOOD_REPLY));
    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(false);
    expect(result).not.toHaveProperty('draft');
  });

  it('reports unavailable on a timeout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('The operation was aborted due to timeout');
      })
    );
    const result = await generateFollowupDraft('viewer-1', STUFFED);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure).toBe('unavailable');
      expect(result.detail).toMatch(/timed out/i);
    }
  });
});
