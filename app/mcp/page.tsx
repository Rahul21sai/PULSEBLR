import Link from 'next/link';
import type { Metadata } from 'next';

import AppShell from '../components/AppShell';
import { Card, PageHeader, SectionTitle, Well } from '../components/ui';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';
import { TOOL_DEFS } from '@/lib/mcp/tool-defs';

/**
 * `/mcp` — how to connect an assistant to PulseBLR.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE ENDPOINT URL IS COMPUTED, NEVER TYPED. Every snippet on this page is built from
 * `absoluteUrl('/api/mcp')`, so a reader on a preview deployment copies a config that points at the
 * preview and a reader on production gets production. A hard-coded host is the one defect that would
 * make this page actively harmful: a config file is copied once and lives in a developer's dotfiles
 * for months, so a wrong URL here is a wrong URL forever with no error message that names us.
 *
 * THE TOOL LIST IS GENERATED FROM `TOOL_DEFS`. A hand-written list would drift the first time a tool
 * is renamed, and nothing would fail — the page would simply lie. Same reason `app/robots.ts` derives
 * its disallow list from `PROTECTED_PATHS` rather than repeating it.
 *
 * IT IS DELIBERATELY NOT IN THE NAV. This is a page for a developer who wants to wire PulseBLR into
 * their editor, not a destination for someone browsing events — the same judgement `/companies` got
 * (CLAUDE.md §4): a top-level slot is for a reader's question, and this is a builder's. The route
 * stays public and unguarded so a link from a README or a Claude Directory listing lands somewhere,
 * and it is NOT in `PROTECTED_PATHS`.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Static. Nothing here reads the database or the request. */
export const revalidate = 86400;

const TITLE = 'Connect PulseBLR to Claude, Cursor and Copilot';
const DESCRIPTION =
  'PulseBLR ships a Model Context Protocol server, so any MCP-capable assistant can search ' +
  'Bengaluru software and hardware engineering events and link straight to them. Read-only, no ' +
  'account, no API key.';

export const metadata: Metadata = {
  metadataBase: new URL(canonicalOrigin()),
  title: `${TITLE} · PulseBLR`,
  description: DESCRIPTION,
  alternates: { canonical: absoluteUrl('/mcp') },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: absoluteUrl('/mcp'),
    siteName: 'PulseBLR',
    type: 'website',
    locale: 'en_IN',
  },
};

const ENDPOINT = absoluteUrl('/api/mcp');

/**
 * Two config shapes cover every client worth naming.
 *
 * `mcpServers` + `{ type: 'http', url }` is what Claude Code, Claude Desktop and Cursor read;
 * VS Code / Copilot uses `servers` in `.vscode/mcp.json` with the same inner object. Both are shown
 * in full rather than as a diff, because a partial JSON snippet pasted into an existing config is
 * how people end up with a file that no longer parses.
 */
const CLIENTS: Array<{ name: string; where: string; snippet: string; note?: string }> = [
  {
    name: 'Claude Code',
    where: 'Run this in your terminal — no file editing.',
    snippet: `claude mcp add --transport http pulseblr ${ENDPOINT}`,
    note: 'Then ask it something like "what AI meetups are on in Bengaluru this week?".',
  },
  {
    name: 'Claude Desktop',
    where: 'Settings → Developer → Edit Config (claude_desktop_config.json)',
    snippet: JSON.stringify(
      { mcpServers: { pulseblr: { type: 'http', url: ENDPOINT } } },
      null,
      2
    ),
    note: 'Restart Claude Desktop after saving.',
  },
  {
    name: 'Cursor',
    where: '~/.cursor/mcp.json for every project, or .cursor/mcp.json for one',
    snippet: JSON.stringify(
      { mcpServers: { pulseblr: { type: 'http', url: ENDPOINT } } },
      null,
      2
    ),
  },
  {
    name: 'VS Code / GitHub Copilot',
    where: '.vscode/mcp.json in your workspace',
    snippet: JSON.stringify({ servers: { pulseblr: { type: 'http', url: ENDPOINT } } }, null, 2),
    note: 'Copilot lists the tools under the Agent-mode tool picker once the server connects.',
  },
];

export default function McpPage() {
  return (
    <AppShell title="MCP">
      <div className="max-w-[880px] mx-auto px-4 md:px-8 pt-4 md:pt-6 pb-12">
        <PageHeader
          eyebrow="For developers"
          title="PulseBLR inside your assistant"
          subtitle={DESCRIPTION}
        />

        <Card className="mb-6">
          <SectionTitle
            title="The endpoint"
            subtitle="Streamable HTTP. Read-only, unauthenticated, no key to manage."
          />
          <Well className="font-mono text-[13px] break-all">{ENDPOINT}</Well>
          <p className="mt-3 text-[13px] leading-relaxed text-[#6E6E73]">
            It answers JSON-RPC 2.0 over <code className="font-mono text-[12px]">POST</code> and
            speaks MCP revisions 2024-11-05 through 2025-06-18, so it works with whichever your
            client negotiates. There is no server-initiated SSE stream and no session — a{' '}
            <code className="font-mono text-[12px]">GET</code> is refused on purpose rather than left
            hanging.
          </p>
        </Card>

        <Card className="mb-6">
          <SectionTitle
            title={`${TOOL_DEFS.length} tools`}
            subtitle="Bengaluru only, and software/hardware engineering only — the same scope as the feed on this site."
          />
          <ul className="flex flex-col gap-3">
            {TOOL_DEFS.map(tool => (
              <li key={tool.name} className="border-t border-[color:var(--hairline)] pt-3 first:border-0 first:pt-0">
                <p className="font-mono text-[12.5px] text-[#1D1D1F]">{tool.name}</p>
                <p className="mt-1 text-[13px] leading-relaxed text-[#6E6E73]">
                  {firstSentence(tool.description)}
                </p>
                <p className="mt-1.5 t-label text-[#8E8E93]">
                  {argumentLine(tool.inputSchema)}
                </p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] leading-relaxed text-[#6E6E73]">
            Every result carries the canonical event page URL, so an assistant can send you straight
            there. Results are ranked by connection potential rather than by date, which is the one
            thing this corpus has that the source platforms do not —{' '}
            <Link href="/" className="text-[#0071E3] hover:underline">
              see it on the feed
            </Link>
            .
          </p>
        </Card>

        <Card className="mb-6">
          <SectionTitle title="Client configuration" subtitle="Pick yours and copy the whole block." />
          <div className="flex flex-col gap-5">
            {CLIENTS.map(client => (
              <div key={client.name}>
                <p className="text-[13.5px] font-semibold text-[#1D1D1F]">{client.name}</p>
                <p className="mt-0.5 mb-2 text-[12.5px] text-[#8E8E93]">{client.where}</p>
                <Well className="font-mono whitespace-pre overflow-x-auto">{client.snippet}</Well>
                {client.note && (
                  <p className="mt-1.5 text-[12.5px] text-[#6E6E73]">{client.note}</p>
                )}
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle
            title="What it does not do yet"
            subtitle="Stated plainly, because the interesting half is the missing half."
          />
          <p className="text-[13px] leading-relaxed text-[#3a3a3c]">
            This version is public data only. The tools that would make it genuinely ours — the
            people you have already met, who you know at a given company, which follow-ups are
            overdue — need per-user authentication on this endpoint, and that is real work rather
            than a flag. It was left out so the public search half could ship on its own.
          </p>
          <p className="mt-3 text-[13px] leading-relaxed text-[#3a3a3c]">
            Until then, that side of the product lives in the app:{' '}
            <Link href="/people" className="text-[#0071E3] hover:underline">
              People
            </Link>{' '}
            and{' '}
            <Link href="/tracker" className="text-[#0071E3] hover:underline">
              the tracker
            </Link>
            .
          </p>
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * The first sentence of a tool description.
 *
 * The full descriptions are written for a MODEL — several paragraphs, including the scope caveats it
 * needs before choosing a tool. On a page a human is scanning, that is a wall. Splitting on the
 * sentence keeps one source of truth for both audiences rather than adding a second summary field
 * that would drift.
 */
function firstSentence(description: string): string {
  const head = description.split('\n')[0];
  const stop = head.indexOf('. ');
  return stop === -1 ? head : `${head.slice(0, stop + 1)}`;
}

/** "Arguments: query, category, area …" — read off the schema, so it cannot list a stale argument. */
function argumentLine(schema: Record<string, unknown>): string {
  const properties = (schema.properties ?? {}) as Record<string, unknown>;
  const required = new Set((schema.required as string[] | undefined) ?? []);
  const names = Object.keys(properties).map(name => (required.has(name) ? `${name}*` : name));
  if (names.length === 0) return 'No arguments';
  return `Arguments: ${names.join(', ')}${required.size > 0 ? '  (* required)' : ''}`;
}
