#!/usr/bin/env tsx
/**
 * Board-game nights are leaking into the tech feed through `Gaming/XR`.
 *
 * Found by looking at the actual first page of the default feed rather than at a total:
 * `/api/events?techOnly=true` returned "Independence from Screens : BoardGaming Sunday" as its
 * top result.
 *
 * WHY THE CONSISTENCY FIX COULD NOT CATCH THIS:
 * diag-tech-consistency.ts / retag-events.ts --inconsistent only select documents where
 * `isTechEvent` CONTRADICTS the tech-topic categories. A board-game night tagged `Gaming/XR`
 * with isTechEvent=true is perfectly self-consistent — and wrong. Internal consistency is not
 * correctness, and a metric that only finds contradictions is blind to agreed-upon errors.
 *
 * WHY `Gaming/XR` SPECIFICALLY:
 * It is the one entry in TECH_CATEGORY_NAMES whose everyday meaning is a LEISURE activity.
 * "AI/ML" and "Cloud/DevOps" have no casual sense; "gaming" does, and Bengaluru runs a lot of
 * board-game meetups. So the taxonomy invites this confusion in a way no other tech topic does.
 *
 * This measures the leak and names every event, so the fix can be chosen from evidence:
 * whether to sharpen the prompt, to narrow the keyword regex, or to accept it.
 *
 * Read-only.
 *
 * Run: npx tsx scripts/diag-gamingxr-leak.ts
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import mongoose from 'mongoose';

/** Leisure gaming, as opposed to games ENGINEERING. */
const LEISURE = /\b(board ?game|boardgaming|tabletop|catan|chess|carrom|poker|quiz night|trivia|dungeons|d&d|mafia|werewolf|card game|jenga|uno|monopoly|scrabble|bingo|karaoke|open mic|jam(?:ming)?|social|mixer|potluck|picnic|walk|trek)\b/i;

/** Actual games/XR engineering. */
const ENGINEERING = /\b(unity|unreal|godot|game dev|gamedev|game engine|shader|\bvr\b|\bar\b|\bxr\b|metaverse|esports|webgl|three\.?js|blender|rendering|physics engine|multiplayer netcode)\b/i;

async function main() {
  await connectDB();
  const now = new Date();

  const rows = await Event.find(
    {
      category: 'Gaming/XR',
      $or: [{ startDateTime: { $gte: now } }, { endDateTime: { $gte: now } }],
    },
    { title: 1, description: 1, category: 1, isTechEvent: 1, source: 1, connectionScore: 1 }
  ).lean();

  const inTechFeed = rows.filter(r => r.isTechEvent);

  console.log(`upcoming events tagged Gaming/XR: ${rows.length}`);
  console.log(`  of those, in the default tech feed: ${inTechFeed.length}\n`);

  const leisure: typeof rows = [];
  const engineering: typeof rows = [];
  const unclear: typeof rows = [];

  for (const r of rows) {
    const text = `${r.title ?? ''} ${r.description ?? ''}`;
    const isEng = ENGINEERING.test(text);
    const isLeisure = LEISURE.test(text);
    // Engineering wins a tie: "Unity game jam" is both, and it is a tech event.
    if (isEng) engineering.push(r);
    else if (isLeisure) leisure.push(r);
    else unclear.push(r);
  }

  const leaking = leisure.filter(r => r.isTechEvent);

  console.log(`  games ENGINEERING (Unity/Unreal/XR/…):  ${engineering.length}   in tech feed ${engineering.filter(r => r.isTechEvent).length}`);
  console.log(`  LEISURE gaming (board games, quizzes):  ${leisure.length}   in tech feed ${leaking.length}  ← the leak`);
  console.log(`  unclear:                                ${unclear.length}   in tech feed ${unclear.filter(r => r.isTechEvent).length}`);

  console.log('\n── LEAKING: leisure events sitting in the tech feed');
  if (leaking.length === 0) console.log('  (none)');
  for (const r of leaking) {
    console.log(`  ${String(r.source).padEnd(11)} score ${String(r.connectionScore ?? '-').padStart(3)}  ${String(r.title).slice(0, 50).padEnd(50)} [${(r.category || []).join(', ')}]`);
  }

  console.log('\n── legitimate games engineering (must NOT be removed by any fix)');
  if (engineering.length === 0) console.log('  (none)');
  for (const r of engineering) {
    console.log(`  ${String(r.source).padEnd(11)} tech=${String(r.isTechEvent).padEnd(5)} ${String(r.title).slice(0, 50).padEnd(50)} [${(r.category || []).join(', ')}]`);
  }

  console.log('\n── unclear, listed so the judgement is visible rather than assumed');
  for (const r of unclear.slice(0, 15)) {
    console.log(`  ${String(r.source).padEnd(11)} tech=${String(r.isTechEvent).padEnd(5)} ${String(r.title).slice(0, 50).padEnd(50)} [${(r.category || []).join(', ')}]`);
  }

  await mongoose.disconnect();
}

main().catch(async e => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
