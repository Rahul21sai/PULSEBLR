import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  KEY_FIELD,
  SEND_TIMEOUT_MS,
  classifyIntakeResponse,
  createIntakeSubmission,
  detailsSignature,
  mayHaveLanded,
  newSubmissionKey,
  sendIntake,
  withTimeout,
  type IntakeDetails,
  type IntakeFailure,
} from '../app/f/[token]/submission';

/**
 * THE PHONE'S HALF OF THE DUPLICATE-CONTACT FIX — `app/f/[token]/submission.ts`.
 *
 * The server can only deduplicate what the form lets it recognise, so these pin the form's side:
 * one key per submission, reused on every retry (edits included) and replaced only by "Add someone
 * else"; a send that cannot hang forever and never throws; and an answer that counts as saved only
 * when the API itself said so — a captive portal's 200 used to show "You're in" for a person who was
 * never saved.
 */

const DETAILS: IntakeDetails = {
  name: 'Asha Rao',
  company: 'Razorpay',
  role: 'SDE',
  linkedin: 'asha-rao',
  phone: '',
  email: '',
  note: '',
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('classifyIntakeResponse — what an answer means', () => {
  it('treats no answer at all as a network failure', () => {
    expect(classifyIntakeResponse(null, null)).toEqual({ kind: 'failed', failure: 'network' });
  });

  it("counts the API's first-write answer as saved", () => {
    expect(classifyIntakeResponse(201, { ok: true, created: true, name: 'Asha' })).toEqual({
      kind: 'saved',
      created: true,
    });
  });

  it('counts a replay as saved — the person is on the list exactly once', () => {
    expect(classifyIntakeResponse(200, { ok: true, created: false, name: 'Asha' })).toEqual({
      kind: 'saved',
      created: false,
    });
  });

  it.each([
    ['a captive portal page (HTML, so no JSON)', null],
    ['an empty object', {}],
    ['ok as a string', { ok: 'true' }],
    ['an array', []],
  ])('does NOT count a 2xx without the API body as saved — %s', (_label, body) => {
    expect(classifyIntakeResponse(200, body)).toEqual({ kind: 'failed', failure: 'unreadable' });
  });

  it.each<[number, IntakeFailure]>([
    [429, 'busy'],
    [404, 'gone'],
    [410, 'gone'],
    [500, 'server'],
    [502, 'server'],
    [503, 'server'],
    [400, 'rejected'],
    [413, 'rejected'],
  ])('maps %i to %s', (status, failure) => {
    expect(classifyIntakeResponse(status, { error: 'anything' })).toEqual({ kind: 'failed', failure });
  });

  it('marks exactly the failures after which the row may exist anyway', () => {
    const all: IntakeFailure[] = ['network', 'unreadable', 'server', 'busy', 'rejected', 'gone'];
    expect(all.filter(mayHaveLanded)).toEqual(['network', 'unreadable', 'server']);
  });
});

describe('detailsSignature — one version of the details', () => {
  it('ignores surrounding whitespace, as the server does', () => {
    expect(detailsSignature({ ...DETAILS, name: '  Asha Rao ' })).toBe(detailsSignature(DETAILS));
  });

  it.each(['name', 'company', 'role', 'linkedin', 'phone', 'email', 'note'] as const)(
    'changes when %s changes',
    field => {
      expect(detailsSignature({ ...DETAILS, [field]: `${DETAILS[field]}x` })).not.toBe(detailsSignature(DETAILS));
    }
  );

  it('tells fields apart, so moving a value between two of them is a change', () => {
    expect(detailsSignature({ ...DETAILS, company: 'SDE', role: 'Razorpay' })).not.toBe(detailsSignature(DETAILS));
  });
});

describe('newSubmissionKey — the best randomness the page has', () => {
  it('uses randomUUID when the page has it', () => {
    const getRandomValues = vi.fn();
    expect(newSubmissionKey({ randomUUID: () => 'from-native', getRandomValues })).toBe('from-native');
    expect(getRandomValues).not.toHaveBeenCalled();
  });

  it('builds one from getRandomValues when randomUUID throws', () => {
    const getRandomValues = vi.fn((array: Uint8Array) => array.fill(7));
    const key = newSubmissionKey({
      randomUUID: () => {
        throw new Error('not in this context');
      },
      getRandomValues,
    });
    expect(getRandomValues).toHaveBeenCalledTimes(1);
    expect(key).toBe('07070707-0707-4707-8707-070707070707');
  });

  it.each([0x00, 0xff])('sets the v4 version and variant bits whatever the bytes are (fill %i)', fill => {
    const key = newSubmissionKey({ getRandomValues: array => array.fill(fill) });
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('createIntakeSubmission — one key per submission', () => {
  it('reuses one key for every retry of a submission, edits included', () => {
    const mint = vi.fn(() => 'key-1');
    const submission = createIntakeSubmission(mint);

    const first = submission.keyFor(DETAILS);
    submission.settle({ kind: 'failed', failure: 'network' });
    const retry = submission.keyFor(DETAILS);
    submission.settle({ kind: 'failed', failure: 'server' });
    const afterEdit = submission.keyFor({ ...DETAILS, email: 'asha@example.com' });

    expect([first, retry, afterEdit]).toEqual(['key-1', 'key-1', 'key-1']);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('keeps the key after a success, so a stray send is a replay rather than a second person', () => {
    const submission = createIntakeSubmission(vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2'));
    submission.keyFor(DETAILS);
    submission.settle({ kind: 'saved', created: true });
    expect(submission.keyFor(DETAILS)).toBe('key-1');
  });

  it('mints a new key only after "Add someone else"', () => {
    const submission = createIntakeSubmission(vi.fn().mockReturnValueOnce('key-1').mockReturnValueOnce('key-2'));
    submission.keyFor(DETAILS);
    submission.settle({ kind: 'saved', created: true });
    submission.reset();
    expect(submission.keyFor({ ...DETAILS, name: 'Ravi Kumar' })).toBe('key-2');
  });

  it('says so when a replay means a later edit was not saved', () => {
    const submission = createIntakeSubmission(() => 'k');
    submission.keyFor(DETAILS);
    submission.settle({ kind: 'failed', failure: 'network' });
    submission.keyFor({ ...DETAILS, email: 'asha@example.com' });
    expect(submission.settle({ kind: 'saved', created: false })).toEqual({
      kind: 'done',
      created: false,
      editedAfterFirstTry: true,
    });
  });

  it('does not cry wolf: an unedited retry, or a retry that itself created the row', () => {
    const unedited = createIntakeSubmission(() => 'k');
    unedited.keyFor(DETAILS);
    unedited.settle({ kind: 'failed', failure: 'network' });
    unedited.keyFor({ ...DETAILS, name: ` ${DETAILS.name} ` }); // whitespace only: the same version
    expect(unedited.settle({ kind: 'saved', created: false })).toEqual({
      kind: 'done',
      created: false,
      editedAfterFirstTry: false,
    });

    const createdByRetry = createIntakeSubmission(() => 'k');
    createdByRetry.keyFor(DETAILS);
    createdByRetry.settle({ kind: 'failed', failure: 'network' });
    createdByRetry.keyFor({ ...DETAILS, email: 'asha@example.com' });
    expect(createdByRetry.settle({ kind: 'saved', created: true })).toEqual({
      kind: 'done',
      created: true,
      editedAfterFirstTry: false,
    });
  });

  it('tells a dead link after a lost answer apart from a dead link after a refusal', () => {
    const afterSilence = createIntakeSubmission(() => 'k');
    afterSilence.keyFor(DETAILS);
    expect(afterSilence.settle({ kind: 'failed', failure: 'network' })).toEqual({
      kind: 'problem',
      failure: 'network',
      earlierMayHaveLanded: false,
    });
    afterSilence.keyFor(DETAILS);
    expect(afterSilence.settle({ kind: 'failed', failure: 'gone' })).toEqual({
      kind: 'problem',
      failure: 'gone',
      earlierMayHaveLanded: true,
    });

    const afterRefusal = createIntakeSubmission(() => 'k');
    afterRefusal.keyFor(DETAILS);
    afterRefusal.settle({ kind: 'failed', failure: 'busy' });
    afterRefusal.keyFor(DETAILS);
    expect(afterRefusal.settle({ kind: 'failed', failure: 'gone' })).toMatchObject({ earlierMayHaveLanded: false });
  });

  it('forgets everything on reset', () => {
    const submission = createIntakeSubmission(() => 'k');
    submission.keyFor(DETAILS);
    submission.settle({ kind: 'failed', failure: 'network' });
    submission.keyFor({ ...DETAILS, email: 'asha@example.com' });
    submission.reset();

    submission.keyFor(DETAILS);
    expect(submission.settle({ kind: 'failed', failure: 'gone' })).toMatchObject({ earlierMayHaveLanded: false });
    submission.keyFor(DETAILS);
    expect(submission.settle({ kind: 'saved', created: false })).toMatchObject({ editedAfterFirstTry: false });
  });
});

describe('sendIntake — one send, which always ends', () => {
  it('posts the details with the key, to the encoded link', async () => {
    const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(
      async () => new Response(JSON.stringify({ ok: true, created: true, name: 'Asha Rao' }), { status: 201 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(sendIntake('tok/en?', DETAILS, 'key-1')).resolves.toEqual({ kind: 'saved', created: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/intake/tok%2Fen%3F');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ ...DETAILS, [KEY_FIELD]: 'key-1' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('never throws: a refused connection is a network failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      })
    );
    await expect(sendIntake('token', DETAILS, 'key-1')).resolves.toEqual({ kind: 'failed', failure: 'network' });
  });

  it('gives up on a request that never answers, instead of "Sending…" forever', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          })
      )
    );
    const pending = sendIntake('token', DETAILS, 'key-1');
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    await expect(pending).resolves.toEqual({ kind: 'failed', failure: 'network' });
  });

  it("does not believe a captive portal's 200", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response('<html><body>Sign in to Venue-WiFi</body></html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          })
      )
    );
    await expect(sendIntake('token', DETAILS, 'key-1')).resolves.toEqual({ kind: 'failed', failure: 'unreadable' });
  });
});

describe('withTimeout — a ceiling that cannot itself break the send', () => {
  it('aborts after the given time, and not before', () => {
    vi.useFakeTimers();
    const { signal } = withTimeout(1000);
    vi.advanceTimersByTime(999);
    expect(signal?.aborted).toBe(false);
    vi.advanceTimersByTime(1);
    expect(signal?.aborted).toBe(true);
  });

  it('is cancelled once the send is over', () => {
    vi.useFakeTimers();
    const { signal, done } = withTimeout(1000);
    done();
    vi.advanceTimersByTime(5000);
    expect(signal?.aborted).toBe(false);
  });

  it('degrades to no ceiling, rather than throwing, where AbortController is missing', () => {
    vi.stubGlobal('AbortController', undefined);
    const timeout = withTimeout(1000);
    expect(timeout.signal).toBeUndefined();
    expect(() => timeout.done()).not.toThrow();
  });
});
