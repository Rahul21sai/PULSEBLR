#!/usr/bin/env tsx
/**
 * Who WOULD get a morning-after follow-up nudge right now — against the real database, sending
 * nothing and writing nothing.
 *
 * Usage:
 *   npx tsx scripts/diag-followup-nudge.ts --dry
 *   npx tsx scripts/diag-followup-nudge.ts --dry --now=2026-09-28T03:30:00Z   # as if at 09:00 IST that day
 *   npx tsx scripts/diag-followup-nudge.ts --dry --assume-subscribed --scan-days=60   # the selection on real folders
 *
 * READ-ONLY BY CONSTRUCTION, not by care: it calls the real sender with `dryRun: true`, which loads
 * no key material, claims no `ReminderLog` row and sends nothing — the same path the workflow's
 * preflight relies on. `--dry` is REQUIRED anyway, so nobody reads this file's name and assumes it
 * might send. It runs the production loader (`loadNudgeRows`) and the production policy, so what it
 * reports is what the 09:00 IST run would do, not a second definition of "who qualifies".
 *
 * PRINTS NO PERSONAL DATA. Accounts are numbered, not named; no email, no user id, no contact. What is
 * printed per nudge is the event's title (the user's own folder name) and two counts, which is exactly
 * what the notification itself would carry.
 */
import './load-env'; // MUST be first
import mongoose from 'mongoose';
import { loadNudgeRows, sendFollowUpNudges } from '../lib/notifications/followup-nudge';
import { planFollowUpNudges } from '../lib/notifications/followup-nudge-policy';
import { FOLLOWUP_NUDGE_KIND } from '../lib/notifications/reminder-policy';
import Folder from '../lib/models/Folder';
import ReminderLog from '../lib/models/ReminderLog';
import User from '../lib/models/User';
import { dayKeyIST, dayKeyOffsetIST } from '../lib/format';
import { toLogLine } from '../lib/security/control-chars';

async function main() {
  if (!process.argv.includes('--dry')) {
    console.error('Refusing to run without --dry. This script only ever reports; pass --dry to say you know that.');
    process.exit(2);
  }
  const nowArg = process.argv.find(arg => arg.startsWith('--now='))?.slice('--now='.length);
  const now = nowArg ? new Date(nowArg) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now is not a date: "${nowArg}"`);
    process.exit(2);
  }

  console.log('='.repeat(62));
  console.log('Morning-after follow-up nudge — DRY RUN, nothing written or sent');
  console.log(`as of ${now.toISOString()} (IST day ${dayKeyIST(now)}); "yesterday" = ${dayKeyOffsetIST(-1, now)}`);
  console.log('='.repeat(62));

  const report = await sendFollowUpNudges({ dryRun: true, now });

  const tally = new Map<string, number>();
  for (const row of report.perUser) tally.set(row.outcome, (tally.get(row.outcome) ?? 0) + 1);

  console.log(`accounts with a push subscription  ${report.usersWithSubscriptions}`);
  console.log(`opted out of follow-up nudges      ${report.optedOut}`);
  console.log(`outcomes                           ${[...tally].map(([k, v]) => `${k} ${v}`).join(' · ') || '(none)'}`);

  const wouldSend = report.perUser.filter(row => row.nudges.length > 0);
  const nudges = wouldSend.reduce((sum, row) => sum + row.nudges.length, 0);
  console.log(`notifications that WOULD be sent   ${nudges}`);

  report.perUser.forEach((row, index) => {
    if (row.candidates === 0 && row.outcome === 'nothing-due') return;
    const bits = [
      `candidates ${row.candidates}`,
      `already ${row.alreadyLogged}`,
      row.deferred ? `deferred ${row.deferred}` : null,
      `pushes today ${row.pushesSentToday}`,
      `devices ${row.devices}`,
    ]
      .filter(Boolean)
      .join(' · ');
    console.log(`  account #${index + 1}  ${row.outcome.padEnd(14)} ${bits}`);
    for (const nudge of row.nudges) {
      console.log(`      · ${toLogLine(nudge.title, 80)} — met ${nudge.metCount}, to follow up ${nudge.pendingCount}`);
    }
  });

  if (report.usersWithSubscriptions === 0) {
    console.log('');
    console.log('No account has a push subscription, so nobody can be nudged. That is consent, not a bug.');
  }

  /*
   * --assume-subscribed [--scan-days=N]: the SELECTION, measured on real folders, as if every account
   * that owns a folder had turned push on. Consent is the one input this replaces, so what it shows is
   * "the data would produce this" rather than "this would be sent". With --scan-days it replays the
   * previous N mornings (09:00 IST each), which is how to see the hand-made-folder decision on real
   * data when today happens to be quiet. Still read-only: `loadNudgeRows` and `planFollowUpNudges`
   * write nothing, and the claimed-row lookup is a find.
   */
  if (process.argv.includes('--assume-subscribed')) {
    const days = Number(process.argv.find(arg => arg.startsWith('--scan-days='))?.split('=')[1] ?? '0');
    const owners = (await Folder.distinct('userId')) as string[];
    console.log('');
    console.log(`── as if subscribed: ${owners.length} account(s) own a folder ──`);
    for (let back = 0; back <= (Number.isFinite(days) ? Math.min(days, 120) : 0); back += 1) {
      const morning = new Date(`${dayKeyOffsetIST(-back, now)}T09:00:00+05:30`);
      const lines: string[] = [];
      for (const [index, userId] of owners.entries()) {
        const rows = await loadNudgeRows(userId, morning);
        const logged = await ReminderLog.find({ userId, kind: FOLLOWUP_NUDGE_KIND }).select('eventId').lean();
        const plan = planFollowUpNudges({
          userId,
          now: morning,
          hasSubscription: true,
          preference: await User.findOne({ googleId: userId }).select('pushFollowUpNudges').lean(),
          ...rows,
          claimedSubjectIds: logged.map(row => String(row.eventId)),
          pushesSentToday: 0,
        });
        for (const nudge of plan.send) {
          lines.push(
            `  account #${index + 1}  ${nudge.eventId ? 'linked ' : 'by hand'}  ${toLogLine(nudge.title, 60)} — met ${nudge.metCount}, to follow up ${nudge.pendingCount}`
          );
        }
      }
      if (lines.length > 0 || back === 0) {
        console.log(`morning of ${dayKeyIST(morning)} (yesterday = ${dayKeyOffsetIST(-1, morning)}): ${lines.length} nudge(s)`);
        for (const line of lines) console.log(line);
      }
    }
  }

  await mongoose.disconnect();
}

main().catch(async error => {
  console.error('diag-followup-nudge failed:', error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
