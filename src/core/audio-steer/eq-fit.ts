/** Fitting the strip's EQ (low shelf, four bells, high shelf) to a wanted change per band. */
import { MEASURE_BANDS } from '../../plugins/audio/types'
import { defaultModules, type EqState } from '../audio-modules'
import { eqResponseDb } from '../eq-response'
import { EQ_MAX, FIT_HI, FIT_LO, clamp, round } from './util'

interface FitParam { get: () => number; set: (v: number) => void; lo: number; hi: number; step: number; mul: boolean }

/** Fit the strip's low shelf, bells and high shelf to a per-band target, with as few bells as do the job.
 *  Returns the EQ (high-pass and low-pass untouched) and the error left, dB RMS. */
export function fitEq(base: EqState, target: number[]): { eq: EqState; rms: number } {
  const idx = MEASURE_BANDS.map((f, b) => (f >= FIT_LO && f <= FIT_HI ? b : -1)).filter((b) => b >= 0)
  const d = defaultModules().eq
  const rmsOf = (eq: EqState) => {
    let e = 0
    for (const b of idx) { const x = eqResponseDb(eq, MEASURE_BANDS[b]!) - target[b]!; e += x * x }
    return Math.sqrt(e / idx.length)
  }
  const fitWith = (bells: number): { eq: EqState; rms: number } => {
    const eq: EqState = {
      ...base, on: true, hp: { ...base.hp, on: false }, lp: { ...base.lp, on: false },
      ls: { on: true, freq: 200, gain: 0, q: 0.7 }, hs: { on: true, freq: 4000, gain: 0, q: 0.7 },
      bands: base.bands.map((_, i) => ({ on: i < bells, freq: 1000, gain: 0, q: 1.4 })),
    }
    let active = eq.bands.filter((x) => x.on)
    // squared error, plus a little for every dB of EQ so that two fits about as good resolve to the gentler one
    const error = () => {
      let g = Math.abs(eq.ls.gain) + Math.abs(eq.hs.gain)
      for (const band of active) g += Math.abs(band.gain)
      // two bells on top of each other only fight or stack past the limit: keep them at least half an octave apart
      for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
        const ratio = active[i]!.freq / active[j]!.freq
        if (ratio < 1.41 && ratio > 1 / 1.41) g += 1000
      }
      return rmsOf(eq) ** 2 + 0.02 * g
    }
    const residualAt = (b: number) => target[b]! - eqResponseDb(eq, MEASURE_BANDS[b]!)
    const mean = (bs: number[]) => (bs.length ? bs.reduce((s, b) => s + target[b]!, 0) / bs.length : 0)
    eq.ls.gain = clamp(mean(idx.filter((b) => MEASURE_BANDS[b]! <= 200)), -EQ_MAX, EQ_MAX)
    eq.hs.gain = clamp(mean(idx.filter((b) => MEASURE_BANDS[b]! >= 5000)), -EQ_MAX, EQ_MAX)
    for (const band of active) {
      let worst = idx[0]!
      for (const b of idx) if (Math.abs(residualAt(b)) > Math.abs(residualAt(worst))) worst = b
      band.freq = clamp(MEASURE_BANDS[worst]!, 200, 8000)
      if (active.some((o) => o !== band && o.gain !== 0 && o.freq / band.freq < 1.41 && band.freq / o.freq < 1.41)) { band.on = false; continue }
      band.gain = clamp(residualAt(worst), -EQ_MAX, EQ_MAX)
    }
    active = active.filter((x) => x.on)
    const params: FitParam[] = [
      { get: () => eq.ls.gain, set: (v) => { eq.ls.gain = v }, lo: -EQ_MAX, hi: EQ_MAX, step: 1, mul: false },
      { get: () => eq.ls.freq, set: (v) => { eq.ls.freq = v }, lo: 100, hi: 400, step: 1.25, mul: true },
      { get: () => eq.hs.gain, set: (v) => { eq.hs.gain = v }, lo: -EQ_MAX, hi: EQ_MAX, step: 1, mul: false },
      { get: () => eq.hs.freq, set: (v) => { eq.hs.freq = v }, lo: 2000, hi: 8000, step: 1.25, mul: true },
      ...active.flatMap((band): FitParam[] => [
        { get: () => band.gain, set: (v) => { band.gain = v }, lo: -EQ_MAX, hi: EQ_MAX, step: 1, mul: false },
        { get: () => band.freq, set: (v) => { band.freq = v }, lo: 200, hi: 8000, step: 1.25, mul: true },
        { get: () => band.q, set: (v) => { band.q = v }, lo: 0.6, hi: 2, step: 1.3, mul: true },
      ]),
    ]
    // pattern search: try each setting a step up and down, keep what helps, then halve the steps
    let best = error()
    for (let scale = 1; scale > 0.05; scale /= 2) {
      for (let sweep = 0; sweep < 12; sweep++) {
        let improved = false
        for (const p of params) {
          const cur = p.get()
          for (const dir of [1, -1]) {
            const next = clamp(p.mul ? cur * Math.pow(p.step, dir * scale) : cur + dir * p.step * scale, p.lo, p.hi)
            if (next === cur) continue
            p.set(next)
            const e = error()
            if (e < best - 1e-6) { best = e; improved = true; break }
            p.set(cur)
          }
        }
        if (!improved) break
      }
    }
    // tidy: knob-sized values, and anything too small to hear is switched off
    const tidy = <T extends { on: boolean; freq: number; gain: number; q: number }>(x: T, def: T): T => {
      const gain = round(x.gain, 0.1)
      return !x.on || Math.abs(gain) < 0.5 ? { ...def, on: false } : { ...x, on: true, gain, freq: Math.round(x.freq), q: round(x.q, 0.01) }
    }
    eq.ls = tidy(eq.ls, d.ls); eq.hs = tidy(eq.hs, d.hs)
    const kept = eq.bands.map((b, i) => tidy(b, d.bands[i]!)).filter((b) => b.on).sort((a, b) => a.freq - b.freq)
    eq.bands = d.bands.map((def, i) => kept[i] ?? { ...def, on: false })
    return { eq, rms: rmsOf(eq) }
  }
  // the fewest bells that get within 0.15 dB of the best fit
  const fits = base.bands.map((_, i) => fitWith(i)).concat(fitWith(base.bands.length))
  const bestRms = Math.min(...fits.map((f) => f.rms))
  const pick = fits.find((f) => f.rms <= bestRms + 0.15)!
  return { eq: { ...pick.eq, hp: base.hp, lp: base.lp }, rms: pick.rms }
}
