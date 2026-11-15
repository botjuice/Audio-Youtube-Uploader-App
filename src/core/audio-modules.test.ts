import { describe, expect, it } from 'vitest'
import { validateLook } from '../plugins/audio/look'
import { lookFromV1 } from '../plugins/audio/v1'
import { MODULE_ORDER, countOn, defaultModules, fromLook, toLook } from './audio-modules'
import { eqResponseDb } from './eq-response'

describe('audio strip ↔ plugin look', () => {
  it('writes every module as a plugin step in fixed order, off modules bypassed, and validates', () => {
    const m = defaultModules()
    const look = toLook(m)
    expect(look.chain.map((s) => s.filter)).toEqual(['volume', 'afftdn', 'agate', 'acrossover', 'highpass', 'lowshelf', 'equalizer', 'equalizer', 'equalizer', 'equalizer', 'highshelf', 'lowpass', 'acompressor', 'deesser', 'aecho', 'asplit', 'alimiter'])
    expect(look.chain.every((s) => s.bypass)).toBe(true)
    expect(look.level).toBeNull()
    const v = validateLook(look)
    expect(v.ok, v.ok ? '' : JSON.stringify(v.errors)).toBe(true)
  })
  it('converts studio units to ffmpeg values and back', () => {
    const m = defaultModules()
    m.gain = { on: true, db: -6 }
    m.comp = { ...m.comp, on: true, threshold: -20, makeup: 6, mix: 50 }
    m.gate = { ...m.gate, on: true, threshold: -40, range: -60, makeup: 3 }
    m.deess = { on: true, intensity: 20, max: 60, frequency: 70, mode: 'e' }
    m.limiter = { ...m.limiter, on: true, ceiling: -1, inGain: 3, outGain: -2 }
    m.eq = { ...m.eq, on: true, hp: { on: true, freq: 75, q: 0.707 }, bands: m.eq.bands.map((b, i) => (i === 0 ? { on: true, freq: 250, gain: -2, q: 1.4 } : b)) }
    m.reverb = { on: true, decay: 2.2, predelay: 25, brightness: 5000, amount: -14 }
    m.level = { on: true, lufs: -14, ceiling: -1.5 }
    const look = toLook(m)
    const o = (id: string) => look.chain.find((s) => s.id === id)!.options!
    expect(o('gain').volume).toBe('-6dB')
    expect(o('comp').threshold).toBeCloseTo(0.1, 5)
    expect(o('comp').makeup).toBeCloseTo(1.9953, 3)
    expect(o('comp').mix).toBe(0.5)
    expect(o('gate').threshold).toBeCloseTo(0.01, 5)
    expect(o('deess')).toEqual({ i: 0.2, m: 0.6, f: 0.7, s: 'e' })
    expect(o('limiter').limit).toBeCloseTo(0.8913, 3)
    expect(o('eq:hp')).toEqual({ frequency: 75, poles: 2, width_type: 'q', width: 0.707 })
    expect(look.level).toEqual({ lufs: -14, ceiling: -1.5 })
    expect(validateLook(look).ok).toBe(true)
    const back = fromLook(look)
    expect(back.unmapped).toEqual([])
    expect(back.modules.gain).toEqual({ on: true, db: -6 })
    expect(back.modules.comp.threshold).toBe(-20); expect(back.modules.comp.makeup).toBe(6); expect(back.modules.comp.mix).toBe(50)
    expect(back.modules.gate.threshold).toBe(-40); expect(back.modules.gate.range).toBe(-60)
    expect(back.modules.deess).toEqual({ on: true, intensity: 20, max: 60, frequency: 70, mode: 'e' })
    expect(back.modules.limiter.ceiling).toBe(-1); expect(back.modules.limiter.inGain).toBe(3)
    expect(back.modules.eq.hp).toEqual({ on: true, freq: 75, q: 0.707 }); expect(back.modules.eq.bands[0]).toEqual({ on: true, freq: 250, gain: -2, q: 1.4 })
    expect(back.modules.reverb.decay).toBe(2.2); expect(back.modules.reverb.predelay).toBe(25); expect(back.modules.reverb.brightness).toBe(5000); expect(Math.abs(back.modules.reverb.amount - -14)).toBeLessThan(0.2)
    expect(back.modules.level).toEqual({ on: true, lufs: -14, ceiling: -1.5 })
    expect(countOn(back.modules)).toBe(8)
  })
  it('maps a converted v1 look by filter name and reports what the strip cannot show', () => {
    const v1 = lookFromV1({ cleanup: { clicks: { enabled: true }, rumble: { enabled: true, frequency: 75 }, hiss: { enabled: true, amount: 15 } }, tone: { enabled: true, mud: { gain: -1.5, frequency: 250 } }, dynamics: { enabled: true, threshold: -20 }, reverb: { enabled: true, amount: -16, decay: 1.2, predelay: 15, tone: 5500 }, loudness: { enabled: true, target: -14 } })
    const { modules: m, unmapped } = fromLook(v1)
    expect(m.eq.on).toBe(true); expect(m.eq.hp).toEqual({ on: true, freq: 75, q: 0.707 })
    expect(m.nr.on).toBe(true); expect(m.nr.reduction).toBe(15); expect(m.nr.track).toBe(true)
    expect(m.eq.bands[0]).toEqual({ on: true, freq: 250, gain: -1.5, q: 1 })
    expect(m.comp.on).toBe(true); expect(m.comp.threshold).toBe(-20)
    expect(m.reverb.on).toBe(true); expect(m.reverb.decay).toBe(1.2); expect(Math.abs(m.reverb.amount - -16)).toBeLessThan(0.2)
    expect(m.level).toEqual({ on: true, lufs: -14, ceiling: -1.5 })
    expect(unmapped).toEqual(['adeclick', 'highpass', 'afade'])   // click removal, the doubled highpass and the fade-in have no module
  })
  it('EQ response follows the knobs', () => {
    const eq = defaultModules().eq
    eq.on = true; eq.hp = { on: true, freq: 80, q: 0.707 }; eq.bands[0] = { on: true, freq: 1000, gain: 6, q: 1 }
    expect(eqResponseDb(eq, 80)).toBeCloseTo(-3, 0)
    expect(eqResponseDb(eq, 1000)).toBeCloseTo(6, 0)
    expect(Math.abs(eqResponseDb(eq, 10000))).toBeLessThan(0.3)
    expect(eqResponseDb({ ...eq, on: false }, 80)).toBe(0)
  })
  it('module order lists every module except the EQ, which lives under the lanes', () => {
    expect(MODULE_ORDER).not.toContain('eq'); expect(MODULE_ORDER.length).toBe(10)
  })
})

describe('spring tamer', () => {
  it('round-trips through the look and validates', () => {
    const m = defaultModules()
    m.spring = { on: true, split: 4500, threshold: -38, ratio: 6, delay: 180, attack: 5, release: 500 }
    m.level = { on: true, lufs: -16.6, ceiling: -1 }
    const look = toLook(m)
    const st = look.chain.find((s) => s.id === 'spring')!
    expect(st.options).toEqual({ split: '4500', order: '8th' })
    expect(st.outputs![1]![0]!.options!.threshold).toBeCloseTo(0.012589, 5)
    expect(look.level).toEqual({ lufs: -16.6, ceiling: -1 })
    const v = validateLook(look)
    expect(v.ok, v.ok ? '' : JSON.stringify(v.errors)).toBe(true)
    const back = fromLook(v.ok ? v.look : look)
    expect(back.unmapped).toEqual([])
    expect(back.modules.spring).toEqual(m.spring)
    expect(back.modules.level).toEqual(m.level)
  })
})
