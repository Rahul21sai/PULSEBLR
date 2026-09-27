/**
 * Remove comments from JavaScript/TypeScript source, keeping string literals intact.
 *
 * Shared by the suites that assert on source TEXT (`tests/sw-policy.test.ts`, and the two
 * route-scope suites), because each of those files explains the rule it checks in prose right
 * next to the code — so a check that read the raw file would be satisfied by the explanation.
 * Not itself a test: vitest only collects `tests/**` files ending `.test.ts`, and this one does
 * not.
 *
 * A CHARACTER SCANNER RATHER THAN TWO REGEXES, and the first draft of sw-policy.test.ts proves
 * why it has to be. `/\/\*[\s\S]*?\*\//g` looks obviously correct and is not: `sw.js`'s
 * changelog contains the text `/_next/static/webpack/*` inside a `//` line comment, and the
 * `/*` in that path opened a block comment that ran on until the next `*​/` far below —
 * swallowing the three `const …_CACHE` declarations with it. The symptom was two cache-naming
 * assertions failing against a `sw.js` that was perfectly correct, i.e. the instrument reporting
 * a fault in the thing it was measuring. This repo's own rule, recorded in CLAUDE.md §17: when a
 * measurement disagrees with the code, the instrument is the first suspect.
 *
 * Order cannot fix it either — stripping line comments first breaks on any block comment
 * containing `//`. Tracking the state is the only version that is right for both.
 *
 * Strings are preserved deliberately: the assertions built on this match on literals like
 * `'/api/'`, so a stripper that removed string bodies would make them vacuous. REGEX LITERALS
 * ARE NOT TRACKED — the files scanned contain none, and sw-policy.test.ts asserts that for
 * `sw.js`, the file where one would be most tempting.
 */
export function stripComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
