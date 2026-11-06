/**
 * Offscreen renderer: one hidden Chromium window, reused for every job.
 * Loads the template once, injects data, waits for the template's own ready signal, captures.
 */
import { app, BrowserWindow, nativeImage, type NativeImage } from 'electron'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateData } from './job'

export const FRAME = { width: 1920, height: 1080 } as const
export const THUMB = { width: 1280, height: 720 } as const
/** The template is authored at 1280×720; zoom 1.5 renders it pixel-identical at 1080p. */
const ZOOM = FRAME.width / THUMB.width

export interface RenderReport {
  fontOk: boolean
  /** Shrink ratio applied per text block (1 = no shrink). */
  fit: Record<string, number>
}

export interface Captured extends RenderReport {
  frame: NativeImage
}

/** Where the template lives: next to the app's resources when packaged; in dev, the repo folder
 *  relative to the built bundle (out/main/*.js → src/plugins/thumbnail/template). */
export function templateDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'thumbnail')
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'plugins', 'thumbnail', 'template')
}

export class OffscreenRenderer {
  private win: BrowserWindow | null = null
  private queue: Promise<unknown> = Promise.resolve()

  /** Serialises renders: the pipeline is sequential anyway, and one window can't render two jobs at once. */
  render(data: TemplateData): Promise<Captured> {
    const run = this.queue.then(() => this.renderNow(data))
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

  private async renderNow(data: TemplateData): Promise<Captured> {
    const win = await this.window()
    const report = (await win.webContents.executeJavaScript(
      `window.renderThumbnail(${JSON.stringify(data)}).then(() => ({ fontOk: window.__fontOk === true, fit: window.__fit || {} }))`,
      true,
    )) as RenderReport
    // Give the compositor one frame after layout before capturing.
    await new Promise((r) => setTimeout(r, 50))
    const frame = await win.webContents.capturePage({ x: 0, y: 0, ...FRAME })
    const size = frame.getSize()
    if (size.width !== FRAME.width || size.height !== FRAME.height) {
      throw new Error(`Captured ${size.width}×${size.height}, expected ${FRAME.width}×${FRAME.height}`)
    }
    return { frame, ...report }
  }
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
