#!/usr/bin/env tsx
/**
 * Hardware is a SUPPLY problem, established by scripts/diag-hardware-gap.ts: exactly 1 of
 * 788 upcoming events mentions real hardware vocabulary, so no amount of tagger work will
 * help. The only fix is sources.
 *
 * This finds them the way that has actually worked in this project — harvest the HOST
 * CALENDAR behind hardware events already in the corpus, rather than guessing handles
 * (0/35 on Meetup slugs, 5/36 on Bevy hosts, 18/107 on Luma handles).
 *
 * Read-only.
 *
 * Run: npx tsx scripts/probe-hardware-sources.ts
 */
import './load-env';
import mongoose from 'mongoose';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

/** Pull the cal- ids a Luma event page references — its host calendars. */
async function calendarsFor(url: string): Promise<string[]> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!res.ok) return [];
    const html = await res.text();
    return [...new Set([...html.matchAll(/"(cal-[A-Za-z0-9]{8,})"/g)].map(m => m[1]))];
  } catch {
    return [];
  }
}

async function upcomingOn(calId: string) {
  try {
    const res = await fetch(
      `https://api.lu.ma/calendar/get-items?calendar_api_id=${encodeURIComponent(calId)}&period=future&pagination_limit=50`,
      { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }
    );
    if (!res.ok) return { n: 0, samples: [] as string[], name: '' };
    const d = (await res.json()) as {
      entries?: Array<{ event?: { name?: string; start_at?: string; geo_address_info?: { city_state?: string } } }>;
    };
    const entries = d.entries ?? [];
    return {
      n: entries.length,
      name: '',
      samples: entries.slice(0, 4).map(e => {
        const ev = e.event ?? {};
        return `${String(ev.start_at ?? '').slice(0, 10)}  ${String(ev.name ?? '?').slice(0, 46)}  ${ev.geo_address_info?.city_state ?? ''}`;
      }),
    };
  } catch {
    return { n: 0, samples: [] as string[], name: '' };
  }
}

async function main() {
  await connectDB();
  const now = new Date();

  // Events already in the corpus that look like hardware, whatever they are tagged.
  const HW = /\b(hardware|robotic|drone|embedded|semiconductor|vlsi|fpga|electronics|chip|silicon|physical ai|deeptech|deep tech)\b/i;
  const candidates = await Event.find({
    startDateTime: { $gte: now },
    $or: [{ title: HW }, { organizer: HW }],
  })
    .select('title organizer source sourceUrl category')
    .lean();

  console.log(`${candidates.length} hardware-ish event(s) already in the corpus:\n`);
  for (const e of candidates) {
    console.log(`  [${e.source}] ${(e.title || '').slice(0, 56)}`);
    console.log(`      host: ${e.organizer ?? '?'}  cats: ${(e.category || []).join(', ')}`);
    console.log(`      ${e.sourceUrl}`);
  }

  // For the Luma ones, find the host calendar — that is the durable source.
  const lumaUrls = candidates
    .filter(e => e.source === 'luma' && typeof e.sourceUrl === 'string')
    .map(e => e.sourceUrl as string);

  console.log(`\nHarvesting host calendars from ${lumaUrls.length} Luma event page(s)…\n`);
  const seen = new Set<string>();
  for (const url of lumaUrls) {
    const cals = await calendarsFor(url);
    for (const cal of cals) {
      if (seen.has(cal)) continue;
      seen.add(cal);
      const { n, samples } = await upcomingOn(cal);
      console.log(`  ${n > 0 ? 'KEEP ' : 'empty'} ${cal}  upcoming=${n}`);
      for (const s of samples) console.log(`          ${s}`);
    }
  }

  console.log('\nAny calendar above with upcoming events and a hardware/deeptech bent is worth');
  console.log('adding to LUMA_SEED_CALENDARS in lib/scrapers/adapters/luma.ts.');

  await mongoose.disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
