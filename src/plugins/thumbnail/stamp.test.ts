import { describe, expect, it } from 'vitest'
import {
  decodeChannels, frameScale, MAX_ID, pageOk, readStamp, scrubStamp, stampChannels, stampColours, stampSample, TEMPLATE,
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
  })

  it('checks the page layout as authored', () => {
    const good: PageMeasure = { innerWidth: 1280, innerHeight: 720, devicePixelRatio: 1.5, stamp: { left: 1268, top: 714, right: 1280, bottom: 720 } }
    expect(pageOk(good)).toBe(true)
    expect(pageOk({ ...good, devicePixelRatio: 1.875 })).toBe(true)          // 125 % Windows scaling is fine
    expect(pageOk({ ...good, innerWidth: 1920, innerHeight: 1080 })).toBe(false) // zoom lost
    expect(pageOk({ ...good, stamp: { ...good.stamp, right: 1263, left: 1251 } })).toBe(false) // scrollbar
    expect(pageOk(undefined)).toBe(false)
  })
})
