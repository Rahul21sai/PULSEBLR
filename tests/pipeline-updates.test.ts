/**
 * Mongoose 9 throws "Cannot pass an array to query updates unless the `updatePipeline` option is
 * set" for an aggregation-pipeline update without the opt-in. `redactActorAuditRows` shipped
 * without it, so EVERY account deletion answered "temporarily unavailable" - and
 * `account-deletion.test.ts` could not see it, because it drives a fake store that never reaches
 * Mongoose. Found only by running the real cascade against Atlas.
 *
 * So this is a source scan, not a behaviour test: every pipeline-form update in the app must
 * carry `updatePipeline: true` in the same call.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['lib', 'app', 'scripts'];
const CALL = /\.(updateMany|updateOne|findOneAndUpdate|findByIdAndUpdate)\(/g;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

/** The argument list of the call opening at `open` (index of its `(`), by bracket matching. */
function callArgs(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(open + 1, i);
  }
  return source.slice(open + 1);
}

/** True when the second top-level argument starts with `[`, i.e. a pipeline update. */
export function isPipelineUpdate(args: string): boolean {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) return /^\s*\[/.test(args.slice(i + 1));
  }
  return false;
}

describe('pipeline-form updates opt in to updatePipeline', () => {
  it('recognises the shapes it guards', () => {
    expect(isPipelineUpdate(`{ a: 1 }, [{ $set: { b: '$c' } }], { session }`)).toBe(true);
    expect(isPipelineUpdate(`{ $or: [{ a: 1 }] }, { $set: { b: 1 } }`)).toBe(false);
  });

  it('every pipeline update in lib/, app/ and scripts/ passes updatePipeline: true', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of ROOTS.flatMap(files)) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(CALL)) {
        const open = match.index! + match[0].length - 1;
        const args = callArgs(source, open);
        if (!isPipelineUpdate(args)) continue;
        seen++;
        if (!/updatePipeline\s*:\s*true/.test(args)) {
          offenders.push(`${file}:${source.slice(0, open).split('\n').length}`);
        }
      }
    }
    // The account-deletion redaction is the known pipeline update; a scan that finds none has
    // stopped recognising the shape, not proven the codebase clean.
    expect(seen).toBeGreaterThan(0);
    expect(offenders).toEqual([]);
  });
});
