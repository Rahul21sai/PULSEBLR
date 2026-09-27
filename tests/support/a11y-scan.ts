/**
 * Source scanners for the accessibility guard in `tests/a11y-static.test.ts`.
 *
 * Pure string work over `.tsx` source, no DOM and no build. Each scanner is written to be exact on
 * the shapes this codebase actually uses rather than to parse JSX in general, and each is
 * mutation-checked by the suite: an introduced violation must be caught, and the fixed tree must
 * produce zero findings. A scanner that cries wolf gets switched off, so precision matters more
 * than reach here — the real screen-reader pass is still the authority (see the test docblock).
 */

export type Finding = { file: string; line: number; snippet: string };

/**
 * Blank out JS comments (`// …`, `/* … *\/`, and JSX `{/* … *\/}`) while keeping every newline and
 * every offset, so line numbers stay true. Comments in this repo quote markup constantly — "a plain
 * <img>, not next/image" — and a scanner reading those would report prose as code.
 *
 * String literals are respected so a `//` inside a URL (`'https://…'`) is not taken for a comment.
 * Template literals are treated as strings too; className templates contain no comment syntax.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && d === '/') {
      // Not a comment when it is the `//` of a URL inside JSX text or an attribute — those only
      // occur after a `:` (https://). JS line comments here never follow a colon directly.
      if (src[i - 1] === ':') {
        i += 2;
        continue;
      }
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      // Only treat quotes as JS strings when they cannot be JSX text apostrophes. JSX text such as
      // `Don't` would otherwise swallow the rest of the file. A quote directly after `=`, `(`, `,`,
      // `{`, `?`, `:`, `[`, `+`, whitespace-after-those, or `return` opens a string.
      let k = i - 1;
      while (k >= 0 && (src[k] === ' ' || src[k] === '\t')) k--;
      const prev = src[k];
      const opensString = c === '`' || (prev !== undefined && '=({,?:[+!&|;\n\r'.includes(prev));
      if (!opensString) {
        i++;
        continue;
      }
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j++;
        else if (c !== '`' && src[j] === '\n') break; // unterminated — bail, it was not a string
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

const lineOf = (src: string, offset: number) => src.slice(0, offset).split('\n').length;

/**
 * Find the end of a JSX opening tag starting at `start` (the `<`), honouring `{…}` expressions and
 * quoted attribute values, so a `>` inside `onClick={() => a > b}` does not end the tag.
 * Returns the offset just past the closing `>`, and whether the tag self-closes.
 */
export function openTagEnd(src: string, start: number): { end: number; selfClosing: boolean } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      if (depth > 0 || src[i - 1] === '=') quote = c;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return { end: i + 1, selfClosing: src[i - 1] === '/' };
  }
  return null;
}

/** (a) Every `<img>` must carry an `alt` attribute — `alt=""` for decoration is a decision, a missing one is not. */
export function findImgWithoutAlt(file: string, raw: string): Finding[] {
  const src = stripComments(raw);
  const found: Finding[] = [];
  const re = /<img\b/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const tag = openTagEnd(src, m.index);
    if (!tag) continue;
    const text = src.slice(m.index, tag.end);
    if (!/\salt=/.test(text)) found.push({ file, line: lineOf(src, m.index), snippet: text.slice(0, 80) });
  }
  return found;
}

/**
 * The matching `</tag>` for an element whose opening tag ends at `from`, counting nested same-name
 * elements. `name` is the JSX name (`button`, `a`, `Link`).
 */
function closeTagStart(src: string, name: string, from: number): number {
  const open = new RegExp(`<${name}(?=[\\s>/])`, 'g');
  const close = new RegExp(`</${name}\\s*>`, 'g');
  let depth = 1;
  let pos = from;
  while (depth > 0) {
    open.lastIndex = pos;
    close.lastIndex = pos;
    const o = open.exec(src);
    const c = close.exec(src);
    if (!c) return -1;
    if (o && o.index < c.index) {
      const t = openTagEnd(src, o.index);
      if (t && !t.selfClosing) depth++;
      pos = t ? t.end : o.index + 1;
    } else {
      depth--;
      pos = c.index + c[0].length;
      if (depth === 0) return c.index;
    }
  }
  return -1;
}

/**
 * (b) An interactive element whose ONLY content is a Material Symbols glyph must be named.
 *
 * The glyph's ligature text ("close", "more_vert") is what a screen reader would otherwise read,
 * and the correct pattern here is `aria-label` on the control and `aria-hidden` on the glyph. A
 * control counts as icon-only when, after removing every glyph `<span>`, nothing is left but
 * whitespace — any other text, JSX expression or child element is taken as a label source and the
 * control is not judged, which keeps this scanner free of false positives at the cost of reach.
 */
export function findUnnamedIconControls(file: string, raw: string): Finding[] {
  const src = stripComments(raw);
  const found: Finding[] = [];
  const re = /<(button|a|Link)(?=[\s>])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const name = m[1];
    const tag = openTagEnd(src, m.index);
    if (!tag || tag.selfClosing) continue;
    const openText = src.slice(m.index, tag.end);
    const closeAt = closeTagStart(src, name, tag.end);
    if (closeAt === -1) continue;
    const inner = src.slice(tag.end, closeAt);
    const glyph = /<span\b[^>]*material-symbols-outlined[^>]*>[\s\S]*?<\/span>/g;
    if (!glyph.test(inner)) continue;
    const rest = inner.replace(glyph, '').trim();
    if (rest !== '') continue;
    if (/\saria-label(ledby)?=/.test(openText)) continue;
    found.push({ file, line: lineOf(src, m.index), snippet: openText.replace(/\s+/g, ' ').slice(0, 100) });
  }
  return found;
}

/**
 * (c) `outline-none` / `focus:outline-none` must travel with a visible replacement in the SAME
 * className — a `focus-visible:` utility, or a `focus:` border/shadow/ring/bg utility (on a text
 * input `:focus` and `:focus-visible` coincide, so a `focus:` indicator is shown to keyboard users).
 *
 * Note what this does and does not protect. Today the global `:focus-visible` outline in
 * globals.css is UNLAYERED while Tailwind's `outline-none` sits in `@layer utilities`, so the ring
 * survives either way. This rule exists so the codebase does not depend on that cascade accident:
 * one `!outline-none`, or the rule moving into a layer, and every one of these would go dark.
 */
export function findOutlineNoneWithoutReplacement(file: string, raw: string): Finding[] {
  const src = stripComments(raw);
  const found: Finding[] = [];
  for (const { text: cls, offset } of classLists(src)) {
    if (!/(^|[\s:])outline-(none|hidden)(?![\w-])/.test(cls)) continue;
    // Split on quotes and braces too: a branch inside `${…}` arrives as `'focus:border-…'`.
    const tokens = cls.split(/[\s'"`{}()?]+/);
    const hasReplacement = tokens.some(
      t =>
        /(^|:)focus-visible:/.test(t) ||
        /(^|:)focus:(shadow|border|ring|bg|outline-(?!none|hidden))/.test(t)
    );
    if (!hasReplacement) found.push({ file, line: lineOf(src, offset), snippet: cls.replace(/\s+/g, ' ').slice(0, 100) });
  }
  return found;
}

/**
 * Every string that could be a class list: `"…"` / `'…'` literals, and WHOLE template literals —
 * `${…}` interpolations included, because this codebase puts the conditional half of a className
 * inside them (`focus:outline-none ${error ? … : 'focus:border-…'}`), and judging the static half
 * alone would report a replacement that is sitting right there in the branch.
 */
export function classLists(src: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '`') {
      let depth = 0;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (depth === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { depth++; j++; continue; }
        if (depth > 0 && src[j] === '}') depth--;
      }
      out.push({ text: src.slice(i + 1, j), offset: i });
      i = j;
    } else if (c === '"' || c === "'") {
      const end = src.indexOf(c, i + 1);
      const nl = src.indexOf('\n', i + 1);
      if (end === -1 || (nl !== -1 && nl < end)) continue; // an apostrophe in JSX text, not a string
      out.push({ text: src.slice(i + 1, end), offset: i });
      i = end;
    }
  }
  return out;
}

/* ─── Contrast ────────────────────────────────────────────────────────────────────────────────── */

/** Start/end offsets of every JSX opening tag, with its name. */
function openingTags(src: string): Array<{ name: string; start: number; end: number }> {
  const tags: Array<{ name: string; start: number; end: number }> = [];
  const re = /<([A-Za-z][\w.]*)(?=[\s>/])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const t = openTagEnd(src, m.index);
    if (t) tags.push({ name: m[1], start: m.index, end: t.end });
  }
  return tags;
}

/** Offsets of elements that are ICON-ONLY controls (the same test as `findUnnamedIconControls`). */
function iconOnlyControlTags(src: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const re = /<(button|a|Link)(?=[\s>])/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const tag = openTagEnd(src, m.index);
    if (!tag || tag.selfClosing) continue;
    const closeAt = closeTagStart(src, m[1], tag.end);
    if (closeAt === -1) continue;
    const glyph = /<span\b[^>]*material-symbols-outlined[^>]*>[\s\S]*?<\/span>/g;
    const inner = src.slice(tag.end, closeAt);
    if (glyph.test(inner) && inner.replace(glyph, '').trim() === '') out.push({ start: m.index, end: tag.end });
  }
  return out;
}

/**
 * Class-list FRAGMENTS: every quoted string, and the static text of every template literal with its
 * `${…}` holes removed. A ternary's branches are quoted strings of their own, so each branch is
 * judged on its own rather than smeared together with the other.
 */
export function classFragments(src: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const quoted = /(['"])([^'"\n]*?)\1/g;
  for (let m = quoted.exec(src); m; m = quoted.exec(src)) out.push({ text: m[2], offset: m.index });
  for (const t of classLists(src)) {
    if (src[t.offset] !== '`') continue;
    let depth = 0;
    let text = '';
    for (let i = 0; i < t.text.length; i++) {
      if (t.text[i] === '$' && t.text[i + 1] === '{') { depth++; i++; text += ' '; continue; }
      if (depth > 0) { if (t.text[i] === '{') depth++; else if (t.text[i] === '}') depth--; continue; }
      text += t.text[i];
    }
    out.push({ text, offset: t.offset });
  }
  return out;
}

export type ContrastFinding = Finding & { ratio: number; needed: number };

/**
 * (d) Text colour below its floor.
 *
 * Two checks, both from the hex values in globals.css rather than from the ratios its comments state
 * (comments drift; the hex is what renders):
 *
 *  1. A NON-TEXT TOKEN used as a text colour — any token below 4.5:1 on BOTH grounds (--ink-3,
 *     --rule). Allowed only where the element is not text a reader must read: a Material Symbols
 *     glyph, an `aria-hidden` element, an `<svg>`, a `disabled:` variant or a `cursor-not-allowed`
 *     state (WCAG 1.4.3 exempts inactive controls), an icon-only control (1.4.11's 3:1 applies, and
 *     these tokens clear it), or a tag that carries an explicit `a11y-exempt:` comment saying why.
 *  2. An explicit PAIR in one fragment — `text-[var(--a)]` with `bg-[var(--b)]` — below 4.5:1, or
 *     below 3:1 for a glyph or text of 24px and up. Alpha modifiers are composited: `/70` on the text,
 *     and a translucent background over both --paper and --surface, taking the worse.
 */
export function findLowContrastText(file: string, raw: string, css: string): ContrastFinding[] {
  const src = stripComments(raw);
  const tokens = resolveTokens(css);
  const paper = tokens['paper'];
  const surface = tokens['surface'];
  const found: ContrastFinding[] = [];
  const tags = openingTags(src);
  const iconOnly = iconOnlyControlTags(src);
  const tagAt = (offset: number) => {
    let best: { name: string; start: number; end: number } | undefined;
    for (const t of tags) if (t.start <= offset && offset < t.end && (!best || t.start > best.start)) best = t;
    return best;
  };
  // Ground-coloured tokens (--accent-ink is #FFFFFF, --card is --surface) are light-on-dark text and
  // cannot be judged without the dark background they sit on, so they are left to the PAIR check.
  const nonText = Object.keys(tokens).filter(
    k =>
      contrast(tokens[k], paper) < 4.5 &&
      contrast(tokens[k], surface) < 4.5 &&
      contrast(tokens[k], paper) >= 1.1
  );
  const TEXT = /(^|\s)((?:[a-z-]+:)*)text-\[(?:color:)?var\(--([a-z0-9-]+)\)\](?:\/(\d+))?/g;
  const BG = /(^|\s)bg-\[var\(--([a-z0-9-]+)\)\](?:\/(\d+))?/;

  for (const frag of classFragments(src)) {
    const tag = tagAt(frag.offset);
    const tagText = tag ? src.slice(tag.start, tag.end) : '';
    const rawTag = tag ? raw.slice(tag.start, tag.end) : '';
    const isGlyph = /material-symbols-outlined/.test(frag.text) || /material-symbols-outlined/.test(tagText);
    const decorative =
      /aria-hidden(=\{?["']?true)?/.test(tagText) || tag?.name === 'svg' || /a11y-exempt:/.test(rawTag);
    const inIconOnly = iconOnly.some(t => t.start <= frag.offset && frag.offset < t.end);
    const inactive = /cursor-not-allowed/.test(frag.text);

    TEXT.lastIndex = 0;
    for (let m = TEXT.exec(frag.text); m; m = TEXT.exec(frag.text)) {
      const variants = m[2];
      const name = m[3];
      const alpha = m[4] ? Number(m[4]) / 100 : 1;
      if (!(name in tokens)) continue;
      const line = lineOf(src, frag.offset);
      const snippet = frag.text.replace(/\s+/g, ' ').trim().slice(0, 100);

      const bg = BG.exec(frag.text);

      // 1. A non-text token as a text colour, with no background of its own in the fragment.
      if (nonText.includes(name) && !bg) {
        // `marker:` is a list bullet — ornament, not text.
        const exempt =
          isGlyph || decorative || inIconOnly || inactive || /(^|:)(disabled|marker):/.test(variants);
        if (!exempt) {
          const ratio = Math.min(contrast(tokens[name], paper), contrast(tokens[name], surface));
          found.push({ file, line, snippet, ratio: Math.round(ratio * 100) / 100, needed: 4.5 });
        }
        continue;
      }

      // 2. An explicit pair in the same fragment. Only un-prefixed text against un-prefixed bg:
      //    `hover:` / `disabled:` states are judged by the rule above, not paired here.
      if (variants) continue;
      if (!bg || !(bg[2] in tokens) || decorative || inactive) continue;
      const bgAlpha = bg[3] ? Number(bg[3]) / 100 : 1;
      const grounds = bgAlpha === 1 ? [tokens[bg[2]]] : [mix(tokens[bg[2]], paper, bgAlpha), mix(tokens[bg[2]], surface, bgAlpha)];
      const ratio = Math.min(...grounds.map(g => contrast(alpha === 1 ? tokens[name] : mix(tokens[name], g, alpha), g)));
      const px = /text-\[(\d+(?:\.\d+)?)px\]/.exec(frag.text);
      const large = px ? Number(px[1]) >= 24 : false;
      const needed = isGlyph || large ? 3 : 4.5;
      if (ratio < needed) found.push({ file, line, snippet, ratio: Math.round(ratio * 100) / 100, needed });
    }
  }
  return found;
}

/** `fg` at `alpha` composited over an opaque `bg`, per channel in sRGB — what the browser paints. */
export function mix(fg: string, bg: string, alpha: number): string {
  const f = parseInt(fg.slice(1), 16);
  const b = parseInt(bg.slice(1), 16);
  const ch = (shift: number) => Math.round(((f >> shift) & 255) * alpha + ((b >> shift) & 255) * (1 - alpha));
  return '#' + [16, 8, 0].map(s => ch(s).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Every `--name: #RRGGBB;` in the `:root` block of globals.css. */
export function parseHexTokens(css: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g;
  for (let m = re.exec(css); m; m = re.exec(css)) if (!(m[1] in tokens)) tokens[m[1]] = m[2].toUpperCase();
  return tokens;
}

/** `--alias: var(--target)` pairs, so `--text-secondary` resolves to `--ink-2`'s hex. */
export function resolveTokens(css: string): Record<string, string> {
  const hex = parseHexTokens(css);
  const alias = /--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)/g;
  const out = { ...hex };
  for (let pass = 0; pass < 4; pass++) {
    alias.lastIndex = 0;
    for (let m = alias.exec(css); m; m = alias.exec(css)) if (!(m[1] in out) && m[2] in out) out[m[1]] = out[m[2]];
  }
  return out;
}

function channel(v: number) {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}
export function luminance(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
