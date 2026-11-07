/**
 * Offscreen renderer: one hidden Chromium window, reused for every job.
 * Loads the template once, injects style variables + data, waits for the template's own
 * ready signal, captures.
 */
import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateData } from './job'

export const FRAME = { width: 1920, height: 1080 } as const
export const THUMB = { width: 1280, height: 720 } as const
/** The template is authored at 1280×720; zoom 1.5 renders it pixel-identical at 1080p. */
const ZOOM = FRAME.width / THUMB.width

export interface LayoutReport {
  lines: number
  clamped: boolean
  /** True when the group still exceeds the safe room after shrinking to the floor. */
  overflow?: boolean
  inkTop?: number; inkBottom?: number; inkLeft?: number; inkRight?: number
}
export interface RenderReport {
  fontOk: boolean
  /** Per-line font problems (reciter / meta), empty when all fonts loaded and draw Arabic. */
  fontErrors: Partial<Record<'reciter' | 'meta', string>>
  /** Shrink ratio applied per text block (1 = no shrink). */
  fit: Record<string, number>
  layout: LayoutReport
}
export interface Captured extends RenderReport { frame: NativeImage }

const TEMPLATE_REL = join('src', 'plugins', 'thumbnail', 'template')

/** Where the template lives.
 *  Packaged: copied next to the app's resources (electron-builder `extraResources`).
 *  Dev: the repo's src/plugins/thumbnail/template, found without assuming where the bundler put
 *  this file — `app.getAppPath()` works when the app runs from package.json, and walking up from
 *  the bundle covers the CLI (`electron out/main/thumbnail-cli.js`) and chunk subfolders. */
export function templateDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'thumbnail')
  const candidates = [join(app.getAppPath(), TEMPLATE_REL)]
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) { candidates.push(join(dir, TEMPLATE_REL)); dir = dirname(dir) }
  const found = candidates.find((c) => existsSync(join(c, 'thumbnail.html')))
  if (!found) throw new Error(`Thumbnail template not found; looked in: ${candidates.join(', ')}`)
  return found
}

export class OffscreenRenderer {
  private win: BrowserWindow | null = null
  private queue: Promise<unknown> = Promise.resolve()

  /** Serialises renders: the pipeline is sequential anyway, and one window can't render two jobs at once. */
  render(data: TemplateData, vars: Record<string, string>): Promise<Captured> {
    const run = this.queue.then(() => this.renderNow(data, vars))
    this.queue = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
  }

  private async window(): Promise<BrowserWindow> {
    await app.whenReady()
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      show: false, width: FRAME.width, height: FRAME.height, useContentSize: true,
      webPreferences: { offscreen: true, zoomFactor: ZOOM, backgroundThrottling: false },
    })
    await win.loadFile(join(templateDir(), 'thumbnail.html'))
    win.webContents.setZoomFactor(ZOOM)
    this.win = win
    return win
  }

  private renderSeq = 0

  private async renderNow(data: TemplateData, vars: Record<string, string>): Promise<Captured> {
    const win = await this.window()
    const renderId = (this.renderSeq = (this.renderSeq + 1) & 511)
    const report = (await win.webContents.executeJavaScript(
      `window.renderThumbnail(${JSON.stringify({ ...data, renderId })}, ${JSON.stringify(vars)})
         .then(() => ({ fontOk: window.__fontOk === true, fontErrors: window.__fontErrors || {}, fit: window.__fit || {}, layout: window.__layout || { lines: 0, clamped: false } }))`,
      true,
    )) as RenderReport
    const frame = await this.captureStamped(win, renderId)
    return { frame, ...report }
  }

  /** Take a frame that provably shows the current DOM — never a leftover one.
   *
   *  `renderThumbnail` resolves once layout is final, but what the compositor hands back next may
   *  still be an older frame: on an offscreen window `capturePage` returns the most recent composited
   *  frame (after minutes of idle the first repaint takes longer than any fixed delay), and even the
   *  first `paint` after `invalidate()` can be a frame that was already in flight. Both were seen in
   *  the app: a cached thumbnail showing another surah, and a frame missing the final positioning.
   *  So every render paints a colour-coded id into a 2px corner stamp, and a frame is accepted only
   *  when its stamp matches; otherwise we keep taking paints (forcing repaints) until it does. */
  private async captureStamped(win: BrowserWindow, renderId: number, timeoutMs = 3000): Promise<NativeImage> {
    const wc = win.webContents
    const debug = !!process.env['THUMB_DEBUG']
    const raw = await new Promise<NativeImage>((resolve, reject) => {
      let settled = false
      let paints = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let poke: ReturnType<typeof setInterval> | undefined
      const stop = () => { settled = true; if (timer) clearTimeout(timer); if (poke) clearInterval(poke); wc.off('paint', onPaint) }
      /** True when the image is a full frame carrying our stamp (then resolved). */
      const consider = (img: NativeImage, source: string): boolean => {
        if (settled) return false
        const s = img.getSize()
        const stamp = s.width === FRAME.width && s.height === FRAME.height ? stampOf(img) : NaN
        if (debug) console.error(`[thumb] render ${renderId}: ${source} ${s.width}x${s.height} stamp=${stamp}`)
        if (stamp !== renderId) return false
        stop(); resolve(img); return true
      }
      const onPaint = (_e: unknown, _dirty: unknown, image: NativeImage) => {
        paints++
        try { consider(image, 'paint') } catch (e) { stop(); reject(e) }
      }
      timer = setTimeout(() => {
        if (settled) return
        // Last resort: an explicit capture, still only accepted with the right stamp.
        wc.capturePage({ x: 0, y: 0, ...FRAME }).then((img) => {
          if (settled) return
          try {
            if (!consider(img, 'capturePage')) { stop(); reject(new Error(`Render ${renderId}: no frame with the current content after ${timeoutMs}ms (${paints} paints, stamp ${stampOf(img)}) — refusing to use a stale frame`)) }
          } catch (e) { stop(); reject(e) }
        }, (e) => { stop(); reject(e) })
      }, timeoutMs)
      if (debug) console.error(`[thumb] render ${renderId}: waiting for stamped frame`)
      wc.on('paint', onPaint)              // listener first, then force repaints until one carries our stamp
      poke = setInterval(() => { if (!settled) wc.invalidate() }, 100)
      wc.invalidate()
    })
    return scrubStamp(raw)
  }
}

/** Stamp pixel: the 2×2 template-px block at the bottom-right corner (3×3 at 1080p); sample 2px in. */
const STAMP_PX = { x: FRAME.width - 2, y: FRAME.height - 2 }
const STAMP_SIZE = 4

/** Decode the render id from a captured frame's corner stamp (BGRA bitmap). */
export function stampOf(img: NativeImage): number {
  const bmp = img.toBitmap()
  const i = (STAMP_PX.y * FRAME.width + STAMP_PX.x) * 4
  const b = bmp[i]!, g = bmp[i + 1]!, r = bmp[i + 2]!
  if (r > 7 || g > 7 || b > 7) return -1
  return r | (g << 3) | (b << 6)
}

/** Copy the pixels just left of the stamp over it, so no trace is left in the output. */
export function scrubStamp(img: NativeImage): NativeImage {
  const bmp = Buffer.from(img.toBitmap())
  for (let y = FRAME.height - STAMP_SIZE; y < FRAME.height; y++) {
    const src = (y * FRAME.width + (FRAME.width - STAMP_SIZE - 1)) * 4
    for (let x = FRAME.width - STAMP_SIZE; x < FRAME.width; x++) bmp.copy(bmp, (y * FRAME.width + x) * 4, src, src + 4)
  }
  return nativeImage.createFromBitmap(bmp, { width: FRAME.width, height: FRAME.height })
}

/** JPEG under `maxBytes`, lowering quality in steps if needed. */
export function toJpegUnder(img: NativeImage, maxBytes: number, startQuality = 92): Buffer {
  for (let q = startQuality; q >= 60; q -= 8) {
    const buf = img.toJPEG(q)
    if (buf.length <= maxBytes) return buf
  }
  return img.toJPEG(60)
}

export function downscale(img: NativeImage): NativeImage {
  return nativeImage.createFromBuffer(img.toPNG()).resize({ ...THUMB, quality: 'best' })
}
