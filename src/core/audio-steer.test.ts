import { describe, expect, it } from 'vitest'
import { validateLook } from '../plugins/audio/look'
import { MEASURE_BANDS, MEASURE_VERSION, type Measure, type RingMeasure } from '../plugins/audio/types'
import { defaultModules, toLook, type EqState } from './audio-modules'
import { builtInDefaultTarget } from './audio-rules'
import { fitEq, noFeedback, refine, report, ringLeftover, setLoudness, staticOver, steer, steerTone, tamerFor, type AudioTarget } from './audio-steer'
import { eqResponseDb } from './eq-response'

/** A clear voice: level body up to 500 Hz, falling 5.5 dB per octave above it and steeply below 160 Hz. */
const baseTone = MEASURE_BANDS.map((f) => -8 - (f > 500 ? 5.5 * Math.log2(f / 500) : 0) - (f < 160 ? 20 * Math.log2(160 / f) : 0))
const rec = (over: Partial<Measure> = {}, tone = baseTone): Measure => ({
  v: MEASURE_VERSION, durationSec: 300, voiceDb: -18, activeShare: 0.9, tone, quiet: tone.map((t) => t - 25), floorDb: -12,
  levels: { p10: -6, p50: -0.6, p90: 2.8, p95: 3.6, p99: 5 }, peakDb: 15, sibilance: -28, ...over,
})

describe('fitting the EQ', () => {
  it('fits a known curve closely, with bells at least half an octave apart', () => {
    const d = defaultModules().eq
    const known: EqState = { ...d, on: true, ls: { on: true, freq: 180, gain: -3, q: 0.7 }, bands: [{ on: true, freq: 500, gain: 4, q: 1.2 }, { on: true, freq: 3000, gain: -3, q: 1 }, d.bands[2]!, d.bands[3]!] }
    const fit = fitEq(d, MEASURE_BANDS.map((f) => (f >= 100 && f <= 10000 ? eqResponseDb(known, f) : 0)))
    expect(fit.rms).toBeLessThan(0.5)
    const on = fit.eq.bands.filter((b) => b.on).map((b) => b.freq)
    for (let i = 1; i < on.length; i++) expect(on[i]! / on[i - 1]!).toBeGreaterThanOrEqual(1.41)
  })

})

const ringOf = (over: Partial<RingMeasure> = {}): RingMeasure => ({
  v: 1, splitHz: 4500, ambientDb: -56, bursts: 60, perMin: 9, burstMs: 130, burstLongMs: 210, burstDb: -39,
  offsets: [50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500], excessDb: [6, 5, 4, 3.5, 3, 2.5, 2, 0.5, -0.5, -2], ringDb: 3.2, halfMs: 700, slope: 0.6, zeroDb: -45, ...over,
})

describe('spring tamer from the ring found', () => {
  it('ducks as deep as the ring stands out, after a typical “s”, and moves with the recording’s level', () => {
    const t = tamerFor(ringOf()).spring
    // ring 4.5 dB at 100–150 ms → threshold = burst level + 1.5 − 4.5 / 0.6
    expect(t).toEqual({ on: true, split: 4500, ratio: 2.5, threshold: -45, delay: 130, attack: 70, release: 900 })
    expect(tamerFor(ringOf({ burstDb: -29 })).spring.threshold).toBe(-35)      // the same recording 10 dB louder
    expect(tamerFor(ringOf({ burstMs: 40 })).spring.delay).toBe(100)           // never so early that an “s” is caught
  })
  it('takes the split from where the ring was found, and the ratio from how the ring grows with a louder “s”', () => {
    expect(tamerFor(ringOf({ splitHz: 5500 })).spring.split).toBe(5500)
    // a louder “s” rings 0.5 dB more per dB → 2:1, and the threshold moves so a typical “s” is still ducked 4.5 dB
    expect(tamerFor(ringOf({ slope: 0.5 })).spring).toMatchObject({ ratio: 2, threshold: -46.5 })
    expect(tamerFor(ringOf({ slope: 0.3 })).spring.ratio).toBe(1.7)             // never gentler than 1.7:1 …
    expect(tamerFor(ringOf({ slope: 1.4 })).spring.ratio).toBe(3.3)             // … or firmer than 3.3:1
    expect(tamerFor(ringOf({ slope: 0.05 })).spring.ratio).toBe(2.5)            // no real relation found: the usual ratio
    const t = tamerFor(ringOf({ bands: [{ fromHz: 3000, toHz: 3750, excessDb: 0.1 }, { fromHz: 4500, toHz: null, excessDb: 4.4 }] }))
    expect(t.text).toMatch(/looked between 3 kHz and 4.5 kHz/)
  })
  it('caps the depth and stays off when nothing rings or too little was found', () => {
    const deep = tamerFor(ringOf({ excessDb: [15, 14, 12, 10, 9, 8, 7, 4, 2, 0] })).spring
    expect(deep.threshold).toBe(round1(-39 + 1.5 - 8 / 0.6))
    expect(tamerFor(ringOf({ excessDb: [3, 1.2, 0.8, 0.5, 0, 0, 0, 0, 0, 0] })).spring.on).toBe(false)
    expect(tamerFor(ringOf({ burstMs: 0 })).spring.on).toBe(false)
    expect(tamerFor(null).spring.on).toBe(false)
  })
})
const round1 = (x: number) => Math.round(x * 2) / 2

describe('steering to the target sound', () => {
  const quietOf = (tone: number[]) => tone.map((t) => t - 25)
  const base = defaultModules(); base.eq = { ...base.eq, on: true, hp: { on: true, freq: 80, q: 0.707 } }; base.level = { on: true, lufs: -16.3, ceiling: -1 }
  const target: AudioTarget = { count: 5, hp: 80, tone: baseTone, over: 4.7, quiet: quietOf(baseTone), ring: 0.8, lufs: -16.3, base, baseVoiceDb: -18, baseTypicalDb: -18.6, measureVersion: MEASURE_VERSION, capturedAt: '2026-11-14T00:00:00.000Z' }
  const on = (m: ReturnType<typeof steer>['modules']) => (['gain', 'nr', 'gate', 'spring', 'comp', 'deess', 'echo', 'reverb', 'limiter'] as const).filter((k) => m[k].on)

  it('gives a recording that already matches only the high-pass and levelling: every module is off unless measured to be needed', () => {
    const s = steer(defaultModules(), rec({ levels: { p10: -5, p50: -0.5, p90: 2.5, p95: 3.2, p99: 4.2 } }), target, null)
    expect(s.modules.eq.hp).toEqual({ on: true, freq: 80, q: 0.707 })
    expect([s.modules.eq.ls, s.modules.eq.hs, ...s.modules.eq.bands].some((x) => x.on)).toBe(false)
    expect(on(s.modules)).toEqual([])
    expect(s.modules.level).toEqual({ on: true, lufs: -16.3, ceiling: -1 })
    for (const k of ['gain', 'nr', 'gate', 'eq', 'comp', 'deess', 'echo', 'reverb', 'limiter', 'spring'] as const) expect(s.notes.some((n) => n.module === k), k).toBe(true)
  })
  it('lifts a muffled recording and cuts a boomy one, by what each is off', () => {
    const muffled = baseTone.map((t, b) => t - (MEASURE_BANDS[b]! >= 2000 ? 6 : 0))
    const a = steer(defaultModules(), rec({ quiet: quietOf(muffled) }, muffled), target)
    expect(eqResponseDb(a.modules.eq, 5000)).toBeGreaterThan(4.5)
    expect(eqResponseDb(a.modules.eq, 5000)).toBeLessThan(7)
    expect(Math.abs(eqResponseDb(a.modules.eq, 400))).toBeLessThan(1.2)
    const boomy = baseTone.map((t, b) => t + (MEASURE_BANDS[b]! <= 315 ? 5 : 0))
    const c = steer(defaultModules(), rec({}, boomy), target)
    expect(eqResponseDb(c.modules.eq, 200)).toBeLessThan(-3)
    expect(Math.abs(eqResponseDb(c.modules.eq, 3000))).toBeLessThan(1.2)
  })
  it('ignores a difference in one narrow band, a louder copy, and never asks more than 9 dB', () => {
    const narrow = baseTone.map((t, b) => t + (MEASURE_BANDS[b] === 1000 ? 4 : 0))
    expect(steerTone(rec({}, narrow), target).every((v) => Math.abs(v) < 2)).toBe(true)
    expect(steerTone(rec({ voiceDb: -8 }), target).every((v) => v === 0)).toBe(true)
    const veryDark = baseTone.map((t, b) => t - (MEASURE_BANDS[b]! >= 1600 ? 25 : 0))
    expect(Math.max(...steerTone(rec({ quiet: quietOf(veryDark) }, veryDark), target).map(Math.abs))).toBeLessThanOrEqual(9)
  })
  it('compressor: off when the level is already as even as the best recordings, firmer the more it jumps', () => {
    expect(steer(defaultModules(), rec({ levels: { p10: -5, p50: -0.5, p90: 2.5, p95: 3.2, p99: 4.3 } }), target).modules.comp.on).toBe(false)
    const mild = steer(defaultModules(), rec({ voiceDb: -20, levels: { p10: -6, p50: -1, p90: 3, p95: 4, p99: 5 } }), target)
    expect(mild.modules.comp).toMatchObject({ on: true, threshold: -21, ratio: 1.35 })
    expect(steer(defaultModules(), rec({ levels: { p10: -9, p50: -1, p90: 5, p95: 7, p99: 9 } }), target).modules.comp.ratio).toBe(2.25)
  })
  it('static: left alone when slight, otherwise part is avoided by lifting less and the rest removed', () => {
    const noisy = (extra: number) => rec({ quiet: quietOf(baseTone).map((q, b) => q + (MEASURE_BANDS[b]! >= 5000 ? extra : 0)) })
    expect(staticOver(noisy(0), target)).toBeCloseTo(0, 5)
    expect(staticOver(noisy(6), target)).toBeCloseTo(6, 5)
    expect(steer(defaultModules(), noisy(2), target).modules.nr.on).toBe(false)
    const s = steer(defaultModules(), noisy(8), target)
    expect(s.modules.nr).toMatchObject({ on: true, reduction: 5 })          // 8 dB: 3 held back, 5 removed
    expect(s.modules.nr.floor).toBeGreaterThanOrEqual(-80)
    // the recording is also muffled: its lift above 2 kHz is 3 dB short of the full one
    const muffled = baseTone.map((t, b) => t - (MEASURE_BANDS[b]! >= 2000 ? 6 : 0))
    const both = steer(defaultModules(), rec({ quiet: quietOf(muffled).map((q, b) => q + (MEASURE_BANDS[b]! >= 5000 ? 8 : 0)) }, muffled), target)
    expect(both.held[MEASURE_BANDS.indexOf(5000)]).toBe(3)
    expect(eqResponseDb(both.modules.eq, 5000)).toBeLessThan(4.2)
    expect(eqResponseDb(both.modules.eq, 5000)).toBeGreaterThan(1.5)
  })
  it('loudness: the rule’s, or as close under it as the peaks allow without the limiter', () => {
    const m = defaultModules()
    expect(setLoudness(m, target, -20.4, { lufs: -19, peak: -6 })).toMatch(/loudness of the rule’s recordings/)
    expect(m.level).toEqual({ on: true, lufs: -16.3, ceiling: -1 })
    // a peaky recording: +2.7 dB would put its −2 dBTP peak over the ceiling, so it stops where the peak reaches −1.3
    expect(setLoudness(m, target, -20.4, { lufs: -19, peak: -2 })).toMatch(/as close/)
    expect(m.level.lufs).toBe(-18.3)
  })
  it('checking a result: what is still off is fed back, and nothing when it is on target', () => {
    const muffled = baseTone.map((t, b) => t - (MEASURE_BANDS[b]! >= 2000 ? 6 : 0))
    const before = rec({ quiet: quietOf(muffled), levels: { p10: -9, p50: -1, p90: 5, p95: 7, p99: 9 } }, muffled)
    const s = steer(defaultModules(), before, target)
    const good = rec({ levels: { p10: -5, p50: -0.5, p90: 2.5, p95: 3.2, p99: 4.2 } })
    expect(refine(noFeedback(), s, before, good, target)).toBeNull()
    // the result came out 4 dB short above 2 kHz and still too jumpy
    const short = rec({ levels: { p10: -6, p50: -0.5, p90: 3.5, p95: 4.5, p99: 5.7 } }, baseTone.map((t, b) => t - (MEASURE_BANDS[b]! >= 2000 ? 4 : 0)))
    const fb = refine(noFeedback(), s, before, short, target)!
    expect(fb.tone[MEASURE_BANDS.indexOf(5000)]).toBeGreaterThan(2.5)
    expect(fb.comp).toBeGreaterThan(1.1)
    const again = steer(defaultModules(), before, target, null, fb)
    expect(eqResponseDb(again.modules.eq, 5000)).toBeGreaterThan(eqResponseDb(s.modules.eq, 5000) + 1)
    expect(again.modules.comp.ratio).toBeGreaterThan(s.modules.comp.ratio)
    const rows = report(before, good, target, s)
    expect(rows.map((r) => r.ok)).toEqual([true, true, true])
    expect(report(before, short, target, s)[0]!.ok).toBe(false)
  })
  it('the default rule that ships with the app is usable and the plugin accepts what it gives', () => {
    const t = builtInDefaultTarget()!
    expect(t.count).toBe(5)
    expect(t.tone).toHaveLength(MEASURE_BANDS.length)
    expect(t.quiet).toHaveLength(MEASURE_BANDS.length)
    expect(t.hp).toBe(80)
    expect(t.lufs).toBeLessThan(-10)
    const s = steer(defaultModules(), rec(), t, ringOf())
    for (const k of ['gain', 'nr', 'gate', 'eq', 'comp', 'deess', 'echo', 'reverb', 'limiter', 'spring'] as const) expect(s.notes.some((n) => n.module === k), k).toBe(true)
    expect(s.modules.reverb.on).toBe(false)
    const v = validateLook(toLook(s.modules))
    expect(v.ok, v.ok ? '' : JSON.stringify(v.errors)).toBe(true)
  })
})
