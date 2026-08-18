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
