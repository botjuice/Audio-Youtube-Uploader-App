/**
 * Offscreen renderer: one hidden Chromium window, reused for every job.
 * Loads the template once, injects style variables + data, waits for the template's own
 * ready signal, verifies the page is laid out as authored, captures a frame that provably
 * shows the current DOM.
 */
import { app, BrowserWindow, nativeImage, screen, type NativeImage, type WebContents } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TemplateData } from './job'
import { cropToBox, describePage, frameScale, MAX_ID, pageVerdict, readStamp, scrubStamp, stampColours, type Frame, type PageMeasure, type StampRead } from './stamp'

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
  /** The page's own viewport measurements after the render. */
  page?: PageMeasure
}
export interface Captured extends RenderReport {
  frame: NativeImage
  /** Non-fatal capture notes (e.g. the stamp fallback was used). */
  warnings: string[]
}

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

const debug = () => !!process.env['THUMB_DEBUG']
const log = (msg: string) => { if (debug()) console.error(`[thumb] ${msg}`) }
const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex')

export class OffscreenRenderer {
  private win: BrowserWindow | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private renderSeq = 0
  /** Hash of the raw frame the previous render returned — the fallback must never hand it back again. */
  private lastAccepted: string | undefined

  /** Serialises renders: the pipeline is sequential anyway, and one window can't render two jobs at once. */
  render(data: TemplateData, vars: Record<string, string>): Promise<Captured> {
    const run = this.queue.then(() => this.renderNow(data, vars))
    this.queue = run.catch(() => undefined)
    return run
  }

  dispose(): void {
    if (this.win && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.lastAccepted = undefined
  }

  private async window(): Promise<BrowserWindow> {
    await app.whenReady()
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      show: false, width: FRAME.width, height: FRAME.height, useContentSize: true,
      webPreferences: {
        offscreen: true, zoomFactor: ZOOM, backgroundThrottling: false,
        // Own in-memory session: Chromium keeps zoom per origin and per session, and the app's own
        // window is the same `file://` origin — without this a user zooming the app re-zooms the
        // template (seen on Windows: stamp off the corner, every render refused).
        partition: 'thumbnail',
      },
    })
    await win.loadFile(join(templateDir(), 'thumbnail.html'))
    win.webContents.setZoomFactor(ZOOM)
    this.win = win
    this.lastAccepted = undefined
    log(`window created: ${this.environment(win)}`)
    return win
  }

  /** Everything about the host that can bend a capture — for logs and failure messages. */
  private environment(win: BrowserWindow): string {
    const [cw, ch] = win.getContentSize()
    let scale = 'n/a'
    try { scale = String(screen.getPrimaryDisplay().scaleFactor) } catch { /* screen unavailable */ }
    return `platform ${process.platform}, content size ${cw}×${ch} DIP, zoom factor ${win.webContents.getZoomFactor()}, primary display scale ${scale}`
  }

  private async runTemplate(wc: WebContents, data: TemplateData, vars: Record<string, string>, renderId: number): Promise<RenderReport> {
    const stamp = stampColours(renderId)
    return (await wc.executeJavaScript(
      `window.renderThumbnail(${JSON.stringify({ ...data, stamp })}, ${JSON.stringify(vars)})
         .then(() => ({ fontOk: window.__fontOk === true, fontErrors: window.__fontErrors || {}, fit: window.__fit || {}, layout: window.__layout || { lines: 0, clamped: false }, page: window.__page }))`,
      true,
    )) as RenderReport
  }

  private async renderNow(data: TemplateData, vars: Record<string, string>): Promise<Captured> {
    const win = await this.window()
    const wc = win.webContents
    const renderId = (this.renderSeq = (this.renderSeq % MAX_ID) + 1)   // 1..63, never 0 (black = no stamp)
    // What the window shows *before* this render: the fallback must never return it.
    const before = await wc.capturePage({ x: 0, y: 0, ...FRAME }).then((img) => sha1(img.toBitmap()), () => undefined)
    let report = await this.runTemplate(wc, data, vars, renderId)
    if (pageVerdict(report.page) === 'bad') {
      // Zoom or size drifted (a persisted zoom level, a resize): put them back and lay out again.
      log(`render ${renderId}: page off — ${describePage(report.page)}; resetting zoom and size`)
      wc.setZoomFactor(ZOOM)
      win.setContentSize(FRAME.width, FRAME.height)
      await this.settleViewport(wc)
      report = await this.runTemplate(wc, data, vars, renderId)
      if (pageVerdict(report.page) === 'bad') {
        throw new Error(`Render ${renderId}: the hidden page's picture box is not at 0,0→1280×720 after resetting zoom — ${describePage(report.page)}; ${this.environment(win)}`)
      }
    }
    const { frame, warnings } = await this.captureStamped(win, renderId, before, report.page)
    if (pageVerdict(report.page) === 'slack') {
      const p = report.page!
      warnings.push(`Viewport ${p.innerWidth}×${p.innerHeight}, picture box 1280×720 — fine (the picture is captured from the box).`)
    }
    return { frame, warnings, ...report }
  }

  /** Zoom and size changes reach the page asynchronously: wait (bounded) until it sees the authored viewport. */
  private async settleViewport(wc: WebContents, ms = 3000): Promise<void> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      const [w, h] = (await wc.executeJavaScript('[innerWidth, innerHeight]', true)) as [number, number]
      if (w === THUMB.width && h === THUMB.height) return
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  /** Take a frame that provably shows the current DOM — never a leftover one.
   *
   *  `renderThumbnail` resolves once layout is final, but what the compositor hands back next may
   *  still be an older frame: on an offscreen window `capturePage` returns the most recent composited
   *  frame (after minutes of idle the first repaint takes longer than any fixed delay), and even the
   *  first `paint` after `invalidate()` can be a frame that was already in flight. Both were seen in
   *  the app: a cached thumbnail showing another surah, and a frame missing the final positioning.
   *  So every render paints a colour-coded id into a corner stamp, and a frame is accepted only when
   *  its stamp matches; otherwise we keep taking paints (forcing repaints) until it does.
   *
   *  Frames may arrive larger than 1920×1080 (Windows display scaling); the stamp is read at the
   *  scaled position and the frame is downscaled after the stamp is scrubbed.
   *
   *  Fallback: if no stamped frame arrives in time but the last two paints are byte-identical and
   *  differ from what the window showed before this render and from the previous render's frame,
   *  that frame is stable and new, so it is used with a warning rather than failing every thumbnail
   *  on a machine where the stamp colour does not survive to the capture. */
  private async captureStamped(win: BrowserWindow, renderId: number, before: string | undefined, page: PageMeasure | undefined, timeoutMs = 3000): Promise<{ frame: NativeImage; warnings: string[] }> {
    const wc = win.webContents
    const warnings: string[] = []
    const raw = await new Promise<Frame>((resolve, reject) => {
      let settled = false
      let paints = 0
      let timer: ReturnType<typeof setTimeout> | undefined
      let poke: ReturnType<typeof setInterval> | undefined
      /** The last two paints, raw, for the stable-and-new fallback and the diagnostics. */
      const recent: { frame: Frame; stamp: StampRead; source: string }[] = []
      const stop = () => { settled = true; if (timer) clearTimeout(timer); if (poke) clearInterval(poke); wc.off('paint', onPaint) }
      /** Paint frames cover the whole viewport, which may carry OS-snapping slack beyond the 1280×720
       *  box; crop them to the box (a `capturePage` with the box rect already is the box). */
      const asFrame = (img: NativeImage, wholeViewport: boolean): Frame | null => {
        const s = img.getSize()
        let f: Frame = { bmp: img.toBitmap(), width: s.width, height: s.height }
        if (wholeViewport && page?.viewport) f = cropToBox(f, page.viewport)
        if (!frameScale(f.width, f.height)) return null
        return f
      }
      /** True when the image is a frame carrying our stamp (then resolved). */
      const consider = (img: NativeImage, source: string): boolean => {
        if (settled) return false
        const f = asFrame(img, source === 'paint')
        if (!f) { log(`render ${renderId}: ${source} ${img.getSize().width}x${img.getSize().height} — not a frame of the template`); return false }
        const st = readStamp(f)
        log(`render ${renderId}: ${source} ${f.width}x${f.height} stamp=${st.id} raw=${JSON.stringify(st.raw)}`)
        recent.push({ frame: f, stamp: st, source })
        if (recent.length > 2) recent.shift()
        if (st.id !== renderId) return false
        stop(); resolve(f); return true
      }
      const onPaint = (_e: unknown, _dirty: unknown, image: NativeImage) => {
        paints++
        try { consider(image, 'paint') } catch (e) { stop(); reject(e) }
      }
      const diagnostics = (): string => {
        const last = recent[recent.length - 1]
        const lastTxt = last ? `last ${last.source} ${last.frame.width}×${last.frame.height}, stamp read ${last.stamp.id}, raw BGRA at the two sample points ${JSON.stringify(last.stamp.raw)}` : 'no frame of the template arrived'
        return `${paints} paints; ${lastTxt}; ${this.environment(win)}; ${describePage(page)}`
      }
      timer = setTimeout(() => {
        if (settled) return
        // Last resort: an explicit capture, still only accepted with the right stamp…
        wc.capturePage({ x: 0, y: 0, ...FRAME }).then((img) => {
          if (settled) return
          try {
            if (consider(img, 'capturePage')) return
            // …or, failing that, a frame that is stable (last two paints identical) and new.
            const [a, b] = recent
            if (a && b && a.frame.width === b.frame.width && a.frame.height === b.frame.height && Buffer.compare(a.frame.bmp, b.frame.bmp) === 0) {
              const h = sha1(b.frame.bmp)
              if (h !== before && h !== this.lastAccepted) {
                warnings.push('Render stamp not readable on this machine — frame accepted because it is stable and new.')
                log(`render ${renderId}: stamp fallback used (${diagnostics()})`)
                stop(); resolve(b.frame); return
              }
              log(`render ${renderId}: stable frame refused — it is ${h === before ? 'what the window showed before this render' : "the previous render's frame"}`)
            }
            stop(); reject(new Error(`Render ${renderId}: no frame with the current content after ${timeoutMs}ms — refusing to use a stale frame (${diagnostics()})`))
          } catch (e) { stop(); reject(e) }
        }, (e) => { stop(); reject(e) })
      }, timeoutMs)
      log(`render ${renderId}: waiting for stamped frame`)
      wc.on('paint', onPaint)              // listener first, then force repaints until one carries our stamp
      poke = setInterval(() => { if (!settled) wc.invalidate() }, 100)
      wc.invalidate()
    })
    this.lastAccepted = sha1(raw.bmp)
    scrubStamp(raw)
    let frame = nativeImage.createFromBitmap(Buffer.from(raw.bmp.buffer, raw.bmp.byteOffset, raw.bmp.byteLength), { width: raw.width, height: raw.height })
    if (raw.width !== FRAME.width || raw.height !== FRAME.height) {
      log(`render ${renderId}: frame ${raw.width}×${raw.height} downscaled to ${FRAME.width}×${FRAME.height}`)
      frame = nativeImage.createFromBuffer(frame.toPNG()).resize({ ...FRAME, quality: 'best' })
    }
    return { frame, warnings }
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
