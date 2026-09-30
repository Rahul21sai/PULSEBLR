import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * WHAT A ROUTE OR PAGE FILE MAY EXPORT. Next type-checks these files' exports against an allowlist,
 * but only inside `next build`: `tsc --noEmit` passes, the suite passes, and the production build
 * fails. It has happened three times on this branch (`createDeleteAccountHandler`,
 * `createIntakeHandler`, `createPushTestHandler`, and once more for a folder-field helper), each time
 * caught late. This moves the same check into the ordinary test run.
 *
 * The allowlists are Next 16's documented route-segment config plus each file kind's own exports
 * (node_modules/next/dist/docs: route handlers, page, layout, metadata files). A helper belongs in
 * `lib/`, which is where every one of the four above now lives.
 */
const SEGMENT_CONFIG = ['dynamic', 'dynamicParams', 'revalidate', 'fetchCache', 'runtime', 'preferredRegion', 'maxDuration'];
const ALLOWED: Record<string, string[]> = {
  'route.ts': ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'generateStaticParams', ...SEGMENT_CONFIG],
  'page.tsx': ['default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', 'generateStaticParams', ...SEGMENT_CONFIG],
  'layout.tsx': ['default', 'metadata', 'generateMetadata', 'viewport', 'generateViewport', 'generateStaticParams', ...SEGMENT_CONFIG],
  'opengraph-image.tsx': ['default', 'alt', 'size', 'contentType', 'generateImageMetadata', ...SEGMENT_CONFIG],
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return name in ALLOWED ? [full] : [];
  });
}

/** Every exported name in a module, including `export { a, b as c } from '…'` and `export default`. */
export function exportedNames(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const names = new Set<string>();
  if (/\bexport\s+default\b/.test(code)) names.add('default');
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:function\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/\bexport\s+(?!type\b)\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim();
      if (!piece || piece.startsWith('type ')) continue;
      const alias = piece.split(/\s+as\s+/).pop()!.trim();
      if (alias) names.add(alias);
    }
  }
  return [...names];
}

describe('route and page files export only what Next allows', () => {
  it('parses the shapes this repo uses', () => {
    expect(exportedNames(`export { POST } from '@/lib/x';`)).toEqual(['POST']);
    expect(exportedNames(`export async function GET() {}\nexport const dynamic = 'force-dynamic';`).sort()).toEqual(['GET', 'dynamic']);
    expect(exportedNames(`export default function Page() {}\nexport function helper() {}`).sort()).toEqual(['default', 'helper']);
    expect(exportedNames(`export type { Foo } from './foo';\nexport interface Bar {}`)).toEqual([]);
  });

  it('every app/ route, page, layout and share-image file', () => {
    const files = walk(path.join(process.cwd(), 'app'));
    // A scan that finds nothing has stopped recognising files, not proven the tree clean.
    expect(files.length).toBeGreaterThan(40);
    const offenders: string[] = [];
    for (const file of files) {
      const kind = path.basename(file);
      const bad = exportedNames(readFileSync(file, 'utf8')).filter(name => !ALLOWED[kind].includes(name));
      if (bad.length) offenders.push(`${path.relative(process.cwd(), file)}: ${bad.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});
