/**
 * End to end against the bundled ffmpeg, on synthetic audio (a tone with noise), so the suite
 * does not depend on anyone's recordings. Real-file checks: `npm run audio -- batch|sweep`.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyse, checkLook, discard, LOOK_PRESETS, processAudio, type AudioHost, type Look } from './index'
import { FfmpegError, runFfmpeg } from './ffmpeg'
import { filterText } from './graph'

const bin = ffmpegStatic as unknown as string
const tmp = mkdtempSync(join(tmpdir(), 'yj-audio-'))
const out = join(tmp, 'out')
const logs: string[] = []
const host = (extra: Partial<AudioHost> = {}): AudioHost => ({ outputDir: out, ffmpegPath: bin, log: (l, m) => logs.push(`${l}: ${m}`), ...extra })
const gen = (name: string, lavfi: string, extra: string[] = []) => {
  const p = join(tmp, name)
  execFileSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', lavfi, ...extra, p])
  return p
}
const cleanup = LOOK_PRESETS.cleanup!.look

let voice = '', silent = '', clipped = '', ir = ''
beforeAll(() => {
  // a quiet "voice" (220 Hz with vibrato) over hiss and 50 Hz hum, mono 48 kHz AAC
  voice = gen('voice.m4a', "aevalsrc='0.08*sin(2*PI*(220+8*sin(2*PI*5*t))*t)+0.03*sin(2*PI*660*t)+0.01*sin(2*PI*50*t)+0.004*(random(0)*2-1)':s=48000:d=12", ['-c:a', 'aac', '-b:a', '192k'])
  silent = gen('silent.wav', 'anullsrc=r=48000:cl=mono', ['-t', '3'])
  clipped = gen('clipped.m4a', "aevalsrc='1.42*max(-0.7,min(0.7,1.5*sin(2*PI*300*t)))':s=48000:d=4", ['-c:a', 'aac', '-b:a', '256k'])
  ir = gen('ir.wav', "aevalsrc='(random(0)*2-1)*exp(-7*t/0.5)*0.01':s=48000:d=0.5")
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const leftovers = () => readdirSync(out).filter((f) => f.includes('.part'))

describe('processAudio', () => {
  it('cleanup preset: levels to −14 LUFS under the ceiling, keeps the length, mono', async () => {
    const seen: number[] = []
    const r = await processAudio({ audioPath: voice, look: cleanup }, host({ onProgress: (p) => seen.push(p) }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cached).toBe(false)
    expect(Math.abs(r.after.lufs - -14)).toBeLessThanOrEqual(0.5)
    expect(r.after.truePeak).toBeLessThanOrEqual(-1.5)
    expect(r.warnings).toEqual([])
    expect(r.after.durationSec).toBeCloseTo(12, 1)
    expect(r.inputSec).toBeCloseTo(12, 1)
    expect(r.after).toMatchObject({ channels: 1, sampleRate: 48000 })
    expect(r.gainDb).toBeGreaterThan(5)
    expect(r.file.endsWith(`${r.cacheKey}.flac`)).toBe(true)
    expect(seen.at(-1)).toBe(100)
    expect(seen.every((p, i) => i === 0 || p >= seen[i - 1]!)).toBe(true)
    expect(leftovers()).toEqual([])
  }, 60_000)

  it('cache: ids, labels and bypassed steps don\'t change the key; an option does', async () => {
    const a = await processAudio({ audioPath: voice, look: cleanup }, host())
    const dressed: Look = { ...cleanup, chain: [...cleanup.chain.map((s, i) => ({ ...s, id: `s${i}`, label: 'x' })), { filter: 'volume', options: { volume: 9 }, bypass: true }] }
    const b = await processAudio({ audioPath: voice, look: dressed }, host())
    expect(a.ok && b.ok && b.cached && a.cacheKey === b.cacheKey && b.after.lufs === a.after.lufs).toBe(true)
    const c = await processAudio({ audioPath: voice, look: { ...cleanup, chain: [...cleanup.chain.slice(0, 3), { filter: 'afftdn', options: { nr: 20 } }] } }, host())
    expect(a.ok && c.ok && a.cacheKey !== c.cacheKey).toBe(true)
  }, 60_000)

  it('no levelling: the rack alone, loudness left where it lands', async () => {
    const r = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'highpass', options: { f: 100 } }] } }, host())
    expect(r.ok && r.gainDb).toBe(0)
    expect(r.ok && r.after.lufs).toBeLessThan(-18)
  }, 60_000)

  it('every preset runs and keeps the length', async () => {
    for (const [k, p] of Object.entries(LOOK_PRESETS)) {
      const r = await processAudio({ audioPath: voice, look: p.look, preview: { start: 2, seconds: 6 } }, host())
      expect(r.ok, `${k}: ${!r.ok && r.message}`).toBe(true)
      if (r.ok) expect(r.after.durationSec, k).toBeCloseTo(6, 1)
    }
  }, 60_000)

  it('extra inputs: an impulse response file through afir', async () => {
    const look: Look = { chain: [{ filter: 'asplit', outputs: [[], [{ filter: 'afir', options: { gtype: 'none' }, inputs: [{ kind: 'file', path: ir }] }]], merge: { filter: 'amix', options: { inputs: 2, normalize: false } } }] }
    const r = await processAudio({ audioPath: voice, look, preview: { start: 0, seconds: 4 } }, host())
    expect(r.ok && r.after.durationSec).toBeCloseTo(4, 1)
    const missing = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'afir', inputs: [{ kind: 'file', path: join(tmp, 'gone.wav') }] }] } }, host())
    expect(!missing.ok && missing.reason).toBe('AUDIO_UNREADABLE')
    expect(!missing.ok && missing.errors?.[0]?.path).toBe('chain[0].inputs[0].path')
  }, 60_000)

  it('preview + bypass + level gives a level-matched original for A/B', async () => {
    const proc = await processAudio({ audioPath: voice, preview: { start: 3, seconds: 5 }, look: { ...cleanup, level: { lufs: -18, ceiling: -1 } } }, host())
    expect(proc.ok).toBe(true)
    if (!proc.ok) return
    expect(proc.after.durationSec).toBeCloseTo(5, 1)
    const orig = await processAudio({ audioPath: voice, preview: { start: 3, seconds: 5 }, bypass: true, level: { lufs: proc.after.lufs, ceiling: -1 } }, host())
    expect(orig.ok).toBe(true)
    if (!orig.ok) return
    expect(Math.abs(orig.after.lufs - proc.after.lufs)).toBeLessThanOrEqual(0.5)
    expect(orig.cacheKey).not.toBe(proc.cacheKey)
  }, 60_000)

  it('previews see recording time: fades and enable ranges act where they would in the whole file', async () => {
    const plain = await processAudio({ audioPath: voice, preview: { start: 5, seconds: 2 } }, host())
    const faded = await processAudio({ audioPath: voice, preview: { start: 5, seconds: 2 }, look: { chain: [{ filter: 'afade', options: { type: 'in', start_time: 0, duration: 1 } }] } }, host())
    expect(plain.ok && faded.ok && Math.abs(plain.after.lufs - faded.after.lufs)).toBeLessThanOrEqual(0.1)   // the fade is over by 1 s
    const muteLater = { chain: [{ filter: 'volume', options: { volume: 0 }, enable: 'between(t,6,8)' }] }
    const window3 = await processAudio({ audioPath: voice, preview: { start: 3, seconds: 1 } }, host())
    const before = await processAudio({ audioPath: voice, preview: { start: 3, seconds: 1 }, look: muteLater }, host())
    expect(before.ok && window3.ok && before.after.lufs === window3.after.lufs).toBe(true)
    const inside = await processAudio({ audioPath: voice, preview: { start: 6.5, seconds: 1 }, look: muteLater }, host())
    expect(!inside.ok && inside.reason).toBe('SILENT_OUTPUT')
  }, 60_000)

  it('a converted v1 reverb lands near v1\'s level: amount −16 dB is about 16 dB under the voice', async () => {
    const { lookFromV1 } = await import('./v1')
    const look = lookFromV1({ cleanup: { clicks: { enabled: false }, rumble: { enabled: false }, hiss: { enabled: false } }, reverb: { enabled: true, amount: -16, decay: 1.2 }, loudness: { enabled: false }, fades: { in: 0 } })
    const wetOnly = { chain: [{ ...look.chain[0]!, outputs: [[{ filter: 'volume', options: { volume: 0 } }], look.chain[0]!.outputs![1]!] }] }
    const dry = await processAudio({ audioPath: voice }, host())
    const wet = await processAudio({ audioPath: voice, look: wetOnly }, host())
    expect(dry.ok && wet.ok).toBe(true)
    if (!dry.ok || !wet.ok) return
    expect(dry.after.lufs - wet.after.lufs).toBeGreaterThan(14)
    expect(dry.after.lufs - wet.after.lufs).toBeLessThan(21)
  }, 60_000)

  it('a preview running past the end is clipped to the real end', async () => {
    const r = await processAudio({ audioPath: voice, preview: { start: 10, seconds: 30 } }, host())
    expect(r.ok && r.after.durationSec).toBeCloseTo(2, 1)
    const bad = await processAudio({ audioPath: voice, preview: { start: 50, seconds: 5 } }, host())
    expect(!bad.ok && bad.reason).toBe('INVALID_JOB')
  }, 60_000)

  it('reports what the rack did: length changes, endless sources, clipped peaks', async () => {
    const faster = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'atempo', options: { tempo: 2 } }] } }, host())
    expect(faster.ok && faster.after.durationSec).toBeCloseTo(6, 1)
    expect(faster.ok && faster.warnings[0]).toMatch(/changes the length/)
    const endless = await processAudio({ audioPath: voice, preview: { start: 0, seconds: 2 }, look: { chain: [{ filter: 'amix', inputs: [{ kind: 'generate', filter: 'sine', chain: [{ filter: 'volume', options: { volume: 0.01 } }] }] }] } }, host())
    expect(endless.ok && endless.after.durationSec).toBeCloseTo(62, 0)
    expect(endless.ok && endless.warnings[0]).toMatch(/cut at 62 s/)
    const hot = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'volume', options: { volume: 20 } }] } }, host())
    expect(hot.ok && hot.after.samplePeak).toBeGreaterThan(-0.05)
    expect(hot.ok && hot.warnings.join()).toMatch(/clipped/)
  }, 120_000)

  it('refuses bad input with a reason, never throws', async () => {
    const lookErr = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'highpass', options: { f: -5 } }] } }, host())
    expect(!lookErr.ok && lookErr.reason).toBe('INVALID_LOOK')
    expect(!lookErr.ok && lookErr.errors?.[0]?.path).toBe('chain[0].options.f')
    const refused = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'highpass' }, { filter: 'acrossover', options: { split: '200 nope' }, outputs: [[], [], []], merge: { filter: 'amix', options: { inputs: 3 } } }] } }, host())
    expect(!refused.ok && refused.reason).toBe('INVALID_LOOK')
    expect(!refused.ok && refused.errors?.[0]?.path).toBe('chain[1]')
    const missing = await processAudio({ audioPath: join(tmp, 'nope.m4a') }, host())
    expect(!missing.ok && missing.reason).toBe('AUDIO_UNREADABLE')
    const relative = await processAudio({ audioPath: 'voice.m4a' }, host())
    expect(!relative.ok && relative.reason).toBe('INVALID_JOB')
    const notAudio = join(tmp, 'notaudio.m4a'); writeFileSync(notAudio, 'hello')
    const garbage = await processAudio({ audioPath: notAudio }, host())
    expect(!garbage.ok && garbage.reason).toBe('AUDIO_UNREADABLE')
    const noBin = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'adeclick' }] } }, host({ ffmpegPath: join(tmp, 'no-ffmpeg') }))
    expect(!noBin.ok && noBin.reason).toBe('FFMPEG_UNUSABLE')
  }, 60_000)

  it('silent input: levelling refuses to blow it up; a silent result is refused', async () => {
    const lv = await processAudio({ audioPath: silent, look: cleanup }, host())
    expect(!lv.ok && lv.reason).toBe('SILENT_INPUT')
    const plain = await processAudio({ audioPath: silent }, host())
    expect(!plain.ok && plain.reason).toBe('SILENT_OUTPUT')
  }, 60_000)

  it('cancel stops ffmpeg and leaves no part file', async () => {
    const ac = new AbortController()
    const p = processAudio({ audioPath: voice, look: { chain: [{ filter: 'anlmdn' }, { filter: 'afftdn' }] } }, host({ signal: ac.signal }))
    setTimeout(() => ac.abort(), 150)
    const r = await p
    expect(!r.ok && r.reason).toBe('CANCELLED')
    expect(leftovers()).toEqual([])
  }, 60_000)

  it('discard removes the file and its sidecar', async () => {
    const r = await processAudio({ audioPath: voice, look: { chain: [{ filter: 'volume', options: { volume: 0.9 } }] } }, host())
    if (!r.ok) throw new Error(r.message)
    await discard(r.file)
    expect(readdirSync(out).some((f) => f.startsWith(r.cacheKey))).toBe(false)
  }, 60_000)
})

describe('checkLook', () => {
  it('ok, with the output format the rack produces', async () => {
    expect(await checkLook(cleanup, { ffmpegPath: bin })).toEqual({ ok: true, sampleRate: 48000, channels: 1 })
    expect(await checkLook({ chain: [{ filter: 'aresample', options: { sample_rate: 96000 } }, { filter: 'pan', options: { args: 'stereo|c0=c0|c1=c0' } }] }, { ffmpegPath: bin })).toEqual({ ok: true, sampleRate: 96000, channels: 2 })
    expect(await checkLook({ chain: [] }, { ffmpegPath: bin }, { channels: 2 })).toEqual({ ok: true, sampleRate: 48000, channels: 2 })
  }, 30_000)

  it('maps ffmpeg\'s refusal to the step', async () => {
    const r = await checkLook({ chain: [{ filter: 'highpass' }, { filter: 'aeval', options: { exprs: 'val(0)*nope' } }] }, { ffmpegPath: bin })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors[0]!.path).toBe('chain[1]')
    expect(r.errors[0]!.message).toMatch(/^aeval: /)
  }, 30_000)
})

describe('ffmpeg runner', () => {
  it('values round-trip exactly through both levels of ffmpeg parsing', () => {
    for (const v of ['a:b', "it's", 'x,y;z', '[br]', 'back\\slash', "q'u:o,t[e];s\\", '  spaced  ', 'ü ½ €']) {
      const g = `[0:a]${filterText('ametadata', { mode: 'add', key: 'k', value: v })},${filterText('ametadata', { mode: 'print', key: 'k', file: '-' })}[out]`
      const r = spawnSync(bin, ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'sine=d=0.03', '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], { encoding: 'utf8' })
      expect(/k=(.*)/.exec(r.stdout)?.[1], v).toBe(v)
    }
  })

  it('kills an ffmpeg that stops making progress (TIMEOUT), instead of waiting forever', async () => {
    // ffmpeg reading raw audio from a stdin nobody writes to: alive, but never progresses
    const t0 = Date.now()
    const err = await runFfmpeg(bin, ['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0', '-f', 'null', '-'], { stallMs: 1500 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FfmpegError)
    expect((err as FfmpegError).reason).toBe('TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 20_000)

  it('a filter that keeps talking but never moves still times out (arealtime at a near-zero speed)', async () => {
    const t0 = Date.now()
    const err = await runFfmpeg(bin, ['-hide_banner', '-f', 'lavfi', '-t', '1', '-i', 'sine', '-af', 'arealtime=speed=1e-300', '-f', 'null', '-'], { stallMs: 1500, maxMs: 6000 }).catch((e: unknown) => e)
    expect((err as FfmpegError).reason).toBe('TIMEOUT')
    expect(Date.now() - t0).toBeLessThan(10_000)
  }, 20_000)
})

describe('analyse', () => {
  it('measures a normal recording without false clipping', async () => {
    const a = await analyse(voice, { ffmpegPath: bin })
    expect(a.durationSec).toBeCloseTo(12, 1)
    expect(a.channels).toBe(1)
    expect(a.sampleRate).toBe(48000)
    expect(a.lufs).toBeLessThan(-18)
    expect(a.clipped).toBe(false)
    expect(a.hotSamplesPct).toBeLessThan(0.1)
    expect(Number.isFinite(a.hissDb) && Number.isFinite(a.rumbleDb)).toBe(true)
    expect(a.hints.some((h) => h.startsWith('Quiet recording'))).toBe(true)
  }, 60_000)

  it('flags a flattened waveform as clipped', async () => {
    const a = await analyse(clipped, { ffmpegPath: bin })
    expect(a.clipped).toBe(true)
    expect(a.hotSamplesPct).toBeGreaterThan(10)
  }, 60_000)

  it('flags silence', async () => {
    const a = await analyse(silent, { ffmpegPath: bin })
    expect(a.hints).toContain('Silent or nearly silent recording.')
  }, 60_000)
})
