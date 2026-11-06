/**
 * Standalone runner — renders without the app, for template work and checks.
 *
 *   npm run build
 *   npm run thumb -- <jobs.json> [outDir]     render one job or an array (each may carry a `style`)
 *   npm run thumb -- --golden [outDir]        empty style must reproduce samples/golden/*.jpg
 *   npm run thumb -- --sweep [outDir]         worst-case job × every knob at min/max + combos; asserts safe bounds
 *
 * Relative photo paths resolve against the JSON file's folder. Results print as JSON lines;
 * exit code 1 if any job failed or any check did not pass.
 */
import { app, nativeImage } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { dispose, render } from './index'
import { templateDir } from './renderer'
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

/** The hardest job the layout will ever see. */
function worstJob(): ThumbnailJob {
  return {
    reciterNameAr: 'عبد الرحمن بن عبد العزيز السديس', photoPath: join(samplesDir(), 'photos', 'mosque-dome-sign.jpg'),
    surahsAr: ['الكافرون', 'العاديات'], prayer: 'Istisqa', date: '2024-12-31',
    options: { sheikhPrefix: true, template: 'default' },
  }
}

interface Variant { name: string; style: StylePatch; expect: 'ok' | 'refuse' }
function sweepVariants(): Variant[] {
  const out: Variant[] = [{ name: 'default', style: {}, expect: 'ok' }]
  for (const { path, field } of STYLE_FIELDS) {
    if (field.kind !== 'number') continue
    out.push({ name: `${path}=min(${field.min})`, style: at(path, field.min), expect: 'ok' })
    out.push({ name: `${path}=max(${field.max})`, style: at(path, field.max), expect: 'ok' })
  }
  const big: Record<string, unknown> = {}
  for (const p of ['title.scale', 'reciter.scale', 'meta.scale', 'text.gapAboveTitle', 'text.gapBelowTitle', 'reciter.pill.opacity', 'reciter.pill.paddingX', 'reciter.pill.paddingY', 'meta.pill.opacity', 'meta.pill.paddingX', 'meta.pill.paddingY', 'dividers.aboveTitle.opacity', 'dividers.aboveTitle.thickness', 'dividers.belowTitle.opacity', 'dividers.belowTitle.thickness', 'title.surahWordScale', 'title.outlineWidth', 'frame.width', 'frame.inset'])
    setPath(big, p, STYLE_FIELDS.find((f) => f.path === p)!.field.kind === 'number' ? (STYLE_FIELDS.find((f) => f.path === p)!.field as { max: number }).max : 1)
  const small: Record<string, unknown> = {}
  for (const p of ['title.scale', 'reciter.scale', 'meta.scale', 'text.gapAboveTitle', 'text.gapBelowTitle', 'text.width'])
    setPath(small, p, (STYLE_FIELDS.find((f) => f.path === p)!.field as { min: number }).min)
  // Everything at max at once is taller than the canvas: the plugin must refuse it cleanly, never clamp it.
  out.push({ name: 'all-max', style: structuredClone(big) as StylePatch, expect: 'refuse' })
  out.push({ name: 'all-max+width-min', style: at('text.width', 0.5, structuredClone(big)) as StylePatch, expect: 'refuse' })
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
  out.push({ name: 'generous+width-min', style: { ...structuredClone(generous), text: { ...generous.text, width: 0.5 } }, expect: 'ok' })
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
    const r: ThumbnailResult = await render({ ...job, style: v.style }, host)
    const problems: string[] = []
    if (!r.ok) { if (v.expect !== 'refuse') problems.push(`${r.reason}: ${r.message}`) }
    else if (v.expect === 'refuse') problems.push(`expected a refusal but rendered: ${JSON.stringify(r.layout)}`)
    else if (r.layout) {
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

async function main(): Promise<number> {
  const args = process.argv.slice(app.isPackaged ? 1 : 2)
  const [first, second] = args
  if (!first) { console.error('usage: thumbnail-cli <jobs.json> [outDir] | --golden [outDir] | --sweep [outDir]'); return 2 }
  const outputDir = resolve(second ?? 'thumbnail-out')
  await fs.mkdir(outputDir, { recursive: true })
  let failed: number
  if (first === '--golden') failed = await golden(outputDir)
  else if (first === '--sweep') failed = await sweep(outputDir)
  else failed = await runJobs(resolve(first), outputDir)
  dispose()
  return failed ? 1 : 0
}

app.whenReady().then(main).then((code) => { app.exit(code) }, (e) => { console.error(e); app.exit(1) })
