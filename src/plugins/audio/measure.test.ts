import { describe, expect, it } from 'vitest'
import { Measurer } from './measure'
import { MEASURE_BANDS } from './types'

const RATE = 32000
const sine = (hz: number, amp: number, seconds: number) => Float32Array.from({ length: Math.round(RATE * seconds) }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / RATE))
const band = (hz: number) => MEASURE_BANDS.indexOf(hz)

describe('measure', () => {
  it('reports level, crest and tone of a plain tone', () => {
    const m = new Measurer()
    m.push(sine(1000, 0.5, 5))
    const r = m.finish()!
    expect(r.voiceDb).toBeCloseTo(-9, 0)          // 0.5 peak sine = −9 dBFS RMS
    expect(r.peakDb).toBeCloseTo(3, 0)
    expect(r.tone[band(1000)]).toBeGreaterThan(-1)   // nearly all the power is in the 1 kHz band
    expect(r.tone[band(250)]).toBeLessThan(-40)
    expect(r.durationSec).toBe(5)
  })

  it('measures the same tone for a quiet and a loud copy', () => {
    const a = new Measurer(), b = new Measurer()
    const mix = (g: number) => { const x = sine(300, 0.4 * g, 4), y = sine(3000, 0.05 * g, 4); return x.map((v, i) => v + y[i]!) }
    a.push(mix(1)); b.push(mix(0.1))
    const ra = a.finish()!, rb = b.finish()!
    expect(rb.voiceDb).toBeCloseTo(ra.voiceDb - 20, 0)
    expect(rb.tone[band(315)]).toBeCloseTo(ra.tone[band(315)]!, 0)
    expect(rb.tone[band(3150)]).toBeCloseTo(ra.tone[band(3150)]!, 0)
    expect(ra.tone[band(315)]! - ra.tone[band(3150)]!).toBeCloseTo(18, 0)   // 0.4 vs 0.05 = 18 dB
  })

  it('finds the background in the pauses and keeps it out of the voice level', () => {
    const m = new Measurer()
    let seed = 1
    const noise = (n: number, amp: number) => Float32Array.from({ length: n }, () => { seed = (seed * 16807) % 2147483647; return amp * (seed / 1073741823.5 - 1) })
    for (let i = 0; i < 6; i++) {
      const v = sine(400, 0.5, 2), n = noise(v.length, 0.001)
      m.push(v.map((x, k) => x + n[k]!))
      m.push(noise(RATE, 0.001))            // one second of background only
    }
    const r = m.finish()!
    expect(r.voiceDb).toBeCloseTo(-9, 0)
    expect(r.activeShare).toBeGreaterThan(0.6)
    expect(r.activeShare).toBeLessThan(0.72)
    expect(r.floorDb).toBeLessThan(-50)        // noise RMS ≈ −65 dBFS, voice −9
    expect(r.floorDb).toBeGreaterThan(-62)
  })

  it('gives no measurement for silence or a clip under two seconds', () => {
    const a = new Measurer(); a.push(new Float32Array(RATE * 5)); expect(a.finish()).toBeNull()
    const b = new Measurer(); b.push(sine(1000, 0.5, 1)); expect(b.finish()).toBeNull()
  })
})
