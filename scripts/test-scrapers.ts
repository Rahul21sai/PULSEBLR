// Ad-hoc live test for the rewritten scrapers. No DB writes.
// Run: npx tsx scripts/test-scrapers.ts
import { scrapeLumaCalendar } from '../lib/scrapers/luma';
import { scrapeMeetupRSS } from '../lib/scrapers/meetup-rss';

function preview(label: string, events: { title: string; startDateTime: Date; venue?: string; sourceUrl: string }[], errors: string[]) {
  console.log(`\n=== ${label}: ${events.length} upcoming events, ${errors.length} errors ===`);
  for (const e of events.slice(0, 5)) {
    console.log(`  • ${e.startDateTime.toISOString()}  ${e.title.slice(0, 60)}  [${e.venue ?? 'online'}]`);
  }
  if (errors.length) console.log('  errors:', errors.slice(0, 3));
}

async function main() {
  const luma = await scrapeLumaCalendar('https://luma.com/bengaluru');
  preview('Luma bengaluru', luma.events, luma.errors);

  const meetup = await scrapeMeetupRSS('https://www.meetup.com/bangpypers/events/rss/');
  preview('Meetup bangpypers', meetup.events, meetup.errors);
}

main().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
