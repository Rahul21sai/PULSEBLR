import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `.github/workflows/daily-push-reminders.yml`, and above all its preflight step.
 *
 * WHY THE SHELL IS EXECUTED RATHER THAN READ. The preflight's whole job is to turn "an unset secret"
 * into the right exit code, and the failure it guards against is a SILENT one: the sender exits 0
 * when unconfigured, and daily-digest.yml measured nine green mornings that sent nothing. A regex over
 * the YAML would pass on a script that says the right words and exits 0 on the wrong branch. So each
 * branch is run for real, under the same `bash -eo pipefail` GitHub uses, with `npx` replaced by a
 * shell function that plays back a canned dry-run report. No database, no network, no npm.
 *
 * WHY GIT BASH IS LOCATED EXPLICITLY ON WINDOWS. `bash` on a Windows PATH is usually
 * `C:\Windows\System32\bash.exe`, which is WSL: it does not see this process's environment, so every
 * case would "pass" or fail for reasons that have nothing to do with the script. CI is Linux, where
 * plain `bash` is right. Where no suitable bash exists the executed cases are skipped, not failed.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'daily-push-reminders.yml');
const PREFLIGHT = 'Verify push is configured, or that nobody has subscribed';
const SEND = 'Send push reminders';

type Step = { name?: string; run?: string; env?: Record<string, string>; uses?: string };
type Workflow = {
  on: { schedule?: { cron: string }[]; workflow_dispatch?: { inputs?: Record<string, unknown> } };
  jobs: Record<string, { steps: Step[] }>;
};

function workflow(): Workflow {
  return load(readFileSync(WORKFLOW, 'utf8')) as Workflow;
}

function step(name: string): Step {
  const found = workflow().jobs['send-push-reminders']?.steps.find(s => s.name === name);
  expect(found, `step "${name}" is missing`).toBeTruthy();
  return found as Step;
}

function findBash(): string | null {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    process.env.PULSEBLR_TEST_BASH,
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
  ];
  return candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate))) ?? null;
}

const BASH = findBash();

/** The same shape `scripts/generate-vapid-keys.ts` mints: raw point and raw scalar, base64url. */
function vapidPair(): { publicKey: string; privateKey: string } {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, 'base64url'),
    Buffer.from(jwk.y as string, 'base64url'),
  ]);
  return { publicKey: point.toString('base64url'), privateKey: jwk.d as string };
}

const PAIR = vapidPair();
const CONFIGURED = {
  VAPID_SUBJECT: 'mailto:ops@pulseblr.example',
  VAPID_PUBLIC_KEY: PAIR.publicKey,
  VAPID_PRIVATE_KEY: PAIR.privateKey,
};
const UNCONFIGURED = { VAPID_SUBJECT: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' };

/** What `summarise()` in scripts/send-push-reminders.ts prints, for a given count. */
function dryReport(subscribers: number): string {
  return [
    '='.repeat(62),
    'PulseBLR Push Reminders — DRY RUN, nothing will be written or sent',
    '='.repeat(62),
    '✅ MongoDB connected successfully',
    '',
    `accounts with a subscription   ${subscribers}`,
    'devices considered             0',
  ].join('\n');
}

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Outcome {
  status: number | null;
  output: string;
  npxCalls: string[];
}

/**
 * Run the preflight exactly as the runner would, with `npx` stubbed.
 *
 * A shell FUNCTION rather than a fake binary on PATH: bash resolves functions before PATH, so there
 * is no Windows/POSIX PATH translation to get wrong, and command substitution inherits it.
 */
function runPreflight(env: Record<string, string>, fake: { output?: string; exit?: number } = {}): Outcome {
  const dir = mkdtempSync(path.join(tmpdir(), 'pulseblr-push-preflight-'));
  scratch.push(dir);
  // Forward slashes: Git Bash accepts `C:/…`, and a backslash path is one escape away from wrong.
  const log = path.join(dir, 'npx.log').replace(/\\/g, '/');

  const stub = [
    'npx() {',
    '  printf "%s\\n" "npx $*" >> "$NPX_LOG"',
    '  printf "%s\\n" "$FAKE_DRY_OUTPUT"',
    '  return "${FAKE_DRY_EXIT:-0}"',
    '}',
  ].join('\n');

  const result = spawnSync(
    BASH as string,
    ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${stub}\n${step(PREFLIGHT).run}`],
    {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        MONGODB_URI: 'mongodb+srv://ci.example/pulseblr',
        DRY_RUN: 'false',
        ...env,
        NPX_LOG: log,
        FAKE_DRY_OUTPUT: fake.output ?? dryReport(0),
        FAKE_DRY_EXIT: String(fake.exit ?? 0),
      },
    }
  );

  const npxCalls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, npxCalls };
}

// Spawning a shell is slower than a pure function, and Git Bash cold-starts slowly on Windows.
const SHELL_TIMEOUT = 20_000;
const shellIt = it.skipIf(!BASH);

describe('daily-push-reminders.yml — preflight, executed', () => {
  shellIt('passes a complete, well-formed, matching key pair without counting anybody', () => {
    const run = runPreflight(CONFIGURED);
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('Push secrets present and well-formed');
    expect(run.npxCalls).toEqual([]);
  }, SHELL_TIMEOUT);

  shellIt('fails without MONGODB_URI, before deciding anything else', () => {
    const run = runPreflight({ ...CONFIGURED, MONGODB_URI: '' });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('::error::MONGODB_URI');
    expect(run.npxCalls).toEqual([]);
  }, SHELL_TIMEOUT);

  shellIt('fails a PARTLY configured push and names what is missing', () => {
    const run = runPreflight({ ...CONFIGURED, VAPID_SUBJECT: '' });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/::error::Push is only PARTLY configured: VAPID_SUBJECT unset/);
    expect(run.npxCalls).toEqual([]);
  }, SHELL_TIMEOUT);

  shellIt('warns and skips when nothing is configured and nobody has subscribed', () => {
    const run = runPreflight(UNCONFIGURED, { output: dryReport(0) });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('::warning::Push is not configured and no account has subscribed');
    // The count really came from the sender's own dry run, not from a guess.
    expect(run.npxCalls).toEqual(['npx tsx scripts/send-push-reminders.ts --dry']);
  }, SHELL_TIMEOUT);

  shellIt('FAILS when nothing is configured but somebody has subscribed', () => {
    const run = runPreflight(UNCONFIGURED, { output: dryReport(2) });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('::error::2 account(s) have turned on push notifications');
  }, SHELL_TIMEOUT);

  shellIt.each([
    ['the count line is missing', 'PulseBLR Push Reminders\n✅ Dry run complete.'],
    ['the count is not a number', 'accounts with a subscription   many'],
    ['the count line was reworded', 'accounts subscribed   0'],
  ])('fails CLOSED when %s, rather than reading "no count" as "nobody"', (_label, output) => {
    const run = runPreflight(UNCONFIGURED, { output });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("::error::Could not read 'accounts with a subscription'");
  }, SHELL_TIMEOUT);

  shellIt('reads the FIRST count when the line appears twice, instead of failing open', () => {
    // Two matches would make the captured value "3\n3". Unguarded, `[ "3\n3" -gt 0 ]` exits 2,
    // `if` treats that as false, and the step warns and skips while three people wait.
    const run = runPreflight(UNCONFIGURED, { output: `${dryReport(3)}\n${dryReport(3)}` });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('::error::3 account(s) have turned on push notifications');
  }, SHELL_TIMEOUT);

  shellIt('fails when the dry run that would count subscribers itself fails', () => {
    const run = runPreflight(UNCONFIGURED, { output: 'MongoServerSelectionError: timed out', exit: 1 });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('dry run that would say whether anybody is');
  }, SHELL_TIMEOUT);

  shellIt('does not enforce keys on a DRY-RUN dispatch, which needs none', () => {
    const run = runPreflight({ ...UNCONFIGURED, DRY_RUN: 'true' }, { output: dryReport(5) });
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain('::warning::Dry run, so not enforced');
    expect(run.npxCalls).toEqual([]);
  }, SHELL_TIMEOUT);

  shellIt.each([
    ['a bare address', 'ops@pulseblr.example'],
    ['an http: URL', 'http://pulseblr.example'],
    ['whitespace after the scheme', 'mailto: ops@pulseblr.example'],
  ])('fails a VAPID_SUBJECT that is %s', (_label, subject) => {
    const run = runPreflight({ ...CONFIGURED, VAPID_SUBJECT: subject });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/::error::VAPID_SUBJECT (must be|contains whitespace)/);
  }, SHELL_TIMEOUT);

  shellIt('names SWAPPED keys as swapped', () => {
    const run = runPreflight({
      ...CONFIGURED,
      VAPID_PUBLIC_KEY: PAIR.privateKey,
      VAPID_PRIVATE_KEY: PAIR.publicKey,
    });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('look SWAPPED');
  }, SHELL_TIMEOUT);

  shellIt('fails two well-formed halves of DIFFERENT pairs', () => {
    const other = vapidPair();
    const run = runPreflight({ ...CONFIGURED, VAPID_PRIVATE_KEY: other.privateKey });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY');
  }, SHELL_TIMEOUT);

  shellIt.each([
    ['padded with =', `${PAIR.publicKey.slice(0, 86)}=`],
    ['standard base64 with / and +', `${PAIR.publicKey.slice(0, 85)}/+`],
    ['one character short', PAIR.publicKey.slice(0, 86)],
  ])('fails a public key that is %s', (_label, publicKey) => {
    const run = runPreflight({ ...CONFIGURED, VAPID_PUBLIC_KEY: publicKey });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain('::error::VAPID_PUBLIC_KEY is not an 87-character');
  }, SHELL_TIMEOUT);
});

describe('daily-push-reminders.yml — shape', () => {
  it('is scheduled', () => {
    expect(workflow().on.schedule?.map(entry => entry.cron)).toEqual(['30 3 * * *']);
  });

  it('gives the send step the four variables the push path reads, and no email or session secret', () => {
    // The push path reads MONGODB_URI and the three VAPID variables, nothing else (grep
    // `process.env` across lib/notifications/push.ts and what it imports). RESEND_API_KEY and
    // NEXTAUTH_SECRET belong to the email job; this one has no business holding them.
    expect(Object.keys(step(SEND).env ?? {}).sort()).toEqual(
      [
        'DRY_RUN',
        'MONGODB_URI',
        'ONLY_EMAIL',
        'RETRY_FAILED',
        'VAPID_PRIVATE_KEY',
        'VAPID_PUBLIC_KEY',
        'VAPID_SUBJECT',
      ].sort()
    );
    expect(readFileSync(WORKFLOW, 'utf8')).not.toMatch(/secrets\.(RESEND_API_KEY|NEXTAUTH_SECRET|NEXTAUTH_URL|EMAIL_FROM)/);
  });

  it('never interpolates an expression into a shell command, so a dispatch input is only ever data', () => {
    for (const s of workflow().jobs['send-push-reminders'].steps) {
      expect(s.run ?? '', `step "${s.name}" pastes \${{ }} into its script`).not.toContain('${{');
    }
  });

  it('exposes the three dispatch inputs the script understands', () => {
    expect(Object.keys(workflow().on.workflow_dispatch?.inputs ?? {}).sort()).toEqual(
      ['dry_run', 'only_email', 'retry_failed']
    );
  });
});
