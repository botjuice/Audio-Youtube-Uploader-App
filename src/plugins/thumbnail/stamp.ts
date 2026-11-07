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

/** Scale of a frame relative to the template (frame px per template px), or null if the frame is
 *  not a 16:9 picture of it. The hidden window is 1920×1080 DIP, but Windows display scaling can
 *  hand back 2400×1350 or 2880×1620 — those are still the same picture. */
export function frameScale(width: number, height: number): number | null {
  if (width < TEMPLATE.width || height < TEMPLATE.height) return null
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

/** What the template reports about its own viewport after a render. */
export interface PageMeasure {
  innerWidth: number
  innerHeight: number
  devicePixelRatio: number
  stamp: { left: number; top: number; right: number; bottom: number }
}

/** True when the page is laid out as authored: a 1280×720 CSS-px viewport (1920×1080 DIP at zoom
 *  1.5) with the stamp ending exactly at the bottom-right corner. `devicePixelRatio` is not checked:
 *  it is zoom × display scale, so 1.875 under 125 % Windows scaling is legitimate (frames then
 *  arrive at 2400×1350 and are downscaled). */
export function pageOk(p: PageMeasure | undefined): boolean {
  if (!p) return false
  const near = (a: number, b: number) => Math.abs(a - b) < 0.5
  return p.innerWidth === TEMPLATE.width && p.innerHeight === TEMPLATE.height
    && near(p.stamp.right, TEMPLATE.width) && near(p.stamp.bottom, TEMPLATE.height)
    && near(p.stamp.right - p.stamp.left, STAMP_W) && near(p.stamp.bottom - p.stamp.top, STAMP_H)
}

export function describePage(p: PageMeasure | undefined): string {
  if (!p) return 'page: not measured'
  const s = p.stamp
  return `page ${p.innerWidth}×${p.innerHeight} css px, devicePixelRatio ${p.devicePixelRatio}, stamp rect ${s.left},${s.top}→${s.right},${s.bottom} (want 1280×720, stamp ending at 1280,720)`
}
