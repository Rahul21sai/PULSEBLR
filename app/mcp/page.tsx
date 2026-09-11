import Link from 'next/link';
import type { Metadata } from 'next';

import AppShell from '../components/AppShell';
import { Card, PageHeader, SectionTitle, Well } from '../components/ui';
import { absoluteUrl, canonicalOrigin } from '@/lib/canonical-origin';
import { PERSONAL_TOOL_DEFS, PUBLIC_TOOL_DEFS } from '@/lib/mcp/tool-defs';
import { TOKEN_PREFIX, TOKEN_TTL_DAYS } from '@/lib/mcp/identity';

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
 *
 * ── NOTHING USER-SPECIFIC IS ON THIS PAGE, AND THAT CONSTRAINS THE v2 SECTION ────────────────
 * It is in `app/sitemap.ts` and therefore publicly indexed, and it is `revalidate = 86400` static. So
 * the authenticated half is DOCUMENTED here and MANAGED in `/settings`: this page names the personal
 * tools, shows the config shape with a `<placeholder>` where the token goes, and links to Settings.
 * It never reads a session, never lists a token, and the token minting UI is not here — a page Google
 * has a copy of is not where a credential belongs. Tool NAMES and schemas are not user-specific: they
 * are in this repo and in every client's tool picker, so publishing them costs nothing and is the
 * whole pitch.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 */

/** Static. Nothing here reads the database or the request. */
export const revalidate = 86400;

const TITLE = 'Connect PulseBLR to Claude, Cursor and Copilot';
const DESCRIPTION =
  'PulseBLR ships a Model Context Protocol server, so any MCP-capable assistant can search ' +
  'Bengaluru software and hardware engineering events and link straight to them. Read-only. Public ' +
  'search needs no account; add a personal token and your assistant can also answer "who do I know ' +
  'at Razorpay?" from the people you have actually met.';

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

/**
 * The same clients, with a token.
 *
 * THE PLACEHOLDER IS A PLACEHOLDER AND MUST STAY ONE. This page is static, public and indexed — it
 * cannot know who is reading it and must not try. `<your-token>` is the shape, and Settings is where
 * the real string comes from.
 *
 * Every one of these adds exactly one thing to the block above: an `Authorization` header. Shown as
 * complete blocks rather than diffs for the reason the public set already gives — a partial JSON
 * snippet pasted into an existing config is how people end up with a file that no longer parses.
 */
const TOKEN_PLACEHOLDER = `${TOKEN_PREFIX}<your-token>`;

const AUTHED_CLIENTS: Array<{ name: string; where: string; snippet: string; note?: string }> = [
  {
    name: 'Claude Code',
    where: 'One flag more than above. Remove the server first if you already added it without a token.',
    snippet: `claude mcp add --transport http pulseblr ${ENDPOINT} \\\n  --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
    note: 'Verify with `claude mcp list` — you should see eight tools rather than four.',
  },
  {
    name: 'Claude Desktop / Cursor',
    where: 'claude_desktop_config.json, or ~/.cursor/mcp.json',
    snippet: JSON.stringify(
      {
        mcpServers: {
          pulseblr: {
            type: 'http',
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
          },
        },
      },
      null,
      2
    ),
  },
  {
    name: 'VS Code / GitHub Copilot',
    where: '.vscode/mcp.json in your workspace',
    snippet: JSON.stringify(
      {
        servers: {
          pulseblr: {
            type: 'http',
            url: ENDPOINT,
            headers: { Authorization: `Bearer ${TOKEN_PLACEHOLDER}` },
          },
        },
      },
      null,
      2
    ),
    note: 'A workspace file is committed by default — put the token in an input variable or your user-level config instead.',
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
            title={`${PUBLIC_TOOL_DEFS.length} public tools`}
            subtitle="No account, no key. Bengaluru only, and software/hardware engineering only — the same scope as the feed on this site."
          />
          <ToolList tools={PUBLIC_TOOL_DEFS} />
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
          <SectionTitle
            title={`${PERSONAL_TOOL_DEFS.length} more with a token`}
            subtitle="Your own record of the people you have met. Nobody else can offer these, because nobody else has the data."
          />
          <p className="mb-4 text-[13px] leading-relaxed text-[#3a3a3c]">
            Event listings are a commodity — several sites aggregate the same Luma and Meetup feeds.
            What is not a commodity is <em>who you met at them</em>, because that only exists if you
            recorded it. With a token in your client,{' '}
            <span className="font-semibold text-[#1D1D1F]">
              &ldquo;who do I know at Razorpay?&rdquo;
            </span>{' '}
            becomes a question your assistant can actually answer.
          </p>
          <ToolList tools={PERSONAL_TOOL_DEFS} />
          <div className="mt-4 rounded-xl bg-[#f9f9fb] p-4 text-[12.5px] leading-relaxed text-[#3a3a3c]">
            <p>
              These are read-only and scoped to the one account that minted the token. There is no
              argument on any of them that can name a different account, and without a token they do
              not appear in the tool list at all.
            </p>
            <p className="mt-2">
              <Link href="/settings" className="font-semibold text-[#0071E3] hover:underline">
                Mint a token in Settings
              </Link>{' '}
              — shown once, revocable at any time, and it expires after {TOKEN_TTL_DAYS.default} days
              by default.
            </p>
          </div>
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

        <Card className="mb-6">
          <SectionTitle
            title="Client configuration, with a token"
            subtitle="Identical to the block above plus one Authorization header."
          />
          <div className="flex flex-col gap-5">
            {AUTHED_CLIENTS.map(client => (
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
          <p className="mt-4 text-[12.5px] leading-relaxed text-[#6E6E73]">
            Replace <code className="font-mono">{TOKEN_PLACEHOLDER}</code> with the token Settings
            gives you. Treat it like a password: it is not a shared link, and a config file holding one
            should not be committed.
          </p>
        </Card>

        <Card>
          <SectionTitle
            title="What it does not do"
            subtitle="Stated plainly, because the limits are the useful part."
          />
          <ul className="flex flex-col gap-3 text-[13px] leading-relaxed text-[#3a3a3c]">
            <li>
              <span className="font-semibold text-[#1D1D1F]">No OAuth, so no connector directory.</span>{' '}
              Authentication is a token you paste into a config file. Any client that can set a header
              works — Claude Code, Claude Desktop, Cursor, VS Code. The one thing it cannot do is the
              &ldquo;add a custom connector&rdquo; flow on claude.ai, which drives an OAuth handshake
              and gives you nowhere to put a header. That flow still reaches the public four tools.
            </li>
            <li>
              <span className="font-semibold text-[#1D1D1F]">Read-only, with no way to opt out of that.</span>{' '}
              Nothing here can save an event, record a person, complete a follow-up or edit anything.
              The token has one scope and it is <code className="font-mono">read</code>.
            </li>
            <li>
              <span className="font-semibold text-[#1D1D1F]">No emails or phone numbers.</span> Person
              results carry a name, employer, role, your own note and a LinkedIn URL where a scan
              supplied one. Contact details stay in{' '}
              <Link href="/people" className="text-[#0071E3] hover:underline">
                the app
              </Link>
              , which is also where the CSV export lives — a result here lands in a model&rsquo;s
              context and from there into a transcript, and that is not where a phone number belongs.
            </li>
            <li>
              <span className="font-semibold text-[#1D1D1F]">No streaming, and no sessions.</span> A{' '}
              <code className="font-mono">GET</code> is refused rather than left hanging, because a
              stateless server has nothing to push. The token is verified on every request.
            </li>
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}

/**
 * One tool family, rendered.
 *
 * Extracted the moment there were two lists rather than copied — the second copy is how the public and
 * personal listings would end up styled differently, which would read as two features from two eras.
 */
function ToolList({ tools }: { tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {tools.map(tool => (
        <li
          key={tool.name}
          className="border-t border-[color:var(--hairline)] pt-3 first:border-0 first:pt-0"
        >
          <p className="font-mono text-[12.5px] text-[#1D1D1F]">{tool.name}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-[#6E6E73]">
            {firstSentence(tool.description)}
          </p>
          <p className="mt-1.5 t-label text-[#8E8E93]">{argumentLine(tool.inputSchema)}</p>
        </li>
      ))}
    </ul>
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
