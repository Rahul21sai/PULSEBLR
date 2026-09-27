/**
 * ACCESSIBILITY, AS FAR AS SOURCE TEXT CAN PROVE IT.
 *
 * Four source scanners over every page and component in app/ (excluding app/api), each one a rule
 * that a real regression in this repo would break silently:
 *
 *   (a) every `<img>` carries `alt` — `alt=""` is a decision that an image is decorative (the covers
 *       sit beside their own title, the avatars beside a name), a missing attribute is not, and a
 *       screen reader then reads the file name of a CDN URL;
 *   (b) a button or link whose only content is a Material Symbols glyph has an accessible name — the
 *       glyph's ligature text ("more_vert", "close") is otherwise what gets announced;
 *   (c) `outline-none` travels with a visible replacement in the same className;
 *   (d) no text colour falls below its WCAG 1.4.3 floor, computed from globals.css's hex values.
 *
 * WHAT THIS CANNOT SEE, stated so a green run is not read as more than it is: focus ORDER, whether a
 * dialog's trap actually holds in a browser, what a screen reader announces for a composite widget,
 * contrast of text over a photograph, and anything a runtime class string assembles from variables.
 * Those need the real-device pass. The scanners are tuned for ZERO false positives on this tree at
 * some cost in reach — a guard that cries wolf is a guard somebody deletes — and each is shown to
 * catch a planted violation below, so zero findings is evidence rather than silence.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contrast,
  findImgWithoutAlt,
  findLowContrastText,
  findOutlineNoneWithoutReplacement,
  findUnnamedIconControls,
  parseHexTokens,
  stripComments,
} from './support/a11y-scan';

const root = path.resolve(import.meta.dirname, '..');
// `fs.globSync` exists at runtime on Node 22 but not in the installed @types/node, so tsc rejects
// it; a plain walk is the same list with no type gap.
function walkTsx(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap(name => {
    const rel = `${dir}/${name}`;
    if (statSync(path.join(root, rel)).isDirectory()) return walkTsx(rel);
    return name.endsWith('.tsx') ? [rel] : [];
  });
}
const files = walkTsx('app')
  .map(f => f.split(path.sep).join('/'))
  .filter(f => !f.startsWith('app/api/'))
  .sort();
const read = (f: string) => readFileSync(path.join(root, f), 'utf8');
const css = read('app/globals.css');

const fmt = (list: Array<{ file: string; line: number; snippet: string }>) =>
  list.map(x => `${x.file}:${x.line}  ${x.snippet}`).join('\n');

describe('the scan covers the app', () => {
  it('reads a real number of files, so an empty glob cannot pass every rule below', () => {
    expect(files.length).toBeGreaterThan(80);
    expect(files).toContain('app/components/Sheet.tsx');
    expect(files).toContain('app/page.tsx');
  });
});

describe('(a) every <img> has an alt attribute', () => {
  it('holds across app/', () => {
    const found = files.flatMap(f => findImgWithoutAlt(f, read(f)));
    expect(found, fmt(found)).toEqual([]);
  });

  it('catches a missing alt, and ignores an <img> quoted in a comment', () => {
    expect(findImgWithoutAlt('x.tsx', '<img src={a} className="c" />')).toHaveLength(1);
    expect(findImgWithoutAlt('x.tsx', '<img src={a} alt="" />')).toHaveLength(0);
    expect(findImgWithoutAlt('x.tsx', '{/* a plain <img>, not next/image */}\n<p/>')).toHaveLength(0);
    // A `>` inside an expression must not end the tag early and hide the alt after it.
    expect(findImgWithoutAlt('x.tsx', '<img onError={e => a > b} alt="" />')).toHaveLength(0);
  });
});

describe('(b) icon-only controls are named', () => {
  it('holds across app/', () => {
    const found = files.flatMap(f => findUnnamedIconControls(f, read(f)));
    expect(found, fmt(found)).toEqual([]);
  });

  it('catches a glyph-only button with no aria-label, and spares a labelled or texted one', () => {
    const glyph = '<span aria-hidden="true" className="material-symbols-outlined">close</span>';
    expect(findUnnamedIconControls('x.tsx', `<button type="button" onClick={f}>${glyph}</button>`)).toHaveLength(1);
    expect(findUnnamedIconControls('x.tsx', `<Link href="/x">\n  ${glyph}\n</Link>`)).toHaveLength(1);
    expect(findUnnamedIconControls('x.tsx', `<button aria-label="Close">${glyph}</button>`)).toHaveLength(0);
    expect(findUnnamedIconControls('x.tsx', `<button>${glyph}Close</button>`)).toHaveLength(0);
    expect(findUnnamedIconControls('x.tsx', `<button>${glyph}{label}</button>`)).toHaveLength(0);
  });
});

describe('(c) outline-none always has a visible replacement', () => {
  it('holds across app/', () => {
    const found = files.flatMap(f => findOutlineNoneWithoutReplacement(f, read(f)));
    expect(found, fmt(found)).toEqual([]);
  });

  it('judges the whole className, including the branch inside ${…}', () => {
    const bare = 'const c = "h-10 w-full focus:outline-none";';
    expect(findOutlineNoneWithoutReplacement('x.tsx', bare)).toHaveLength(1);
    expect(findOutlineNoneWithoutReplacement('x.tsx', 'const c = "outline-none focus:shadow-[inset_0_0_0_2px_var(--accent)]";')).toHaveLength(0);
    expect(findOutlineNoneWithoutReplacement('x.tsx', 'const c = "focus:outline-none focus-visible:ring-2";')).toHaveLength(0);
    const branch = 'const c = `focus:outline-none ${e ? "border-red" : "focus:border-[var(--accent)]"}`;';
    expect(findOutlineNoneWithoutReplacement('x.tsx', branch)).toHaveLength(0);
  });

  it('the global ring is unlayered, which is why a Tailwind outline-none cannot defeat it today', () => {
    // If `:focus-visible` ever moves into an @layer, every `outline-none` above would win over it.
    // (c) keeps the codebase from depending on that, and this pins the cascade fact itself.
    const plain = stripComments(css);
    const at = plain.indexOf(':focus-visible {');
    expect(at).toBeGreaterThan(-1);
    const before = plain.slice(0, at);
    // The rule must sit at the TOP LEVEL: every block opened before it — @supports, @theme, any
    // @layer — has closed by the time it starts.
    let depth = 0;
    let inLayer = 0;
    const re = /@layer\s+[\w-]+\s*\{|\{|\}/g;
    const stack: boolean[] = [];
    for (let m = re.exec(before); m; m = re.exec(before)) {
      if (m[0] === '}') {
        if (stack.pop()) inLayer--;
        depth--;
      } else {
        const isLayer = m[0].startsWith('@layer');
        stack.push(isLayer);
        if (isLayer) inLayer++;
        depth++;
      }
    }
    expect(inLayer).toBe(0);
    expect(depth).toBe(0);
  });
});

describe('(d) text contrast, computed from the token hex values', () => {
  const tokens = parseHexTokens(css);

  it('holds across app/', () => {
    const found = files.flatMap(f => findLowContrastText(f, read(f), css));
    expect(found, found.map(x => `${x.file}:${x.line} ${x.ratio}:1 < ${x.needed}:1  ${x.snippet}`).join('\n')).toEqual([]);
  });

  it('the text tokens clear 4.5:1 on both grounds, and --ink-3 does not (which is why it is not text)', () => {
    for (const t of ['ink', 'ink-2', 'accent', 'live']) {
      expect(contrast(tokens[t], tokens['paper']), `--${t} on paper`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(tokens[t], tokens['surface']), `--${t} on surface`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(tokens['accent-ink'], tokens['accent'])).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokens['ink-3'], tokens['paper'])).toBeLessThan(4.5);
    // …but it does clear 1.4.11's 3:1 for icons, which is the job it is kept for.
    expect(contrast(tokens['ink-3'], tokens['paper'])).toBeGreaterThanOrEqual(3);
  });

  it('the ratios written beside the tokens are the ratios the hex values produce', () => {
    // globals.css documents each token's contrast in a comment. They had drifted (--ink claimed
    // 16.4:1 against a real 17.5:1), and a stated ratio people trust is worse than none.
    const against: Record<string, string> = { 'accent-ink': 'accent' };
    for (const name of ['ink', 'ink-2', 'ink-3', 'accent', 'accent-ink', 'live']) {
      const line = css.match(new RegExp(`--${name}:\\s*#[0-9A-Fa-f]{6};[^\\n]*`))![0];
      const stated = Number(line.match(/(\d+(?:\.\d+)?):1/)![1]);
      const actual = contrast(tokens[name], tokens[against[name] ?? 'paper']);
      expect(Math.abs(actual - stated), `--${name}: comment says ${stated}:1, hex gives ${actual.toFixed(2)}:1`).toBeLessThan(0.06);
    }
  });

  it('catches --ink-3 as text, and spares it on a glyph, a disabled state or an aria-hidden mark', () => {
    const f = (src: string) => findLowContrastText('x.tsx', src, css);
    expect(f('<p className="text-[12px] text-[color:var(--ink-3)]">Hint</p>')).toHaveLength(1);
    expect(f('<span className={a ? "text-[var(--ink)]" : "text-[var(--ink-3)]"}>{n}</span>')).toHaveLength(1);
    expect(f('<span aria-hidden="true" className="material-symbols-outlined text-[var(--ink-3)]">x</span>')).toHaveLength(0);
    expect(f('<button className="disabled:text-[var(--ink-3)]">Go</button>')).toHaveLength(0);
    expect(f('<span aria-hidden="true" className="text-[var(--ink-3)]">·</span>')).toHaveLength(0);
    expect(f('<p className="text-[var(--ink-2)]">Fine</p>')).toHaveLength(0);
  });

  it('composites an alpha modifier against its background', () => {
    const f = (src: string) => findLowContrastText('x.tsx', src, css);
    // White at 60% on the accent green measures 4.44:1 — the chip count this suite was written
    // against. 70% is 5.46:1.
    expect(f('<span className="bg-[var(--accent)] text-[var(--accent-ink)]/60">3</span>')).toHaveLength(1);
    expect(f('<span className="bg-[var(--accent)] text-[var(--accent-ink)]/70">3</span>')).toHaveLength(0);
  });
});
