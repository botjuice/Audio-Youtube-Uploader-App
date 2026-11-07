/**
 * App side of the thumbnail plugin boundary: builds data-only jobs from app records,
 * picks the output folder, and exposes preview helpers. The plugin itself lives in
 * src/plugins/thumbnail and imports nothing from here.
 */
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'

import type { LibraryRecord, ReciterInfo, Settings, StyleError, StylePatch, StyleSchemaInfo, SurahOption, ThumbnailPreview, ThumbnailRule, ThumbnailSample } from '@shared/types'
import { resolveThumbnailLook, type ThumbTarget, type ThumbnailLook } from '@core/thumb-rules'
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

/** The style patch a recording gets from the thumbnail rules (undefined = plugin defaults). */
export function styleForRecord(rec: Pick<LibraryRecord, 'reciterKey' | 'tokens' | 'playlists'>, rules: readonly ThumbnailRule[], surahs: SurahDict): ThumbnailLook {
  return resolveThumbnailLook(thumbTarget(rec), rules, surahs)
}

/** A representative job for a reciter page preview (their photo + name, a fixed surah/prayer/date). */
export function sampleJobForReciter(reciter: Pick<ReciterInfo, 'nameAr' | 'imagePath'>, options: Settings['thumbnails']): ThumbnailJob | null {
  if (!reciter.nameAr || !reciter.imagePath) return null
  const today = new Date()
  const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  return { reciterNameAr: reciter.nameAr, photoPath: reciter.imagePath, surahsAr: ['الكهف'], prayer: 'Jumuah', date, options: { sheikhPrefix: options.sheikhPrefix, template: 'default' } }
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

