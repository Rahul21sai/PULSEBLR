"""
Turn `docs/audit/screened-companies.json` into registry entries and splice them into
`lib/companies/registry.ts`.

Generated rather than hand-typed because 234 entries typed by hand is 234 chances to fat-finger a
`strength`, and `strength` is the field where a mistake silently mis-attributes people forever.
Runs once; the file is edited by hand afterwards like any other.

Two things it is careful about:

  - `strengthReason` from the research pass is emitted as a COMMENT on the ambiguous entries, not
    dropped. The registry's header says "when in doubt choose 'ambiguous'", and the next person to
    look at `{ name: 'Plum', strength: 'ambiguous' }` will reasonably wonder why a payments company
    needed hedging. "'plum' is an ordinary English word" answers that in place and stops the
    downgrade being quietly reverted as over-cautious.
  - It refuses to run twice, by checking for a marker it inserts.
"""

import json
import io
import re

SECTOR_ORDER = [
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
]

MARKER = '// ── Bengaluru tech employers'

path = 'lib/companies/registry.ts'
src = io.open(path, encoding='utf-8').read()
if MARKER in src:
    raise SystemExit('Already spliced — registry.ts contains the marker. Nothing to do.')

entries = json.load(io.open('docs/audit/screened-companies.json', encoding='utf-8'))


def ts_str(s):
    return "'" + s.replace('\\', '\\\\').replace("'", "\\'") + "'"


def emit(c):
    parts = [f'name: {ts_str(c["name"])}', f'sector: {ts_str(c["sector"])}', f'strength: {ts_str(c["strength"])}']
    aliases = [a for a in (c.get('aliases') or []) if a.strip() and a.strip().lower() != c['name'].lower()]
    if aliases:
        parts.append('aliases: [' + ', '.join(ts_str(a) for a in aliases) + ']')
    site = (c.get('website') or '').strip()
    if site.startswith('http'):
        parts.append(f'website: {ts_str(site)}')

    line = '  { ' + ', '.join(parts) + ' },'

    reason = (c.get('strengthReason') or '').strip()
    if c['strength'] == 'ambiguous' and reason:
        # One line, collapsed, so a wide entry plus its justification stays readable.
        reason = re.sub(r'\s+', ' ', reason)
        if len(reason) > 150:
            reason = reason[:147].rstrip() + '…'
        return f'  // ambiguous: {reason}\n{line}'
    return line


blocks = []
blocks.append(f'''
  {MARKER} added 2026-09-06 ─────────────────────────────────
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
  // person does not read `{{ name: 'Plum', strength: 'ambiguous' }}` as over-caution and revert it.
''')

for sector in SECTOR_ORDER:
    group = [c for c in entries if c['sector'] == sector]
    if not group:
        continue
    group.sort(key=lambda c: c['name'].lower())
    blocks.append(f'\n  // {sector} ({len(group)})')
    for c in group:
        blocks.append(emit(c))

addition = '\n'.join(blocks) + '\n'

# Splice immediately before the closing bracket of the COMPANIES array — the first `];` at column 0.
close = src.index('\n];')
src = src[:close] + '\n' + addition + src[close:]
io.open(path, 'w', encoding='utf-8', newline='').write(src)

print(f'spliced {len(entries)} entries into {path}')
print('distinctive:', sum(1 for c in entries if c['strength'] == 'distinctive'))
print('ambiguous:', sum(1 for c in entries if c['strength'] == 'ambiguous'))
