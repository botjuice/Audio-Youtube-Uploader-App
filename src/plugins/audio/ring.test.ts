import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { describe, expect, it } from 'vitest'
import { analyseRing, chooseSplit, findBursts, multiBandLevels, SPLIT_EDGES } from './ring'

/** 10 ms levels of a band: room at `room` dBFS, an "s" of `len` frames at `burst` every 6 s, and after each a leftover
 *  that starts `ring` dB over the room and dies away with the given half-time. */
function band({ room = -56, burst = -36, len = 14, ring = 5, halfMs = 400, seconds = 120 }: { room?: number; burst?: number; len?: number; ring?: number; halfMs?: number; seconds?: number }): Float32Array {
  const env = new Float32Array(seconds * 100).fill(room)
  for (let s = 200; s + 600 < env.length; s += 600) {
    for (let k = 0; k < len; k++) env[s + k] = burst
    for (let k = 0; k < 300; k++) { const over = ring * Math.pow(0.5, (k * 10) / halfMs); env[s + len + k] = room + over }
  }
  return env
}

describe('ring detection', () => {
  it('finds the bursts, how long they last and how loud they are', () => {
    const env = band({})
    const f = findBursts(env)
    expect(f.ambientDb).toBeCloseTo(-56, 0)
    expect(f.bursts.length).toBe(19)
    const r = analyseRing(env, 4500)!
    expect(r.bursts).toBe(19)
    expect(r.burstMs).toBe(140)
    expect(r.burstDb).toBeCloseTo(-36, 0)
    expect(r.perMin).toBeCloseTo(9.5, 0)
  })
  it('measures how far the band stays above the room after a burst, and how fast that dies away', () => {
    const r = analyseRing(band({ ring: 6, halfMs: 400 }), 4500)!
    const at = (ms: number) => r.excessDb[r.offsets.indexOf(ms)]!
    expect(at(100)).toBeGreaterThan(4.5)
    expect(at(100)).toBeLessThan(5.6)       // 6 dB halved every 400 ms → about 5 at 100 ms
    expect(at(1500)).toBeLessThan(0.6)
    expect(r.halfMs).toBeGreaterThanOrEqual(400)
    expect(r.halfMs).toBeLessThanOrEqual(700)
    const dry = analyseRing(band({ ring: 0 }), 4500)!
    expect(Math.abs(dry.ringDb)).toBeLessThan(0.3)
  })
  it('gives the same ring for a quiet and a loud copy, with the levels moved', () => {
    const a = analyseRing(band({}), 4500)!, b = analyseRing(band({ room: -66, burst: -46 }), 4500)!
    expect(b.burstDb).toBeCloseTo(a.burstDb - 10, 0)
    expect(b.excessDb).toEqual(a.excessDb)
  })
  it('says nothing about a recording that is too short or has too few bursts', () => {
    expect(analyseRing(new Float32Array(2000).fill(-50), 4500)).toBeNull()
    const few = analyseRing(band({ seconds: 31 }), 4500)!
    expect(few.burstMs).toBe(0)
    expect(few.bursts).toBeLessThan(8)
  })
  it('finds where the ring starts: the lowest band that rings, going down from the strongest without a gap', () => {
    // bands from 3000 / 3750 / 4500 / 5500 / 7000: an "s" shows in the top three, the ring in whichever are given one
    const make = (rings: number[]) => SPLIT_EDGES.map((_, k) => band({ burst: k >= 2 ? -36 : -56, ring: rings[k]! }))
    expect(chooseSplit(make([0, 0.5, 5, 5, 4])).splitHz).toBe(4500)
    expect(chooseSplit(make([0, 4, 6, 5, 4])).splitHz).toBe(3750)
    expect(chooseSplit(make([0, 0, 1, 5, 4])).splitHz).toBe(5500)
    expect(chooseSplit(make([4, 0, 1, 5, 4])).splitHz).toBe(5500)      // a ringing band below a gap is not joined on
    const none = chooseSplit(make([0, 0, 0.5, 0.8, 0.5]))
    expect(none.splitHz).toBe(4500)                                     // nothing rings: the usual split
    expect(none.bands.map((b) => b.fromHz)).toEqual(SPLIT_EDGES)
  })
  it('splits a file into the bands in order (a tone lands in the band it belongs to)', async () => {
    const bin = ffmpegStatic as unknown as string, dir = mkdtempSync(join(tmpdir(), 'yj-ring-'))
    try {
      for (const [hz, want] of [[3300, 0], [5000, 2], [9000, 4]] as const) {
        const f = join(dir, `${hz}.wav`)
        execFileSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=f=${hz}:r=48000:d=2`, f])
        const bands = await multiBandLevels(bin, f)
        expect(bands).toHaveLength(SPLIT_EDGES.length)
        const at = bands.map((e) => e[100]!)
        expect(at.indexOf(Math.max(...at)), `${hz} Hz`).toBe(want)
      }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  }, 30_000)
})
