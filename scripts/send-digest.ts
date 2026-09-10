#!/usr/bin/env tsx
/**
 * Send today's digest emails — to exactly the people whose stored cadence says today.
 *
 * Usage:
 *   npm run send-digest                              # send
 *   npx tsx scripts/send-digest.ts --dry             # decide and report, write nothing, send nothing
 *   npx tsx scripts/send-digest.ts --only=me@example.com
 *   npx tsx scripts/send-digest.ts --max-events=3
 *   npx tsx scripts/send-digest.ts --retry-failed
 *
 * ── WHAT THIS SCRIPT USED TO DO, AND WHY IT HAD TO CHANGE. ──────────────────────────────────────
 * It resolved one hardcoded `USER_EMAIL`, built `generateDailyDigest` for that account and mailed it
 * EVERY MORNING. `User.preferences.digestFrequency` had existed since preferences landed, with three
 * documented values and `'weekly'` as the default, and nothing anywhere read it — so the cadence a
 * user picked had no effect whatsoever, and the only person who could receive a digest was whoever
 * held the `USER_EMAIL` secret.
 *
 * Two consequences of walking every user instead, both deliberate:
 *
 *   · `USER_EMAIL` IS NO LONGER READ. Recipients come from the `User` collection and their own stored
 *     preference. The secret can stay set in the workflow; it is simply ignored. `--only=` is the
 *     replacement for "just me", and it is better because it cannot silently become the only
 *     recipient for a year.
 *   · THE SOURCE-HEALTH SECTION IS GONE FROM WHAT GETS MAILED. `generateDailyDigest` includes
 *     `getUnhealthySources()`, which names every failing scraper and quotes its `lastError` string.
 *     That was fine while the one recipient was the operator. It is a disclosure of internals the
 *     moment the recipient list is "every consenting user", so the scheduled mailing now uses the
 *     narrower `formatDigestEmail`. The old formatter and its source-health section are untouched and
 *     still serve `GET /api/notifications/send-digest`, which is admin-only.
 *
 * IDEMPOTENT AND SAFE TO RE-RUN, which is the property the workflow depends on. Every digest already
 * mailed carries a `DigestLog` row keyed `{ userId, kind, periodKey }`, and a second run in the same
 * period finds it and sends nothing — so a retried Action, a manual `workflow_dispatch` firing next to
 * the schedule, and an operator running this by hand against the same Atlas database all converge on
 * at most one digest per person per period. The guard is a unique index, not a check in this file.
 *
 * IT EXITS 0 WHEN IT IS NOT CONFIGURED, as it always has, for the reason recorded here originally: a
 * hard failure turns the scheduled Action red and emails a failure every single morning, and a cron
 * that cries wolf daily gets muted — after which real breakage goes unnoticed. A genuine send failure
 * DOES exit 1, because that is a fault worth waking up to.
 */

import './load-env'; // MUST be first — populates process.env from .env.local
import { sendScheduledDigests, type SendDigestReport } from '../lib/notifications/digest';
import { istWeekday, WEEKLY_DIGEST_IST_WEEKDAY } from '../lib/notifications/digest-schedule';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function value(name: string): string | undefined {
  const hit = process.argv.find(arg => arg.startsWith(`--${name}=`));
  return hit?.split('=').slice(1).join('=') || undefined;
}

function numeric(name: string): number | undefined {
  const raw = value(name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  // A typo must not silently become a different policy: `--max-events=five` would otherwise parse to
  // NaN and every digest would come out empty, reported as "nothing to say".
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`❌ --${name} must be a positive number (got "${raw}")`);
    process.exit(2);
  }
  return parsed;
}

function summarise(report: SendDigestReport, now: Date): void {
  console.log('');
  console.log(`users considered   ${report.usersConsidered}`);
  console.log(`  due today        ${report.usersDue}`);
  console.log(`  never asked      ${report.neverAsked}`);
  console.log(`  opted out (off)  ${report.optedOut}`);
  console.log(`  not due today    ${report.notDue}`);
  console.log(`emails sent        ${report.emailsSent}`);
  console.log(`emails failed      ${report.emailsFailed}`);
  console.log(`events mailed      ${report.eventsMailed}`);

  if (report.perUser.length > 0) {
    console.log('');
    console.log('per user — outcome, address, and WHY:');
    for (const row of report.perUser) {
      const bits = [
        `cadence ${row.frequency ?? '—'}`,
        row.periodKey ? `period ${row.periodKey}` : null,
        row.events ? `events ${row.events}` : null,
        row.sentToday ? `already today ${row.sentToday}` : null,
        row.raced ? 'raced' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      // The address is printed because this is an operator tool run against their own data, and
      // "which account did nothing happen for" is the first question every time.
      console.log(`  ${row.outcome.padEnd(14)} ${row.email.padEnd(38)} ${bits}`);
      if (row.error) console.log(`                 ↳ ${row.error}`);
    }
  }

  /*
   * THE TWO STATES THAT LOOK LIKE A BUG AND ARE NOT. Both are printed unconditionally when they
   * apply, because the first person to run this and see "emails sent 0" will otherwise conclude the
   * sender is broken and go looking in the wrong file.
   */
  if (report.usersDue === 0 && report.neverAsked > 0) {
    console.log('');
    console.log(
      `ℹ️  ${report.neverAsked} user(s) have never been asked, so nobody is due and nothing was ` +
        'sent. That is deliberate: `preferences.digestFrequency` DEFAULTS TO "weekly" in the schema, ' +
        'so the cadence alone is not consent — `preferences.onboardedAt` must also be set, which ' +
        '`PUT /api/me/preferences` stamps on any save including a skip. See digestDecision() in ' +
        'lib/notifications/digest-schedule.ts.'
    );
  }

  if (report.notDue > 0 && istWeekday(now) !== WEEKLY_DIGEST_IST_WEEKDAY) {
    console.log('');
    console.log(
      `ℹ️  ${report.notDue} user(s) are on the weekly cadence and today is not Monday in IST, so ` +
        'they are correctly skipped. The workflow runs every morning ON PURPOSE and this policy is ' +
        'what turns six of those seven runs into a no-op for a weekly subscriber — the cadence is a ' +
        'preference, not a cron schedule.'
    );
  }
}

async function main() {
  const dryRun = flag('dry') || flag('dry-run');
  const now = new Date();

  console.log('='.repeat(60));
  console.log(`PulseBLR Digest Sender${dryRun ? ' — DRY RUN, nothing will be written or sent' : ''}`);
  console.log('='.repeat(60));

  try {
    const report = await sendScheduledDigests({
      now,
      dryRun,
      onlyEmail: value('only'),
      maxEvents: numeric('max-events'),
      maxPerDay: numeric('max-per-day'),
      retryFailed: flag('retry-failed'),
    });

    if (report.notConfigured.length > 0) {
      // Skip, not fail. See the header.
      console.log('');
      console.log(
        `ℹ️  Digest not configured (${report.notConfigured.join(', ')} unset) — skipping, no email ` +
          'sent.'
      );
      console.log(
        '   NEXTAUTH_SECRET is required because it signs the unsubscribe link. An email with no ' +
          'working way off the list is worse than no email, so nothing is sent without it.'
      );
      process.exit(0);
    }

    summarise(report, now);

    if (report.emailsFailed > 0) {
      console.log('');
      console.log(
        `❌ ${report.emailsFailed} email(s) failed. Their DigestLog rows are marked 'failed' and are ` +
          'NOT retried automatically — a failure reported by the client does not prove the message ' +
          'was undelivered, and re-sending on a false negative is the duplicate this design ' +
          'refuses. Run with --retry-failed once you have decided.'
      );
      process.exit(1);
    }

    console.log('');
    console.log(dryRun ? '✅ Dry run complete.' : '✅ Digest run complete.');
    process.exit(0);
  } catch (error) {
    console.error('');
    console.error('❌ Fatal error sending the digest:');
    console.error(error);
    process.exit(1);
  }
}

main();
