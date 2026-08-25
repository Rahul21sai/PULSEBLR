/**
 * Whole-app spatial verification: the glass surfaces, the route transition, and the things they
 * could plausibly have broken. Needs a running server.
 *
 *   node scripts/diag-spatial-app.mjs [baseUrl]
 *
 * Each check guards a specific failure this change could cause:
 *
 *  1. FIXED CHROME IS STILL FIXED. app/template.tsx wraps every page in a motion.div. A
 *     `transform` or `filter` on that element makes it a CONTAINING BLOCK for position:fixed
 *     descendants, silently repositioning DesktopNav / MobileBottomNav / the command bar relative
 *     to the wrapper instead of the viewport — and framer-motion settles on
 *     `transform: translateY(0px) scale(1)`, which still creates one, so it would not heal when
 *     the animation ended. Asserts the wrapper has neither, and that a top bar stays pinned
 *     across a real scroll.
 *
 *  2. GLASS IS ACTUALLY GLASS. `.glass-card` is opaque by default and gains transparency only
 *     inside @supports, so a browser that cannot blur never gets a 74%-transparent card with 12px
 *     text on it. In a browser that CAN, backdrop-filter must be present — the CSS optimiser has
 *     been observed collapsing a prefixed/standard pair down to the -webkit- form alone.
 *
 *  3. TEXT ON GLASS IS STILL READABLE, measured against each element's OWN painted background
 *     stack composited onto the page ground. A first version compared everything to the card and
 *     reported the category chip at 1.03:1 — nonsense, because pills carry their own tint.
 *     Measuring text against a surface it does not sit on is a probe bug that reads exactly like
 *     a contrast bug, so this distinction is load-bearing.
 *
 *  4. THE AMBIENT FIELD IS BEHIND EVERYTHING on every route, and eats no input.
 *
 *  5. NO HORIZONTAL OVERFLOW at either viewport.
 *
 *  6. REDUCED MOTION DISABLES THE TRANSITION rather than shortening it.
 */
import { chromium } from 'playwright'

const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '')

/*
 * PUBLIC routes carry the real assertions. /tracker, /folders, /settings and /dashboard sit behind
 * ProtectedRouteGate, so signed OUT they render a sign-in wall with no content cards at all —
 * which reports as `glass=0` and looks exactly like the glass conversion having failed there. It
 * has not; there is nothing to convert until you are signed in. They are still checked for the
 * ambient field and for overflow, because those must hold on the wall too.
 */
const PUBLIC = ['/', '/companies', '/calendar']
const PROTECTED = ['/tracker', '/folders', '/settings', '/dashboard']

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

const lum = (c) => {
  const p = (c.match(/[\d.]+/g) || []).slice(0, 3).map(Number)
  const f = (v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2])
}
const ratio = (a, b) => {
  const s = [lum(a), lum(b)].sort((m, n) => n - m)
  return +((s[0] + 0.05) / (s[1] + 0.05)).toFixed(2)
}

const browser = await chromium.launch()

for (const vp of VIEWPORTS) {
  console.log(`\n-- ${vp.name} ${vp.width}x${vp.height} ----------------------------------`)
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
  const page = await ctx.newPage()

  for (const route of [...PUBLIC, ...PROTECTED]) {
    const isProtected = PROTECTED.includes(route)
    let status = 0
    try {
      const res = await page.goto(base + route, { waitUntil: 'domcontentloaded', timeout: 90000 })
      status = res ? res.status() : 0
    } catch (err) {
      fail(`${route}: navigation failed - ${err.message.slice(0, 70)}`)
      continue
    }
    await page.waitForTimeout(2400)

    const probe = await page.evaluate(() => {
      const out = {}
      // framer-motion writes an inline opacity on the template wrapper; that is how we find it.
      const tpl = [...document.querySelectorAll('div')].find((d) => d.style.opacity !== '')
      if (tpl) {
        const cs = getComputedStyle(tpl)
        out.tplTransform = cs.transform
        out.tplFilter = cs.filter
        out.tplPerspective = cs.perspective
      }
      const f = document.querySelector('.ambient-field')
      if (f) {
        const cs = getComputedStyle(f)
        out.field = `${cs.position}/z${cs.zIndex}/${cs.pointerEvents}`
        out.fieldOk = cs.position === 'fixed' && cs.pointerEvents === 'none'
      }
      const cards = [...document.querySelectorAll('.glass-card')]
      out.glass = cards.length
      if (cards.length) {
        const cs = getComputedStyle(cards[0])
        out.glassBg = cs.backgroundColor
        out.backdrop = cs.backdropFilter || cs.webkitBackdropFilter || 'none'
      }
      out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth
      out.signInWall = /sign in/i.test(document.body.innerText)
      return out
    })

    const tag = route.padEnd(12)

    // 1. containing block
    const cb = [probe.tplTransform, probe.tplFilter, probe.tplPerspective].filter(
      (v) => v && v !== 'none',
    )
    if (cb.length) {
      fail(`${tag} template wrapper creates a containing block (${cb.join(' ')}) - fixed nav will be mispositioned`)
    }

    // 1b. a top bar must still be pinned after scrolling
    await page.evaluate(() => window.scrollBy(0, 700))
    await page.waitForTimeout(450)
    const bars = await page.evaluate(() =>
      [...document.querySelectorAll('*')]
        .filter((el) => getComputedStyle(el).position === 'fixed')
        .map((el) => {
          const r = el.getBoundingClientRect()
          return { top: Math.round(r.top), h: Math.round(r.height) }
        })
        .filter((r) => r.h > 24),
    )
    if (bars.length > 0 && !bars.some((r) => r.top >= -2 && r.top <= 2)) {
      fail(`${tag} no fixed bar remained at viewport top after scrolling (tops: ${bars.map((r) => r.top).join(',')}) - containing-block regression`)
    }

    // 4. ambient field
    if (!probe.field) fail(`${tag} .ambient-field not mounted`)
    else if (!probe.fieldOk) fail(`${tag} field is ${probe.field} - must be fixed and pointer-events:none`)

    // 5. overflow
    if (probe.overflowX > 0) fail(`${tag} horizontal overflow ${probe.overflowX}px`)

    // 2. glass, only where content actually renders
    if (probe.glass > 0) {
      const translucent = /rgba\(/.test(probe.glassBg) && !/,\s*1\)$/.test(probe.glassBg)
      if (!/blur/.test(probe.backdrop)) {
        fail(`${tag} .glass-card has no backdrop-filter (${probe.backdrop}) - optimiser may have dropped the standard property`)
      } else if (!translucent) {
        fail(`${tag} .glass-card is opaque (${probe.glassBg}) in a blur-capable browser`)
      }
    } else if (!isProtected) {
      fail(`${tag} no .glass-card found on a public content route`)
    }

    console.log(
      `  ${tag} http=${status} glass=${String(probe.glass).padStart(2)}` +
        (isProtected ? ` (protected, signInWall=${probe.signInWall})` : '') +
        ` backdrop=${(probe.backdrop || 'n/a').slice(0, 26).padEnd(26)} field=${probe.field} overflowX=${probe.overflowX}`,
    )
  }
  await ctx.close()
}

// -- 3. contrast on glass, measured per element --------------------------------------
console.log('\n-- text contrast on glass ----------------------------------')
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(3200)

  const samples = await page.evaluate(() => {
    const card = document.querySelector('.glass-card')
    if (!card) return null

    const GROUND = [245, 245, 247] // --paper
    const parse = (c) => {
      const n = (c.match(/[\d.]+/g) || []).map(Number)
      return { r: n[0] || 0, g: n[1] || 0, b: n[2] || 0, a: n.length > 3 ? n[3] : 1 }
    }
    const over = (fg, bg) => [
      Math.round(fg.r * fg.a + bg[0] * (1 - fg.a)),
      Math.round(fg.g * fg.a + bg[1] * (1 - fg.a)),
      Math.round(fg.b * fg.a + bg[2] * (1 - fg.a)),
    ]
    // Walk up collecting painted layers, then composite them onto the page ground.
    const effectiveBg = (el) => {
      const layers = []
      for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
        const c = parse(getComputedStyle(n).backgroundColor)
        if (c.a > 0.001) layers.push(c)
        if (c.a >= 0.999) break
      }
      let acc = GROUND
      for (let i = layers.length - 1; i >= 0; i--) acc = over(layers[i], acc)
      return `rgb(${acc[0]}, ${acc[1]}, ${acc[2]})`
    }

    const texts = [...card.querySelectorAll('h3, p, span, a')]
      .filter((el) => el.children.length === 0 && el.textContent && el.textContent.trim().length > 2)
      // Icon fonts render glyphs, not readable text.
      .filter((el) => !String(el.className || '').includes('material-symbols'))
      .slice(0, 10)
      .map((el) => {
        const cs = getComputedStyle(el)
        return {
          text: el.textContent.trim().slice(0, 22),
          color: cs.color,
          size: parseFloat(cs.fontSize),
          weight: Number(cs.fontWeight) || 400,
          bg: effectiveBg(el),
        }
      })
    return { cardBg: getComputedStyle(card).backgroundColor, texts }
  })

  if (!samples) fail('no .glass-card on the feed to measure')
  else {
    console.log(`  card bg ${samples.cardBg} - each row measured against its OWN painted stack`)
    let allPass = true
    for (const t of samples.texts) {
      const r = ratio(t.color, t.bg)
      // WCAG AA large text: >=24px, or >=18.66px at >=700 weight.
      const large = t.size >= 24 || (t.size >= 18.66 && t.weight >= 700)
      const need = large ? 3 : 4.5
      if (r < need) {
        allPass = false
        fail(`"${t.text}" ${t.size}px/${t.weight} on ${t.bg} -> ${r}:1 (needs ${need}:1)`)
      } else {
        console.log(`  ok    "${t.text.padEnd(22)}" ${String(t.size).padStart(5)}px on ${t.bg.padEnd(20)} -> ${r}:1`)
      }
    }
    if (allPass) ok('all sampled text on glass clears its AA threshold')
  }
  await ctx.close()
}

// -- 6. the route transition ----------------------------------------------------------
console.log('\n-- route transition ---------------------------------------')
for (const motion of ['no-preference', 'reduce']) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: motion })
  const page = await ctx.newPage()
  await page.goto(base + '/', { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForTimeout(2600)

  const read = () =>
    page.evaluate(() => {
      const d = [...document.querySelectorAll('div')].find((x) => x.style.opacity !== '')
      return d ? d.style.opacity : 'none'
    })

  await page.evaluate(() => {
    const link = document.querySelector('a[href="/companies"]')
    if (link) link.click()
  })
  const seen = []
  for (let i = 0; i < 8; i++) {
    seen.push(await read())
    await page.waitForTimeout(40)
  }
  const distinct = [...new Set(seen)]
  if (motion === 'reduce') {
    const mid = seen.some((s) => s !== 'none' && Number(s) > 0 && Number(s) < 0.99)
    if (mid) fail(`reduce: transition still animating (${distinct.join(' ')})`)
    else ok(`reduce: no fade (${distinct.join(' ')})`)
  } else {
    const moved = distinct.filter((s) => s !== 'none').length > 1
    if (!moved) console.log(`  info  no-preference: no intermediate opacity captured (${distinct.join(' ')}) - the fade is 260ms, sampling may miss it`)
    else ok(`no-preference: fade observed (${distinct.join(' ')})`)
  }
  await ctx.close()
}

await browser.close()
console.log(failures === 0 ? '\nPASS - whole-app spatial layer verified' : `\nFAILED - ${failures} problem(s)`)
process.exit(failures === 0 ? 0 : 1)
