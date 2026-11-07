/**
 * Standalone runner — renders without the app, for template work and checks.
 *
 *   npm run build
 *   npm run thumb -- <jobs.json> [outDir]     render one job or an array (each may carry a `style`)
 *   npm run thumb -- --golden [outDir]        empty style must reproduce samples/golden/*.jpg
 *   npm run thumb -- --sweep [outDir]         worst-case job × every knob at min/max + combos; asserts safe bounds
 *   npm run thumb -- --idle <seconds> [outDir]  render job A, sit idle, render job B: B's pixels must differ from A's
 *   npm run thumb -- --hostile [outDir]       zoom/size drift between renders and an unreadable stamp must still give fresh pictures
 *
 * Relative photo paths resolve against the JSON file's folder. Results print as JSON lines;
 * exit code 1 if any job failed or any check did not pass.
 */
import { app, BrowserWindow, nativeImage } from 'electron'
import { existsSync, promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { dispose, render } from './index'
import { WORST_CASE } from './job'
import { templateDir } from './renderer'
import { BUNDLED_FONTS } from './fonts'
import { STYLE_FIELDS, type StylePatch } from './style'
import type { PluginHost, ThumbnailJob, ThumbnailResult } from './types'

const SAFE = 24, W = 1280, H = 720
const log = (level: string, m: string) => console.error(`[${level}] ${m}`)

const samplesDir = () => join(templateDir(), '..', 'samples')

async function loadJobs(file: string): Promise<ThumbnailJob[]> {
  const raw = JSON.parse(await fs.readFile(file, 'utf8')) as ThumbnailJob | ThumbnailJob[]
  const base = dirname(file)
  return (Array.isArray(raw) ? raw : [raw]).map((j) => ({ ...j, photoPath: isAbsolute(j.photoPath) ? j.photoPath : resolve(base, j.photoPath) }))
}

async function runJobs(file: string, outputDir: string): Promise<number> {
  const host: PluginHost = { outputDir, log }
  let failed = 0
  for (const job of await loadJobs(file)) {
    const result = await render(job, host)
    if (!result.ok) failed++
    console.log(JSON.stringify({ surahs: job.surahsAr, ...result }))
  }
  return failed
}

/** Mean absolute RGB difference between two same-size images (0 = identical). */
function meanDiff(a: string, b: string): number {
  const A = nativeImage.createFromPath(a), B = nativeImage.createFromPath(b)
  const sa = A.getSize(), sb = B.getSize()
  if (sa.width !== sb.width || sa.height !== sb.height) return Infinity
  const pa = A.toBitmap(), pb = B.toBitmap()
  let sum = 0, n = 0
  for (let i = 0; i < pa.length; i += 4) { sum += Math.abs(pa[i]! - pb[i]!) + Math.abs(pa[i + 1]! - pb[i + 1]!) + Math.abs(pa[i + 2]! - pb[i + 2]!); n += 3 }
  return sum / n
}

async function golden(outputDir: string): Promise<number> {
  const jobs = await loadJobs(join(samplesDir(), 'jobs.json'))
  const host: PluginHost = { outputDir, log }
  let failed = 0, i = -1
  for (const job of jobs) {
    i++
    const ref = join(samplesDir(), 'golden', `job${i}.thumb.jpg`)
    if (!(await fs.stat(ref).catch(() => null))) continue
    const r = await render({ ...job, style: {} }, host)
    if (!r.ok) { failed++; console.log(JSON.stringify({ golden: i, ok: false, reason: r.reason, message: r.message })); continue }
    const diff = meanDiff(r.thumbnail, ref)
    const pass = diff < 1.5
    if (!pass) failed++
    console.log(JSON.stringify({ golden: i, ok: pass, meanDiff: +diff.toFixed(3), thumbnail: r.thumbnail }))
  }
  console.error(failed ? `golden: ${failed} mismatch(es)` : 'golden: all match')
  return failed
}

const setPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
  const keys = path.split('.')
  let cur = obj
  for (const k of keys.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
  cur[keys[keys.length - 1]!] = value
}
const at = (path: string, value: unknown, into: Record<string, unknown> = {}) => { setPath(into, path, value); return into }

/** The hardest job the layout will ever see (content from WORST_CASE, exported for the app's editor). */
function worstJob(): ThumbnailJob {
  return { ...WORST_CASE, surahsAr: [...WORST_CASE.surahsAr], photoPath: join(samplesDir(), 'photos', 'mosque-dome-sign.jpg'), options: { sheikhPrefix: true, template: 'default' } }
}

/** expect: 'ok' must render; 'refuse' must be refused; 'either' may be refused only with TEXT_OVERFLOW (below the floor). */
interface Variant { name: string; style: StylePatch; expect: 'ok' | 'refuse' | 'either'; job?: Partial<ThumbnailJob> }
function sweepVariants(): Variant[] {
  const out: Variant[] = [{ name: 'default', style: {}, expect: 'ok' }]
  for (const f of BUNDLED_FONTS) out.push({ name: `font=${f.id}`, style: { reciter: { font: f.id }, meta: { font: f.id } }, expect: 'ok' })
  out.push({ name: 'font=custom-path', style: { reciter: { font: join(templateDir(), 'fonts', 'Mirza-Bold.ttf') }, meta: { font: join(templateDir(), 'fonts', 'Tajawal-Regular.ttf') } }, expect: 'ok' })
  out.push({ name: 'font=missing-file', style: { reciter: { font: '/nowhere/NoSuchFont.ttf' } }, expect: 'refuse' })
  if (existsSync('/System/Library/Fonts/Supplemental/Impact.ttf')) out.push({ name: 'font=no-arabic-glyphs', style: { meta: { font: '/System/Library/Fonts/Supplemental/Impact.ttf' } }, expect: 'refuse' })
  for (const { path, field } of STYLE_FIELDS) {
    if (field.kind !== 'number') continue
    // text.width 0.5 with the 1.4.0 defaults (reciter 1.3×, meta 1.38×) genuinely needs < 55 % on the worst case: a refusal is right there.
    out.push({ name: `${path}=min(${field.min})`, style: at(path, field.min), expect: path === 'text.width' ? 'either' : 'ok' })
    out.push({ name: `${path}=max(${field.max})`, style: at(path, field.max), expect: 'ok' })
  }
  const big: Record<string, unknown> = {}
  for (const p of ['title.scale', 'reciter.scale', 'meta.scale', 'text.gapAboveTitle', 'text.gapBelowTitle', 'reciter.pill.opacity', 'reciter.pill.paddingX', 'reciter.pill.paddingY', 'meta.pill.opacity', 'meta.pill.paddingX', 'meta.pill.paddingY', 'dividers.aboveTitle.opacity', 'dividers.aboveTitle.thickness', 'dividers.belowTitle.opacity', 'dividers.belowTitle.thickness', 'title.surahWordScale', 'title.outlineWidth', 'frame.width', 'frame.inset'])
    setPath(big, p, STYLE_FIELDS.find((f) => f.path === p)!.field.kind === 'number' ? (STYLE_FIELDS.find((f) => f.path === p)!.field as { max: number }).max : 1)
  const small: Record<string, unknown> = {}
  for (const p of ['title.scale', 'reciter.scale', 'meta.scale', 'text.gapAboveTitle', 'text.gapBelowTitle', 'text.width'])
    setPath(small, p, (STYLE_FIELDS.find((f) => f.path === p)!.field as { min: number }).min)
  // Everything at max at once: either the group shrinks to fit (≥ the floor) or it is refused with TEXT_OVERFLOW — never clipped.
  out.push({ name: 'all-max', style: structuredClone(big) as StylePatch, expect: 'either' })
  out.push({ name: 'all-max+width-min', style: at('text.width', 0.5, structuredClone(big)) as StylePatch, expect: 'either' })
  // Reported 2026-11-07: 10px too wide for the room with a 6px frame — must shrink by ~1%, not refuse.
  out.push({ name: 'reported-zalzalah-adiyat-frame6', job: { surahsAr: ['الزلزلة', 'العاديات'], prayer: 'Maghrib' },
    style: { text: { width: 0.95 }, title: { scale: 1.15 }, meta: { scale: 1.38 }, frame: { width: 6 } }, expect: 'ok' })
  out.push({ name: 'tall-but-fits-by-shrinking', style: { title: { scale: 1.15 }, reciter: { scale: 1.6, pill: { opacity: 0.6, paddingY: 30 } }, meta: { scale: 1.6, pill: { opacity: 0.6, paddingY: 30 } }, text: { gapAboveTitle: 60, gapBelowTitle: 60 } }, expect: 'ok' })
  out.push({ name: 'all-min', style: small as StylePatch, expect: 'ok' })
  // A generous but sane combination must render, including pushed into every corner (clamping allowed).
  const generous: StylePatch = {
    title: { scale: 1.15, surahWordScale: 1.2, outlineWidth: 6, glow: 2 },
    reciter: { scale: 1.2, pill: { opacity: 0.6 } }, meta: { scale: 1.2, pill: { opacity: 0.6 } },
    text: { gapAboveTitle: 24, gapBelowTitle: 24 },   // a gap applies on both sides of a divider
    dividers: { aboveTitle: { opacity: 1, thickness: 8, width: 800 }, belowTitle: { opacity: 1, thickness: 8, width: 800 } },
    frame: { width: 12, inset: 24 },
  }
  out.push({ name: 'generous', style: generous, expect: 'ok' })
  for (const [x, y] of [[-250, -120], [250, -120], [-250, 120], [250, 120], [0, -120], [0, 120]]) {
    out.push({ name: `generous+offset(${x},${y})`, style: { ...structuredClone(generous), text: { ...generous.text, offsetX: x, offsetY: y } }, expect: 'ok' })
  }
  out.push({ name: 'generous+width-min', style: { ...structuredClone(generous), text: { ...generous.text, width: 0.5 } }, expect: 'either' })
  out.push({ name: 'no-lines', style: { reciter: { opacity: 0 }, meta: { opacity: 0 }, title: { opacity: 0 } }, expect: 'ok' })
  out.push({ name: 'only-title', style: { reciter: { opacity: 0 }, meta: { opacity: 0 } }, expect: 'ok' })
  out.push({ name: 'only-reciter', style: { title: { opacity: 0 }, meta: { opacity: 0 } }, expect: 'ok' })
  out.push({ name: 'raw-photo', style: { overlay: { top: 0, middle: 0, bottom: 0, vignetteStrength: 0, scrimStrength: 0 } }, expect: 'ok' })
  out.push({ name: 'everything-on', style: { ...structuredClone(generous), photo: { zoom: 1.4, blur: 4, grain: 0.6, sepia: 0.4 }, title: { ...generous.title, color: '#5bd1c9', gradientAngle: 90 }, reciter: { ...generous.reciter, color: 'rgb(255 240 200)' } }, expect: 'ok' })
  return out
}

async function sweep(outputDir: string): Promise<number> {
  const job = worstJob()
  const host: PluginHost = { outputDir, log: () => {} }
  const rows: Record<string, unknown>[] = []
  let failed = 0
  const variants = sweepVariants()
  console.error(`sweep: ${variants.length} renders`)
  for (const v of variants) {
    const r: ThumbnailResult = await render({ ...job, ...v.job, style: v.style }, host)
    const problems: string[] = []
    if (!r.ok) {
      if (v.expect === 'ok') problems.push(`${r.reason}: ${r.message}`)
      else if (v.expect === 'either' && r.reason !== 'TEXT_OVERFLOW') problems.push(`${r.reason}: ${r.message}`)
    }
    else if (v.expect === 'refuse') problems.push(`expected a refusal but rendered: ${JSON.stringify(r.layout)}`)
    else if (r.layout) {
      const worst = Math.min(1, ...Object.entries(r.layout.fit).filter(([k]) => k !== 'group').map(([, v]) => v))
      if (worst < 0.55 - 1e-6) problems.push(`rendered below the floor: ${JSON.stringify(r.layout.fit)}`)
      const l = r.layout
      if (l.inkTop < SAFE - 1 || l.inkBottom > H - SAFE + 1 || l.inkLeft < SAFE - 1 || l.inkRight > W - SAFE + 1) problems.push(`outside safe area: ${JSON.stringify(l)}`)
      await fs.copyFile(r.thumbnail, join(outputDir, `sweep-${v.name.replace(/[^\w.=()+-]/g, '_')}.jpg`))
    }
    if (problems.length) failed++
    rows.push({ name: v.name, expect: v.expect, ok: problems.length === 0, problems, result: r.ok ? 'rendered' : r.reason, warnings: r.ok ? r.warnings : [], layout: r.ok ? r.layout : undefined })
    if (problems.length) console.log(JSON.stringify({ name: v.name, problems }))
  }
  await fs.writeFile(join(outputDir, 'sweep.json'), JSON.stringify(rows, null, 2))
  console.error(failed ? `sweep: ${failed}/${variants.length} FAILED → ${join(outputDir, 'sweep.json')}` : `sweep: all ${variants.length} within bounds → ${outputDir}`)
  return failed
}

/** Stale-capture check: after the hidden window has been idle, the next render must still be its own job's picture. */
async function idle(seconds: number, outputDir: string): Promise<number> {
  const jobs = (await loadJobs(join(samplesDir(), 'jobs.json'))).filter((j) => !j.surahsAr.includes('سورة غير موجودة') && !j.photoPath.includes('does-not-exist'))
  const host: PluginHost = { outputDir, log }
  const a = await render(jobs[0]!, host)
  if (!a.ok) { console.log(JSON.stringify({ idle: 'A', ...a })); return 1 }
  console.error(`A rendered (${jobs[0]!.surahsAr.join(' ')}); idling ${seconds}s …`)
  await new Promise((r) => setTimeout(r, seconds * 1000))
  const b = await render(jobs[1]!, host)
  if (!b.ok) { console.log(JSON.stringify({ idle: 'B', ...b })); return 1 }
  const same = meanDiff(a.thumbnail, b.thumbnail) < 0.01
  console.log(JSON.stringify({ idleSeconds: seconds, a: a.cacheKey, b: b.cacheKey, identicalImage: same, ok: !same }))
  console.error(same ? 'idle: STALE CAPTURE — B is A\'s picture' : 'idle: ok — B is its own picture')
  return same ? 1 : 0
}

/** Windows-report checks (2026-11-07): the capture must not depend on the window's zoom or size
 *  staying what the plugin asked for, and must still give a fresh picture when the stamp cannot be
 *  read — but never the previous render's picture. */
async function hostile(outputDir: string): Promise<number> {
  const jobs = (await loadJobs(join(samplesDir(), 'jobs.json'))).slice(0, 3).map((j) => ({ ...j, style: {} }))
  const host: PluginHost = { outputDir, log }
  const golden = (i: number) => join(samplesDir(), 'golden', `job${i}.thumb.jpg`)
  let failed = 0
  const check = (name: string, ok: boolean, detail: unknown) => { if (!ok) failed++; console.log(JSON.stringify({ hostile: name, ok, detail })) }

  const a = await render(jobs[0]!, host)
  check('baseline', a.ok && meanDiff(a.thumbnail, golden(0)) < 1.5, a)
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) { check('window', false, 'no hidden window'); return failed }

  // 1. A persisted zoom level and a resize (what a user zooming the app on Windows used to do to the
  //    shared file:// origin): the next render must notice, reset, and still match the golden picture.
  win.webContents.setZoomFactor(1)
  win.setContentSize(1600, 900)
  const b = await render(jobs[1]!, host)
  check('zoom-and-size-drift', b.ok && meanDiff(b.thumbnail, golden(1)) < 1.5, b)

  // 1b. Windows snaps the client area to whole physical pixels: 1922×1081 DIP is what a 1920×1080 request
  //     can come back as at 125 %. The viewport is then 1281.33×720.67 CSS px; the picture box must stay at
  //     0,0→1280,720, the frame cropped to it, and the golden picture reproduced with no warning.
  win.setContentSize(1922, 1081)
  const s1 = await render({ ...jobs[0]!, style: { output: { quality: 91 } } }, host)
  check('viewport-snapping-slack', s1.ok && s1.warnings.length === 0 && meanDiff(s1.thumbnail, golden(0)) < 1.5, s1)
  // 1c. More slack than snapping explains (1960×1102 → 1306.67×734.67 CSS px): still the right picture, with a warning.
  win.setContentSize(1960, 1102)
  const s2 = await render({ ...jobs[1]!, style: { output: { quality: 91 } } }, host)
  check('viewport-large-slack', s2.ok && s2.warnings.some((w) => w.includes('picture box 1280×720')) && meanDiff(s2.thumbnail, golden(1)) < 1.5, s2)
  win.setContentSize(1920, 1080)

  // 2. The stamp cannot be read: the fallback must return the (stable, new) picture with a warning.
  const css = await win.webContents.insertCSS('#stamp { visibility: hidden !important }')
  const c = await render(jobs[2]!, host)
  check('no-stamp-fallback', c.ok && c.warnings.some((w) => w.includes('stamp not readable')) && meanDiff(c.thumbnail, golden(2)) < 1.5, c)

  // 3. Same picture again under another cache key with the stamp still unreadable: the only stable
  //    frame is the previous render's, so it must be refused rather than handed back.
  const d = await render({ ...jobs[2]!, style: { output: { quality: 89 } } }, host)
  check('no-stamp-refuses-previous-frame', !d.ok && d.reason === 'RENDER_FAILED' && d.message.includes('stale'), d)
  await win.webContents.removeInsertedCSS(css)

  // 4. Stamp back: a normal render again, no warning.
  const e = await render({ ...jobs[0]!, style: { output: { quality: 89 } } }, host)
  check('recovered', e.ok && e.warnings.length === 0 && meanDiff(e.thumbnail, golden(0)) < 1.5, e)
  console.error(failed ? `hostile: ${failed} check(s) FAILED` : 'hostile: all checks pass')
  return failed
}

async function main(): Promise<number> {
  // Chromium switches may be passed through for scaling checks (e.g. --force-device-scale-factor=1.25).
  const args = process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('--force-device-scale-factor'))
  const [first, second] = args
  if (!first) { console.error('usage: thumbnail-cli <jobs.json> [outDir] | --golden [outDir] | --sweep [outDir] | --idle <seconds> [outDir] | --hostile [outDir]'); return 2 }
  const outputDir = resolve((first === '--idle' ? args[2] : second) ?? 'thumbnail-out')
  await fs.mkdir(outputDir, { recursive: true })
  let failed: number
  if (first === '--golden') failed = await golden(outputDir)
  else if (first === '--sweep') failed = await sweep(outputDir)
  else if (first === '--idle') failed = await idle(Number(second) || 390, outputDir)
  else if (first === '--hostile') failed = await hostile(outputDir)
  else failed = await runJobs(resolve(first), outputDir)
  dispose()
  return failed ? 1 : 0
}

app.whenReady().then(main).then((code) => { app.exit(code) }, (e) => { console.error(e); app.exit(1) })
