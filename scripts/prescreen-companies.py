"""
Mechanical over-match pre-screen for candidate registry entries.

WHY THIS EXISTS. `lib/companies/registry.ts` matches a company name as a SUBSTRING, and
`strength: 'distinctive'` is the licence to match it anywhere including free text. Getting that
wrong is the one way to do real damage here: measured against this app's live corpus, naive
substring matching reported "Intel" 37 times (matching *intel*ligence), "CRED" 31
(*cred*entials, in*cred*ible) and "SAP" 157.

288 candidates arrived from a research pass whose verifiers downgraded 36 of them. That is a
plausible rate, but it is a JUDGEMENT, and judgement does not scale to 288 names. This screen is
the mechanical half: it does not ask whether a name feels distinctive, it asks whether the literal
lowercase string occurs inside vocabulary that really appears in Bengaluru event copy, job titles
and other company names. A name that does cannot be 'distinctive', regardless of how recognisable
the brand is.

Deliberately NOT a decision-maker. It emits a report; the strengths get corrected from it and the
final word stays with the live-corpus check that follows. Pure stdlib so it runs anywhere.
"""

import json
import io
import re
import sys

# Vocabulary that genuinely shows up in this corpus: event copy, session titles, job titles,
# venue names, and the generic industry words every second startup puts in its own name.
VOCAB = """
intelligence artificial machine learning deep neural network networks model models modelling
credentials credential incredible accredited accreditation
metadata metaverse metrics metric parameters parameter
platform platforms solution solutions system systems technology technologies
data database databases dataset datasets analytics analysis
cloud clouds cluster clusters container containers kubernetes docker
storage store stores stored storing
security secure securing insecure
software hardware firmware middleware
developer developers development develop
engineer engineers engineering
product products production
design designer designs designing
manager management managing
architect architecture architects
science scientist scientists
research researcher
digital digitisation digitization
enterprise enterprises
service services serving
application applications
interface interfaces
framework frameworks
library libraries
protocol protocols
pipeline pipelines
workflow workflows
automation automate automated
integration integrations
migration migrations
deployment deploy deployed
observability monitoring
performance
scalable scaling scale
reliability reliable
availability
infrastructure
operations
compliance
governance
strategy strategic
finance financial fintech
payment payments
lending lender
insurance insurer
banking bank banks
trading trader
market marketing markets
customer customers
commerce commercial
retail
health healthcare
education
mobility mobile
logistics
energy
climate
space spacecraft
robot robotics robotic
sensor sensors
embedded
semiconductor
silicon
circuit circuits
processor processors
memory
wireless
antenna
signal signals
power powered powering
control controller
motor motors
drive driven driver drivers
battery
vehicle vehicles
aerospike nozzle rocket
checkpoint checkpoints checkpointing
extreme extremely
pure purely purity
western
thales theorem
okta oktane
refresh
open source opensource
free
community communities
meetup meetups
summit summits
conference conferences
workshop workshops
hackathon hackathons
bootcamp
webinar webinars
session sessions
talk talks
panel panels
demo demos
sprint
festival
night nights
morning evening
bangalore bengaluru india indian karnataka
whitefield koramangala indiranagar hebbal marathahalli electronic city
first second third next last
new news
best better
smart smarter
next generation
future
global local
india stack
united
national international
institute institutes
university
college
school
academy
center centre centres
lab labs laboratory
studio studios
works working work
group groups
team teams
club clubs
society
foundation
association
council
chapter chapters
network chapter
alliance
consortium
partner partners partnership
venture ventures
capital
fund funds funding
invest investor investors investment
accelerator
incubator
startup startups
founder founders
scale scaleup
unicorn
""".split()

VOCAB = sorted(set(w.strip().lower() for w in VOCAB if w.strip()))

EXISTING = """Google|Microsoft|Amazon|Meta|Apple|NVIDIA|IBM|Oracle|Intel|Qualcomm|Samsung|Cisco|Adobe|SAP|Dell|Uber|Atlassian|GitHub|GitLab|Postman|Docker|HashiCorp|JetBrains|BrowserStack|Vercel|Cloudflare|Twilio|Grafana|ServiceNow|VMware|MongoDB|Databricks|Snowflake|Confluent|Elastic|Redis|Hasura|Sarvam AI|Krutrim|Lyzr|Atlan|Fractal|Mu Sigma|Ola Krutrim|Razorpay|PhonePe|CRED|Zerodha|Groww|Jupiter|slice|Navi|Juspay|Setu|Zeta|Chargebee|JPMorgan|Goldman Sachs|Visa|PayPal|Flipkart|Swiggy|Zomato|Meesho|Myntra|Udaan|ShareChat|Dream11|Unacademy|Rapido|Urban Company|Freshworks|Zoho|Salesforce|HubSpot|Zluri|Whatfix|Darwinbox|Rippling|ThoughtWorks|Infosys|Wipro|TCS|Accenture|Deloitte|Walmart|Target|Intuit|Lowes|Tesco|Shell|Societe Generale|Accel|Peak XV|Blume Ventures|Lightspeed|Antler|Z47|Arkam Ventures|Y Combinator|The Product Folks|Hasgeek|GDG Bangalore|CNCF|OWASP|Devfolio|Bengaluru Tech Week|Bitshala|PyData Bangalore|AMD|Keysight|Texas Instruments|Bosch|Micron|Nokia|Logitech|Arm|OpenAI|Anthropic|ElevenLabs|Cartesia|kipi.ai|Magicball|ClickHouse|StarTree|SurrealDB|UiPath|n8n|Nutanix|HackerRank|Contentstack|Amadeus|Pine Labs|Hack2skill|HackCulture|DevAarambh|Outskill|Scaler|Apidays|FOSS United|Global AI Community""".split('|')

res = json.load(io.open('docs/audit/workflow-result.json', encoding='utf-8'))
cands = res['companies']

existing_lower = {n.lower() for n in EXISTING}
cand_names = [c['name'] for c in cands]

problems = []
seen = {}
deduped = []
dupes = []

for c in cands:
    name = c['name']
    low = name.lower()
    reasons = []

    # 1. Duplicate of an existing entry, or of another candidate.
    #
    #    The five research buckets overlapped by design (a company can be both "Hardware &
    #    Semiconductor" and a "Services & GCC" centre), so the same employer came back more than
    #    once. Duplicates are RESOLVED here rather than reported, by keeping the first occurrence
    #    and merging later aliases into it — a duplicate name in the registry is exactly what
    #    `scripts/diag-seed-integrity.ts` exists to catch, so it should never reach the file.
    if low in existing_lower:
        dupes.append((name, 'already in registry'))
        continue
    if low in seen:
        first = seen[low]
        merged = sorted(set((first.get('aliases') or []) + (c.get('aliases') or [])))
        if merged:
            first['aliases'] = merged
        # Keep the MORE CAUTIOUS strength when two buckets disagree.
        if c['strength'] == 'ambiguous':
            first['strength'] = 'ambiguous'
            if c.get('strengthReason'):
                first['strengthReason'] = c['strengthReason']
        dupes.append((name, 'duplicate within candidates — merged'))
        continue
    seen[low] = c
    deduped.append(c)

    if c['strength'] == 'distinctive':
        toks = [t for t in re.findall(r'[a-z0-9&.]+', low) if len(t) >= 2]

        # 2. Very short strings are never safe to match as substrings.
        if len(low.replace(' ', '')) <= 4:
            reasons.append(f'SHORT ({len(low.replace(" ", ""))} chars) — must be ambiguous')

        # 3. Vocabulary collision — and the test differs by arity, because the resolver matches
        #    the WHOLE name, not its tokens.
        #
        #    A multi-word name is matched as a phrase, so "Palo Alto Networks" containing the
        #    generic word "networks" is harmless: the phrase itself is distinctive. What IS risky
        #    is a phrase where EVERY word is ordinary, because then the phrase can occur in
        #    ordinary copy — "pure storage", "extreme networks", "western digital".
        if len(toks) == 1:
            t = toks[0]
            if t in VOCAB:
                reasons.append(f'SINGLE-WORD name "{t}" is ordinary vocabulary')
            else:
                inside = [w for w in VOCAB if len(w) > len(t) and t in w]
                if inside:
                    reasons.append(f'SINGLE-WORD name "{t}" is a fragment of {inside[:3]}')
        else:
            generic = [t for t in toks if t in VOCAB]
            if len(generic) == len(toks):
                reasons.append(f'EVERY word is ordinary vocabulary {generic} — the phrase can occur in plain copy')

        # 4. The name is a substring of another company's name, which would attribute an event to
        #    both. (One direction only: the SHORTER name is the dangerous one.)
        others = [o for o in (cand_names + EXISTING) if o.lower() != low and low in o.lower()]
        if others:
            reasons.append(f'SUBSTRING of other companies {sorted(set(others))[:3]}')

    if reasons:
        problems.append((name, c['sector'], c['strength'], reasons))

print(f'candidates: {len(cands)}  after dedup: {len(deduped)}  dropped as dupes: {len(dupes)}')
print(f'vocab terms: {len(VOCAB)}')
print(f'\nDUPLICATES RESOLVED ({len(dupes)}):')
for name, why in dupes:
    print(f'  {name} — {why}')

print(f'\nOVER-MATCH FLAGS ({len(problems)}) — each must become ambiguous or be justified:')
for name, sector, strength, reasons in problems:
    print(f'  {name}  [{sector} / {strength}]')
    for r in reasons:
        print(f'      - {r}')

# Apply the screen: anything flagged for a vocabulary or substring collision is forced to
# 'ambiguous'. This is the whole point of a mechanical pass — the correction is not left to a
# later judgement call that may not happen.
flagged = {n for n, _, _, _ in problems}
forced = 0
for c in deduped:
    if c['name'] in flagged and c['strength'] == 'distinctive':
        c['strength'] = 'ambiguous'
        reasons = next(r for n, _, _, r in problems if n == c['name'])
        c['strengthReason'] = c.get('strengthReason') or '; '.join(reasons)
        forced += 1

print(f'\nforced to ambiguous by this screen: {forced}')
print(f'final: {len(deduped)} entries — '
      f"{sum(1 for c in deduped if c['strength'] == 'distinctive')} distinctive, "
      f"{sum(1 for c in deduped if c['strength'] == 'ambiguous')} ambiguous")

io.open('docs/audit/screened-companies.json', 'w', encoding='utf-8').write(
    json.dumps(deduped, indent=1, ensure_ascii=False)
)
print('wrote docs/audit/screened-companies.json')
