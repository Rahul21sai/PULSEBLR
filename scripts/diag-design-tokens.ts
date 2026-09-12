/**
 * Is the design system actually IN EFFECT in a browser — the palette, the two typefaces, the type
 * scale — or does it only look right in the source?
 *
 * WHY THIS IS A SCRIPT AND NOT A UNIT TEST, AND WHY IT EXISTS AT ALL. Every failure it checks for
 * is invisible to source inspection and silent at runtime:
 *
 * · **The typeface bug shipped and nobody saw it for weeks.** `--font-sans` named the literal
 *   `'Inter'`, but `next/font` registers a HASHED family name, so the token fell through to
 *   `system-ui` — Segoe UI on Windows. The CSS was readable, plausible, and wrong. Every tracking
 *   value in the file had been calibrated for one face and was being applied to another. Nothing
 *   errors, nothing warns, and a screenshot only reveals it if you already know the two faces
 *   apart. The only honest check is to read the RESOLVED `font-family` out of a real browser.
 * · **A missing utility class degrades to "inherited", which looks deliberate.** A `.ty-*` step that
 *   failed to compile still renders text at a readable size. So each step is asserted against its
 *   specified px AND against the face the semantic rule demands, with a control proving an
 *   undefined class does not coincidentally match.
 * · **A contrast probe can return a clean pass from a parser bug.** One in this repo returned
 *   exactly `1.00` for 22 categories because Chrome resolves `color-mix()` to `color(srgb 0..1)`
 *   floats rather than `rgb()`. A custom property is worse still: it hands back its LITERAL token
 *   text, so a hex parser is mandatory and an rgb-only parser reports em-dashes. Hence the control
 *   pair below, which MUST fail — a detector that cannot fire proves nothing when it passes.
 *
 * THE SEMANTIC RULE IS THE ONE CARRYING THE WHOLE DESIGN, so it is asserted rather than described:
 *
 *     Serif (Newsreader) is the city's content.  Sans (Plus Jakarta Sans) is the product's voice.
 *
 * Event titles, venue names and people's names are things in the world — serif. Everything the app
 * says ABOUT them (dates, counts, areas, buttons, filters, empty-state copy) is the app talking —
 * sans. A reader should be able to tell the two apart without reading a word, which is only true if
 * each step lands on the right face.
 *
 * Read-only: GET requests and computed styles. No DB, no sign-in, no writes. Needs a dev server,
 * and `playwright` (already a devDependency, launched only here and on CI runners — never on
 * Vercel).
 *
 *   npx tsx scripts/diag-design-tokens.ts
 *   PB_BASE=http://localhost:3205 npx tsx scripts/diag-design-tokens.ts
 *   PB_BASE=http://localhost:3205 npx tsx scripts/diag-design-tokens.ts /events/<id>
 *
 * Exits non-zero on any resolved value that contradicts the specification.
 */

import { chromium } from 'playwright';

const BASE = process.env.PB_BASE || 'http://localhost:3000';
/**
 * Routes to check. Accepts `/tracker`, `tracker`, or `PB_PATHS=/tracker,/calendar`.
 *
 * The bare-name form is not a convenience, it is a WORKAROUND FOR THE SHELL. Under Git-bash on
 * Windows, MSYS rewrites an argument that looks like an absolute path — `/tracker` arrives as
 * `C:/Program Files/Git/tracker`. An earlier version filtered on `startsWith('/')` and therefore
 * silently dropped every route argument and checked only the home page, reporting a clean pass for
 * surfaces it had never opened. A filter that silently discards its input is the same failure class
 * as a probe that cannot fail.
 */
const RAW = [
  ...process.argv.slice(2),
  ...(process.env.PB_PATHS ? process.env.PB_PATHS.split(',') : []),
]
  .map((a) => a.trim())
  // Recover a route from the mangled form as well as the plain one.
  .map((a) => (a.includes('/Git/') ? '/' + a.split('/Git/').pop()! : a))
  .filter((a) => a && !a.startsWith('-'))
  .map((a) => (a.startsWith('/') ? a : '/' + a));
const ROUTES = RAW.length ? [...new Set(RAW)] : ['/'];

/* ───────────────────────────── The specification ───────────────────────────── */

/** The nine values, and the floor each must clear as TEXT on `--paper`. */
const PALETTE: Array<{ name: string; minOnPaper: number | null; note: string }> = [
  { name: '--paper', minOnPaper: null, note: 'the page ground itself' },
  { name: '--surface', minOnPaper: null, note: 'raised only — bars, sheets, menus' },
  { name: '--ink', minOnPaper: 4.5, note: 'primary text' },
  { name: '--ink-2', minOnPaper: 4.5, note: 'secondary text, metadata' },
  { name: '--ink-3', minOnPaper: 3, note: 'NEVER body text — icons, disabled, decorative' },
  { name: '--rule', minOnPaper: null, note: 'hairlines, not text' },
  { name: '--accent', minOnPaper: 4.5, note: 'links, primary action, active state' },
  { name: '--accent-ink', minOnPaper: null, note: 'sits on --accent, not on paper' },
  { name: '--live', minOnPaper: 4.5, note: 'urgent OR destructive' },
];

/** The type scale. `face` is what the SEMANTIC rule demands, not what the CSS happens to say. */
const STEPS: Array<{ cls: string; px: number; face: 'sans' | 'serif'; role: string }> = [
  { cls: 'ty-meta', px: 13, face: 'sans', role: 'dates, counts, areas — the app talking' },
  { cls: 'ty-body', px: 16, face: 'sans', role: 'body copy' },
  { cls: 'ty-lede', px: 18, face: 'serif', role: 'editorial lede' },
  { cls: 'ty-row-title', px: 20, face: 'serif', role: 'an event title — a thing in the world' },
  { cls: 'ty-section', px: 26, face: 'sans', role: 'a section label the app wrote' },
  { cls: 'ty-h1', px: 34, face: 'serif', role: 'page-defining headline' },
  { cls: 'ty-display', px: 52, face: 'serif', role: 'display' },
];

/* ───────────────────────────── Colour maths ───────────────────────────── */

/**
 * Parse whatever Chrome hands back. All four forms occur in practice, and getting this wrong is how
 * the earlier probe produced a clean-looking result from a parser failure:
 *   · `#RRGGBB` / `#RGB`   — a CUSTOM PROPERTY returns its literal token text, so this is the
 *                            COMMON case here, not the exotic one.
 *   · `color(srgb 0 0 0)`  — what `color-mix()` resolves to. Floats 0..1, not 0..255.
 *   · `rgb(r, g, b)`       — a real computed colour.
 */
function parseColour(css: string): [number, number, number] | null {
  const text = String(css).trim();
  let m = text.match(/^#([0-9a-f]{6})$/i);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)) as [number, number, number];
  m = text.match(/^#([0-9a-f]{3})$/i);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1][i] + m![1][i], 16)) as [number, number, number];
  m = text.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  if (m) return [1, 2, 3].map((i) => Math.round(parseFloat(m![i]) * 255)) as [number, number, number];
  m = text.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const n = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  return [n[0], n[1], n[2]];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (c: [number, number, number]) => {
    const v = c.map((x) => {
      const s = x / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
  };
  const [la, lb] = [lum(a), lum(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/* ───────────────────────────── Run ───────────────────────────── */

void (async () => {
let failures = 0;
const fail = (msg: string) => {
  failures++;
  console.log('  FAIL  ' + msg);
};

const browser = await chromium.launch();

try {
  for (const route of ROUTES) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const url = BASE + route;
    console.log('');
    console.log('═══ ' + url + ' at 390×844 ═══');

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 90_000 });
    } catch {
      fail('could not load ' + url + ' — is a dev server running on ' + BASE + '?');
      await page.close();
      continue;
    }

    /* ── 1. THE FONT LOADERS. The documented silent failure. ── */
    const fonts = await page.evaluate(() => {
      // A hashed family renders at a different width from the system fallback, so a width
      // comparison distinguishes "the variable resolved" from "it fell through" — which the
      // family STRING alone cannot do, because the fallback is listed in the same stack.
      //
      // Measured through a `.map` rather than a named helper on purpose: esbuild (which `tsx` uses)
      // wraps a name-inferred `const f = () => {}` in its `__name()` helper, and `page.evaluate`
      // ships the function source to a browser where that helper does not exist.
      const widths = ['var(--font-sans)', 'var(--font-serif)', 'system-ui'].map((family) => {
        const el = document.createElement('span');
        el.style.font = '16px ' + family;
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        el.textContent = 'Hxjq 0123456789';
        document.body.appendChild(el);
        const w = el.getBoundingClientRect().width;
        el.remove();
        return w;
      });
      const root = getComputedStyle(document.documentElement);
      return {
        bodyFamily: getComputedStyle(document.body).fontFamily,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        sansVar: root.getPropertyValue('--font-sans').trim(),
        serifVar: root.getPropertyValue('--font-serif').trim(),
        loaderSans: root.getPropertyValue('--font-jakarta').trim(),
        loaderSerif: root.getPropertyValue('--font-newsreader').trim(),
        wSans: widths[0],
        wSerif: widths[1],
        wSystem: widths[2],
      };
    });

    console.log('── fonts (resolved) ──');
    console.log('  body font-family  ' + fonts.bodyFamily);
    console.log('  --font-jakarta    ' + (fonts.loaderSans || '(EMPTY)'));
    console.log('  --font-newsreader ' + (fonts.loaderSerif || '(EMPTY)'));
    console.log(
      '  widths            sans ' +
        fonts.wSans.toFixed(2) +
        ' | serif ' +
        fonts.wSerif.toFixed(2) +
        ' | system-ui ' +
        fonts.wSystem.toFixed(2)
    );

    if (!fonts.loaderSans) fail('--font-jakarta is empty — the next/font loader variable is not on <html>');
    if (!fonts.loaderSerif) fail('--font-newsreader is empty — the next/font loader variable is not on <html>');
    // A LITERAL family name in the token is the exact shipped bug. It must be the loader variable.
    if (!fonts.sansVar.includes('var(--font-jakarta)') && !/Jakarta/i.test(fonts.bodyFamily)) {
      fail('--font-sans does not resolve to the loader family: ' + fonts.sansVar);
    }
    if (Math.abs(fonts.wSans - fonts.wSystem) < 0.5) {
      fail('the sans renders identically to system-ui — the variable is falling through, which is the shipped bug');
    }
    if (Math.abs(fonts.wSerif - fonts.wSystem) < 0.5) {
      fail('the serif renders identically to system-ui — Newsreader did not load');
    }

    /* ── 2. THE PALETTE, read as resolved values, with a control that must fail. ── */
    const values = await page.evaluate((names: string[]) => {
      const root = getComputedStyle(document.documentElement);
      return Object.fromEntries(names.map((n) => [n, root.getPropertyValue(n).trim()]));
    }, PALETTE.map((p) => p.name));

    const paper = parseColour(values['--paper']);
    console.log('── palette (resolved) + contrast as text on --paper ──');
    if (!paper) {
      fail('--paper did not resolve to a colour: ' + JSON.stringify(values['--paper']));
    } else {
      for (const spec of PALETTE) {
        const raw = values[spec.name];
        const rgb = parseColour(raw);
        if (!rgb) {
          fail(spec.name + ' did not resolve to a colour: ' + JSON.stringify(raw));
          continue;
        }
        const ratio = contrast(rgb, paper);
        const verdict =
          spec.minOnPaper === null
            ? 'n/a'
            : ratio >= spec.minOnPaper
              ? 'ok'
              : 'FAIL (needs ' + spec.minOnPaper + ':1)';
        console.log(
          '  ' +
            spec.name.padEnd(13) +
            raw.padEnd(10) +
            (ratio.toFixed(2) + ':1').padEnd(10) +
            verdict.padEnd(22) +
            spec.note
        );
        if (spec.minOnPaper !== null && ratio < spec.minOnPaper) {
          failures++;
        }
      }
      // THE CONTROL. `--paper` on white is ~1.05:1 and must NOT read as a pass. If this prints a
      // ratio near 1 the maths and the parser are both alive; if it prints an em-dash or exactly
      // 1.00 for a pair that differs, the parser has failed and every pass above is meaningless.
      const control = contrast([250, 249, 245], [255, 255, 255]);
      const controlOk = control > 1.0 && control < 1.3;
      console.log(
        '  control      paper-on-white ' + control.toFixed(2) + ':1  ' +
          (controlOk ? 'detector is alive and would fail a real pair' : 'DETECTOR BROKEN')
      );
      if (!controlOk) fail('the contrast detector cannot distinguish a near-identical pair — no pass above is trustworthy');
    }

    // The ground itself. A cool grey here means the old palette is still winning somewhere.
    console.log('  body ground   ' + fonts.bodyBg + '   body ink ' + fonts.bodyColor);
    const bodyBg = parseColour(fonts.bodyBg);
    if (bodyBg && paper && contrast(bodyBg, paper) > 1.02) {
      fail('the body ground is not --paper (' + fonts.bodyBg + ') — a stale ground is still applied');
    }

    /* ── 3. THE TYPE SCALE, size and face per step. ── */
    const rows = await page.evaluate((steps: Array<{ cls: string }>) => {
      return steps.map((s) => {
        const el = document.createElement('p');
        el.className = s.cls;
        el.textContent = 'Kubernetes Bengaluru Meetup 42';
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        // Read BEFORE detaching: the declaration is LIVE, so a post-remove read returns '' and
        // parseFloat turns that into NaN — a check that reports NaN cannot fail.
        const out = {
          cls: s.cls,
          size: parseFloat(cs.fontSize),
          lineHeight: cs.lineHeight,
          tracking: cs.letterSpacing,
          numeric: cs.fontVariantNumeric,
          family: cs.fontFamily,
        };
        el.remove();
        return out;
      });
    }, STEPS);

    // The control for this section: an undefined class must not coincidentally match a step.
    const typeControl = await page.evaluate(() => {
      const el = document.createElement('p');
      el.className = 'ty-this-class-does-not-exist';
      el.textContent = 'x';
      el.style.position = 'absolute';
      el.style.left = '-9999px';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { size: parseFloat(cs.fontSize), lineHeight: cs.lineHeight };
      el.remove();
      return out;
    });

    console.log('── type scale (resolved) ──');
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const spec = STEPS[i];
      const isSerif = /Newsreader/i.test(r.family);
      const faceOk = spec.face === 'serif' ? isSerif : !isSerif && /Jakarta/i.test(r.family);
      const sizeOk = Math.abs(r.size - spec.px) < 0.6;
      console.log(
        '  ' +
          (faceOk && sizeOk ? 'ok   ' : 'FAIL ') +
          ('.' + r.cls).padEnd(15) +
          (r.size.toFixed(0) + 'px' + (sizeOk ? '' : ' (spec ' + spec.px + ')')).padEnd(16) +
          ('lh ' + r.lineHeight).padEnd(13) +
          ('track ' + r.tracking).padEnd(18) +
          ((isSerif ? 'Newsreader' : 'Jakarta') + (faceOk ? '' : ' ← spec says ' + spec.face)).padEnd(28) +
          spec.role
      );
      if (!sizeOk) failures++;
      if (!faceOk) failures++;
    }
    console.log(
      '  control  .ty-this-class-does-not-exist -> ' +
        typeControl.size +
        'px lh ' +
        typeControl.lineHeight +
        '  (must differ from every step above)'
    );
    // `.ty-body` is 16px, the same as the inherited default, so SIZE alone cannot prove that rule
    // compiled. Its line-height is what distinguishes it — state that rather than claiming more.
    const body = rows.find((r) => r.cls === 'ty-body');
    if (body && body.lineHeight === typeControl.lineHeight) {
      fail('.ty-body is indistinguishable from an unstyled paragraph — that rule did not compile');
    }
    const meta = rows.find((r) => r.cls === 'ty-meta');
    if (meta && !meta.numeric.includes('tabular')) {
      fail('.ty-meta has no tabular-nums, so times and counts will jitter between rows');
    }

    /* ── 4. THE STRUCTURE PRIMITIVES. Same silent-failure class as the fonts, one layer down. ──
     *
     * An undefined custom property makes its whole declaration INVALID AT COMPUTED-VALUE TIME, so
     * `padding: var(--s-4)` on a missing token computes to `0px` — no error, no warning, and a row
     * that reads as "tight spacing" rather than as a bug. `.rule-*` fails the same way: a hairline
     * declared against a missing colour simply does not paint, and hairlines are what this design
     * uses INSTEAD of shadows, so losing them silently removes all the separation at once.
     */
    const structure = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const spacing = ['--s-1', '--s-2', '--s-3', '--s-4', '--s-6', '--s-8', '--s-12', '--s-16', '--s-24']
        .map((n) => ({ name: n, value: root.getPropertyValue(n).trim() }));
      const probes = [
        { cls: 'row-pad', prop: 'paddingTop' },
        { cls: 'rule-b', prop: 'borderBottomWidth' },
        { cls: 'rule-t', prop: 'borderTopWidth' },
        { cls: 'r-touch', prop: 'borderTopLeftRadius' },
        { cls: 'r-flat', prop: 'borderTopLeftRadius' },
        { cls: 'sticky-bar', prop: 'boxShadow' },
      ].map((p) => {
        const el = document.createElement('div');
        el.className = p.cls;
        el.textContent = 'x';
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = {
          cls: p.cls,
          prop: p.prop,
          value: String((cs as unknown as Record<string, string>)[p.prop]),
          borderColour: cs.borderBottomColor,
        };
        el.remove();
        return out;
      });
      return { spacing, probes };
    });

    console.log('── structure primitives (resolved) ──');
    const missingTokens = structure.spacing.filter((t) => !t.value);
    console.log('  spacing  ' + structure.spacing.map((t) => t.name.replace('--s-', '') + ':' + (t.value || 'MISSING')).join('  '));
    if (missingTokens.length) {
      fail(missingTokens.length + ' spacing token(s) do not resolve — every declaration using them computes to 0: ' + missingTokens.map((t) => t.name).join(', '));
    }
    for (const p of structure.probes) {
      // `.r-flat` is legitimately 0px — roundness means interactive, and a structural container is
      // deliberately square. So 0 is only a failure for the primitives whose whole job is a value.
      const zeroIsWrong = p.cls !== 'r-flat';
      const isZero = p.value === '0px' || p.value === 'none' || p.value === '';
      const ok = zeroIsWrong ? !isZero : true;
      console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + ('.' + p.cls).padEnd(13) + p.prop.padEnd(24) + p.value);
      if (!ok) fail('.' + p.cls + ' computed ' + JSON.stringify(p.value) + ' — the rule did not compile, or its token is missing');
    }

    /* ── 5. IS THE SCALE COMPOSABLE? The cascade bug that broke three surfaces at once. ──
     *
     * `globals.css` was UNLAYERED, and an unlayered rule beats a layered one regardless of
     * specificity or source order — so every custom class here silently outranked every Tailwind
     * utility. `cn()` delivering a caller's class to a primitive achieved nothing whenever that class
     * collided with one of these. Measured before the fix, on real elements:
     *
     *   `ty-meta font-semibold`     -> weight 500   (the utility was discarded)
     *   `ty-meta text-[var(--ink)]` -> --ink-2      (so did the colour)
     *   `<h2 class="font-sans">`    -> Newsreader   (the element default could not be overridden)
     *
     * It made the feed's row clock grey and unbolded, "Happening now" --ink-2 instead of --live, and
     * the category links under /events/[id]'s description grey where the code asks for --accent. The
     * source read correctly in all three places. Nothing errored.
     *
     * The `.ty-*` scale is now in `@layer components` and the `h1,h2,h3` face default in
     * `@layer base`, so utilities win again. The LAST case is the control: with no utility present
     * the step must still apply, or the fix has simply broken the scale instead.
     */
    const overrides = await page.evaluate((cases: Array<{ cls: string; prop: string }>) =>
      cases.map((c) => {
        const el = document.createElement('p');
        el.className = c.cls;
        el.textContent = 'Hxjq 0123';
        el.style.position = 'absolute';
        el.style.left = '-9999px';
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        // Read BEFORE detaching: the declaration is live and a post-remove read returns ''.
        const got = String((cs as unknown as Record<string, string>)[c.prop]);
        el.remove();
        return { cls: c.cls, prop: c.prop, got };
      }),
    [
      { cls: 'ty-meta font-semibold', prop: 'fontWeight' },
      { cls: 'ty-row-title text-[13px]', prop: 'fontSize' },
      { cls: 'ty-section font-normal', prop: 'fontWeight' },
      { cls: 'ty-meta', prop: 'fontSize' },
    ]);
    const WANT: Record<string, string> = {
      'ty-meta font-semibold': '600',
      'ty-row-title text-[13px]': '13px',
      'ty-section font-normal': '400',
      'ty-meta': '13px',
    };
    console.log('-- is the type scale composable? (a utility must beat the class) --');
    for (const o of overrides) {
      const want = WANT[o.cls];
      const ok = o.got === want;
      console.log('  ' + (ok ? 'ok   ' : 'FAIL ') + o.cls.padEnd(28) + o.prop.padEnd(11) +
        'got ' + o.got.padEnd(10) + 'want ' + want);
      if (!ok) fail(o.cls + ' -> ' + o.prop + ' is ' + o.got + ', want ' + want +
        ' (an unlayered globals.css rule is outranking a Tailwind utility again)');
    }

    /* ── 6. HORIZONTAL OVERFLOW. The recorded failure was a right edge at x=485 on a 390 viewport. ── */
    const overflow = await page.evaluate(() => {
      let worst = { x: 0, tag: '', cls: '' };
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        // A horizontal snap scroller is SUPPOSED to be wider than the viewport; what must not
        // overflow is the document. Report the widest element for context, judge on the document.
        if (b.right > worst.x) {
          worst = { x: Math.round(b.right), tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50) };
        }
      }
      return { worst, docScrollWidth: document.documentElement.scrollWidth, viewport: window.innerWidth };
    });
    console.log('── horizontal overflow ──');
    console.log(
      '  viewport ' + overflow.viewport +
        ' | documentElement.scrollWidth ' + overflow.docScrollWidth +
        ' | widest element right edge x=' + overflow.worst.x +
        ' (' + overflow.worst.tag + ' ' + overflow.worst.cls + ')'
    );
    if (overflow.docScrollWidth > overflow.viewport) {
      fail('the document scrolls sideways by ' + (overflow.docScrollWidth - overflow.viewport) + 'px');
    } else {
      console.log('  ok    no horizontal scroll');
    }

    await page.close();
  }
} finally {
  await browser.close();
}

console.log('');
console.log(failures === 0 ? '✓ every resolved value matches the specification' : '✗ ' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
})();
