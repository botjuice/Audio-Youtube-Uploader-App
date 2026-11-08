import { describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', isPackaged: false }, BrowserWindow: class {}, nativeImage: {} }))
import { bucketPeaks } from './audio'

describe('bucketPeaks', () => {
  it('returns one [min, max] pair per bucket in −1…1, and zeros for no samples', () => {
    const s = new Int16Array([0, 16384, -32768, 8192, 0, 0, 100, -100])
    expect(bucketPeaks(s, 2)).toEqual([-1, 0.5, -100 / 32768, 100 / 32768])
    expect(bucketPeaks(new Int16Array(0), 3)).toEqual([0, 0, 0, 0, 0, 0])
  })
  it('copes with more buckets than samples', () => {
    const out = bucketPeaks(new Int16Array([32767, -32768]), 4)
    expect(out).toHaveLength(8)
    expect(Math.max(...out)).toBeCloseTo(1, 3)
    expect(Math.min(...out)).toBe(-1)
  })
})
