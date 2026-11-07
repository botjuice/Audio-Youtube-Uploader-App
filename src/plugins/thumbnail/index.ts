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
import { bundledFontFaceCss } from './fonts'
import { canonicalStyle, cssVars, customFontFiles, safeMargin, validateStyle, type Style } from './style'
import type { PluginHost, PluginManifest, ThumbnailJob, ThumbnailResult } from './types'

export type { PluginHost, PluginManifest, ThumbnailJob, ThumbnailReason, ThumbnailResult } from './types'
export { DEFAULT_STYLE, STYLE_FIELDS, STYLE_SCHEMA, validateStyle, type Style, type StylePatch, type StyleError, type StyleFieldInfo } from './style'
export { BUNDLED_FONTS, type BundledFont } from './fonts'

export const manifest: PluginManifest = { id: 'thumbnail', version: '1.2.0', templateVersion: 3, styleVersion: 2 }

/** YouTube's limit for custom thumbnails. */
const THUMB_MAX_BYTES = 2 * 1024 * 1024
/** Below this shrink ratio the text would be unreadable at feed size; refuse rather than ship it. */
const MIN_FIT = 0.55
/** Template canvas (template pixels, 1280×720); the safe margin comes from the style (frame-aware). */
const CANVAS = { width: 1280, height: 720 }

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

  const styled = validateStyle(job.style ?? {})
  if (!styled.ok) {
    return { ok: false, reason: 'INVALID_STYLE', message: styled.errors.map((e) => `${e.key}: ${e.message}`).join('; ') }
  }
  const style: Style = styled.style

  let photo: { size: number; mtimeMs: number }
  try {
    const st = await fs.stat(job.photoPath)
    if (!st.isFile() || st.size === 0) throw new Error('not a file or empty')
    await fs.access(job.photoPath, fs.constants.R_OK)
    photo = { size: st.size, mtimeMs: st.mtimeMs }
  } catch (e) {
    return { ok: false, reason: 'PHOTO_UNREADABLE', message: `Photo cannot be read: ${job.photoPath} (${errMsg(e)})` }
  }

  // Custom font files are part of the picture too: a replaced file at the same path must re-render.
  const custom = customFontFiles(style)
  const fontStamp: string[] = []
  for (const line of ['reciter', 'meta'] as const) {
    const file = custom[line]
    if (!file) continue
    try {
      const st = await fs.stat(file)
      if (!st.isFile() || st.size === 0) throw new Error('not a file or empty')
      fontStamp.push(`${line}:${file}:${st.size}:${Math.round(st.mtimeMs)}`)
    } catch (e) {
      return { ok: false, reason: 'FONT_NOT_LOADED', message: `${line === 'reciter' ? 'Reciter' : 'Prayer · date'} font file cannot be read: ${file} (${errMsg(e)})` }
    }
  }
  const key = cacheKey(job, manifest.templateVersion, photo, canonicalStyle(style) + '|' + fontStamp.join('|'))
  const frame = framePath(host.outputDir, key)
  const thumbnail = thumbPath(host.outputDir, key)
  if (await bothExist(host.outputDir, key)) return { ok: true, frame, thumbnail, cacheKey: key, cached: true, warnings: [] }

  try {
    await fs.mkdir(host.outputDir, { recursive: true })
    // Freshness is guaranteed by the renderer: a frame is only accepted when it carries this render's stamp.
    const customFonts: Partial<Record<'reciter' | 'meta', string>> = {}
    if (custom.reciter) customFonts.reciter = pathToFileURL(custom.reciter).href
    if (custom.meta) customFonts.meta = pathToFileURL(custom.meta).href
    const out = await getRenderer().render({ ...check.data, photo: pathToFileURL(job.photoPath).href, bundledCss: bundledFontFaceCss(), customFonts }, cssVars(style))

    if (!out.fontOk) return { ok: false, reason: 'FONT_NOT_LOADED', message: 'The surah calligraphy font did not load — refusing to render the surah name as plain code.' }
    for (const line of ['reciter', 'meta'] as const) {
      const err = out.fontErrors?.[line]
      if (err) return { ok: false, reason: 'FONT_NOT_LOADED', message: `${line === 'reciter' ? 'Reciter' : 'Prayer · date'} font: ${err}${custom[line] ? ` — ${custom[line]}` : ''}` }
    }
    const worst = Math.min(1, ...Object.values(out.fit))
    if (worst < MIN_FIT) {
      return { ok: false, reason: 'TEXT_OVERFLOW', message: `Text had to shrink to ${Math.round(worst * 100)}% to fit — too small to read. Shorten the reciter name or surah list, or reduce the size knobs.` }
    }
    const l = out.layout
    if (l.lines > 0 && l.inkTop !== undefined && l.inkBottom !== undefined && l.inkLeft !== undefined && l.inkRight !== undefined) {
      const safe = safeMargin(style)
      const tooTall = l.inkBottom - l.inkTop > CANVAS.height - 2 * safe
      const tooWide = l.inkRight - l.inkLeft > CANVAS.width - 2 * safe
      if (tooTall || tooWide) {
        const have = tooTall ? `${Math.round(l.inkBottom - l.inkTop)}px tall` : `${Math.round(l.inkRight - l.inkLeft)}px wide`
        const room = tooTall ? `${CANVAS.height - 2 * safe}px` : `${CANVAS.width - 2 * safe}px`
        return { ok: false, reason: 'TEXT_OVERFLOW', message: `The text group is ${have} but only ${room} fits inside the safe area — reduce size, gap, pill or divider knobs.` }
      }
    }
    const warnings: string[] = []
    if (l.clamped) warnings.push('Text group was pulled back inside the safe area (offset or size knobs pushed it to the edge).')
    if (worst < 1) warnings.push(`Text shrank to ${Math.round(worst * 100)}% to fit its box.`)

    const quality = Math.round(style.output.quality)
    const frameBuf = out.frame.toJPEG(quality)
    const thumbBuf = toJpegUnder(downscale(out.frame), THUMB_MAX_BYTES, quality)
    await writeAtomic(frame, frameBuf)
    await writeAtomic(thumbnail, thumbBuf)
    host.log('info', `Thumbnail rendered (${Math.round(thumbBuf.length / 1024)} KB) → ${key}`)
    const layout = { inkTop: l.inkTop ?? 0, inkBottom: l.inkBottom ?? 0, inkLeft: l.inkLeft ?? 0, inkRight: l.inkRight ?? 0, clamped: l.clamped, fit: out.fit }
    return { ok: true, frame, thumbnail, cacheKey: key, cached: false, warnings, layout }
  } catch (e) {
    host.log('error', `Thumbnail render failed: ${errMsg(e)}`)
    await fs.rm(frame, { force: true }).catch(() => {})
    await fs.rm(thumbnail, { force: true }).catch(() => {})
    return { ok: false, reason: 'RENDER_FAILED', message: errMsg(e) }
  }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
