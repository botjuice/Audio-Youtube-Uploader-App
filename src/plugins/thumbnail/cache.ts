import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { ThumbnailJob } from './types'

export interface PhotoStat { size: number; mtimeMs: number }

/** Stable key: every job field that affects the picture, plus the photo's identity and the template version. */
export function cacheKey(job: ThumbnailJob, templateVersion: number, photo: PhotoStat): string {
  const h = createHash('sha1')
  h.update(JSON.stringify({
    v: templateVersion,
    name: job.reciterNameAr.trim(),
    photo: [job.photoPath, photo.size, Math.round(photo.mtimeMs)],
    surahs: job.surahsAr,
    prayer: job.prayer,
    date: job.date,
    options: job.options,
  }))
  return h.digest('hex').slice(0, 20)
}

export const framePath = (dir: string, key: string) => join(dir, `${key}.frame.jpg`)
export const thumbPath = (dir: string, key: string) => join(dir, `${key}.thumb.jpg`)

export async function bothExist(dir: string, key: string): Promise<boolean> {
  const ok = (p: string) => fs.stat(p).then((s) => s.size > 0, () => false)
  return (await ok(framePath(dir, key))) && (await ok(thumbPath(dir, key)))
}

/** Write via a temp file and rename, so a crash never leaves a half-written image that looks valid. */
export async function writeAtomic(path: string, data: Buffer): Promise<void> {
  const tmp = `${path}.part`
  await fs.writeFile(tmp, data)
  await fs.rename(tmp, path)
}
