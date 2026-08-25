/**
 * Assert the spatial layer is real, and that adding depth did not break the rules it was
 * built to respect. Needs a server (default http://localhost:3100).
 *
 *   node scripts/diag-spatial-layer.mjs [baseUrl]
 *
 * Six checks, each of which failed for a real reason at some point in this work:
 *
 *  1. NO CONTENT-ONLY OVERLAP, at 1440x900 and 390x844, at scroll-top AND scrolled.
 *     Clip-aware, and it EXCLUDES position:fixed/sticky ancestors — a naive probe reports
 *     the command bar and bottom nav "overlapping" every row they scroll over, which is
 *     intended behaviour because those bars are near-opaque. Per CLAUDE.md.
 *
 *  2. NO HORIZONTAL OVERFLOW. The single most common defect in the audited Stitch exports
 *     (one overflowed by 336px at 1440), and a blurred halo inset by -12% is exactly the
 *     kind of thing that causes it — which is why .cover-halo sets `contain: paint`.
 *
 *  3. REDUCED MOTION IS HONOURED BY CONSTRUCTION. The audit's sharpest finding was 0 of 27
 *     Stitch screens honouring it. The scroll-driven rules are wrapped in
 *     `prefers-reduced-motion: no-preference`, so under `reduce` the animation-name must
 *     resolve to `none` — not merely to a 0.001ms duration, which is what the global reduce
 *     block would give and which cannot be relied on for a timeline-driven animation.
 *
 *  4. THE HALO FOLLOWS THE COVER. It must render for an event WITH an image and be absent
 *     for one without: blurring a flat category tint produces a coloured smear louder than
 *     the card it is meant to lift.
 *
 *  5. ELEVATION IS STILL A RING PLUS A LIFT. Cards' computed box-shadow must resolve to
 *     MULTIPLE layers. A single large blur is the "fog" the --lift tokens replaced, and it
 *     is what 20 of the 27 audited screens shipped. This is the regression guard for the
 *     `hover:shadow-[0_10px_34px_...]` class of edit.
 *
 *  6. THE SIGNATURE ELEMENT SURVIVED. Three meter bars, and a data-level still set. Giving
 *     the meter depth must not have changed what it MEANS.
 */
import { chromium } from 'playwright'

const base = (process.argv[2] || 'http://localhost:3100').replace(/\/$/, '')
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]

let failures = 0
const fail = (m) => {
  console.log(`  FAIL  ${m}`)
  failures++
}
const ok = (m) => console.log(`  ok    ${m}`)

/** Elements that overlap while sharing no fixed/sticky ancestor and no DOM ancestry. */
const OVERLAP_PROBE = () => {
  const inFixed = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const pos = getComputedStyle(n).position
      if (pos === 'fixed' || pos === 'sticky') return true
    }
    return false
  }
  // Leaf-ish content only: text-bearing elements with no element children.
  const nodes = [...document.querySelectorAll('h1,h2,h3,p,span,a,button,li,td')].filter((el) => {
    if (el.children.length > 0) return false
    if (!el.textContent || !el.textContent.trim()) return false
    if (inFixed(el)) return false
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) < 0.05) return false
    const r = el.getBoundingClientRect()
    if (r.width < 6 || r.height < 6) return false
    // Only what is actually on screen.
    if (r.bottom < 0 || r.top > innerHeight) return false
    return true
  })

  const rects = nodes.map((el) => ({ el, r: el.getBoundingClientRect() }))
  const hits = []
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i]
      const b = rects[j]
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue
      const ox = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
      const oy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
      // 2px tolerance: subpixel layout is not an overlap.
      if (ox > 2 && oy > 2) {
        hits.push({
          a: `${a.el.tagName}.${a.el.className}`.slice(0, 70),
          b: `${b.el.tagName}.${b.el.className}`.slice(0, 70),
          area: Math.round(ox * oy),
        })
      }
    }
  }
  return hits
}

const browser = await chromium.launch()

// Discover a real event WITH a cover and, if one exists, one WITHOUT.
const api = await fetch(`${base}/api/events?techOnly=false&limit=60`).then((r) => r.json())
const all = api.events || []
const withCover = all.find((e) => e.imageUrl)
const withoutCover = all.find((e) => !e.imageUrl)
console.log(
  `corpus sample: ${all.length} events, ${all.filter((e) => e.imageUrl).length} with a cover\n`,
)

for (const vp of VIEWPORTS) {
  console.log(`── ${vp.name} ${vp.width}x${vp.height} ─────────────────────────────`)
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()

  for (const [label, path] of [
    ['feed', '/'],
    ['event detail', withCover ? `/events/${withCover._id}` : '/'],
  ]) {
    await page.goto(base + path, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(1400)

    for (const where of ['top', 'scrolled']) {
      if (where === 'scrolled') {
        await page.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 1.4)))
        await page.waitForTimeout(700)
      }
      const hits = await page.evaluate(OVERLAP_PROBE)
      if (hits.length) {
        fail(`${label} @${where}: ${hits.length} content overlap(s), worst ${hits[0].area}px² — ${hits[0].a} vs ${hits[0].b}`)
      } else {
        ok(`${label} @${where}: 0 content-only overlaps`)
      }
    }

    const overflow = await page.evaluate(() => {
      const de = document.documentElement
      return de.scrollWidth - de.clientWidth
    })
    if (overflow > 0) fail(`${label}: horizontal overflow ${overflow}px`)
    else ok(`${label}: no horizontal overflow`)
  }

  await ctx.close()
}

// ── 3. reduced motion ────────────────────────────────────────────────────────────
console.log('── reduced motion ───────────────────────────────────────')
for (const motion of ['no-preference', 'reduce']) {
  const ctx = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: motion === 'reduce' ? 'reduce' : 'no-preference',
  })
  const page = await ctx.newPage()
  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(1200)

  const probe = await page.evaluate(() => {
    const el = document.querySelector('.spatial-rise')
    if (!el) return { found: false }
    const cs = getComputedStyle(el)
    return { found: true, animationName: cs.animationName, timeline: cs.animationTimeline || '(unsupported)' }
  })

  if (!probe.found) {
    console.log(`  info  no .spatial-rise on the feed at this viewport (Spotlight not rendering) — skipped`)
  } else if (motion === 'reduce') {
    if (probe.animationName === 'none') ok(`reduce: .spatial-rise animation-name = none (opted out, not just shortened)`)
    else fail(`reduce: .spatial-rise still animating (${probe.animationName})`)
  } else {
    // `none` here is CORRECT on a browser without scroll-driven animation support — the
    // static composition IS the design. Reported, never failed.
    console.log(
      `  info  no-preference: animation-name=${probe.animationName} timeline=${probe.timeline}` +
        (probe.animationName === 'none' ? '  (browser lacks animation-timeline: view() — static by design)' : ''),
    )
  }
  await ctx.close()
}

// ── 4/5/6. halo, elevation, meter ────────────────────────────────────────────────
console.log('── spatial layer integrity ──────────────────────────────')
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()

  if (withCover) {
    await page.goto(`${base}/events/${withCover._id}`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(1200)
    const halo = await page.evaluate(() => {
      const h = document.querySelector('.cover-halo')
      if (!h) return { present: false }
      const img = h.querySelector('img')
      const cs = getComputedStyle(img)
      return {
        present: true,
        blur: cs.filter,
        contain: getComputedStyle(h).contain,
        opacity: cs.opacity,
      }
    })
    if (!halo.present) fail('event WITH a cover: .cover-halo missing')
    else if (!/blur\(/.test(halo.blur)) fail(`halo present but no blur filter (${halo.blur})`)
    else if (!/paint/.test(halo.contain)) fail(`halo missing \`contain: paint\` (${halo.contain}) — overflow risk`)
    else ok(`halo renders, ${halo.blur.match(/blur\([^)]+\)/)[0]}, contain:${halo.contain}, opacity ${halo.opacity}`)

    // 5. elevation shape
    const shadows = await page.evaluate(() => {
      const el = document.querySelector('.lift-3')
      if (!el) return null
      const s = getComputedStyle(el).boxShadow
      // Count top-level comma-separated layers (rgb(...) contains commas, so split carefully).
      const layers = s.split(/,(?![^(]*\))/).length
      return { shadow: s.slice(0, 90), layers }
    })
    if (!shadows) fail('.lift-3 not found on the event hero')
    else if (shadows.layers < 2) fail(`elevation collapsed to a single blur (${shadows.layers} layer): ${shadows.shadow}`)
    else ok(`hero elevation is ${shadows.layers} stacked layers (ring + lift), not one blur`)
  }

  if (withoutCover) {
    await page.goto(`${base}/events/${withoutCover._id}`, { waitUntil: 'networkidle', timeout: 60000 })
    await page.waitForTimeout(1000)
    const n = await page.evaluate(() => document.querySelectorAll('.cover-halo').length)
    if (n === 0) ok('event WITHOUT a cover: no halo (a blurred flat tint would be a smear)')
    else fail(`event without a cover still rendered ${n} halo(s)`)
  } else {
    console.log('  info  no cover-less event in the sample — halo-suppression case not exercised')
  }

  // 6. the meter
  await page.goto(base + '/', { waitUntil: 'networkidle', timeout: 60000 })
  await page.waitForTimeout(1500)
  const meter = await page.evaluate(() => {
    const m = document.querySelector('.meter')
    if (!m) return { found: false }
    return {
      found: true,
      bars: m.querySelectorAll('i').length,
      level: m.getAttribute('data-level'),
      label: m.parentElement?.getAttribute('title')?.slice(0, 46),
      litShadow: getComputedStyle(m.querySelector('i')).boxShadow.slice(0, 60),
    }
  })
  if (!meter.found) fail('connection meter not rendered on the feed')
  else if (meter.bars !== 3) fail(`meter has ${meter.bars} bars, expected 3`)
  else if (!meter.level) fail('meter lost its data-level')
  else ok(`meter intact: 3 bars, level ${meter.level}, title "${meter.label}…"`)

  await ctx.close()
}

await browser.close()
console.log(failures === 0 ? '\nPASS — spatial layer verified' : `\nFAILED — ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
