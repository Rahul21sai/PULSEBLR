/**
 * Does the expanded registry mis-attribute real events?
 *
 * Read-only. This is the check that decides whether 234 new entries were safe, and it is the only
 * honest one available: an adversarial reviewer and a lexical screen both reason about names in the
 * abstract, whereas over-matching only ever happens against real scraped copy. The repo has been
 * here before — a naive match reported "Intel" 37 times off *intel*ligence, "CRED" 31 off
 * *cred*entials and "SAP" 157 — and none of that was visible in the registry, only in the corpus.
 *
 * WHAT IT DOES. Runs the production `resolveCompanies()` over every stored event, twice: once with
 * only the pre-existing companies and once with all of them. Then it NAMES every attribution the
 * expansion added, grouped by company, with the field that justified it — so each one can be judged
 * by eye rather than trusted because a total looked reasonable.
 *
 * WHY IT NAMES ROWS INSTEAD OF COUNTING THEM. `diag-offcity.ts` learned this the expensive way: a
 * diagnostic that reports "attributions rose from 109 to N" cannot distinguish 200 correct new
 * attributions from 150 correct ones and 50 that are wrong. The wrong ones are the entire question,
 * and they are only recognisable by reading them.
 *
 * HOW TO READ THE OUTPUT. A company with many new attributions is not automatically suspect — it may
 * genuinely run a lot of events. What is suspect is:
 *
 *   - an attribution justified by the TITLE or TAGS rather than the organiser, on a `distinctive`
 *     entry, where the matched text is clearly not the company;
 *   - a company appearing on events with no plausible connection to it;
 *   - a short or wordlike name appearing at all (those should all be `ambiguous`, and `ambiguous`
 *     names are only matched against the organiser field).
 *
 * Exits non-zero only if a `distinctive` NEW entry matched something outside the organiser field on
 * more than a handful of events, which is the shape of a real over-match rather than a busy host.
 */
import './load-env';
import connectDB from '../lib/mongodb';
import Event from '../lib/models/Event';
import { COMPANIES, type Company } from '../lib/companies/registry';
import { resolveCompanies } from '../lib/companies/resolve';

/**
 * The registry as it stood before the 2026-09-06 expansion.
 *
 * Hardcoded rather than derived, because the point is to compare against a FIXED baseline. Deriving
 * it (say, "everything above the marker comment") would silently change meaning the next time
 * somebody adds an entry, and this script would stop measuring what it claims to.
 */
const PRE_EXPANSION = new Set(
  `Google|Microsoft|Amazon|Meta|Apple|NVIDIA|IBM|Oracle|Intel|Qualcomm|Samsung|Cisco|Adobe|SAP|Dell|Uber|Atlassian|GitHub|GitLab|Postman|Docker|HashiCorp|JetBrains|BrowserStack|Vercel|Cloudflare|Twilio|Grafana|ServiceNow|VMware|MongoDB|Databricks|Snowflake|Confluent|Elastic|Redis|Hasura|Sarvam AI|Krutrim|Lyzr|Atlan|Fractal|Mu Sigma|Ola Krutrim|Razorpay|PhonePe|CRED|Zerodha|Groww|Jupiter|slice|Navi|Juspay|Setu|Zeta|Chargebee|JPMorgan|Goldman Sachs|Visa|PayPal|Flipkart|Swiggy|Zomato|Meesho|Myntra|Udaan|ShareChat|Dream11|Unacademy|Rapido|Urban Company|Freshworks|Zoho|Salesforce|HubSpot|Zluri|Whatfix|Darwinbox|Rippling|ThoughtWorks|Infosys|Wipro|TCS|Accenture|Deloitte|Walmart|Target|Intuit|Lowes|Tesco|Shell|Societe Generale|Accel|Peak XV|Blume Ventures|Lightspeed|Antler|Z47|Arkam Ventures|Y Combinator|The Product Folks|Hasgeek|GDG Bangalore|CNCF|OWASP|Devfolio|Bengaluru Tech Week|Bitshala|PyData Bangalore|AMD|Keysight|Texas Instruments|Bosch|Micron|Nokia|Logitech|Arm|OpenAI|Anthropic|ElevenLabs|Cartesia|kipi.ai|Magicball|ClickHouse|StarTree|SurrealDB|UiPath|n8n|Nutanix|HackerRank|Contentstack|Amadeus|Pine Labs|Hack2skill|HackCulture|DevAarambh|Outskill|Scaler|Apidays|FOSS United|Global AI Community`.split(
    '|'
  )
);

const BY_NAME = new Map<string, Company>(COMPANIES.map(c => [c.name, c]));

interface Hit {
  title: string;
  organizer: string;
  /** Which field justified it — the important column. */
  via: 'organizer' | 'title' | 'tags' | 'unclear';
  upcoming: boolean;
}

async function main() {
  await connectDB();

  const events = await Event.find({})
    .select('title organizer tags startDateTime')
    .lean();

  console.log(`Registry: ${COMPANIES.length} companies (${PRE_EXPANSION.size} pre-expansion)`);
  console.log(`Corpus:   ${events.length} stored events\n`);

  const now = new Date();
  const added = new Map<string, Hit[]>();

  for (const e of events) {
    const organizer = (e.organizer as string) || '';
    const title = (e.title as string) || '';
    const tags = (e.tags as string[]) || [];

    const all = resolveCompanies({ organizer, title, tags });
    for (const name of all) {
      if (PRE_EXPANSION.has(name)) continue;

      // Which field carried it? Re-resolve with one field at a time, using the production
      // function — never a reimplementation of its matching rules, for the reason
      // `diag-offcity.ts` imports the real predicate rather than mirroring it.
      const viaOrganizer = resolveCompanies({ organizer, title: null, tags: null }).includes(name);
      const viaTitle = resolveCompanies({ organizer: null, title, tags: null }).includes(name);
      const viaTags = resolveCompanies({ organizer: null, title: null, tags }).includes(name);

      const via: Hit['via'] = viaOrganizer
        ? 'organizer'
        : viaTitle
          ? 'title'
          : viaTags
            ? 'tags'
            : 'unclear';

      if (!added.has(name)) added.set(name, []);
      added.get(name)!.push({
        title: title.slice(0, 78),
        organizer: organizer.slice(0, 40),
        via,
        upcoming: new Date(e.startDateTime as Date) >= now,
      });
    }
  }

  const ranked = [...added.entries()].sort((a, b) => b[1].length - a[1].length);
  const totalNew = ranked.reduce((n, [, hits]) => n + hits.length, 0);

  console.log(
    `NEW ATTRIBUTIONS: ${totalNew} across ${ranked.length} newly-added companies\n` +
      '─'.repeat(100)
  );

  // The suspicious set: a `distinctive` new entry matched by something OTHER than the organiser.
  // That is where a false positive lives — an `ambiguous` entry cannot be matched outside the
  // organiser field at all, which is the whole point of the flag.
  const suspicious: Array<{ name: string; hits: Hit[] }> = [];

  for (const [name, hits] of ranked) {
    const company = BY_NAME.get(name);
    const strength = company?.strength ?? '?';
    const nonOrganizer = hits.filter(h => h.via !== 'organizer');
    const upcoming = hits.filter(h => h.upcoming).length;

    console.log(
      `\n${name}  [${strength}]  ${hits.length} event(s), ${upcoming} upcoming` +
        (nonOrganizer.length ? `  ⚠ ${nonOrganizer.length} matched OUTSIDE the organiser field` : '')
    );
    for (const h of hits.slice(0, 6)) {
      console.log(`   via ${h.via.padEnd(9)} | host: ${h.organizer || '(none)'} | ${h.title}`);
    }
    if (hits.length > 6) console.log(`   … and ${hits.length - 6} more`);

    if (strength === 'distinctive' && nonOrganizer.length > 3) {
      suspicious.push({ name, hits: nonOrganizer });
    }
  }

  console.log('\n' + '═'.repeat(100));
  if (!suspicious.length) {
    console.log(
      'No distinctive new entry matched outside the organiser field on more than 3 events.\n' +
        'Read the list above anyway — this check bounds the damage, it does not confirm every\n' +
        'attribution is correct.'
    );
    return;
  }

  console.log('SUSPECTED OVER-MATCH — each of these needs its strength reconsidered:');
  for (const s of suspicious) {
    console.log(`\n  ${s.name}: ${s.hits.length} non-organiser matches`);
    for (const h of s.hits.slice(0, 8)) {
      console.log(`    via ${h.via} | ${h.title}`);
    }
  }
  process.exitCode = 1;
}

main()
  .catch(err => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
