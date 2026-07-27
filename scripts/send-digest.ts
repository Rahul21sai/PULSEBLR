#!/usr/bin/env tsx
/**
 * Send daily digest email
 * Usage: npm run send-digest
 */

import './load-env'; // MUST be first — populates process.env from .env.local
import { sendDailyDigestEmail } from '../lib/notifications/email';

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
    const success = await sendDailyDigestEmail({
      to: userEmail,
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