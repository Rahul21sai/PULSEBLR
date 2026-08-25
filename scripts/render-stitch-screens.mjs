/**
 * Render Stitch-exported HTML at real resolution and report what breaks.
 *
 * Stitch's own screenshots are 512px thumbnails, which cannot show typography, hairlines
 * or spacing — the things this repo's design rules are actually about. This drives the
 * installed Playwright chromium instead, at the two viewports CLAUDE.md verifies against
 * (1440x900 desktop, 390x844 mobile), and records:
 *
 *   - a full-page PNG and an above-the-fold PNG
 *   - console errors and FAILED requests, because 22 of 27 exports pull CDN <script>s and
 *     Google Fonts; a design that only renders with third-party network access is not
 *     implementable in a PWA with a service worker and a strict CSP
 *   - whether a WebGL context actually initialises (the "3D" claim), not just whether
 *     three.js is referenced
 *
 *   node scripts/render-stitch-screens.mjs <htmlDir> <outDir> [nameSubstring]
 */
import { chromium } from 'playwright'
import { readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'

const [htmlDir, outDir, match = ''] = process.argv.slice(2)
if (!htmlDir || !outDir) {
  console.error('usage: node scripts/render-stitch-screens.mjs <htmlDir> <outDir> [nameSubstring]')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const files = readdirSync(htmlDir)
  .filter((f) => f.endsWith('.html'))
  .filter((f) => f.toLowerCase().includes(match.toLowerCase()))

const browser = await chromium.launch()
const report = []

for (const file of files) {
  const name = basename(file, '.html')
  const isMobile = /mobile/i.test(name)
  const viewport = isMobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }

  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 })
  const page = await ctx.newPage()

  const consoleErrors = []
  const failedRequests = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160))
  })
  page.on('requestfailed', (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url().slice(0, 90)}`))
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`HTTP${r.status()} ${r.url().slice(0, 90)}`)
  })

  let webgl = null
  let scrollH = null
  let overflowX = null
  let fonts = []
  try {
    await page.goto('file:///' + resolve(htmlDir, file).replace(/\\/g, '/'), {
      waitUntil: 'networkidle',
      timeout: 45000,
    })
  } catch (err) {
    failedRequests.push(`NAV: ${err.message.slice(0, 80)}`)
  }
  // give three.js / shaders a beat to initialise and paint
  await page.waitForTimeout(3500)

  try {
    const probe = await page.evaluate(() => {
      const canvases = [...document.querySelectorAll('canvas')]
      const live = canvases.filter((c) => {
        try {
          return !!(c.getContext('webgl2') || c.getContext('webgl'))
        } catch {
          return false
        }
      })
      const de = document.documentElement
      return {
        canvases: canvases.length,
        webglLive: live.length,
        scrollH: de.scrollHeight,
        // horizontal overflow is the single most common export defect
        overflowX: de.scrollWidth - de.clientWidth,
        fonts: [...new Set([...document.querySelectorAll('*')].slice(0, 400).map((e) => getComputedStyle(e).fontFamily.split(',')[0].replace(/["']/g, '')))].slice(0, 6),
      }
    })
    webgl = `${probe.webglLive}/${probe.canvases}`
    scrollH = probe.scrollH
    overflowX = probe.overflowX
    fonts = probe.fonts
  } catch {
    webgl = 'probe-failed'
  }

  await page.screenshot({ path: join(outDir, `${name}.fold.png`), fullPage: false })
  await page.screenshot({ path: join(outDir, `${name}.full.png`), fullPage: true })
  await ctx.close()

  report.push({ name, viewport: `${viewport.width}x${viewport.height}`, scrollH, overflowX, webgl, fonts, consoleErrors, failedRequests })

  const flag = overflowX > 0 ? ` OVERFLOW-X=${overflowX}px` : ''
  console.log(
    `${name.padEnd(40)} ${viewport.width}x${viewport.height} h=${String(scrollH).padEnd(6)} webgl=${String(webgl).padEnd(6)} err=${consoleErrors.length} netfail=${failedRequests.length}${flag}`,
  )
}

await browser.close()
writeFileSync(join(outDir, '_report.json'), JSON.stringify(report, null, 2), 'utf8')

const withFail = report.filter((r) => r.failedRequests.length)
const withOverflow = report.filter((r) => r.overflowX > 0)
const withWebgl = report.filter((r) => r.webgl && r.webgl !== '0/0' && !r.webgl.startsWith('0/'))
console.log(`\nSUMMARY  ${report.length} screens`)
console.log(`  network failures : ${withFail.length}`)
console.log(`  horizontal overflow: ${withOverflow.length}${withOverflow.length ? ' -> ' + withOverflow.map((r) => `${r.name}(${r.overflowX}px)`).join(', ') : ''}`)
console.log(`  live WebGL context : ${withWebgl.length} -> ${withWebgl.map((r) => r.name).join(', ') || 'none'}`)
console.log(`  report: ${join(outDir, '_report.json')}`)
