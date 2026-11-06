/**
 * Thumbnail plugin — the only public surface.
 *
 *   render(job, host) → { ok, frame, thumbnail } | { ok: false, reason, message }
 *
 * Rules: data in, files or a reason out. Imports nothing from src/main or src/core.
 */
import { promises as fs } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { bothExist, cacheKey, framePath, thumbPath, writeAtomic } from './cache'
import { checkJob } from './job'
import { downscale, OffscreenRenderer, toJpegUnder } from './renderer'
import type { PluginHost, PluginManifest, ThumbnailJob, ThumbnailResult } from './types'

export type { PluginHost, PluginManifest, ThumbnailJob, ThumbnailReason, ThumbnailResult } from './types'

export const manifest: PluginManifest = { id: 'thumbnail', version: '1.0.0', templateVersion: 1 }

/** YouTube's limit for custom thumbnails. */
const THUMB_MAX_BYTES = 2 * 1024 * 1024
/** Below this shrink ratio the text would be unreadable at feed size; refuse rather than ship it. */
const MIN_FIT = 0.55

let renderer: OffscreenRenderer | null = null
const getRenderer = () => (renderer ??= new OffscreenRenderer())

/** Close the hidden window. Safe to call any time; the next render reopens it. */
export function dispose(): void {
  renderer?.dispose()
  renderer = null
}

export async function render(job: ThumbnailJob, host: PluginHost): Promise<ThumbnailResult> {
  const check = checkJob(job)
  if (!check.ok) return check

  let photo: { size: number; mtimeMs: number }
  try {
    const st = await fs.stat(job.photoPath)
    if (!st.isFile() || st.size === 0) throw new Error('not a file or empty')
    await fs.access(job.photoPath, fs.constants.R_OK)
    photo = { size: st.size, mtimeMs: st.mtimeMs }
  } catch (e) {
    return { ok: false, reason: 'PHOTO_UNREADABLE', message: `Photo cannot be read: ${job.photoPath} (${errMsg(e)})` }
  }

  const key = cacheKey(job, manifest.templateVersion, photo)
  const frame = framePath(host.outputDir, key)
  const thumbnail = thumbPath(host.outputDir, key)
  if (await bothExist(host.outputDir, key)) return { ok: true, frame, thumbnail, cacheKey: key, cached: true }

  try {
    await fs.mkdir(host.outputDir, { recursive: true })
    const out = await getRenderer().render({ ...check.data, photo: pathToFileURL(job.photoPath).href })

    if (!out.fontOk) return { ok: false, reason: 'FONT_NOT_LOADED', message: 'The surah calligraphy font did not load — refusing to render the surah name as plain code.' }
    const worst = Math.min(1, ...Object.values(out.fit))
    if (worst < MIN_FIT) {
      return { ok: false, reason: 'TEXT_OVERFLOW', message: `Text had to shrink to ${Math.round(worst * 100)}% to fit — too small to read. Shorten the reciter name or surah list.` }
    }

    const frameBuf = out.frame.toJPEG(90)
    const thumbBuf = toJpegUnder(downscale(out.frame), THUMB_MAX_BYTES)
    await writeAtomic(frame, frameBuf)
    await writeAtomic(thumbnail, thumbBuf)
    host.log('info', `Thumbnail rendered (${Math.round(thumbBuf.length / 1024)} KB) → ${key}`)
    return { ok: true, frame, thumbnail, cacheKey: key, cached: false }
  } catch (e) {
    host.log('error', `Thumbnail render failed: ${errMsg(e)}`)
    await fs.rm(frame, { force: true }).catch(() => {})
    await fs.rm(thumbnail, { force: true }).catch(() => {})
    return { ok: false, reason: 'RENDER_FAILED', message: errMsg(e) }
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
