import { describe, expect, it } from 'vitest'
import {
  cropToBox, decodeChannels, frameScale, MAX_ID, pageOk, pageVerdict, readStamp, scrubStamp, stampChannels, stampColours, stampSample, TEMPLATE,
  type Frame, type PageMeasure,
} from './stamp'

/** A black BGRA frame at the given size with the stamp painted as the template would. */
function frameWith(id: number, width: number, height: number, perturb = 0): Frame {
  const bmp = new Uint8Array(width * height * 4)
  const sx = width / TEMPLATE.width, sy = height / TEMPLATE.height
  const paint = (c: [number, number, number], x0: number, x1: number) => {
    for (let y = Math.floor(height - 6 * sy); y < height; y++) for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const i = (y * width + x) * 4
      const clamp = (v: number) => Math.max(0, Math.min(255, v + perturb))
      bmp[i] = clamp(c[2]); bmp[i + 1] = clamp(c[1]); bmp[i + 2] = clamp(c[0]); bmp[i + 3] = 255
    }
  }
  paint(stampChannels(id), width - 12 * sx, width - 6 * sx)
  paint(stampChannels(MAX_ID ^ id), width - 6 * sx, width)
  return { bmp, width, height }
}

describe('stamp encoding', () => {
  it('encodes 63 ids on wide levels and decodes each after ±30 per channel', () => {
    const seen = new Set<string>()
    for (let id = 1; id <= MAX_ID; id++) {
      const { main, inverse } = stampColours(id)
      seen.add(main)
      expect(main).not.toBe(inverse)
      const [r, g, b] = stampChannels(id)
      for (const d of [-30, -15, 0, 15, 30]) {
        const c = (v: number) => Math.max(0, Math.min(255, v + d))
        expect(decodeChannels(c(r), c(g), c(b))).toBe(id)
      }
    }
    expect(seen.size).toBe(MAX_ID)
    expect(() => stampColours(0)).toThrow()
    expect(() => stampColours(64)).toThrow()
  })

  it('rejects values further than the tolerance from every level', () => {
    expect(decodeChannels(42, 0, 0)).toBe(-1)   // halfway between 0 and 85
    expect(decodeChannels(0, 0, 0)).toBe(0)     // black decodes to the reserved id 0
  })

  it('reads the id from frames at 1080p and under Windows display scaling, with perturbation', () => {
    for (const [w, h] of [[1920, 1080], [2400, 1350], [2880, 1620], [3360, 1890]] as const) {
      for (const id of [1, 2, 21, 42, 63]) {
        for (const p of [-30, 0, 30]) expect(readStamp(frameWith(id, w, h, p)).id, `${w}x${h} id ${id} ±${p}`).toBe(id)
      }
    }
  })

  it('refuses black, a uniform region, and a stamp whose complement block is wrong', () => {
    const black: Frame = { bmp: new Uint8Array(1920 * 1080 * 4), width: 1920, height: 1080 }
    expect(readStamp(black).id).toBe(-1)
    const f = frameWith(5, 1920, 1080)
    const b = stampSample(1920, 1080, 1)
    const i = (b.y * 1920 + b.x) * 4
    f.bmp[i] = f.bmp[i + 1] = f.bmp[i + 2] = 0  // inverse block black → mismatch
    expect(readStamp(f).id).toBe(-1)
    // a uniform (photo-like) region decodes to some id in both blocks but never a complementary pair
    const grey: Frame = { bmp: new Uint8Array(1920 * 1080 * 4).fill(170), width: 1920, height: 1080 }
    expect(readStamp(grey).id).toBe(-1)
  })

  it('scrubs the stamp with the pixels to its left', () => {
    const f = frameWith(9, 1920, 1080)
    f.bmp.fill(200, 0, f.bmp.length)  // uniform picture…
    const g = frameWith(9, 1920, 1080)
    for (let i = 0; i < f.bmp.length; i++) if (g.bmp[i] !== 0) f.bmp[i] = g.bmp[i]!  // …with the stamp on top
    scrubStamp(f)
    expect(f.bmp.every((v) => v === 200)).toBe(true)
  })

  it('accepts 16:9 frames at any scale and rejects others', () => {
    expect(frameScale(1920, 1080)).toBe(1.5)   // frame px per template px
    expect(frameScale(2400, 1350)).toBe(1.875)
    expect(frameScale(1920, 1000)).toBeNull()
    expect(frameScale(640, 360)).toBeNull()
    expect(frameScale(1280, 720)).toBeNull()   // a box captured at zoom 1.0 has too few pixels
  })

  it('checks the page layout as authored', () => {
    const box = { left: 0, top: 0, right: 1280, bottom: 720 }
    const good: PageMeasure = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1.5, stamp: { left: 1268, top: 714, right: 1280, bottom: 720 }, box }
    expect(pageOk(good)).toBe(true)
    expect(pageVerdict(good)).toBe('ok')
    expect(pageOk({ ...good, devicePixelRatio: 1.875 })).toBe(true)          // 125 % Windows scaling is fine
    // Windows 125 %: the viewport snaps to 1281×721 CSS px; with the box pinned the stamp still ends at 1280,720
    expect(pageVerdict({ ...good, innerWidth: 1281, innerHeight: 721 })).toBe('ok')
    // …but if the stamp followed the viewport (the 1.4.0 template, RTL block hugging the right edge) it is wrong
    expect(pageOk({ ...good, innerWidth: 1281, innerHeight: 721, stamp: { left: 1269.333, top: 714, right: 1281.333, bottom: 720 }, box: { ...box, left: 1.333, right: 1281.333 } })).toBe(false)
    expect(pageOk({ ...good, innerWidth: 1920, innerHeight: 1080 })).toBe(false) // zoom lost on the 1920 window: far beyond snapping slack
    expect(pageOk({ ...good, innerWidth: 1067, innerHeight: 600 })).toBe(false) // zoom lost on a 1600 window: box cut off
    expect(pageOk({ ...good, stamp: { ...good.stamp, right: 1263, left: 1251 } })).toBe(false) // scrollbar
    expect(pageVerdict({ ...good, innerWidth: 1300, innerHeight: 740 })).toBe('slack') // lots of slack: render with a warning
    expect(pageOk(undefined)).toBe(false)
  })

  it('crops a full-viewport frame to the picture box before reading the stamp', () => {
    // Windows 125 %: 1281.333×721 CSS px viewport → 2402×1351 physical frame; the box is the top-left 2400×1350.
    const vw = 2402, vh = 1351
    const bmp = new Uint8Array(vw * vh * 4).fill(60)
    const boxed = frameWith(17, 2400, 1350)
    for (let y = 0; y < 1350; y++) bmp.set(boxed.bmp.subarray(y * 2400 * 4, (y + 1) * 2400 * 4), y * vw * 4)
    const whole: Frame = { bmp, width: vw, height: vh }
    const cropped = cropToBox(whole, { width: 1281.333, height: 721 })
    expect([cropped.width, cropped.height]).toEqual([2400, 1350])
    expect(readStamp(cropped).id).toBe(17)
    // More slack (1300.27×740.27 CSS px → 2438×1388): the viewport corner misses the stamp; the crop finds it.
    const big = new Uint8Array(2438 * 1388 * 4).fill(60)
    for (let y = 0; y < 1350; y++) big.set(boxed.bmp.subarray(y * 2400 * 4, (y + 1) * 2400 * 4), y * 2438 * 4)
    const bigFrame: Frame = { bmp: big, width: 2438, height: 1388 }
    expect(readStamp(bigFrame).id).toBe(-1)
    const bigCropped = cropToBox(bigFrame, { width: 2438 / 1.875, height: 1388 / 1.875 })
    expect([bigCropped.width, bigCropped.height]).toEqual([2400, 1350])
    expect(readStamp(bigCropped).id).toBe(17)
    const exact = frameWith(3, 1920, 1080)
    expect(cropToBox(exact, { width: 1280, height: 720 })).toBe(exact)  // nothing to crop
  })
})
