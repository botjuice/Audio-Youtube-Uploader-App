/**
 * The calls that hand back numbers (measure, ring, ringSplit, levellingGain) through the public surface, against the
 * bundled ffmpeg on synthetic audio: what they refuse, that they can be cancelled and cannot hang, and that a caller's
 * gain and rate are handled as a render's own.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AudioError, CATALOG, RING_VERSION, checkLook, discard, levellingGain, measure, processAudio, ring, ringSplit, type AudioHost, type Look } from './index'
import { generateCatalog } from './catalog-gen'
import { checkFfmpeg, ffmpegRelease } from './ffmpeg'

const bin = ffmpegStatic as unknown as string
const tmp = mkdtempSync(join(tmpdir(), 'yj-measuring-'))
const out = join(tmp, 'out')
const host = (extra: Partial<AudioHost> = {}): AudioHost => ({ outputDir: out, ffmpegPath: bin, log: () => {}, ...extra })
const gen = (name: string, lavfi: string) => {
  const p = join(tmp, name)
  execFileSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi, '-c:a', 'aac', '-b:a', '192k', p])
  return p
}
/** A "voice" (220 Hz) with an "s" every two seconds: 80 ms of 6 kHz, then a tail of it dying away over half a second. */
const VOICE = '0.1*sin(2*PI*220*t)', ESS = '0.2*sin(2*PI*6000*t)*(lt(mod(t,2),0.08)+0.25*gte(mod(t,2),0.08)*exp(-(mod(t,2)-0.08)*6))'
/** A step that never lets a sample through in any useful time: what a stalled ffmpeg looks like. */
const STALLS: Look = { chain: [{ filter: 'arealtime', options: { speed: 1e-300 } }] }

let mono = '', stereo = '', peaky = ''
beforeAll(() => {
  mono = gen('mono.m4a', `aevalsrc='${VOICE}+${ESS}':s=48000:d=40`)
  stereo = gen('stereo.m4a', `aevalsrc='${VOICE}|${ESS}':s=48000:c=stereo:d=40`)   // the "s" only on the right
  peaky = gen('peaky.m4a', "aevalsrc='0.01*sin(2*PI*220*t)+0.9*sin(2*PI*220*t)*lt(mod(t,1),0.02)':s=48000:d=12")   // short loud peaks over a quiet tone
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const failure = async (p: Promise<unknown>): Promise<AudioError> => {
  const e = await p.then(() => null, (x: unknown) => x)
  expect(e).toBeInstanceOf(AudioError)
  return e as AudioError
}

describe('the ffmpeg that ships with the app', () => {
  it('is the release the catalog was made from, whoever built it', async () => {
    expect(ffmpegRelease('ffmpeg version 6.0 Copyright (c) 2000-2023 the FFmpeg developers')).toBe('6.0')
    expect(ffmpegRelease('ffmpeg version 6.0-essentials_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers')).toBe('6.0')
    expect(ffmpegRelease('ffmpeg version 6.1.1-essentials_build-www.gyan.dev Copyright (c) 2000-2023 the FFmpeg developers')).toBe('6.1.1')
    expect(ffmpegRelease('ffmpeg version n6.0-static https://johnvansickle.com/ffmpeg/')).toBe('6.0')
    expect(ffmpegRelease('something else')).toBeNull()
    const here = generateCatalog(bin)
    expect(ffmpegRelease(here.ffmpeg), here.ffmpeg).toBe(ffmpegRelease(CATALOG.ffmpeg))
  }, 120_000)

  it('has every filter the catalog lists, with the same options (builds of one release differ only in what was left out)', async () => {
    const here = generateCatalog(bin)
    const absent = Object.keys(CATALOG.filters).filter((name) => !here.filters[name])
    const sig = (f: { options: { name: string; type: string }[] }) => f.options.map((o) => `${o.name}:${o.type}`).sort().join(' ')
    const different = Object.keys(CATALOG.filters).filter((name) => here.filters[name] && sig(here.filters[name]!) !== sig(CATALOG.filters[name]!))
    expect(different, 'filters whose options differ in this build').toEqual([])
    expect(absent, 'catalog filters this build was made without').toEqual([])
    const build = await checkFfmpeg(bin)
    for (const name of Object.keys(CATALOG.filters)) expect(build.filters.has(name), name).toBe(true)
  }, 120_000)

  it('a look that needs a filter the build lacks is refused on that step', async () => {
    const build = await checkFfmpeg(bin)
    build.filters.delete('aecho')   // as if this build had been made without it
    try {
      const look: Look = { chain: [{ filter: 'highpass' }, { filter: 'aecho' }, { filter: 'aecho', bypass: true }], level: { lufs: -16, ceiling: -1 } }
      const want = { path: 'chain[1]', message: 'the ffmpeg on this computer was built without the aecho filter' }
      expect(await processAudio({ audioPath: mono, look }, host())).toMatchObject({ ok: false, reason: 'INVALID_LOOK', errors: [want] })
      expect(await checkLook(look, host())).toEqual({ ok: false, errors: [want] })
      expect(await levellingGain(mono, look, host())).toMatchObject({ ok: false, reason: 'INVALID_LOOK', errors: [want] })
      expect(await failure(measure(mono, host(), look))).toMatchObject({ reason: 'INVALID_LOOK', errors: [want] })
    } finally { build.filters.add('aecho') }
  }, 60_000)
})

describe('ring and ringSplit through the plugin', () => {
  it('find the bursts and where they ring', async () => {
    const r = await ring(mono, host(), 4500)
    expect(r).toMatchObject({ v: RING_VERSION, splitHz: 4500 })
    expect(r!.bursts).toBeGreaterThanOrEqual(15)
    expect(r!.burstMs).toBeGreaterThan(0)
    const s = await ringSplit(mono, host())
    expect(s.bands.map((b) => b.fromHz)).toEqual([3000, 3750, 4500, 5500, 7000])
    expect(s.bursts).toBeGreaterThanOrEqual(6)
    expect((await ring(mono, host(), 4500, undefined, { start: 0, seconds: 10 }))).toBeNull()   // under 30 s: nothing to say
  }, 60_000)

  it('read both channels of a stereo file: an "s" on the right only is found by both', async () => {
    expect((await ring(stereo, host(), 4500))!.bursts).toBeGreaterThanOrEqual(15)
    expect((await ringSplit(stereo, host())).bursts).toBeGreaterThanOrEqual(6)
  }, 60_000)
})

describe('what the measuring calls refuse', () => {
  it('a split, a stretch or a file that cannot be used, before ffmpeg runs', async () => {
    for (const bad of [0, -100, NaN, Infinity, 30000, '4500' as unknown as number]) expect((await failure(ring(mono, host(), bad))).reason, String(bad)).toBe('INVALID_JOB')
    const spans = [{ start: -1, seconds: 5 }, { start: 0, seconds: 0 }, { start: 0, seconds: -1 }, { start: NaN, seconds: 5 }, { start: 0, seconds: Infinity }, {} as { start: number; seconds: number }, { start: 500, seconds: 5 }]
    for (const span of spans) {
      expect((await failure(measure(mono, host(), undefined, span))).reason, JSON.stringify(span)).toBe('INVALID_JOB')
      expect((await failure(ring(mono, host(), 4500, undefined, span))).reason).toBe('INVALID_JOB')
      expect((await failure(ringSplit(mono, host(), span))).reason).toBe('INVALID_JOB')
    }
    expect((await measure(mono, host(), undefined, { start: 1e-7, seconds: 5 }))!.durationSec).toBeCloseTo(5, 0)   // no exponent reaches ffmpeg
    expect((await failure(measure('mono.m4a', host()))).reason).toBe('INVALID_JOB')
    expect((await failure(ring(join(tmp, 'nope.m4a'), host()))).reason).toBe('AUDIO_UNREADABLE')
    const notAudio = join(tmp, 'notaudio.m4a'); writeFileSync(notAudio, 'hello')
    expect((await failure(ringSplit(notAudio, host()))).reason).toBe('AUDIO_UNREADABLE')
    expect((await failure(measure(mono, host({ ffmpegPath: join(tmp, 'no-ffmpeg') })))).reason).toBe('FFMPEG_UNUSABLE')
  }, 60_000)

  it('a look that is not one, or that ffmpeg refuses, with the step at fault', async () => {
    const invalid = await failure(measure(mono, host(), { chain: [{ filter: 'highpass', options: { f: -5 } }] }))
    expect(invalid).toMatchObject({ reason: 'INVALID_LOOK' })
    expect(invalid.errors?.[0]?.path).toBe('chain[0].options.f')
    const refused = await failure(ring(mono, host(), 4500, { chain: [{ filter: 'highpass' }, { filter: 'acrossover', options: { split: '200 nope' }, outputs: [[], [], []], merge: { filter: 'amix', options: { inputs: 3 } } }] }))
    expect(refused).toMatchObject({ reason: 'INVALID_LOOK' })
    expect(refused.errors?.[0]?.path).toBe('chain[1]')
  }, 60_000)

  it('levellingGain gives processAudio’s reasons and never throws', async () => {
    const look: Look = { chain: [], level: { lufs: -16, ceiling: -1 } }
    expect(await levellingGain('mono.m4a', look, host())).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    expect(await levellingGain(join(tmp, 'nope.m4a'), look, host())).toMatchObject({ ok: false, reason: 'AUDIO_UNREADABLE' })
    const bad = await levellingGain(mono, { chain: [{ filter: 'highpass', options: { f: -5 } }], level: look.level }, host())
    expect(bad).toMatchObject({ ok: false, reason: 'INVALID_LOOK' })
    expect(!bad.ok && bad.errors?.[0]?.path).toBe('chain[0].options.f')
    const g = await levellingGain(mono, look, host())
    expect(g.ok && Number.isInteger(Math.round(g.gainDb! * 100)) && Math.abs(g.gainDb! * 100 - Math.round(g.gainDb! * 100)) < 1e-9).toBe(true)   // to 0.01 dB
  }, 60_000)
})

describe('the measuring calls end', () => {
  it('on cancel: at once, with the reason', async () => {
    const before = new AbortController(); before.abort()
    expect(await failure(measure(mono, host({ signal: before.signal })))).toMatchObject({ reason: 'CANCELLED', message: 'Cancelled' })
    for (const call of [(h: AudioHost) => measure(mono, h, STALLS), (h: AudioHost) => ring(mono, h, 4500, STALLS), (h: AudioHost) => levellingGain(mono, { ...STALLS, level: { lufs: -16, ceiling: -1 } }, h).then((r) => { if (!r.ok) throw new AudioError(r.reason, r.message); return r })]) {
      const ac = new AbortController()
      const t0 = Date.now()
      setTimeout(() => ac.abort(), 300)
      expect((await failure(call(host({ signal: ac.signal })))).reason).toBe('CANCELLED')
      expect(Date.now() - t0).toBeLessThan(5000)
    }
  }, 60_000)

  it('when ffmpeg stalls: as a TIMEOUT, not a wait forever', async () => {
    const t0 = Date.now()
    expect((await failure(measure(mono, host({ stallMs: 1500 }), STALLS))).reason).toBe('TIMEOUT')
    expect((await failure(ring(mono, host({ stallMs: 1500 }), 4500, STALLS))).reason).toBe('TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(15_000)
  }, 40_000)

  it('when a step never ends on its own: cut like a render', async () => {
    const endless: Look = { chain: [{ filter: 'amix', inputs: [{ kind: 'generate', filter: 'sine', chain: [{ filter: 'volume', options: { volume: 0.01 } }] }] }] }
    const m = await measure(mono, host(), endless, { start: 0, seconds: 4 })
    expect(m!.durationSec).toBeCloseTo(64, 0)   // max(2 × 4, 4 + 60)
    const g = await levellingGain(mono, { ...endless, level: { lufs: -16, ceiling: -1 } }, host())
    expect(g.ok).toBe(true)
  }, 120_000)
})

describe('measuring through a look over a stretch', () => {
  it('runs the look in recording time, as a render of that stretch does', async () => {
    // silent between 6 s and 8 s of the recording: half of the stretch 6–10 s
    const look: Look = { chain: [{ filter: 'volume', options: { volume: 0 }, enable: 'between(t,6,8)' }] }
    const m = await measure(mono, host(), look, { start: 6, seconds: 4 })
    expect(m!.activeShare).toBeGreaterThan(0.4)
    expect(m!.activeShare).toBeLessThan(0.6)
    expect((await measure(mono, host(), look, { start: 10, seconds: 4 }))!.activeShare).toBeGreaterThan(0.95)
  }, 60_000)
})

describe('a gain and a rate the caller gives', () => {
  const look: Look = { chain: [{ filter: 'volume', options: { volume: '3dB' } }], level: { lufs: -18, ceiling: -1 } }
  it('are part of what the file is: another rate is another file, float noise in the gain is not', async () => {
    const a = await processAudio({ audioPath: mono, look, preview: { start: 2, seconds: 4 }, gainDb: 3, rate: 48000 }, host())
    const b = await processAudio({ audioPath: mono, look, preview: { start: 2, seconds: 4 }, gainDb: 3, rate: 44100 }, host())
    const c = await processAudio({ audioPath: mono, look, preview: { start: 2, seconds: 4 }, gainDb: 3.0000000000000004, rate: 48000 }, host())
    expect(a.ok && b.ok && c.ok).toBe(true)
    if (!a.ok || !b.ok || !c.ok) return
    expect(b.cacheKey).not.toBe(a.cacheKey)
    expect(a.after.sampleRate).toBe(48000)
    expect(b.after.sampleRate).toBe(44100)
    expect(c).toMatchObject({ cacheKey: a.cacheKey, cached: true })
  }, 60_000)

  it('are checked: a rate ffmpeg cannot work at is refused, a gain beyond the limits is capped and said so', async () => {
    for (const rate of [-48000, 1, 1e9, 44100.5, NaN]) expect(await processAudio({ audioPath: mono, look, gainDb: 3, rate }, host()), String(rate)).toMatchObject({ ok: false, reason: 'INVALID_JOB' })
    const capped = await processAudio({ audioPath: mono, look, preview: { start: 2, seconds: 4 }, gainDb: 99, rate: 48000 }, host())
    expect(capped.ok && capped.gainDb).toBe(24)
    expect(capped.ok && capped.warnings.join()).toMatch(/outside what levelling may do/)
  }, 60_000)

  it('a whole recording is still checked against the loudness target', async () => {
    // a target this recording's peaks cannot allow under the ceiling: the limiter holds it far below
    const loud: Look = { chain: [], level: { lufs: -8, ceiling: -1 } }
    const plain = await processAudio({ audioPath: peaky, look: loud }, host())
    expect(plain).toMatchObject({ ok: false, reason: 'LOUDNESS_OFF_TARGET' })
    const g = await levellingGain(peaky, loud, host())
    expect(g.ok).toBe(true)
    if (!g.ok) return
    expect(await processAudio({ audioPath: peaky, look: loud, gainDb: g.gainDb!, rate: g.rate! }, host())).toMatchObject({ ok: false, reason: 'LOUDNESS_OFF_TARGET' })
    // an excerpt with that gain lands where it lands
    expect(await processAudio({ audioPath: peaky, look: loud, gainDb: g.gainDb!, rate: g.rate!, preview: { start: 2, seconds: 4 } }, host())).toMatchObject({ ok: true })
  }, 60_000)
})

describe('discard', () => {
  it('leaves alone what the plugin did not write', async () => {
    const mine = join(tmp, 'keep.flac'); writeFileSync(mine, 'x')
    await discard(mine)
    await discard(mono)
    expect(existsSync(mine) && existsSync(mono)).toBe(true)
  })
})
