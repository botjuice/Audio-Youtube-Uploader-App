/**
 * Render-id stamp: pure pixel maths, no Electron, unit-tested.
 *
 * Every render paints its id into two 6×6 template-px blocks at the bottom-right corner of the
 * template: the id's colour, then its complement. A captured frame is trusted only when both
 * decode and agree, which rules out the black of an empty window and any uniform photo region.
 *
 * Encoding: 2 bits per channel at levels {0, 85, 170, 255} (63 usable ids; 0 is reserved because
 * black is also "no stamp"). Levels are 85 apart, so GPU output ranges, colour management or
 * dithering that shift a channel by up to ±40 still decode to the right level.
 */

export const TEMPLATE = { width: 1280, height: 720 } as const
/** One block, template px. */
export const STAMP_BLOCK = 6
/** Whole stamp (two blocks side by side), template px. */
export const STAMP_W = STAMP_BLOCK * 2
export const STAMP_H = STAMP_BLOCK
export const LEVELS = [0, 85, 170, 255] as const
export const STAMP_TOLERANCE = 40
export const MAX_ID = 63

/** r, g, b levels for an id (2 bits each, r lowest). */
export function stampChannels(id: number): [number, number, number] {
  return [LEVELS[id & 3]!, LEVELS[(id >> 2) & 3]!, LEVELS[(id >> 4) & 3]!]
}

/** CSS colours for the two blocks of an id. */
export function stampColours(id: number): { main: string; inverse: string } {
  if (!Number.isInteger(id) || id < 1 || id > MAX_ID) throw new Error(`stamp id out of range: ${id}`)
  const css = (c: [number, number, number]) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`
  return { main: css(stampChannels(id)), inverse: css(stampChannels(MAX_ID ^ id)) }
}

/** Nearest level index for a channel value, or -1 when it is further than the tolerance from every level. */
export function decodeLevel(v: number): number {
  let best = -1, dist = Infinity
  LEVELS.forEach((l, i) => { const d = Math.abs(v - l); if (d < dist) { dist = d; best = i } })
  return dist <= STAMP_TOLERANCE ? best : -1
}

/** Id encoded by an r, g, b triple, or -1. */
export function decodeChannels(r: number, g: number, b: number): number {
  const lr = decodeLevel(r), lg = decodeLevel(g), lb = decodeLevel(b)
  if (lr < 0 || lg < 0 || lb < 0) return -1
  return lr | (lg << 2) | (lb << 4)
}

/** A BGRA bitmap of a captured frame, at any scale of the 16:9 template. */
export interface Frame { bmp: Uint8Array; width: number; height: number }

/** The output frame; a box frame with fewer pixels than this (zoom lost) is not accepted. */
export const FRAME_MIN = { width: 1920, height: 1080 } as const

/** Scale of a frame relative to the template (frame px per template px), or null if the frame is
 *  not a 16:9 picture of it at 1080p or better. The hidden window is 1920×1080 DIP, but Windows
 *  display scaling can hand back 2400×1350 or 2880×1620 — those are still the same picture. */
export function frameScale(width: number, height: number): number | null {
  if (width < FRAME_MIN.width || height < FRAME_MIN.height) return null
  const sx = width / TEMPLATE.width, sy = height / TEMPLATE.height
  return Math.abs(sx - sy) * TEMPLATE.height <= 2 ? sx : null
}

/** Frame-px centre of block 0 (id) or 1 (inverse). */
export function stampSample(width: number, height: number, which: 0 | 1): { x: number; y: number } {
  const sx = width / TEMPLATE.width, sy = height / TEMPLATE.height
  const fromRight = STAMP_W - which * STAMP_BLOCK - STAMP_BLOCK / 2   // 9 or 3 template px
  return { x: Math.min(width - 1, Math.floor(width - fromRight * sx)), y: Math.min(height - 1, Math.floor(height - (STAMP_H / 2) * sy)) }
}

export interface StampRead {
  /** Decoded id, or -1 when the two blocks do not carry a consistent id. */
  id: number
  /** Raw [b, g, r, a] at the two sample points — for diagnostics. */
  raw: [number[], number[]]
}

/** Decode the stamp of a frame. */
export function readStamp(f: Frame): StampRead {
  const px = (which: 0 | 1): number[] => {
    const { x, y } = stampSample(f.width, f.height, which)
    const i = (y * f.width + x) * 4
    return [f.bmp[i]!, f.bmp[i + 1]!, f.bmp[i + 2]!, f.bmp[i + 3]!]
  }
  const a = px(0), b = px(1)
  const main = decodeChannels(a[2]!, a[1]!, a[0]!)
  const inverse = decodeChannels(b[2]!, b[1]!, b[0]!)
  const ok = main >= 1 && inverse >= 0 && inverse === (MAX_ID ^ main)
  return { id: ok ? main : -1, raw: [a, b] }
}

/** Copy the pixels just left of the stamp over it (in place) so no trace is left in the output.
 *  Covers one extra frame px on each side for anti-aliasing at non-integer scales. */
export function scrubStamp(f: Frame): Frame {
  const sx = f.width / TEMPLATE.width, sy = f.height / TEMPLATE.height
  const w = Math.min(f.width - 2, Math.ceil(STAMP_W * sx) + 1), h = Math.min(f.height - 1, Math.ceil(STAMP_H * sy) + 1)
  const x0 = f.width - w, srcX = x0 - 1
  const bmp = f.bmp
  for (let y = f.height - h; y < f.height; y++) {
    const src = (y * f.width + srcX) * 4
    for (let x = x0; x < f.width; x++) {
      const dst = (y * f.width + x) * 4
      bmp[dst] = bmp[src]!; bmp[dst + 1] = bmp[src + 1]!; bmp[dst + 2] = bmp[src + 2]!; bmp[dst + 3] = bmp[src + 3]!
    }
  }
  return f
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/** What the template reports about its own viewport after a render. */
export interface PageMeasure {
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number
  stamp: Rect
  /** The fixed 1280×720 picture box (`#thumb`), CSS px. Older templates did not report it. */
  box?: Rect
  /** Exact viewport size in CSS px (`visualViewport`), fractional under OS pixel snapping. */
  viewport?: { width: number; height: number }
}

/** How much wider/taller than 1280×720 the viewport may be before it is worth a warning. Windows snaps
 *  the client area to whole physical pixels, so 1281×721 CSS px at 125 % scaling is normal. */
export const VIEWPORT_SLACK = 4
/** Beyond this the viewport is not snapping slack but a lost zoom or a resized window (1920×1080 or
 *  1067×600 CSS px): the box would not have its 1080p pixels, so the render is refused. */
export const VIEWPORT_SLACK_MAX = 40

/** 'ok': laid out as authored. 'slack': the picture box and stamp are exactly where they belong but the
 *  viewport carries more slack than usual — render, with a warning. 'bad': the picture itself moved or is
 *  cut off (zoom lost: 1920×1080 or 1067×600 viewports; a scrollbar; a shifted box).
 *  `devicePixelRatio` is not checked: it is zoom × display scale on some platforms and zoom alone on
 *  others. */
export function pageVerdict(p: PageMeasure | undefined): 'ok' | 'slack' | 'bad' {
  if (!p) return 'bad'
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5
  const s = p.stamp
  const stampOk = near(s.right, TEMPLATE.width) && near(s.bottom, TEMPLATE.height) && near(s.right - s.left, STAMP_W) && near(s.bottom - s.top, STAMP_H)
  const b = p.box
  const boxOk = !b || (near(b.left, 0) && near(b.top, 0) && near(b.right, TEMPLATE.width) && near(b.bottom, TEMPLATE.height))
  // The viewport must hold the whole box, else the capture cuts the picture.
  const over = Math.max(p.innerWidth - TEMPLATE.width, p.innerHeight - TEMPLATE.height)
  if (!stampOk || !boxOk || p.innerWidth < TEMPLATE.width || p.innerHeight < TEMPLATE.height || over > VIEWPORT_SLACK_MAX) return 'bad'
  return over <= VIEWPORT_SLACK ? 'ok' : 'slack'
}

/** True when the render can go ahead (verdict 'ok' or 'slack'). */
export const pageOk = (p: PageMeasure | undefined): boolean => pageVerdict(p) !== 'bad'

export function describePage(p: PageMeasure | undefined): string {
  if (!p) return 'page: not measured'
  const r = (x: Rect) => `${x.left},${x.top}→${x.right},${x.bottom}`
  const vp = p.viewport ? ` (exact ${p.viewport.width}×${p.viewport.height})` : ''
  return `page ${p.innerWidth}×${p.innerHeight} css px${vp}, devicePixelRatio ${p.devicePixelRatio}, box rect ${p.box ? r(p.box) : 'n/a'}, stamp rect ${r(p.stamp)} (want viewport ≥ 1280×720, box 0,0→1280,720, stamp ending at 1280,720)`
}

/** Crop a full-viewport frame to the picture box. The box is the top-left 1280×720 CSS px of a viewport
 *  `viewportCss` wide/high (fractional under OS snapping, e.g. 1281.333×721 → a 2402×1351 frame at
 *  1.875 px per CSS px holds a 2400×1350 box). A frame already the size of the box is returned as is. */
export function cropToBox(f: Frame, viewportCss: { width: number; height: number }): Frame {
  const k = f.width / viewportCss.width
  const w = Math.min(f.width, Math.round(TEMPLATE.width * k)), h = Math.min(f.height, Math.round(TEMPLATE.height * k))
  if (w === f.width && h === f.height) return f
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) out.set(f.bmp.subarray(y * f.width * 4, (y * f.width + w) * 4), y * w * 4)
  return { bmp: out, width: w, height: h }
}
