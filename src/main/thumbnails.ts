/**
 * App side of the thumbnail plugin boundary: builds data-only jobs from app records,
 * picks the output folder, and exposes preview helpers. The plugin itself lives in
 * src/plugins/thumbnail and imports nothing from here.
 */
import { promises as fs } from 'node:fs'

import type { LibraryRecord, ReciterInfo, Settings, ThumbnailPreview } from '@shared/types'
import { translateSurah, type SurahDict } from '@core/surahs'
import { render, dispose as disposePlugin, type ThumbnailJob, type ThumbnailResult } from '../plugins/thumbnail/index'
import { activity } from './log'
import { stateFile } from './paths'

export const thumbsDir = (library: string) => stateFile(library, 'thumbs')

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
): { ok: true; job: ThumbnailJob } | { ok: false; reason: string; message: string } {
  if (!rec.parsed) return { ok: false, reason: 'INVALID_JOB', message: 'Filename is not fully parsed yet.' }
  if (!reciter?.nameAr) return { ok: false, reason: 'INVALID_JOB', message: 'Reciter has no Arabic name.' }
  if (!reciter.imagePath) return { ok: false, reason: 'PHOTO_UNREADABLE', message: 'Reciter folder has no photo.' }
  return {
    ok: true,
    job: {
      reciterNameAr: reciter.nameAr,
      photoPath: reciter.imagePath,
      surahsAr: rec.parsed.surahs.map((s) => translateSurah(s, surahs)),
      prayer: rec.parsed.prayer,
      date: isoDate(rec.parsed.date),
      options: { sheikhPrefix: options.sheikhPrefix, template: 'default' },
    },
  }
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
export async function toPreview(result: ThumbnailResult): Promise<ThumbnailPreview> {
  if (!result.ok) return { ok: false, reason: result.reason, message: result.message }
  const buf = await fs.readFile(result.thumbnail)
  return { ok: true, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}`, cached: result.cached }
}

export function disposeThumbnails(): void { disposePlugin() }

