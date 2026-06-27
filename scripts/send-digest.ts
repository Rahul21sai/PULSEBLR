#!/usr/bin/env tsx
/**
 * Send daily digest email
 * Usage: npm run send-digest
 */

import { sendDailyDigestEmail } from '../lib/notifications/email';

async function main() {
  console.log('='.repeat(60));
  console.log('PulseBLR Daily Digest Sender');
  console.log('='.repeat(60));
  console.log('');

  const userEmail = process.env.USER_EMAIL;

  if (!userEmail) {
    console.error('❌ USER_EMAIL environment variable not set');
    console.error('Please set USER_EMAIL in .env.local');
    process.exit(1);
  }

  if (!process.env.RESEND_API_KEY) {
    console.error('❌ RESEND_API_KEY environment variable not set');
    console.error('Please set RESEND_API_KEY in .env.local');
    process.exit(1);
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