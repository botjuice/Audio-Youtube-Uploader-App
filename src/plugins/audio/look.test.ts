import { describe, expect, it } from 'vitest'
import { DEFAULT_LOOK, LOOK_FIELDS, LOOK_PRESETS, REVERB_PRESETS, canonicalLook, controllingToggle, describeLook, validateLook } from './look'
import { buildGraph, reverbLevelOffset } from './chain'
import { channelCorrelation, generateIr, IR_RATE } from './ir'
import { parseEbur, parseProbe, percentile } from './ffmpeg'

describe('look schema', () => {
  it('every number knob has a sane range, step and a default inside it', () => {
    for (const { path, field } of LOOK_FIELDS) {
      expect(field.label, path).toBeTruthy()
      expect(field.desc, path).toBeTruthy()
      if (field.kind !== 'number') continue
      expect(field.min, path).toBeLessThan(field.max)
      expect(field.step, path).toBeGreaterThan(0)
      expect(field.default, path).toBeGreaterThanOrEqual(field.min)
      expect(field.default, path).toBeLessThanOrEqual(field.max)
      // the default sits on the step grid, so a slider can land on it exactly
      const steps = (field.default - field.min) / field.step
      expect(Math.abs(steps - Math.round(steps)), path).toBeLessThan(1e-6)
    }
  })

  it('empty look resolves to the defaults; factory chain = cleanup + loudness + fades', () => {
    const v = validateLook({})
    expect(v.ok && v.look).toEqual(DEFAULT_LOOK)
    expect(describeLook(DEFAULT_LOOK)).toBe('remove clicks · cut rumble < 75 Hz · reduce hiss 12 dB · level to -14 LUFS · fades 0.5/1.5 s')
  })

  it('rejects unknown knobs, wrong types and out-of-range values, naming each', () => {
    const v = validateLook({ reverb: { decay: 99, enabled: 'yes' }, tone: { bass: 1 }, cleanup: 3 })
    expect(v.ok).toBe(false)
    if (v.ok) return
    expect(v.errors.map((e) => e.key).sort()).toEqual(['cleanup', 'reverb.decay', 'reverb.enabled', 'tone.bass'])
    expect(v.errors.find((e) => e.key === 'reverb.decay')!.message).toContain('between 0.3 and 6 s')
  })

  it('rounds slider float noise so the cache key is stable', () => {
    const a = validateLook({ reverb: { amount: -12.000000001 } }), b = validateLook({ reverb: { amount: -12 } })
    expect(a.ok && b.ok && canonicalLook(a.look) === canonicalLook(b.look)).toBe(true)
  })

  it('key order never changes the canonical form', () => {
    const a = validateLook({ reverb: { decay: 2, amount: -10 }, fades: { out: 3 } })
    const b = validateLook({ fades: { out: 3 }, reverb: { amount: -10, decay: 2 } })
    expect(a.ok && b.ok && canonicalLook(a.look) === canonicalLook(b.look)).toBe(true)
  })

  it('every preset is a valid patch', () => {
    for (const p of [...Object.values(REVERB_PRESETS), ...Object.values(LOOK_PRESETS)]) expect(validateLook(p.patch).ok).toBe(true)
  })

  it('controllingToggle points each knob at the switch that greys it out', () => {
    expect(controllingToggle('reverb.decay')).toBe('reverb.enabled')
    expect(controllingToggle('cleanup.hiss.amount')).toBe('cleanup.hiss.enabled')
    expect(controllingToggle('tone.presence.gain')).toBe('tone.enabled')
    expect(controllingToggle('reverb.enabled')).toBeNull()
    expect(controllingToggle('fades.in')).toBeNull()
    expect(controllingToggle('limiter.ceiling')).toBeNull()   // the limiter always runs
  })
})

describe('chain', () => {
  const look = (p: unknown) => { const v = validateLook(p); if (!v.ok) throw new Error('bad'); return v.look }

  it('factory look, mono: exact graph', () => {
    expect(buildGraph(DEFAULT_LOOK, { channels: 1, mode: 'render', gainDb: 2.5, fadeIn: 0.5, fadeOut: { start: 98.5, duration: 1.5 } })).toBe(
      '[0:a]aresample=48000,aformat=sample_fmts=fltp,adeclick,highpass=f=75:poles=2,highpass=f=75:poles=2,afftdn=nr=12:nf=-42:tn=1[pre];'
      + '[pre]volume=2.5dB,aresample=192000,alimiter=limit=0.8414:level=0:attack=5:release=50:latency=1,aresample=48000,afade=t=in:st=0:d=0.5,afade=t=out:st=98.5:d=1.5[out]')
  })

  it('measure mode ends in ebur128 and never applies gain, limiter or fades', () => {
    const g = buildGraph(DEFAULT_LOOK, { channels: 1, mode: 'measure', gainDb: 5 })
    expect(g.endsWith('ebur128=peak=true:framelog=verbose[out]')).toBe(true)
    expect(g).not.toMatch(/volume|alimiter|afade/)
  })

  it('reverb: mono goes stereo, wet level is amount minus the decay offset, mix keeps full length', () => {
    const g = buildGraph(look({ reverb: { enabled: true, amount: -12, decay: 2 } }), { channels: 1, mode: 'render' })
    expect(g).toContain('pan=stereo|c0=c0|c1=c0[dry0]')
    expect(g).toContain(`[wet]volume=${+(-12 - reverbLevelOffset(2)).toFixed(4)}dB[wetv]`)
    expect(g).toContain('amix=inputs=2:normalize=0:duration=longest')   // duration=first cut 0.16 s off every file
  })

  it('switched-off sections leave no filter behind; the limiter is always there', () => {
    const g = buildGraph(look({ cleanup: { clicks: { enabled: false }, rumble: { enabled: false }, hiss: { enabled: false } }, loudness: { enabled: false } }), { channels: 1, mode: 'render' })
    expect(g).toBe('[0:a]aresample=48000,aformat=sample_fmts=fltp[pre];[pre]aresample=192000,alimiter=limit=0.8414:level=0:attack=5:release=50:latency=1,aresample=48000[out]')
  })

  it('tone bands at 0 dB are skipped; bypass ignores the whole look', () => {
    const t = buildGraph(look({ tone: { enabled: true, mud: { gain: 0 }, presence: { gain: 0 } } }), { channels: 1, mode: 'render' })
    expect(t).not.toContain('equalizer')
    const b = buildGraph(look({ reverb: { enabled: true }, tone: { enabled: true } }), { channels: 1, mode: 'render', bypass: true, gainDb: -3 })
    expect(b).toBe('[0:a]aresample=48000,aformat=sample_fmts=fltp[pre];[pre]volume=-3dB,aresample=192000,alimiter=limit=0.8414:level=0:attack=5:release=50:latency=1,aresample=48000[out]')
  })

  it('numbers never use exponent notation', () => {
    const g = buildGraph(look({ reverb: { enabled: true, width: 0, amount: -30 }, tone: { enabled: true, deesser: 0.05 } }), { channels: 1, mode: 'render', gainDb: 0.0000001 })
    expect(g).not.toMatch(/\de[-+]?\d/)
  })
})

describe('reverb IR', () => {
  const spec = { decay: 2, predelay: 20, tone: 5000, width: 0.8 }

  it('length = pre-delay + decay; silent during the pre-delay', () => {
    const [L] = generateIr(spec)
    expect(L.length).toBe(Math.round(0.02 * IR_RATE) + 2 * IR_RATE)
    expect(L.slice(0, Math.round(0.02 * IR_RATE)).every((x) => x === 0)).toBe(true)
  })

  it('each channel has unit energy (so amount is relative to the voice)', () => {
    for (const ch of generateIr(spec)) expect(ch.reduce((s, x) => s + x * x, 0)).toBeCloseTo(1, 5)
  })

  it('decays: the last 10 % carries far less energy than the first 10 %', () => {
    const [L] = generateIr({ ...spec, predelay: 0 })
    const e = (a: Float32Array) => a.reduce((s, x) => s + x * x, 0)
    const tenth = Math.floor(L.length / 10)
    expect(e(L.slice(-tenth)) / e(L.slice(0, tenth))).toBeLessThan(1e-3)
  })

  it('width 0 = identical channels, width 1 = independent', () => {
    expect(channelCorrelation(generateIr({ ...spec, width: 0 }))).toBeCloseTo(1, 5)
    expect(Math.abs(channelCorrelation(generateIr({ ...spec, width: 1 })))).toBeLessThan(0.05)
  })

  it('is deterministic', () => {
    expect(generateIr(spec)[1]).toEqual(generateIr(spec)[1])
  })
})

describe('parsers', () => {
  it('reads stream facts from an ffmpeg banner', () => {
    expect(parseProbe('  Duration: 00:07:28.83, start: 0.000000, bitrate: 259 kb/s\n  Stream #0:0[0x1](eng): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, mono, fltp, 256 kb/s (default)'))
      .toEqual({ durationSec: 448.83, sampleRate: 48000, channels: 1, codec: 'aac' })
    expect(parseProbe('Duration: 00:00:01.00, bitrate: 1 kb/s\n Stream #0:0: Audio: pcm_f32le ([3][0][0][0] / 0x0003), 48000 Hz, 2 channels, flt, 3072 kb/s')!.channels).toBe(2)
    expect(parseProbe('Duration: 00:00:01.00\n Stream #0:0: Audio: flac, 48000 Hz, stereo, s32 (24 bit)')!.channels).toBe(2)
    expect(parseProbe('nothing here')).toBeNull()
  })

  it('reads the ebur128 summary, including silence', () => {
    expect(parseEbur('[Parsed_ebur128_0 @ 0x1] Summary:\n\n  Integrated loudness:\n    I:         -14.7 LUFS\n    Threshold: -24.7 LUFS\n\n  Loudness range:\n    LRA:         4.2 LU\n\n  True peak:\n    Peak:        0.1 dBFS'))
      .toEqual({ lufs: -14.7, lra: 4.2, truePeak: 0.1 })
    expect(parseEbur('Summary:\n    I:         -70.0 LUFS\n    LRA:         0.0 LU\n    Peak:       -inf dBFS')).toEqual({ lufs: -70, lra: 0, truePeak: -Infinity })
    expect(parseEbur('no summary')).toBeNull()
  })

  it('percentile', () => {
    expect(percentile([5, 1, 3, 2, 4], 0)).toBe(1)
    expect(percentile([5, 1, 3, 2, 4], 0.5)).toBe(3)
    expect(percentile([], 0.5)).toBe(-Infinity)
  })
})
