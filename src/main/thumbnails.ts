/**
 * App side of the thumbnail plugin boundary: builds data-only jobs from app records,
 * picks the output folder, and exposes preview helpers. The plugin itself lives in
 * src/plugins/thumbnail and imports nothing from here.
 */
import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'

import type { LibraryRecord, ReciterInfo, Settings, StyleError, StylePatch, StyleSchemaInfo, SurahOption, ThumbnailPreview, ThumbnailRule, ThumbnailSample } from '@shared/types'
import { prunePatch, resolveThumbnailLook, setKnob as setKnobPath, type ThumbTarget, type ThumbnailLook } from '@core/thumb-rules'
import { buildLookFile, parseLookFile, pathKnobs, remapStrings, sanitisePatch, type LookFile, type LookFileFont } from '@core/look-file'
import { DEFAULT_SURAHS, translateSurah, type SurahDict } from '@core/surahs'
import { SURAHS_AR } from '../plugins/thumbnail/surahs'
import { PRAYERS } from '@core/prayers'
import { DEFAULT_STYLE, STYLE_FIELDS, dispose as disposePlugin, manifest, render, validateStyle, type ThumbnailJob, type ThumbnailResult } from '../plugins/thumbnail/index'
import { activity } from './log'
import { stateFile } from './paths'

export const thumbsDir = (library: string) => stateFile(library, 'thumbs')
/** Copies of images chosen for thumbnail rules (travel with the library, like the rules). */
export const rulePhotosDir = (library: string) => stateFile(library, 'thumb-photos')
export const rulePhotoPath = (library: string, file: string) => join(rulePhotosDir(library), basename(file))
/** Copies of font files chosen for thumbnail rules (absolute paths are stored in the style patch, as the plugin wants). */
export const ruleFontsDir = (library: string) => stateFile(library, 'fonts')

/** Every custom font path referenced by the rules' `reciter.font` / `meta.font` knobs. */
export function fontPathsInRules(rules: readonly ThumbnailRule[]): Set<string> {
  const out = new Set<string>()
  for (const r of rules) for (const line of ['reciter', 'meta'] as const) {
    const v = (r.style as Record<string, Record<string, unknown> | undefined>)[line]?.font
    if (typeof v === 'string' && v.includes('/')) out.add(v)
  }
  return out
}

/** Absolute path of a rule's photo when the file still exists; otherwise undefined (callers fall back to the reciter photo). */
export async function resolveRulePhoto(library: string, file: string | undefined, recordId?: string): Promise<string | undefined> {
  if (!file) return undefined
  const abs = rulePhotoPath(library, file)
  try { if ((await fs.stat(abs)).size > 0) return abs } catch { /* missing */ }
  activity.warn(`Rule photo “${file}” is missing — using the reciter photo instead.`, recordId)
  return undefined
}

/** DD.MM.YYYY → YYYY-MM-DD (the plugin wants ISO). */
export function isoDate(ddmmyyyy: string): string {
  const [d = '', m = '', y = ''] = ddmmyyyy.split('.')
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

/** Build the plugin job for a recording, or explain why one can't be built. */
export function buildThumbnailJob(
  rec: Pick<LibraryRecord, 'parsed' | 'fileName'>,
  reciter: Pick<ReciterInfo, 'nameAr' | 'imagePath'> | undefined,
  surahs: SurahDict,
  options: Settings['thumbnails'],
  style?: StylePatch,
  /** absolute path of a rule photo that replaces the reciter's */
  photoOverride?: string,
): { ok: true; job: ThumbnailJob } | { ok: false; reason: string; message: string } {
  if (!rec.parsed) return { ok: false, reason: 'INVALID_JOB', message: 'Filename is not fully parsed yet.' }
  if (!reciter?.nameAr) return { ok: false, reason: 'INVALID_JOB', message: 'Reciter has no Arabic name.' }
  const photoPath = photoOverride ?? reciter.imagePath
  if (!photoPath) return { ok: false, reason: 'PHOTO_UNREADABLE', message: 'Reciter folder has no photo.' }
  return {
    ok: true,
    job: {
      reciterNameAr: reciter.nameAr,
      photoPath,
      surahsAr: rec.parsed.surahs.map((s) => translateSurah(s, surahs)),
      prayer: rec.parsed.prayer,
      date: isoDate(rec.parsed.date),
      options: { sheikhPrefix: options.sheikhPrefix, template: 'default' },
      ...(style ? { style } : {}),
    },
  }
}

/** What the rules engine needs to know about a recording. */
export const thumbTarget = (rec: Pick<LibraryRecord, 'reciterKey' | 'tokens' | 'playlists'>): ThumbTarget =>
  ({ reciter: rec.reciterKey, tokens: rec.tokens, playlists: rec.playlists.final })

/** The Default look stores differences from the plugin's factory style; drop knobs that equal it (e.g. after the plugin adopts them as defaults). */
export function pruneDefaultLook(rules: readonly ThumbnailRule[]): ThumbnailRule[] {
  return rules.map((r) => (r.origin === 'default' ? { ...r, style: prunePatch(r.style as Record<string, unknown>, DEFAULT_STYLE as unknown as Record<string, unknown>) as StylePatch } : r))
}

/** The style patch a recording gets from the thumbnail rules (undefined = plugin defaults). */
export function styleForRecord(rec: Pick<LibraryRecord, 'reciterKey' | 'tokens' | 'playlists'>, rules: readonly ThumbnailRule[], surahs: SurahDict): ThumbnailLook {
  return resolveThumbnailLook(thumbTarget(rec), rules, surahs)
}

export async function renderJob(job: ThumbnailJob, library: string, recordId?: string): Promise<ThumbnailResult> {
  return render(job, {
    outputDir: thumbsDir(library),
    log: (level, message) => (level === 'error' ? activity.warn(message, recordId) : level === 'warn' ? activity.warn(message, recordId) : activity.info(message, recordId)),
  })
}

/** Turn a plugin result into something the renderer can display (data: URL — file:// is blocked in dev). */
export async function toPreview(result: ThumbnailResult, opts: { withFrame?: boolean; ms?: number } = {}): Promise<ThumbnailPreview> {
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message, ...(opts.ms !== undefined ? { ms: opts.ms } : {}) }
  const thumb = await fs.readFile(result.thumbnail)
  const out: ThumbnailPreview = { ok: true, dataUrl: `data:image/jpeg;base64,${thumb.toString('base64')}`, cached: result.cached, warnings: result.warnings ?? [] }
  if (opts.withFrame) out.frameDataUrl = `data:image/jpeg;base64,${(await fs.readFile(result.frame)).toString('base64')}`
  if (opts.ms !== undefined) out.ms = opts.ms
  return out
}

/** A rule's preview: user-chosen surahs/prayer/date on a real reciter, with the rule's style. Same job shape the pipeline builds. */
export function buildSampleJob(
  sample: ThumbnailSample,
  reciter: Pick<ReciterInfo, 'nameAr' | 'imagePath'> | undefined,
  options: Pick<Settings['thumbnails'], 'sheikhPrefix'>,
  style?: StylePatch,
  photoOverride?: string,
): { ok: true; job: ThumbnailJob } | { ok: false; reason: string; message: string } {
  if (!reciter) return { ok: false, reason: 'INVALID_JOB', message: 'Choose a reciter for the preview.' }
  if (!reciter.nameAr) return { ok: false, reason: 'INVALID_JOB', message: 'This reciter has no Arabic name — set it in Reciters.' }
  const photoPath = photoOverride ?? reciter.imagePath
  if (!photoPath) return { ok: false, reason: 'PHOTO_UNREADABLE', message: 'This reciter folder has no photo.' }
  const surahs = sample.surahsAr.map((s) => s.trim()).filter(Boolean)
  if (surahs.length < 1 || surahs.length > 3) return { ok: false, reason: 'INVALID_JOB', message: 'Choose between 1 and 3 surahs.' }
  if (!PRAYERS.includes(sample.prayer)) return { ok: false, reason: 'UNKNOWN_PRAYER', message: `Unknown prayer "${sample.prayer}".` }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sample.date)) return { ok: false, reason: 'BAD_DATE', message: 'Date must be YYYY-MM-DD.' }
  const job: ThumbnailJob = { reciterNameAr: reciter.nameAr, photoPath, surahsAr: surahs, prayer: sample.prayer, date: sample.date, options: { sheikhPrefix: options.sheikhPrefix, template: 'default' } }
  if (style && Object.keys(style).length) job.style = style
  return { ok: true, job }
}

/** The plugin's knob table for the editor (ranges, steps, defaults, descriptions). */
export function styleSchema(): StyleSchemaInfo {
  return { fields: [...STYLE_FIELDS], defaults: DEFAULT_STYLE, styleVersion: manifest.styleVersion }
}

/** Every problem in a style patch, by dotted key. Empty = valid. */
export function styleProblems(patch: unknown): StyleError[] {
  const v = validateStyle(patch ?? {})
  return v.ok ? [] : v.errors
}

/** The 114 surahs in order, with a Latin label taken from the app dictionary. */
export function surahOptions(): SurahOption[] {
  const byAr = new Map<string, string[]>()
  for (const [key, ar] of Object.entries(DEFAULT_SURAHS)) (byAr.get(ar) ?? byAr.set(ar, []).get(ar)!).push(key)
  return SURAHS_AR.map((ar, i) => {
    const keys = (byAr.get(ar) ?? []).filter((k) => /^[a-z]+$/.test(k)).sort((a, b) => a.length - b.length)
    const pick = keys.find((k) => k.length >= 4 && !k.startsWith('al') && !k.startsWith('an') && !k.startsWith('as')) ?? keys[0] ?? ''
    return { n: i + 1, ar, label: pick ? pick[0]!.toUpperCase() + pick.slice(1) : '' }
  })
}

export function disposeThumbnails(): void { disposePlugin() }


// ── Look files (export / import) ──────────────────────────────────────────────

/** Build a look file, embedding the custom font files the knobs point at (missing files are left as paths). */
export async function packLook(rule: Pick<ThumbnailRule, 'label' | 'overlay' | 'origin' | 'style'>, look: StylePatch, appVersion: string): Promise<LookFile> {
  const fonts: Record<string, LookFileFont> = {}
  for (const { value } of [...pathKnobs(rule.style ?? {}), ...pathKnobs(look)]) {
    if (fonts[value]) continue
    try { fonts[value] = { name: basename(value), data: (await fs.readFile(value)).toString('base64') } } catch { /* not on this machine any more */ }
  }
  return buildLookFile(rule, look, { appVersion, styleVersion: manifest.styleVersion }, fonts)
}

/** Parse a look file: restore embedded fonts into the library, drop knobs this plugin rejects, and say what changed. */
export async function unpackLook(text: string, library: string): Promise<{ file: LookFile; notes: string[] }> {
  const file = parseLookFile(text)
  const notes: string[] = []
  const remap: Record<string, string> = {}
  for (const [origPath, font] of Object.entries(file.fonts ?? {})) {
    if (await fs.access(origPath).then(() => true, () => false)) continue   // same machine, file still there
    const ext = extname(font.name).toLowerCase() || '.ttf'
    const stem = basename(font.name, extname(font.name)).replace(/[^\w.-]+/g, '_').slice(0, 60) || 'font'
    const target = join(ruleFontsDir(library), `${stem}-${Date.now()}${ext}`)
    await fs.mkdir(ruleFontsDir(library), { recursive: true })
    await fs.writeFile(target, Buffer.from(font.data, 'base64'))
    remap[origPath] = target
    notes.push(`Font “${font.name}” restored into the library.`)
  }
  let knobs = remapStrings(file.knobs, remap), look = remapStrings(file.look, remap)
  // fonts referenced but neither embedded nor present here → the plugin would fail at render time; fall back to the default font
  for (const [which, patch] of [['knobs', knobs], ['look', look]] as const) {
    for (const { path, value } of pathKnobs(patch)) {
      if (await fs.access(value).then(() => true, () => false)) continue
      const next = setKnobPath(patch as Record<string, unknown>, path, undefined) as StylePatch
      if (which === 'knobs') knobs = next; else look = next
      notes.push(`Font file “${basename(value)}” isn't on this computer — that line keeps its current font.`)
    }
  }
  const k = sanitisePatch(knobs, styleProblems), l = sanitisePatch(look, styleProblems)
  for (const d of [...new Set([...k.dropped, ...l.dropped])]) notes.push(`Skipped a knob this version doesn't have: ${d}.`)
  return { file: { ...file, knobs: k.patch, look: l.patch }, notes }
}
