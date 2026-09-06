// Registry of companies and communities with a Bengaluru event presence.
//
// PURPOSE: the product goal is "every company in Bangalore that runs events is
// listed, from Google down to the startups". Platform search cannot deliver that
// (measured: a nonsense keyword returns the same 12 results as "Google", and only
// 5 of those 12 even mention Google). What DOES work is resolving the host strings
// we already scrape — 86% of stored events name their organiser — into canonical
// companies. This registry is that mapping.
//
// THE AMBIGUITY PROBLEM, which drives the whole shape of this file:
// A naive substring match is actively harmful. Measured against the live corpus,
// matching company names as plain substrings reported "Intel" 37 times (it was
// matching *intel*ligence), "CRED" 31 (*cred*entials, in*cred*ible), "SAP" 157,
// "Meta" (*meta*data, *meta*verse) and "Target" (the ordinary verb). So every entry
// declares how confidently its name can be matched:
//
//   strength: 'distinctive'  The name is effectively unique. Safe to match anywhere,
//                            including descriptions. e.g. Razorpay, BrowserStack.
//   strength: 'ambiguous'    The name is also a common word or word-fragment. Match
//                            ONLY in the organiser/host field, where a bare mention
//                            means the company really is the host. e.g. Intel, Meta,
//                            Target, CRED, SAP, Apple, Docker, Redis.
//
// Adding a company is a one-line entry. Getting `strength` wrong is the one way to
// do real damage, so when in doubt choose 'ambiguous'.

export type CompanyStrength = 'distinctive' | 'ambiguous';

export type CompanySector =
  | 'Big Tech'
  | 'Developer Tools'
  | 'Data & AI'
  | 'Fintech'
  | 'Consumer Internet'
  | 'SaaS'
  | 'Services & GCC'
  | 'Hardware & Semiconductor'
  | 'Community'
  | 'Investor';

export interface Company {
  /** Canonical display name, used as the stored value and the URL slug source. */
  name: string;
  sector: CompanySector;
  strength: CompanyStrength;
  /**
   * Extra strings that mean this company. The canonical `name` is always matched,
   * so aliases only need to cover what it doesn't (legal names, product brands,
   * community names, common misspellings).
   */
  aliases?: string[];
  /** Homepage, shown on the company page. */
  website?: string;
}

export const COMPANIES: Company[] = [
  // ── Big Tech ──────────────────────────────────────────────────────────────
  { name: 'Google', sector: 'Big Tech', strength: 'distinctive', aliases: ['Google Cloud', 'GDG', 'Google Developer Group', 'Google Developers', 'Alphabet', 'Google India'], website: 'https://developers.google.com' },
  { name: 'Microsoft', sector: 'Big Tech', strength: 'distinctive', aliases: ['Microsoft Reactor', 'Azure', 'MSFT', 'Microsoft India'], website: 'https://developer.microsoft.com' },
  { name: 'Amazon', sector: 'Big Tech', strength: 'distinctive', aliases: ['AWS', 'Amazon Web Services', 'Amazon India'], website: 'https://aws.amazon.com' },
  // "Meta" matches metadata/metaverse; "Apple" matches the fruit in food events.
  { name: 'Meta', sector: 'Big Tech', strength: 'ambiguous', aliases: ['Facebook', 'Meta India'] },
  { name: 'Apple', sector: 'Big Tech', strength: 'ambiguous' },
  { name: 'NVIDIA', sector: 'Big Tech', strength: 'distinctive', aliases: ['Nvidia India'] },
  { name: 'IBM', sector: 'Big Tech', strength: 'distinctive', aliases: ['IBM Consulting', 'Red Hat'] },
  { name: 'Oracle', sector: 'Big Tech', strength: 'distinctive' },
  { name: 'Intel', sector: 'Big Tech', strength: 'ambiguous' },
  { name: 'Qualcomm', sector: 'Big Tech', strength: 'distinctive' },
  { name: 'Samsung', sector: 'Big Tech', strength: 'distinctive', aliases: ['Samsung R&D', 'SRI-B'] },
  { name: 'Cisco', sector: 'Big Tech', strength: 'distinctive' },
  { name: 'Adobe', sector: 'Big Tech', strength: 'distinctive' },
  { name: 'SAP', sector: 'Big Tech', strength: 'ambiguous', aliases: ['SAP Labs'] },
  { name: 'Dell', sector: 'Big Tech', strength: 'ambiguous' },
  { name: 'Uber', sector: 'Big Tech', strength: 'ambiguous' },

  // ── Developer tools & infrastructure ─────────────────────────────────────
  { name: 'Atlassian', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'GitHub', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'GitLab', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Postman', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Docker', sector: 'Developer Tools', strength: 'ambiguous' },
  { name: 'HashiCorp', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Terraform'] },
  { name: 'JetBrains', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'BrowserStack', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Vercel', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Cloudflare', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Twilio', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Grafana', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Grafana Labs'] },
  { name: 'ServiceNow', sector: 'SaaS', strength: 'distinctive' },
  { name: 'VMware', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Broadcom'] },

  // ── Data & AI ─────────────────────────────────────────────────────────────
  { name: 'MongoDB', sector: 'Data & AI', strength: 'distinctive', aliases: ['IndiaMongoDB'] },
  { name: 'Databricks', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Snowflake', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Confluent', sector: 'Data & AI', strength: 'distinctive', aliases: ['Apache Kafka'] },
  { name: 'Elastic', sector: 'Data & AI', strength: 'ambiguous', aliases: ['Elasticsearch'] },
  { name: 'Redis', sector: 'Data & AI', strength: 'ambiguous' },
  { name: 'Hasura', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Sarvam AI', sector: 'Data & AI', strength: 'distinctive', aliases: ['Sarvam'] },
  { name: 'Krutrim', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Lyzr', sector: 'Data & AI', strength: 'distinctive', aliases: ['Lyzr AI'] },
  { name: 'Atlan', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Fractal', sector: 'Data & AI', strength: 'ambiguous', aliases: ['Fractal Analytics'] },
  { name: 'Mu Sigma', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Ola Krutrim', sector: 'Data & AI', strength: 'distinctive' },

  // ── Fintech ───────────────────────────────────────────────────────────────
  { name: 'Razorpay', sector: 'Fintech', strength: 'distinctive', aliases: ['Razorpay Rize'] },
  { name: 'PhonePe', sector: 'Fintech', strength: 'distinctive' },
  { name: 'CRED', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'Zerodha', sector: 'Fintech', strength: 'distinctive', aliases: ['Rainmatter'] },
  { name: 'Groww', sector: 'Fintech', strength: 'distinctive' },
  { name: 'Jupiter', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'slice', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'Navi', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'Juspay', sector: 'Fintech', strength: 'distinctive' },
  { name: 'Setu', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'Zeta', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'Chargebee', sector: 'SaaS', strength: 'distinctive' },
  { name: 'JPMorgan', sector: 'Fintech', strength: 'distinctive', aliases: ['JP Morgan', 'JPMC'] },
  { name: 'Goldman Sachs', sector: 'Fintech', strength: 'distinctive', aliases: ['Goldman'] },
  { name: 'Visa', sector: 'Fintech', strength: 'ambiguous' },
  { name: 'PayPal', sector: 'Fintech', strength: 'distinctive' },

  // ── Consumer internet ─────────────────────────────────────────────────────
  { name: 'Flipkart', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Swiggy', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Zomato', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Eternal'] },
  { name: 'Meesho', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Myntra', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Udaan', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'ShareChat', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Mohalla Tech'] },
  { name: 'Dream11', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Unacademy', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Rapido', sector: 'Consumer Internet', strength: 'distinctive' },
  { name: 'Urban Company', sector: 'Consumer Internet', strength: 'distinctive' },

  // ── SaaS ──────────────────────────────────────────────────────────────────
  { name: 'Freshworks', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Zoho', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Salesforce', sector: 'SaaS', strength: 'distinctive' },
  { name: 'HubSpot', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Zluri', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Whatfix', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Darwinbox', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Rippling', sector: 'SaaS', strength: 'distinctive' },

  // ── Services, consulting and global capability centres ────────────────────
  { name: 'ThoughtWorks', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'Infosys', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'Wipro', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'TCS', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Tata Consultancy'] },
  { name: 'Accenture', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'Deloitte', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'Walmart', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Walmart Global Tech'] },
  { name: 'Target', sector: 'Services & GCC', strength: 'ambiguous' },
  { name: 'Intuit', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'Lowes', sector: 'Services & GCC', strength: 'distinctive', aliases: ["Lowe's"] },
  { name: 'Tesco', sector: 'Services & GCC', strength: 'distinctive' },
  { name: 'Shell', sector: 'Services & GCC', strength: 'ambiguous' },
  { name: 'Societe Generale', sector: 'Services & GCC', strength: 'distinctive' },

  // ── Investors and accelerators ────────────────────────────────────────────
  { name: 'Accel', sector: 'Investor', strength: 'ambiguous' },
  { name: 'Peak XV', sector: 'Investor', strength: 'distinctive', aliases: ['Sequoia India', 'Surge'] },
  { name: 'Blume Ventures', sector: 'Investor', strength: 'distinctive', aliases: ['Blume'] },
  { name: 'Lightspeed', sector: 'Investor', strength: 'distinctive' },
  { name: 'Antler', sector: 'Investor', strength: 'distinctive' },
  { name: 'Z47', sector: 'Investor', strength: 'distinctive', aliases: ['Matrix Partners India'] },
  { name: 'Arkam Ventures', sector: 'Investor', strength: 'distinctive', aliases: ['Arkam'] },
  { name: 'Y Combinator', sector: 'Investor', strength: 'distinctive', aliases: ['YC'] },

  // ── Communities that behave like publishers of company events ─────────────
  { name: 'The Product Folks', sector: 'Community', strength: 'distinctive', aliases: ['TPF'] },
  { name: 'Hasgeek', sector: 'Community', strength: 'distinctive', aliases: ['The Fifth Elephant', 'Rootconf'] },
  { name: 'GDG Bangalore', sector: 'Community', strength: 'distinctive', aliases: ['GDG Cloud Bengaluru', 'GDG Bengaluru'] },
  { name: 'CNCF', sector: 'Community', strength: 'distinctive', aliases: ['Cloud Native Computing Foundation', 'Kubernetes Community Days'] },
  { name: 'OWASP', sector: 'Community', strength: 'distinctive', aliases: ['null community'] },
  { name: 'Devfolio', sector: 'Community', strength: 'distinctive' },
  { name: 'Bengaluru Tech Week', sector: 'Community', strength: 'distinctive', aliases: ['BTS', 'BTW', 'Bangalore Tech Summit'] },
  { name: 'Bitshala', sector: 'Community', strength: 'distinctive' },
  { name: 'PyData Bangalore', sector: 'Community', strength: 'distinctive', aliases: ['BangPypers'] },

  // ── Seeded from the user's own event-attendance history (Aug 2025 - Aug 2026) ──
  // Every company below either hosted an event the user personally attended or already
  // appears as an organiser string in the live corpus, so each demonstrably runs
  // Bengaluru events. `strength` follows the header rule: when in doubt, 'ambiguous'.
  { name: 'AMD', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['AMD India', 'AMD Developer Community'] },
  { name: 'Keysight', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Keysight Technologies'] },
  { name: 'Texas Instruments', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['TI India'] },
  { name: 'Bosch', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Bosch India', 'RBEI', 'Bosch Global Software'] },
  { name: 'Micron', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Micron India'] },
  { name: 'Nokia', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Nokia India'] },
  { name: 'Logitech', sector: 'Hardware & Semiconductor', strength: 'distinctive' },
  { name: 'Arm', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Arm India'] },
  { name: 'OpenAI', sector: 'Data & AI', strength: 'distinctive', aliases: ['OpenAI Codex Community'] },
  { name: 'Anthropic', sector: 'Data & AI', strength: 'distinctive', aliases: ['Claude Community', 'CCCL'] },
  { name: 'ElevenLabs', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Cartesia', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'kipi.ai', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'Magicball', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'ClickHouse', sector: 'Data & AI', strength: 'distinctive' },
  { name: 'StarTree', sector: 'Data & AI', strength: 'distinctive', aliases: ['Apache Pinot'] },
  { name: 'SurrealDB', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'UiPath', sector: 'Developer Tools', strength: 'distinctive', aliases: ['UiPath Community'] },
  { name: 'n8n', sector: 'Developer Tools', strength: 'distinctive', aliases: ['n8n Bangalore'] },
  { name: 'Nutanix', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'HackerRank', sector: 'Developer Tools', strength: 'distinctive' },
  { name: 'Contentstack', sector: 'SaaS', strength: 'distinctive' },
  { name: 'Amadeus', sector: 'SaaS', strength: 'distinctive', aliases: ['Amadeus Labs'] },
  { name: 'Pine Labs', sector: 'Fintech', strength: 'distinctive' },
  { name: 'Hack2skill', sector: 'Community', strength: 'distinctive' },
  { name: 'HackCulture', sector: 'Community', strength: 'distinctive' },
  { name: 'DevAarambh', sector: 'Community', strength: 'distinctive' },
  { name: 'Outskill', sector: 'Community', strength: 'distinctive' },
  { name: 'Scaler', sector: 'Community', strength: 'distinctive', aliases: ['Scaler Academy'] },
  { name: 'Apidays', sector: 'Community', strength: 'distinctive', aliases: ['FOST', 'Future of Software Technologies'] },
  { name: 'FOSS United', sector: 'Community', strength: 'distinctive', aliases: ['IndiaFOSS', 'FOSSUnited'] },
  { name: 'Global AI Community', sector: 'Community', strength: 'distinctive', aliases: ['AgentCon'] },

  // ── Bengaluru tech employers added 2026-09-06 ─────────────────────────────────
  //
  // 234 entries, researched by sector and then screened twice before landing here.
  //
  // WHY THE SCREENING MATTERS MORE THAN THE COUNT. Every name below is matched as a SUBSTRING,
  // and `strength: 'distinctive'` licenses matching it anywhere including free text — which is
  // how a naive match once reported "Intel" 37 times off *intel*ligence and "SAP" 157 times.
  // At this scale that judgement cannot be made name by name by eye, so it was made twice:
  //
  //   1. An adversarial pass per sector, told that a false 'distinctive' mis-attributes people
  //      forever while a false 'ambiguous' merely matches less often. It downgraded 36.
  //   2. A mechanical pass (`scripts/prescreen-companies.py`) that ignores brand recognition and
  //      asks only whether the literal string collides: any name of four characters or fewer,
  //      any single word that is ordinary vocabulary or a fragment of one, any phrase whose every
  //      word is generic, and any name that is a substring of another company's. It also merged
  //      54 duplicates the overlapping sector buckets produced.
  //
  // Result: 146 distinctive, 88 ambiguous. Every name of four characters or fewer is ambiguous,
  // without exception — that includes ISRO, DRDO, HSBC, KPMG and EY, which are unmistakable to a
  // human and still only match safely against the organiser field.
  //
  // The `// ambiguous:` comments record WHY each downgrade happened. They are there so the next
  // person does not read `{ name: 'Plum', strength: 'ambiguous' }` as over-caution and revert it.


  // Developer Tools (11)
  { name: 'Akamai', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Akamai Technologies', 'Linode'], website: 'https://www.akamai.com' },
  { name: 'Appsmith', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Appsmith Inc'], website: 'https://www.appsmith.com' },
  { name: 'Composio', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Composio HQ'], website: 'https://composio.dev' },
  // ambiguous: the alias 'Digital Ocean' matches the marketing phrase 'digital ocean of data', and 'digital' is a generic industry term
  { name: 'DigitalOcean', sector: 'Developer Tools', strength: 'ambiguous', aliases: ['DigitalOcean India', 'Digital Ocean'], website: 'https://www.digitalocean.com' },
  // ambiguous: two-character token — 'F5' is the refresh key and appears in ordinary text, version strings and IDs
  { name: 'F5', sector: 'Developer Tools', strength: 'ambiguous', aliases: ['F5 Networks', 'NGINX', 'F5 India'], website: 'https://www.f5.com' },
  { name: 'HackerEarth', sector: 'Developer Tools', strength: 'distinctive', aliases: ['Hacker Earth'], website: 'https://www.hackerearth.com' },
  // ambiguous: "harness" is an ordinary English verb and "harness the power of AI" is one of the most common title constructions in this corpus.
  { name: 'Harness', sector: 'Developer Tools', strength: 'ambiguous', aliases: ['Harness Inc', 'Harness India', 'Harness.io'], website: 'https://www.harness.io' },
  { name: 'JFrog', sector: 'Developer Tools', strength: 'distinctive', aliases: ['JFrog India', 'Artifactory'], website: 'https://jfrog.com' },
  // ambiguous: 'last' is an ordinary English word and 'Last9' collides with strings like 'last90days'; the 'Last Nine' alias ('the last nine months') was dropped…
  { name: 'Last9', sector: 'Developer Tools', strength: 'ambiguous', aliases: ['Last 9', 'Last9 Inc'], website: 'https://last9.io' },
  { name: 'SigNoz', sector: 'Developer Tools', strength: 'distinctive', website: 'https://signoz.io' },
  { name: 'SolarWinds', sector: 'Developer Tools', strength: 'distinctive', aliases: ['SolarWinds India'], website: 'https://www.solarwinds.com' },

  // Data & AI (16)
  // ambiguous: 'aerospike' is also a rocket-engine nozzle type, which appears verbatim in space-tech event copy (Bengaluru has an active space-hardware scene)
  { name: 'Aerospike', sector: 'Data & AI', strength: 'ambiguous', aliases: ['Aerospike India'], website: 'https://aerospike.com' },
  { name: 'Cloudera', sector: 'Data & AI', strength: 'distinctive', aliases: ['Cloudera India', 'Hortonworks'], website: 'https://www.cloudera.com' },
  { name: 'Couchbase', sector: 'Data & AI', strength: 'distinctive', aliases: ['Couchbase India'], website: 'https://www.couchbase.com' },
  { name: 'Cropin', sector: 'Data & AI', strength: 'distinctive', aliases: ['CropIn Technology', 'Cropin Technology Solutions'], website: 'https://www.cropin.com' },
  { name: 'Entropik', sector: 'Data & AI', strength: 'distinctive', aliases: ['Entropik Tech', 'Entropik Technologies'], website: 'https://www.entropik.io' },
  { name: 'Fivetran', sector: 'Data & AI', strength: 'distinctive', aliases: ['Fivetran India'], website: 'https://www.fivetran.com' },
  // ambiguous: "glean" is an ordinary English verb ("glean insights from your data") and matches as a whole token.
  { name: 'Glean', sector: 'Data & AI', strength: 'ambiguous', aliases: ['Glean India', 'Glean Technologies'], website: 'https://www.glean.com' },
  { name: 'Informatica', sector: 'Data & AI', strength: 'distinctive', aliases: ['Informatica Business Solutions', 'Informatica India'], website: 'https://www.informatica.com' },
  // ambiguous: "portkey" is a Harry Potter common noun that turns up as a whole token in themed quiz/trivia titles, which this all-city corpus ingests; the compan…
  { name: 'Portkey', sector: 'Data & AI', strength: 'ambiguous', aliases: ['Portkey AI', 'Portkey.ai'], website: 'https://portkey.ai' },
  // ambiguous: "sigmoid" is standard ML vocabulary (the sigmoid activation) and appears as a whole token in ML talk titles and organiser tags.
  { name: 'Sigmoid', sector: 'Data & AI', strength: 'ambiguous', aliases: ['Sigmoid Analytics'], website: 'https://www.sigmoid.com' },
  { name: 'Skit.ai', sector: 'Data & AI', strength: 'distinctive', aliases: ['Vernacular.ai', 'Skit AI'], website: 'https://skit.ai' },
  { name: 'TheMathCompany', sector: 'Data & AI', strength: 'distinctive', aliases: ['MathCo', 'The Math Company'], website: 'https://themathcompany.com' },
  { name: 'ThoughtSpot', sector: 'Data & AI', strength: 'distinctive', aliases: ['ThoughtSpot India'], website: 'https://www.thoughtspot.com' },
  { name: 'Tiger Analytics', sector: 'Data & AI', strength: 'distinctive', aliases: ['Tiger Analytics India'], website: 'https://www.tigeranalytics.com' },
  { name: 'Tredence', sector: 'Data & AI', strength: 'distinctive', aliases: ['Tredence Analytics', 'Tredence Inc'], website: 'https://www.tredence.com' },
  { name: 'TrueFoundry', sector: 'Data & AI', strength: 'distinctive', aliases: ['True Foundry'], website: 'https://www.truefoundry.com' },

  // Fintech (53)
  // ambiguous: four-character token, so it must stay organiser-field only under the <=4-char rule
  { name: 'Acko', sector: 'Fintech', strength: 'ambiguous', aliases: ['Acko Drive', 'Acko General Insurance', 'Acko Insurance'], website: 'https://www.acko.com' },
  // ambiguous: 'angel' is ubiquitous in startup-event strings ('angel investor', 'Angel Network', 'angel round'), and 'angel one' occurs as an ordinary adjacency,…
  { name: 'Angel One', sector: 'Fintech', strength: 'ambiguous', aliases: ['Angel Broking', 'Angel One Limited'], website: 'https://www.angelone.in' },
  // ambiguous: three-letter acronym — far too short to match outside the organiser field
  { name: 'ANZ', sector: 'Fintech', strength: 'ambiguous', aliases: ['Australia and New Zealand Banking Group', 'ANZ Bengaluru', 'ANZ Support Services India'], website: 'https://www.anz.com' },
  // ambiguous: four-character token that sits inside 'axiom' and 'axios' (the HTTP client, ubiquitous in dev-event text)
  { name: 'Axio', sector: 'Fintech', strength: 'ambiguous', aliases: ['Capital Float', 'CapFloat Financial Services'], website: 'https://www.axio.co.in' },
  { name: 'Broadridge', sector: 'Fintech', strength: 'distinctive', aliases: ['Broadridge Financial Solutions', 'Broadridge India'], website: 'https://www.broadridge.com' },
  { name: 'Canara Bank', sector: 'Fintech', strength: 'distinctive', aliases: ['Canara'], website: 'https://www.canarabank.com' },
  // ambiguous: 'capital' is a common word in startup-event copy and 'capital one' occurs as an incidental adjacency ('raising capital one round at a time')
  { name: 'Capital One', sector: 'Fintech', strength: 'ambiguous', aliases: ['Capital One India', 'Capital One Financial'], website: 'https://www.capitalone.com' },
  { name: 'Cashfree Payments', sector: 'Fintech', strength: 'distinctive', aliases: ['Cashfree', 'Cashfree Payments India'], website: 'https://www.cashfree.com' },
  { name: 'CoinSwitch', sector: 'Fintech', strength: 'distinctive', aliases: ['CoinSwitch Kuber', 'Bitcipher Labs'], website: 'https://coinswitch.co' },
  { name: 'Decentro', sector: 'Fintech', strength: 'distinctive', aliases: ['Decentro Tech'], website: 'https://decentro.tech' },
  { name: 'Deutsche Bank', sector: 'Fintech', strength: 'distinctive', aliases: ['Deutsche India', 'DB Global Technology', 'Deutsche Bank Group'], website: 'https://www.db.com' },
  // ambiguous: 'Digit' is the stem of 'digital' / 'digits' and the alias 'Go Digit' is a prefix of the extremely common phrase 'go digital'
  { name: 'Digit Insurance', sector: 'Fintech', strength: 'ambiguous', aliases: ['Go Digit', 'Go Digit General Insurance', 'GoDigit'], website: 'https://www.godigit.com' },
  { name: 'EdgeVerve', sector: 'Fintech', strength: 'distinctive', aliases: ['EdgeVerve Systems', 'Finacle', 'Infosys Finacle'], website: 'https://www.edgeverve.com' },
  { name: 'FamPay', sector: 'Fintech', strength: 'distinctive', aliases: ['FamApp', 'Trio Payments'], website: 'https://fampay.in' },
  // ambiguous: 'Fi' is a two-character token that occurs inside 'Wi-Fi' / 'sci-fi' and 'money' is an ordinary English word, so neither half of the name is safe ou…
  { name: 'Fi Money', sector: 'Fintech', strength: 'ambiguous', aliases: ['Epifi Technologies', 'Fi Neobank', 'Fi.Money', 'epiFi'], website: 'https://fi.money' },
  { name: 'Fidelity Investments', sector: 'Fintech', strength: 'distinctive', aliases: ['FMR India', 'Fidelity Investments India', 'FMR LLC'], website: 'https://www.fidelity.com' },
  { name: 'Finastra', sector: 'Fintech', strength: 'distinctive', aliases: ['Misys', 'Finastra India'], website: 'https://www.finastra.com' },
  { name: 'FinBox', sector: 'Fintech', strength: 'distinctive', aliases: ['Moneyhoney', 'FinBox India'], website: 'https://finbox.in' },
  { name: 'Fisdom', sector: 'Fintech', strength: 'distinctive', aliases: ['Finwizard Technology'], website: 'https://www.fisdom.com' },
  // ambiguous: four-character token and a near-miss of 'file' — too short to match anywhere but the organiser field
  { name: 'Fyle', sector: 'Fintech', strength: 'ambiguous', aliases: ['Fyle Technologies', 'FyleHQ'], website: 'https://www.fylehq.com' },
  { name: 'Happay', sector: 'Fintech', strength: 'distinctive', aliases: ['VA Tech Ventures'], website: 'https://www.happay.com' },
  // ambiguous: four-character acronym — the <=4-char rule applies, same as ANZ and LSEG; it also appears inside strings like 'HSBCnet'
  { name: 'HSBC', sector: 'Fintech', strength: 'ambiguous', aliases: ['HSBC Technology India', 'HSBC Software Development India', 'HSBC India'], website: 'https://www.hsbc.co.in' },
  { name: 'HyperVerge', sector: 'Fintech', strength: 'distinctive', website: 'https://hyperverge.co' },
  { name: 'Innoviti', sector: 'Fintech', strength: 'distinctive', aliases: ['Innoviti Payment Solutions', 'Innoviti Technologies'], website: 'https://innoviti.com' },
  { name: 'Instamojo', sector: 'Fintech', strength: 'distinctive', website: 'https://www.instamojo.com' },
  // ambiguous: 'Jana' is a common Indian name fragment and word ('Jana Gana Mana', 'Janardhan'), so the short alias forms are unsafe outside the organiser field
  { name: 'Jana Small Finance Bank', sector: 'Fintech', strength: 'ambiguous', aliases: ['Jana SFB', 'Janalakshmi Financial Services'], website: 'https://www.janabank.com' },
  // ambiguous: 'jar' is an ordinary English noun and a three-character token (venue/organiser strings like 'The Mason Jar' would match)
  { name: 'Jar', sector: 'Fintech', strength: 'ambiguous', aliases: ['Changejar Technologies', 'Jar App', 'MyJar'], website: 'https://www.myjar.app' },
  { name: 'Khatabook', sector: 'Fintech', strength: 'distinctive', aliases: ['Biz Analyst', 'Kyte Technologies'], website: 'https://khatabook.com' },
  { name: 'KreditBee', sector: 'Fintech', strength: 'distinctive', aliases: ['Krazybee', 'KreditBee NBFC'], website: 'https://www.kreditbee.in' },
  { name: 'Kuvera', sector: 'Fintech', strength: 'distinctive', aliases: ['Arevuk Advisory Services'], website: 'https://kuvera.in' },
  // ambiguous: four-character acronym; 'London Stock Exchange' is also referenced generically in finance-event copy
  { name: 'LSEG', sector: 'Fintech', strength: 'ambiguous', aliases: ['London Stock Exchange Group', 'Refinitiv', 'LSEG India'], website: 'https://www.lseg.com' },
  // ambiguous: the alias 'M2P' is a three-character token and 'fintech' is a generic industry term — the short alias must be organiser-field only
  { name: 'M2P Fintech', sector: 'Fintech', strength: 'ambiguous', aliases: ['M2P Solutions', 'M2P'], website: 'https://m2pfintech.com' },
  // ambiguous: both tokens are ordinary English words — 'money' and 'view' — so the pair can occur as an incidental adjacency in a finance-event title or organise…
  { name: 'Money View', sector: 'Fintech', strength: 'ambiguous', aliases: ['Moneyview', 'Whizdm Innovations'], website: 'https://moneyview.in' },
  { name: 'Morgan Stanley', sector: 'Fintech', strength: 'distinctive', aliases: ['Morgan Stanley Advantage Services', 'MSAS'], website: 'https://www.morganstanley.com' },
  { name: 'NatWest Group', sector: 'Fintech', strength: 'distinctive', aliases: ['NatWest', 'NatWest Digital X', 'NatWest Group India', 'RBS Services India'], website: 'https://www.natwestgroup.com' },
  { name: 'Northern Trust', sector: 'Fintech', strength: 'distinctive', aliases: ['Northern Trust Corporation'], website: 'https://www.northerntrust.com' },
  { name: 'Onsurity', sector: 'Fintech', strength: 'distinctive', aliases: ['Onsurity Technologies'], website: 'https://www.onsurity.com' },
  // ambiguous: 'Open' is one of the most common tokens in tech-event text ('open source', 'open banking'), and the aliases 'Open Money' / 'Open Financial' are ord…
  { name: 'Open Financial Technologies', sector: 'Fintech', strength: 'ambiguous', aliases: ['Open Financial', 'Open Financial Technologies Pvt Ltd', 'Open Money', 'Open.Money', 'OpenMoney', 'Zwitch'], website: 'https://open.money' },
  { name: 'Perfios', sector: 'Fintech', strength: 'distinctive', aliases: ['Karza Technologies', 'Perfios Software Solutions'], website: 'https://www.perfios.com' },
  // ambiguous: 'plum' is an ordinary English word (the fruit, and 'plum role'), and a four-character token that appears in venue and cafe names
  { name: 'Plum', sector: 'Fintech', strength: 'ambiguous', aliases: ['Plum Benefits', 'Plum Health', 'Plum Insurance', 'PlumHQ'], website: 'https://www.plumhq.com' },
  { name: 'Rupeek', sector: 'Fintech', strength: 'distinctive', aliases: ['Rupeek Fintech'], website: 'https://rupeek.com' },
  { name: 'Scripbox', sector: 'Fintech', strength: 'distinctive', aliases: ['Scripbox Advisors'], website: 'https://scripbox.com' },
  { name: 'Signzy', sector: 'Fintech', strength: 'distinctive', aliases: ['Signzy Technologies'], website: 'https://www.signzy.com' },
  // ambiguous: 'Simpl' is the stem of 'simple' / 'simply' / 'simplify', which appear constantly in event copy
  { name: 'Simpl', sector: 'Fintech', strength: 'ambiguous', aliases: ['Get Simpl', 'GetSimpl', 'GetSimpl Technologies', 'One Sigma Technologies'], website: 'https://getsimpl.com' },
  // ambiguous: 'smallcase' reads as ordinary prose for lowercase/'small case'; the spaced 'Small Case' alias was dropped for the same reason
  { name: 'smallcase', sector: 'Fintech', strength: 'ambiguous', aliases: ['Smallcase Technologies', 'Tickertape'], website: 'https://www.smallcase.com' },
  { name: 'Standard Chartered', sector: 'Fintech', strength: 'distinctive', aliases: ['Standard Chartered Bank', 'Standard Chartered GBS', 'SC Ventures'], website: 'https://www.sc.com' },
  // ambiguous: 'stripe' is an ordinary English word (also 'striped', 'stripes' in design/venue copy)
  { name: 'Stripe', sector: 'Fintech', strength: 'ambiguous', aliases: ['Stripe India', 'Stripe Payments India', 'Recko'], website: 'https://stripe.com' },
  // ambiguous: 'Re' is a two-character second token and the pair is a prefix of 'Swiss Reinsurance' / 'Swiss research'
  { name: 'Swiss Re', sector: 'Fintech', strength: 'ambiguous', aliases: ['Swiss Re Global Business Solutions', 'Swiss Reinsurance'], website: 'https://www.swissre.com' },
  { name: 'Ujjivan Small Finance Bank', sector: 'Fintech', strength: 'distinctive', aliases: ['Ujjivan', 'Ujjivan SFB', 'Ujjivan Financial Services'], website: 'https://www.ujjivansfb.in' },
  { name: 'Wells Fargo', sector: 'Fintech', strength: 'distinctive', aliases: ['Wells Fargo India', 'Wells Fargo International Solutions', 'WFIS'], website: 'https://www.wellsfargo.com' },
  { name: 'Wibmo', sector: 'Fintech', strength: 'distinctive', aliases: ['Wibmo Inc'], website: 'https://www.wibmo.com' },
  { name: 'Yodlee', sector: 'Fintech', strength: 'distinctive', aliases: ['Envestnet | Yodlee', 'Envestnet Yodlee', 'Envestnet', 'Yodlee Infotech'], website: 'https://www.yodlee.com' },
  { name: 'Zolve', sector: 'Fintech', strength: 'distinctive', aliases: ['Zolve Innovations'], website: 'https://www.zolve.com' },

  // Consumer Internet (23)
  // ambiguous: 'apna' is an everyday Hindi word ('our own') and a 4-char token
  { name: 'Apna', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['apna.co', 'Apna Time Tech', 'Apna Jobs'], website: 'https://apna.co' },
  { name: 'BigBasket', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Supermarket Grocery Supplies', 'BBnow', 'BB Now'], website: 'https://www.bigbasket.com' },
  // ambiguous: 'blackbuck' is an Indian antelope and appears in the wildlife/trek listings this corpus deliberately ingests
  { name: 'BlackBuck', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Zinka Logistics', 'Zinka Logistics Solutions'], website: 'https://blackbuck.com' },
  { name: 'BYJU\'S', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Byjus', 'Think and Learn', 'WhiteHat Jr'], website: 'https://byjus.com' },
  { name: 'Cuemath', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Cuelearn', 'Cue Learn'], website: 'https://www.cuemath.com' },
  { name: 'cult.fit', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Curefit', 'Cure.fit', 'Cultfit', 'Curefit Healthcare'], website: 'https://www.cult.fit' },
  // ambiguous: 'healthify' is used as a verb in wellness marketing copy ('healthify your diet'), and the corpus is full of wellness listings
  { name: 'HealthifyMe', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Healthify', 'Healthify Me'], website: 'https://www.healthifyme.com' },
  // ambiguous: 'licious' is the tail of 'delicious', a word that appears constantly in food and meetup copy
  { name: 'Licious', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Delightful Gourmet'], website: 'https://www.licious.in' },
  // ambiguous: the 'MPL' short form collides inside 'simple', 'sample' and 'compliance', so it is not retained as an alias; 'Mobile' on its own is generic
  { name: 'Mobile Premier League', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Galactus Funware Technology', 'MPL Esports'], website: 'https://www.mpl.live' },
  { name: 'MyGate', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Vivish Technologies'], website: 'https://mygate.com' },
  { name: 'Ninjacart', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Ninja Cart', '63 Ideas Infolabs'], website: 'https://ninjacart.com' },
  { name: 'NoBroker', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['NoBrokerHood'], website: 'https://www.nobroker.in' },
  { name: 'PlaySimple Games', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['PlaySimple'], website: 'https://playsimple.in' },
  // ambiguous: 'porter' is an ordinary noun, a common surname (Porter's five forces), and a fragment of 'reporter'/'transporter'/'importer'
  { name: 'Porter', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Smartshift Logistics', 'SmartShift', 'Porter.in'], website: 'https://porter.in' },
  // ambiguous: 'practo' sits inside 'chiropractor', which appears in the wellness listings this corpus ingests
  { name: 'Practo', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Practo Technologies'], website: 'https://www.practo.com' },
  // ambiguous: 'pratilipi' is an ordinary Sanskrit/Hindi noun ('copy', 'manuscript') that can appear in the literary and cultural listings this corpus ingests
  { name: 'Pratilipi', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Nasadiya Technologies', 'Pratilipi Comics', 'Pratilipi FM'], website: 'https://www.pratilipi.com' },
  // ambiguous: 'Shadowfax' is Gandalf's horse in Tolkien and can appear in the book-club and pop-culture listings this corpus ingests
  { name: 'Shadowfax', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Shadowfax Technologies'], website: 'https://www.shadowfax.in' },
  { name: 'Simplilearn', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Simplilearn Solutions'], website: 'https://www.simplilearn.com' },
  { name: 'Vedantu', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Vedantu Innovations'], website: 'https://www.vedantu.com' },
  // ambiguous: 'verse' is an ordinary noun and a fragment of 'universe'/'conversely'; the bare 'VerSe' alias was dropped for that reason, and 'Josh' is a common f…
  { name: 'VerSe Innovation', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Dailyhunt', 'Newshunt', 'Josh App'], website: 'https://verse.in' },
  // ambiguous: 4-char token; too short to match safely outside an employer/organiser field
  { name: 'Yulu', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['Yulu Bikes', 'Yulu Mobility'], website: 'https://www.yulu.bike' },
  // ambiguous: 'zepto' is the SI prefix (zeptosecond, zeptogram) and the prefix of the unrelated ZeptoLab games studio
  { name: 'Zepto', sector: 'Consumer Internet', strength: 'ambiguous', aliases: ['KiranaKart Technologies', 'Zeptonow', 'Zepto Now'], website: 'https://www.zeptonow.com' },
  { name: 'Zetwerk', sector: 'Consumer Internet', strength: 'distinctive', aliases: ['Zetwerk Manufacturing Businesses'], website: 'https://www.zetwerk.com' },

  // SaaS (33)
  // ambiguous: 'Boomi' is a fragment of 'booming' — 'the booming AI market'
  { name: 'Boomi', sector: 'SaaS', strength: 'ambiguous', aliases: ['Dell Boomi', 'Boomi India'], website: 'https://boomi.com' },
  // ambiguous: 'check point' / 'checkpoint' is ordinary English and a standard ML/CI term — 'model checkpoint', 'checkpoint file', 'save a checkpoint'
  { name: 'Check Point Software', sector: 'SaaS', strength: 'ambiguous', aliases: ['Check Point', 'Check Point Software Technologies'], website: 'https://www.checkpoint.com' },
  { name: 'Citrix', sector: 'SaaS', strength: 'distinctive', aliases: ['Citrix Systems', 'Citrix R&D India'], website: 'https://www.citrix.com' },
  { name: 'CloudSEK', sector: 'SaaS', strength: 'distinctive', aliases: ['Cloud SEK', 'CloudSEK Information Security'], website: 'https://cloudsek.com' },
  { name: 'Cohesity', sector: 'SaaS', strength: 'distinctive', aliases: ['Cohesity India'], website: 'https://www.cohesity.com' },
  { name: 'Commvault', sector: 'SaaS', strength: 'distinctive', aliases: ['Commvault India'], website: 'https://www.commvault.com' },
  { name: 'DevRev', sector: 'SaaS', strength: 'distinctive', aliases: ['DevRev Inc'], website: 'https://devrev.ai' },
  { name: 'Exotel', sector: 'SaaS', strength: 'distinctive', aliases: ['Ameyo', 'Exotel India', 'Exotel Techcom'], website: 'https://exotel.com' },
  { name: 'Fortinet', sector: 'SaaS', strength: 'distinctive', aliases: ['Fortinet India'], website: 'https://www.fortinet.com' },
  // ambiguous: "gupshup" is a common Hindi word for chat/chit-chat and is used verbatim in Indian event titles ("Tech Gupshup").
  { name: 'Gupshup', sector: 'SaaS', strength: 'ambiguous', aliases: ['Gupshup.io', 'Webaroo'], website: 'https://www.gupshup.io' },
  { name: 'LeadSquared', sector: 'SaaS', strength: 'distinctive', aliases: ['Lead Squared', 'MarketXpander Services'], website: 'https://www.leadsquared.com' },
  { name: 'McAfee', sector: 'SaaS', strength: 'distinctive', aliases: ['McAfee India', 'McAfee Software India'], website: 'https://www.mcafee.com' },
  // ambiguous: both tokens are generic health-service words - 'medi assist' occurs in ordinary health-camp copy and in other TPAs' and clinics' names
  { name: 'Medi Assist', sector: 'SaaS', strength: 'ambiguous', aliases: ['MediAssist', 'Medi Assist Healthcare Services', 'Medi Assist TPA'], website: 'https://www.mediassist.in' },
  { name: 'MoEngage', sector: 'SaaS', strength: 'distinctive', aliases: ['MoEngage Inc'], website: 'https://www.moengage.com' },
  { name: 'Netskope', sector: 'SaaS', strength: 'distinctive', aliases: ['Netskope India'], website: 'https://www.netskope.com' },
  // ambiguous: The "Observe AI" alias collides with the ordinary imperative phrase "observe AI" ("Observe AI Agents in Production"), which is exactly the copy thi…
  { name: 'Observe.AI', sector: 'SaaS', strength: 'ambiguous', aliases: ['Observe AI', 'ObserveAI'], website: 'https://www.observe.ai' },
  // ambiguous: four-character token; 'okta' is also the meteorological unit of cloud cover and sits inside strings like 'Oktane'
  { name: 'Okta', sector: 'SaaS', strength: 'ambiguous', aliases: ['Auth0', 'Okta India'], website: 'https://www.okta.com' },
  // ambiguous: the alias 'Open Text' matches ordinary phrases — 'open text file', 'open text editor'
  { name: 'OpenText', sector: 'SaaS', strength: 'ambiguous', aliases: ['Micro Focus', 'OpenText India', 'Open Text'], website: 'https://www.opentext.com' },
  { name: 'Palo Alto Networks', sector: 'SaaS', strength: 'distinctive', aliases: ['Palo Alto Networks India', 'PANW'], website: 'https://www.paloaltonetworks.com' },
  { name: 'Rubrik', sector: 'SaaS', strength: 'distinctive', aliases: ['Rubrik India'], website: 'https://www.rubrik.com' },
  { name: 'Saviynt', sector: 'SaaS', strength: 'distinctive', aliases: ['Saviynt India'], website: 'https://saviynt.com' },
  // ambiguous: the alias 'Scrut' is a fragment of 'scrutiny' / 'scrutinize' / 'scrutinised'
  { name: 'Scrut Automation', sector: 'SaaS', strength: 'ambiguous', aliases: ['Scrut'], website: 'https://www.scrut.io' },
  { name: 'Securonix', sector: 'SaaS', strength: 'distinctive', aliases: ['Securonix India'], website: 'https://www.securonix.com' },
  { name: 'SentinelOne', sector: 'SaaS', strength: 'distinctive', aliases: ['Sentinel One', 'SentinelOne India'], website: 'https://www.sentinelone.com' },
  { name: 'SonicWall', sector: 'SaaS', strength: 'distinctive', aliases: ['SonicWall India'], website: 'https://www.sonicwall.com' },
  { name: 'SpotDraft', sector: 'SaaS', strength: 'distinctive', aliases: ['Spot Draft'], website: 'https://www.spotdraft.com' },
  { name: 'Sprinto', sector: 'SaaS', strength: 'distinctive', aliases: ['Sprinto Inc'], website: 'https://sprinto.com' },
  { name: 'Tekion', sector: 'SaaS', strength: 'distinctive', aliases: ['Tekion Corp', 'Tekion India'], website: 'https://tekion.com' },
  { name: 'Tracxn', sector: 'SaaS', strength: 'distinctive', aliases: ['Tracxn Technologies'], website: 'https://tracxn.com' },
  { name: 'Trellix', sector: 'SaaS', strength: 'distinctive', aliases: ['McAfee Enterprise', 'FireEye', 'Trellix India'], website: 'https://www.trellix.com' },
  { name: 'Yellow.ai', sector: 'SaaS', strength: 'distinctive', aliases: ['Yellow AI', 'Yellow Messenger', 'YellowAI'], website: 'https://yellow.ai' },
  // ambiguous: 'zoom' is an ordinary English word and appears in nearly every online-event listing — 'Zoom link', 'zoom in'
  { name: 'Zoom', sector: 'SaaS', strength: 'ambiguous', aliases: ['Zoom Video Communications', 'Zoom Communications'], website: 'https://www.zoom.com' },
  { name: 'Zscaler', sector: 'SaaS', strength: 'distinctive', aliases: ['Zscaler India'], website: 'https://www.zscaler.com' },

  // Services & GCC (21)
  { name: 'Altimetrik', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Altimetrik India'], website: 'https://www.altimetrik.com' },
  { name: 'Capgemini', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Capgemini India', 'Capgemini Engineering', 'Altran'], website: 'https://www.capgemini.com' },
  // ambiguous: "cognizant" is an ordinary English adjective ("be cognizant of the trade-offs") and matches as a whole token, so it must not be read out of titles…
  { name: 'Cognizant', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['Cognizant Technology Solutions'], website: 'https://www.cognizant.com' },
  // ambiguous: 4-character token; too short to trust anywhere but the organiser field.
  { name: 'EPAM', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['EPAM Systems', 'EPAM India'], website: 'https://www.epam.com' },
  // ambiguous: 2-character name — the shortest in the batch; "ey" is a fragment of they/key/money/survey, so it is only safe as a standalone organiser token.
  { name: 'EY', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['Ernst & Young', 'EY GDS', 'EY Global Delivery Services', 'EY India'], website: 'https://www.ey.com/en_in' },
  { name: 'GlobalLogic', sector: 'Services & GCC', strength: 'distinctive', aliases: ['GlobalLogic India', 'GlobalLogic, a Hitachi Group Company'], website: 'https://www.globallogic.com' },
  { name: 'Happiest Minds', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Happiest Minds Technologies'], website: 'https://www.happiestminds.com' },
  // ambiguous: The "HCL" alias is a 3-char token (also the chemical formula HCl); short enough that only an organiser-field claim should count.
  { name: 'HCLTech', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['HCL Technologies', 'HCL', 'HCL Tech'], website: 'https://www.hcltech.com' },
  // ambiguous: 4-character token, and the "KGS" alias is 3 characters — acronyms this short are organiser-field-only.
  { name: 'KPMG', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['KPMG Global Services', 'KGS', 'KPMG India'], website: 'https://kpmg.com/in' },
  // ambiguous: The "LTTS" alias is a 4-character token, and "Technology Services" is a generic industry phrase.
  { name: 'L&T Technology Services', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['L&T Technology Services Limited', 'LTTS', 'LnT Technology Services'], website: 'https://www.ltts.com' },
  // ambiguous: The "Lollypop" alias is a common-noun spelling of "lollipop" and reads as a whole token in the kids/leisure listings this corpus ingests.
  { name: 'Lollypop Design Studio', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['Lollypop', 'Lollypop Design'], website: 'https://lollypop.design' },
  { name: 'LTIMindtree', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Mindtree', 'L&T Infotech', 'Larsen & Toubro Infotech', 'LTI Mindtree'], website: 'https://www.ltimindtree.com' },
  { name: 'Mphasis', sector: 'Services & GCC', strength: 'distinctive', aliases: ['MphasiS BFL', 'Mphasis Limited', 'Mphasis NEXTlabs'], website: 'https://www.mphasis.com' },
  // ambiguous: "persistent systems" is ordinary technical phrasing that occurs verbatim in talk titles ("Building Persistent Systems with Kafka").
  { name: 'Persistent Systems', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['Persistent Systems Limited'], website: 'https://www.persistent.com' },
  { name: 'Publicis Sapient', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Sapient', 'Publicis Sapient India', 'SapientRazorfish'], website: 'https://www.publicissapient.com' },
  // ambiguous: 3-character token; too short to match outside the organiser field.
  { name: 'PwC', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['PricewaterhouseCoopers', 'PwC Acceleration Centre', 'PwC India', 'PwC AC Bangalore'], website: 'https://www.pwc.in' },
  { name: 'Quest Global', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Quest Global Engineering'], website: 'https://www.quest-global.com' },
  { name: 'Siemens', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Mentor Graphics', 'Siemens Digital Industries Software', 'Siemens EDA', 'Siemens Healthineers', 'Siemens India', 'Siemens Technology India', 'Siemens Technology and Services'], website: 'https://www.siemens.com' },
  // ambiguous: The "Sonata" alias is a whole-token match on the musical form — this corpus ingests concert and recital listings via District/AllEvents, where "Son…
  { name: 'Sonata Software', sector: 'Services & GCC', strength: 'ambiguous', aliases: ['Sonata Software Limited', 'Sonata'], website: 'https://www.sonata-software.com' },
  { name: 'Tata Elxsi', sector: 'Services & GCC', strength: 'distinctive', aliases: ['Tata Elxsi Limited'], website: 'https://www.tataelxsi.com' },
  { name: 'Tech Mahindra', sector: 'Services & GCC', strength: 'distinctive', aliases: ['TechM', 'Tech Mahindra Limited'], website: 'https://www.techmahindra.com' },

  // Hardware & Semiconductor (57)
  { name: 'Airbus', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Airbus India', 'Airbus India Engineering Centre'], website: 'https://www.airbus.com' },
  // ambiguous: 'analog devices' is an ordinary hardware phrase that stands alone in event copy about analog devices
  { name: 'Analog Devices', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Analog Devices India', 'ADI India'], website: 'https://www.analog.com' },
  // ambiguous: 'applied materials' reads as a generic materials-science phrase; the 'AMAT' alias is also a fragment of 'amateur'
  { name: 'Applied Materials', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Applied Materials India', 'AMAT'], website: 'https://www.appliedmaterials.com' },
  // ambiguous: adaptive / captive — both contain 'aptiv', and 'adaptive' is everywhere in ADAS and AI event copy
  { name: 'Aptiv', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Aptiv India'], website: 'https://www.aptiv.com' },
  { name: 'Arista Networks', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Arista India', 'Arista Networks India'], website: 'https://www.arista.com' },
  // ambiguous: the bare 'Ather' form sits inside 'rather', 'gather', 'weather', 'leather' and the name 'Heather', so it is not retained as an alias at all
  { name: 'Ather Energy', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Ather Energy Limited', 'Ather Energy Ltd'], website: 'https://www.atherenergy.com' },
  { name: 'Bellatrix Aerospace', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Bellatrix'], website: 'https://bellatrix.aero' },
  // ambiguous: the 'BEL' alias is a major Bengaluru road and locality (BEL Road, BEL Layout) and a fragment of 'below', 'label', 'belong'
  { name: 'Bharat Electronics', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['BEL', 'Bharat Electronics Limited', 'BEL Bangalore'], website: 'https://bel-india.in' },
  { name: 'Boeing', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Boeing India', 'BIETC', 'Boeing India Engineering and Technology Center'], website: 'https://www.boeing.co.in' },
  // ambiguous: cadence — ordinary English noun (running cadence, release cadence, musical cadence)
  { name: 'Cadence', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Cadence Design Systems', 'Cadence India'], website: 'https://www.cadence.com' },
  { name: 'CommScope', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Ruckus Networks', 'CommScope India', 'ARRIS International'], website: 'https://www.commscope.com' },
  // ambiguous: continental — ordinary English adjective, and the bare alias also names hotels, breakfasts and cricket clubs
  { name: 'Continental Automotive', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Continental', 'Continental Automotive India', 'Continental AG'], website: 'https://www.continental.com' },
  { name: 'CynLr', sector: 'Hardware & Semiconductor', strength: 'distinctive', website: 'https://www.cynlr.com' },
  // ambiguous: 'digantara' is a Sanskrit noun (horizon/space) that can appear as a title word in the cultural listings this corpus ingests
  { name: 'Digantara', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Digantara Research and Technologies'], website: 'https://www.digantara.co.in' },
  // ambiguous: four-character token; the lab aliases are short acronyms too ('CABS' is the plural of cab). The proposed 'ADE' alias is removed — it is a fragment…
  { name: 'DRDO', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Defence Research and Development Organisation', 'LRDE', 'GTRE', 'CABS', 'DRDO Bengaluru'], website: 'https://www.drdo.gov.in' },
  { name: 'eInfochips', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['eInfochips (an Arrow company)'], website: 'https://www.einfochips.com' },
  { name: 'Ericsson', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Ericsson India', 'Ericsson R&D'], website: 'https://www.ericsson.com' },
  // ambiguous: 'Extreme' is an ordinary English adjective and 'Networks' a generic industry term, so the pair can appear in ordinary copy
  { name: 'Extreme Networks', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Extreme Networks India'], website: 'https://www.extremenetworks.com' },
  { name: 'GE Aerospace', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['GE Aviation', 'GE India Technology Centre', 'John F. Welch Technology Centre', 'JFWTC', 'GE India'], website: 'https://www.geaerospace.com' },
  { name: 'GE HealthCare', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Wipro GE Healthcare', 'GE HealthCare India'], website: 'https://www.gehealthcare.com' },
  // ambiguous: "Harman" is a common Indian personal name (Harman, Harman Singh) and organiser fields routinely carry personal names.
  { name: 'Harman', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['HARMAN Connected Services', 'HARMAN India', 'Harman International'], website: 'https://www.harman.com' },
  // ambiguous: the 'HPE' alias is a three-character token, below the short-token floor
  { name: 'Hewlett Packard Enterprise', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['HPE', 'HPE India', 'Hewlett Packard', 'Hewlett-Packard Enterprise'], website: 'https://www.hpe.com' },
  // ambiguous: the 'HAL' alias is a Bengaluru locality — HAL Airport Road, HAL 2nd Stage, HAL Layout are in venue and address strings all over the corpus, and it…
  { name: 'Hindustan Aeronautics', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['HAL', 'Hindustan Aeronautics Limited', 'HAL Bangalore'], website: 'https://hal-india.co.in' },
  { name: 'Honeywell', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Honeywell Aerospace', 'Honeywell India', 'Honeywell Technology Solutions'], website: 'https://www.honeywell.com' },
  { name: 'Ignitarium', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Ignitarium Technology Solutions'], website: 'https://ignitarium.com' },
  { name: 'Infineon Technologies', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Infineon', 'Infineon India', 'Infineon Technologies India'], website: 'https://www.infineon.com' },
  // ambiguous: four-character token, and 'ISRO Layout' is a Bengaluru locality that appears in address strings
  { name: 'ISRO', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Indian Space Research Organisation', 'URSC', 'U R Rao Satellite Centre', 'ISTRAC', 'ISRO Bengaluru'], website: 'https://www.isro.gov.in' },
  { name: 'Juniper Networks', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Juniper India', 'Juniper Networks India'], website: 'https://www.juniper.net' },
  // ambiguous: 'Lam' is a three-letter token and a common surname; 'research' is a generic industry word
  { name: 'Lam Research', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Lam Research India'], website: 'https://www.lamresearch.com' },
  { name: 'Lenovo', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Lenovo India', 'Motorola Mobility'], website: 'https://www.lenovo.com' },
  // ambiguous: marvellous / marvel — 'marvell' is a fragment of the British spelling
  { name: 'Marvell', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Marvell Technology', 'Marvell Semiconductor', 'Marvell India'], website: 'https://www.marvell.com' },
  // ambiguous: MATLAB / Simulink — the aliases are tool names that stand alone as ordinary words in titles ('MATLAB workshop', 'Simulink training'), which a coach…
  { name: 'MathWorks', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['MathWorks India', 'MATLAB', 'Simulink'], website: 'https://www.mathworks.com' },
  { name: 'MediaTek', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['MediaTek India', 'MediaTek Bangalore'], website: 'https://www.mediatek.com' },
  { name: 'Mercedes-Benz R&D India', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['MBRDI', 'Mercedes-Benz Research and Development India', 'Mercedes-Benz R&D'], website: 'https://www.mbrdi.co.in' },
  // ambiguous: microchip — generic hardware noun, and the bare alias is exactly that word
  { name: 'Microchip Technology', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Microchip', 'Microchip India', 'Microsemi'], website: 'https://www.microchip.com' },
  { name: 'Mistral Solutions', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Mistral Solutions Pvt Ltd'], website: 'https://www.mistralsolutions.com' },
  { name: 'NetApp', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['NetApp India'], website: 'https://www.netapp.com' },
  { name: 'Netradyne', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Netradyne India'], website: 'https://www.netradyne.com' },
  // ambiguous: the 'NXP' alias is a three-character token, below the short-token floor
  { name: 'NXP Semiconductors', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['NXP', 'NXP India', 'NXP Semiconductors India'], website: 'https://www.nxp.com' },
  { name: 'Ola Electric', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Ola Cell Technologies', 'Ola Electric Mobility', 'Ola Futurefactory'], website: 'https://www.olaelectric.com' },
  { name: 'Philips', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Philips Innovation Campus', 'Philips India', 'Philips Healthcare'], website: 'https://www.philips.co.in' },
  { name: 'Pixxel', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Pixxel India', 'Pixxel Space', 'Pixxel Space Technologies'], website: 'https://www.pixxel.space' },
  // ambiguous: 'pure' is an ordinary adjective and 'storage' a generic industry term — 'pure storage' occurs in ordinary infrastructure copy
  { name: 'Pure Storage', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Pure Storage India'], website: 'https://www.purestorage.com' },
  { name: 'Renesas Electronics', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Renesas', 'Renesas India', 'Intersil'], website: 'https://www.renesas.com' },
  // ambiguous: used idiomatically as a superlative ('the Rolls-Royce of frameworks') and shared with Rolls-Royce Motor Cars, a different (BMW-owned) company — org…
  { name: 'Rolls-Royce', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Rolls Royce', 'Rolls-Royce India', 'Rolls-Royce Engineering Centre India'], website: 'https://www.rolls-royce.com' },
  { name: 'Safran', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Safran Engineering Services', 'Safran India'], website: 'https://www.safran-group.com' },
  { name: 'Sasken', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Sasken Technologies', 'Sasken Communication Technologies'], website: 'https://www.sasken.com' },
  { name: 'SiFive', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['SiFive India'], website: 'https://www.sifive.com' },
  { name: 'STMicroelectronics', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['ST Microelectronics', 'STMicro', 'STMicroelectronics India'], website: 'https://www.st.com' },
  { name: 'Synopsys', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Synopsys India'], website: 'https://www.synopsys.com' },
  { name: 'Tejas Networks', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Saankhya Labs', 'Tejas Networks Limited'], website: 'https://www.tejasnetworks.com' },
  { name: 'Tessolve', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Tessolve Semiconductor', 'Tessolve Bangalore'], website: 'https://www.tessolve.com' },
  // ambiguous: Thales is the mathematician in "Thales' theorem", which stands alone in student and education event titles in this corpus
  { name: 'Thales', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['Gemalto', 'Thales Engineering Competence Centre', 'Thales Group', 'Thales India'], website: 'https://www.thalesgroup.com' },
  { name: 'Tonbo Imaging', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Tonbo'], website: 'https://www.tonboimaging.com' },
  { name: 'Ultrahuman', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Ultrahuman Healthcare', 'Ultrahuman Ring'], website: 'https://www.ultrahuman.com' },
  { name: 'Ultraviolette', sector: 'Hardware & Semiconductor', strength: 'distinctive', aliases: ['Ultraviolette Automotive'], website: 'https://www.ultraviolette.com' },
  // ambiguous: 'Western' is an ordinary adjective and 'Digital' a generic industry term — 'western digital <noun>' appears in ordinary copy
  { name: 'Western Digital', sector: 'Hardware & Semiconductor', strength: 'ambiguous', aliases: ['HGST', 'SanDisk', 'Western Digital India'], website: 'https://www.westerndigital.com' },

  // Community (20)
  // ambiguous: "agile India" is ordinary industry prose ("the agile India community") and a generic phrase rather than a unique string.
  { name: 'Agile India', sector: 'Community', strength: 'ambiguous', aliases: ['Agile Software Community of India', 'AgileIndia'] },
  { name: 'Analytics India Magazine', sector: 'Community', strength: 'distinctive', aliases: ['AIM Media House', 'MachineHack'], website: 'https://analyticsindiamag.com' },
  // ambiguous: The "GHCI" alias is a 4-character token that collides with GHCi, the Glasgow Haskell Compiler interactive shell — a Haskell meetup titled "Intro to…
  { name: 'AnitaB.org India', sector: 'Community', strength: 'ambiguous', aliases: ['Grace Hopper Celebration India', 'GHCI', 'AnitaB.org'], website: 'https://anitab.org' },
  { name: 'AWS User Group Bengaluru', sector: 'Community', strength: 'distinctive', aliases: ['AWS User Group Bangalore', 'AWS UG Bengaluru', 'AWS Community Day Bengaluru'] },
  { name: 'BDOTNET', sector: 'Community', strength: 'distinctive', aliases: ['Bangalore .NET User Group', 'Bangalore Dot Net User Group'] },
  { name: 'BlrDroid', sector: 'Community', strength: 'distinctive', aliases: ['Blr Droid', 'Bangalore Android User Group'] },
  // ambiguous: Compound of two very common words; the "Design Up" alias is generic enough to surface in unrelated design-event titles.
  { name: 'DesignUp', sector: 'Community', strength: 'ambiguous', aliases: ['Design Up', 'DesignUp Conference'], website: 'https://designup.io' },
  { name: 'droidcon India', sector: 'Community', strength: 'distinctive', aliases: ['droidcon Bengaluru'], website: 'https://www.droidcon.com' },
  { name: 'Friends of Figma, Bangalore', sector: 'Community', strength: 'distinctive', aliases: ['Friends of Figma Bangalore', 'Friends of Figma Bengaluru'] },
  // ambiguous: 4-character acronym; too short to match outside the organiser field.
  { name: 'GIDS', sector: 'Community', strength: 'ambiguous', aliases: ['Great Indian Developer Summit', 'Great International Developer Summit', 'Saltmarch Media'], website: 'https://developersummit.com' },
  { name: 'IEEE Bangalore Section', sector: 'Community', strength: 'distinctive', aliases: ['IEEE Bangalore', 'IEEE Bangalore Chapter'] },
  { name: 'Makers Tribe', sector: 'Community', strength: 'distinctive', aliases: ['MakersTribe', 'Makers Tribe Bangalore'] },
  { name: 'Nasscom', sector: 'Community', strength: 'distinctive', aliases: ['nasscom 10000 Startups', 'Nasscom CoE'], website: 'https://nasscom.in' },
  // ambiguous: 'Newton' is the SI unit of force and a common surname, and the phrase 'Newton School' also names unrelated schools; sector set to Community to matc…
  { name: 'Newton School', sector: 'Community', strength: 'ambiguous', aliases: ['Newton School of Technology', 'NewtonSchool'], website: 'https://www.newtonschool.co' },
  // ambiguous: "open source India" is a phrase that appears constantly in ordinary event copy and titles.
  { name: 'Open Source India', sector: 'Community', strength: 'ambiguous', aliases: ['OSI Days', 'EFY Group', 'Open Source India Conference'] },
  { name: 'PGConf India', sector: 'Community', strength: 'distinctive', aliases: ['PGConf.IN'], website: 'https://pgconf.in' },
  { name: 'ProductTank Bangalore', sector: 'Community', strength: 'distinctive', aliases: ['ProductTank Bengaluru', 'Mind the Product Bangalore'] },
  { name: 'Rust Bangalore', sector: 'Community', strength: 'distinctive', aliases: ['Rust Bengaluru', 'Rust Bangalore Meetup'] },
  { name: 'TiE Bangalore', sector: 'Community', strength: 'distinctive', aliases: ['TiE Bengaluru', 'TiE Bangalore Chapter'] },
  { name: 'YourStory', sector: 'Community', strength: 'distinctive', aliases: ['TechSparks', 'YourStory Media'], website: 'https://yourstory.com' },

];

/** URL-safe slug for a company name. */
export function companySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Canonical names, for validation and UI lists. */
export const COMPANY_NAMES: string[] = COMPANIES.map(c => c.name);

const BY_SLUG = new Map(COMPANIES.map(c => [companySlug(c.name), c]));

export function companyBySlug(slug: string): Company | undefined {
  return BY_SLUG.get(slug);
}

export const COMPANY_SECTORS: CompanySector[] = [
  'Big Tech',
  'Developer Tools',
  'Data & AI',
  'Fintech',
  'Consumer Internet',
  'SaaS',
  'Services & GCC',
  'Hardware & Semiconductor',
  'Investor',
  'Community',
];
