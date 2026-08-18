#!/usr/bin/env tsx
/**
 * Send daily digest email
 * Usage: npm run send-digest
 */

import './load-env'; // MUST be first — populates process.env from .env.local
import { sendDailyDigestEmail } from '../lib/notifications/email';
import connectDB from '../lib/mongodb';
import User from '../lib/models/User';

async function main() {
  console.log('='.repeat(60));
  console.log('PulseBLR Daily Digest Sender');
  console.log('='.repeat(60));
  console.log('');

  const userEmail = process.env.USER_EMAIL;

  // Email digests are OPTIONAL (see lib/notifications/email.ts — it degrades
  // gracefully). When Resend isn't configured we SKIP with exit 0 rather than
  // failing: a hard exit(1) here turns the scheduled GitHub Action red and
  // emails a failure every single day. Set RESEND_API_KEY + USER_EMAIL (locally
  // in .env.local, or as GitHub Actions secrets) to actually send the digest.
  if (!process.env.RESEND_API_KEY || !userEmail) {
    const missing = [
      !process.env.RESEND_API_KEY ? 'RESEND_API_KEY' : null,
      !userEmail ? 'USER_EMAIL' : null,
    ].filter(Boolean).join(', ');
    console.log(`ℹ️  Digest not configured (${missing} unset) — skipping, no email sent.`);
    process.exit(0);
  }

  try {
    // The digest's personal half is scoped by user id, so USER_EMAIL has to be
    // resolved to an actual account. Skipping with exit 0 (rather than failing) keeps
    // the scheduled Action green, matching how a missing RESEND_API_KEY is handled
    // above -- a red cron that emails a failure every morning gets muted, and then
    // real breakage goes unnoticed.
    await connectDB();
    const user = await User.findOne({ email: userEmail.toLowerCase() }).select('googleId').lean();
    if (!user) {
      console.log(
        `\u2139\ufe0f  No account found for USER_EMAIL (${userEmail}) -- sign in once with that ` +
          'Google account so the digest has tracker data to report. Skipping, no email sent.'
      );
      process.exit(0);
    }

    const success = await sendDailyDigestEmail({
      to: userEmail,
      userId: user.googleId,
    });

    if (success) {
      console.log('');
      console.log('✅ Daily digest sent successfully!');
      console.log(`📧 Sent to: ${userEmail}`);
      console.log('');
      process.exit(0);
    } else {
      console.log('');
      console.log('❌ Failed to send daily digest');
      console.log('');
      process.exit(1);
    }
  } catch (error) {
    console.error('');
    console.error('❌ Fatal error sending digest:');
    console.error(error);
    console.error('');
    process.exit(1);
  }
}

main();

// Made with Bob