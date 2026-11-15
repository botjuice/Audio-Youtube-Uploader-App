import { describe, expect, it } from 'vitest'
import { validateLook } from '../plugins/audio/look'
import { MEASURE_BANDS, MEASURE_VERSION, type Measure, type RingMeasure } from '../plugins/audio/types'
import { defaultModules, toLook } from './audio-modules'
import { AUDIO_RULE_FORMAT, MAX_REFERENCES, buildRuleFile, meanTarget, normaliseAudioRules, parseRuleFile, resolveRule, targetUsable, withDefaults, type AudioRule, type AudioRulesState } from './audio-rules'
import { noFeedback, refine, report, steer } from './audio-steer'
import { eqResponseDb } from './eq-response'

const tone = MEASURE_BANDS.map((f) => -8 - (f > 500 ? 5.5 * Math.log2(f / 500) : 0) - (f < 160 ? 20 * Math.log2(160 / f) : 0))
const rec = (over: Partial<Measure> = {}, t = tone): Measure => ({
  v: MEASURE_VERSION, durationSec: 300, voiceDb: -18, activeShare: 0.9, tone: t, quiet: t.map((x) => x - 25), floorDb: -12,
  levels: { p10: -6, p50: -0.6, p90: 2.8, p95: 3.6, p99: 5 }, peakDb: 15, sibilance: -28, ...over,
})
const ring = (over: Partial<RingMeasure> = {}): RingMeasure => ({ v: 1, splitHz: 4500, ambientDb: -56, bursts: 60, perMin: 9, burstMs: 130, burstLongMs: 210, burstDb: -39, offsets: [50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500], excessDb: [6, 5, 4, 3.5, 3, 2.5, 2, 0.5, -0.5, -2], ringDb: 3.2, halfMs: 700, slope: 0.6, zeroDb: -45, ...over })
const base = () => {
  const m = defaultModules()
  m.eq = { ...m.eq, on: true, hp: { on: true, freq: 90, q: 0.707 }, bands: m.eq.bands.map((b, i) => (i === 0 ? { on: true, freq: 3000, gain: 4, q: 0.8 } : b)) }
  m.comp = { ...m.comp, on: true, threshold: -19, ratio: 1.5 }
  m.reverb = { on: true, decay: 2, predelay: 20, brightness: 5000, amount: -15 }
  m.gate = { ...m.gate, on: true, threshold: -50 }
  m.spring = { ...m.spring, on: true, threshold: -40 }
  m.level = { on: true, lufs: -15, ceiling: -2 }
  return m
}
const captured = (m: Measure, lufs = -15, ringLeft: number | null = 1) => ({ after: m, ringLeft, lufs })

describe('audio rules: which rule applies', () => {
  const target = meanTarget([captured(rec())], base(), rec())
  const rule = (reciterKey: string | null, withTarget = true): AudioRule => ({ id: `r-${reciterKey}`, reciterKey, refs: [{ recordId: 'a/b.m4a', modules: base() }], target: withTarget ? target : null })
  it('a reciter’s own rule, else the default rule, else the one that ships with the app', () => {
    const state: AudioRulesState = { v: 1, applyToUploads: true, rules: [rule('almousa'), rule(null)] }
    expect(resolveRule(state, 'almousa')).toMatchObject({ via: 'reciter', rule: { reciterKey: 'almousa' } })
    expect(resolveRule(state, 'someoneelse')).toMatchObject({ via: 'default', rule: { reciterKey: null } })
    expect(resolveRule({ ...state, rules: [rule('almousa')] }, 'someoneelse')).toEqual({ rule: null, via: 'built-in' })
    // a rule that was never captured does not apply yet
    expect(resolveRule({ ...state, rules: [rule('almousa', false)] }, 'almousa').via).toBe('built-in')
  })
  it('tidies a stored state: one rule per reciter, five references at most, unusable targets dropped', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ recordId: `a/${i}.m4a`, modules: i === 0 ? base() : null }))
    const s = normaliseAudioRules({ applyToUploads: true, rules: [{ ...rule('x'), refs: many }, rule('x'), { ...rule(null), target: { ...target, measureVersion: 999 } }, 'junk'] })
    expect(s.rules).toHaveLength(2)
    expect(s.rules[0]!.refs).toHaveLength(MAX_REFERENCES)
    expect(s.rules[1]!.target).toBeNull()
    expect(s.applyToUploads).toBe(true)
    expect(normaliseAudioRules(null)).toEqual({ v: 1, applyToUploads: false, rules: [] })
  })
  it('drops a rule left with neither references nor a usable target, unless it is a draft being saved', () => {
    const lost = { ...rule('y'), refs: [], target: { ...target, measureVersion: 999 } }
    expect(normaliseAudioRules({ rules: [lost, rule('x')] }).rules.map((r) => r.reciterKey)).toEqual(['x'])
    expect(normaliseAudioRules({ rules: [lost] }, { keepEmpty: true }).rules).toHaveLength(1)
  })
})

describe('audio rules: the target', () => {
  it('is the mean of how the references measure after processing', () => {
    const bright = tone.map((x, b) => x + (MEASURE_BANDS[b]! >= 2000 ? 4 : 0))
    const t = meanTarget([captured(rec()), captured(rec({ levels: { p10: -6, p50: -0.6, p90: 3, p95: 4, p99: 6 } }, bright), -16, 2), captured(rec(), -17, null)], base(), rec({ voiceDb: -20 }))
    const b5k = MEASURE_BANDS.indexOf(5000)
    expect(t.count).toBe(3)
    expect(t.tone[b5k]).toBeCloseTo(tone[b5k]! + 4 / 3, 1)
    expect(t.over).toBeCloseTo((5.6 + 6.6 + 5.6) / 3, 1)
    expect(t.lufs).toBe(-16)
    expect(t.ring).toBe(1.5)                     // only the references a ring could be measured in
    expect(t.hp).toBe(90)
    expect(t.baseVoiceDb).toBe(-20)
    expect(targetUsable(t)).toBe(true)
    expect(() => meanTarget([], base(), rec())).toThrow()
    const noHp = base(); noHp.eq.hp.on = false
    expect(meanTarget([captured(rec())], noHp, rec()).hp).toBe(0)
  })
  it('a single edit is its own target: the recording it was made on needs no more EQ than a touch', () => {
    const t = meanTarget([captured(rec())], base(), rec())
    const s = steer(defaultModules(), rec(), t, null)
    expect(Math.abs(eqResponseDb(s.modules.eq, 3000))).toBeLessThan(1)   // already sounds like the target
  })
  it('steering to a rule carries over what is taste (reverb, gate, limiter, de-esser, delay, gain) and its high-pass and ceiling', () => {
    const t = meanTarget([captured(rec())], base(), rec())
    const s = steer(defaultModules(), rec({ voiceDb: -24 }), t, null)
    expect(s.modules.echo).toEqual(base().echo)
    expect(s.modules.gate).toMatchObject({ on: true, threshold: -56 })
    expect(s.modules.eq.hp).toMatchObject({ on: true, freq: 90 })
    expect(s.modules.level).toEqual({ on: true, lufs: -15, ceiling: -2 })
    expect(s.notes.find((n) => n.module === 'gate')!.text).toMatch(/as in the rule/)
    expect(validateLook(toLook(s.modules)).ok).toBe(true)
    const noHp = base(); noHp.eq.hp.on = false
    expect(steer(defaultModules(), rec(), meanTarget([captured(rec())], noHp, rec()), null).modules.eq.hp.on).toBe(false)
  })
})

describe('audio rules: reverb is set to reach the room the references have', () => {
  // the references end up with their quietest moments 10 dB under the voice (a lot of room) with the rule's reverb at −15 dB
  const t = meanTarget([captured(rec({ floorDb: -10 }))], base(), rec())
  it('a drier recording gets the rule’s reverb; one that already has that much room gets none', () => {
    expect(t.floorDb).toBe(-10)
    const dry = steer(defaultModules(), rec({ floorDb: -25 }), t, null)
    expect(dry.modules.reverb).toMatchObject({ on: true, amount: -15, decay: 2 })
    expect(dry.notes.find((n) => n.module === 'reverb')!.text).toMatch(/drier than the rule’s recordings/)
    const roomy = steer(defaultModules(), rec({ floorDb: -9 }), t, null)
    expect(roomy.modules.reverb.on).toBe(false)
    expect(roomy.notes.find((n) => n.module === 'reverb')!.text).toMatch(/already has as much room/)
  })
  it('checking the result moves the amount until the room matches', () => {
    const before = rec({ floorDb: -25 })
    const s = steer(defaultModules(), before, t, null)
    // the result is still 6 dB drier than the references: more reverb next time
    const fb = refine(noFeedback(), s, before, rec({ floorDb: -16 }), t)!
    expect(fb.reverb).toBe(6)
    expect(steer(defaultModules(), before, t, null, fb).modules.reverb.amount).toBe(-9)
    // and too much room: less
    expect(refine(noFeedback(), s, before, rec({ floorDb: -6 }), t)!.reverb).toBe(-4)
    expect(refine(noFeedback(), s, before, rec({ floorDb: -10.5 }), t)).toBeNull()
    const rows = report(before, rec({ floorDb: -10.5 }), t, s)
    expect(rows.find((r) => r.what.startsWith('Room'))).toMatchObject({ before: '25.0 dB', after: '10.5 dB', target: '10.0 dB', ok: true })
  })
  it('a rule without reverb leaves reverb off everywhere', () => {
    const noReverb = base(); noReverb.reverb.on = false
    const s = steer(defaultModules(), rec({ floorDb: -40 }), meanTarget([captured(rec({ floorDb: -10 }))], noReverb, rec()), null)
    expect(s.modules.reverb.on).toBe(false)
  })
})

describe('audio rule files', () => {
  const target = meanTarget([captured(rec())], base(), rec())
  const rule: AudioRule = { id: 'r1', reciterKey: 'almousa', label: 'Masjid system', refs: [{ recordId: 'A/one.m4a', modules: base() }, { recordId: 'A/two.m4a', modules: null }], target }
  it('round-trips: the target and the settings travel in the file', () => {
    const file = buildRuleFile(rule, (id) => id.split('/')[1]!, { appVersion: '3.3.1', now: new Date('2026-11-15T00:00:00Z') })
    expect(file.format).toBe(AUDIO_RULE_FORMAT)
    expect(file.references.map((r) => r.name)).toEqual(['one.m4a', 'two.m4a'])
    const back = parseRuleFile(JSON.stringify(file))
    expect(back).toMatchObject({ label: 'Masjid system', reciterKey: 'almousa' })
    expect(back.target).toEqual(target)
    expect(back.references[0]!.modules).toEqual(base())
    expect(back.references[1]!.modules).toBeNull()
  })
  it('a default rule comes back as the default rule; a rule without a target cannot be exported', () => {
    const file = buildRuleFile({ ...rule, reciterKey: null }, (id) => id, { appVersion: '3.3.1' })
    expect(parseRuleFile(JSON.stringify(file)).reciterKey).toBeNull()
    expect(() => buildRuleFile({ ...rule, target: null }, (id) => id, { appVersion: '3.3.1' })).toThrow(/Save the rule first/)
  })
  it('refuses what it cannot use, in plain words', () => {
    expect(() => parseRuleFile('nope')).toThrow(/not valid JSON/)
    expect(() => parseRuleFile(JSON.stringify({ format: 'yoosy-joosy.thumbnail-look' }))).toThrow(/not an audio rule/)
    const file = buildRuleFile(rule, (id) => id, { appVersion: '3.3.1' })
    expect(() => parseRuleFile(JSON.stringify({ ...file, version: 99 }))).toThrow(/newer version/)
    expect(() => parseRuleFile(JSON.stringify({ ...file, target: { ...file.target, measureVersion: 99 } }))).toThrow(/different version of the app’s measurements/)
    expect(() => parseRuleFile(JSON.stringify({ ...file, target: { ...file.target, tone: [1, 2] } }))).toThrow(/no usable target/)
  })
  it('settings from an older file get the modules they lack, switched off', () => {
    const old = JSON.parse(JSON.stringify(base())) as Record<string, unknown>
    delete old['spring']
    const m = withDefaults(old)
    expect(m.spring).toEqual(defaultModules().spring)
    expect(m.reverb).toEqual(base().reverb)
    expect(validateLook(toLook(m)).ok).toBe(true)
  })
})
