/**
 * End to end against the bundled ffmpeg, on synthetic audio (a tone with noise), so the suite
 * does not depend on anyone's recordings. Real-file checks: `npm run audio -- batch|sweep`.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { analyse, discard, processAudio, type AudioHost } from './index'
import { FfmpegError, runFfmpeg } from './ffmpeg'

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

let voice = '', silent = '', clipped = ''
beforeAll(() => {
  // a quiet "voice" (220 Hz with harmonics-ish vibrato) over hiss and 50 Hz hum, mono 48 kHz AAC
  voice = gen('voice.m4a', "aevalsrc='0.08*sin(2*PI*(220+8*sin(2*PI*5*t))*t)+0.03*sin(2*PI*660*t)+0.01*sin(2*PI*50*t)+0.004*(random(0)*2-1)':s=48000:d=12", ['-c:a', 'aac', '-b:a', '192k'])
  silent = gen('silent.wav', 'anullsrc=r=48000:cl=mono', ['-t', '3'])
  // hard-clipped tone, then AAC like every real recording (the codec smears the flat tops)
  clipped = gen('clipped.m4a', "aevalsrc='1.42*max(-0.7,min(0.7,1.5*sin(2*PI*300*t)))':s=48000:d=4", ['-c:a', 'aac', '-b:a', '256k'])
})
afterAll(() => rmSync(tmp, { recursive: true, force: true }))

const leftovers = () => readdirSync(out).filter((f) => f.includes('.part'))

describe('processAudio', () => {
  it('factory look: levels to −14 LUFS under the ceiling, keeps the length, mono', async () => {
    const seen: number[] = []
    const r = await processAudio({ audioPath: voice }, host({ onProgress: (p) => seen.push(p) }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.cached).toBe(false)
    expect(Math.abs(r.after.lufs - -14)).toBeLessThanOrEqual(0.5)
    expect(r.after.truePeak).toBeLessThanOrEqual(-1.5)
    expect(r.warnings).toEqual([])
    expect(r.after.durationSec).toBeCloseTo(12, 1)
    expect(r.after.channels).toBe(1)
    expect(r.gainDb).toBeGreaterThan(5)
    expect(r.file.endsWith(`${r.cacheKey}.flac`)).toBe(true)
    expect(seen.at(-1)).toBe(100)
    expect(seen.every((p, i) => i === 0 || p >= seen[i - 1]!)).toBe(true)
    expect(leftovers()).toEqual([])
  }, 60_000)

  it('same job again is a cache hit with the same measurements', async () => {
    const a = await processAudio({ audioPath: voice }, host())
    const b = await processAudio({ audioPath: voice, look: {} }, host())
    expect(a.ok && b.ok && b.cached && a.cacheKey === b.cacheKey && b.after.lufs === a.after.lufs).toBe(true)
  }, 60_000)

  it('a different look is a different file', async () => {
    const a = await processAudio({ audioPath: voice }, host())
    const b = await processAudio({ audioPath: voice, look: { cleanup: { hiss: { amount: 20 } } } }, host())
    expect(a.ok && b.ok && a.cacheKey !== b.cacheKey).toBe(true)
  }, 60_000)

  it('reverb makes it stereo and still lands on target', async () => {
    const r = await processAudio({ audioPath: voice, look: { reverb: { enabled: true, decay: 2.2 } } }, host())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.after.channels).toBe(2)
    expect(Math.abs(r.after.lufs - -14)).toBeLessThanOrEqual(0.5)
    expect(r.after.durationSec).toBeCloseTo(12, 1)
  }, 60_000)

  it('preview + bypass at matchLufs gives a level-matched A/B pair', async () => {
    const proc = await processAudio({ audioPath: voice, preview: { start: 3, seconds: 5 }, look: { loudness: { target: -18 } } }, host())
    expect(proc.ok).toBe(true)
    if (!proc.ok) return
    expect(proc.after.durationSec).toBeCloseTo(5, 1)
    const orig = await processAudio({ audioPath: voice, preview: { start: 3, seconds: 5 }, bypass: true, matchLufs: proc.after.lufs }, host())
    expect(orig.ok).toBe(true)
    if (!orig.ok) return
    expect(Math.abs(orig.after.lufs - proc.after.lufs)).toBeLessThanOrEqual(0.5)
    expect(orig.cacheKey).not.toBe(proc.cacheKey)
  }, 60_000)

  it('a preview running past the end is clipped to the real end', async () => {
    const r = await processAudio({ audioPath: voice, preview: { start: 10, seconds: 30 } }, host())
    expect(r.ok && r.after.durationSec).toBeCloseTo(2, 1)
    const bad = await processAudio({ audioPath: voice, preview: { start: 50, seconds: 5 } }, host())
    expect(!bad.ok && bad.reason).toBe('INVALID_JOB')
  }, 60_000)

  it('refuses bad input with a reason, never throws', async () => {
    const lookErr = await processAudio({ audioPath: voice, look: { reverb: { decay: 60 } } as never }, host())
    expect(!lookErr.ok && lookErr.reason).toBe('INVALID_LOOK')
    expect(!lookErr.ok && lookErr.message).toContain('reverb.decay')
    const missing = await processAudio({ audioPath: join(tmp, 'nope.m4a') }, host())
    expect(!missing.ok && missing.reason).toBe('AUDIO_UNREADABLE')
    const relative = await processAudio({ audioPath: 'voice.m4a' }, host())
    expect(!relative.ok && relative.reason).toBe('INVALID_JOB')
    const notAudio = join(tmp, 'notaudio.m4a'); writeFileSync(notAudio, 'hello')
    const garbage = await processAudio({ audioPath: notAudio }, host())
    expect(!garbage.ok && garbage.reason).toBe('AUDIO_UNREADABLE')
    const noBin = await processAudio({ audioPath: voice, look: { fades: { in: 1 } } }, host({ ffmpegPath: join(tmp, 'no-ffmpeg') }))
    expect(!noBin.ok && noBin.reason).toBe('FFMPEG_UNUSABLE')
  }, 60_000)

  it('silent input is refused instead of being blown up by +24 dB', async () => {
    const r = await processAudio({ audioPath: silent }, host())
    expect(!r.ok && r.reason).toBe('SILENT_INPUT')
  }, 60_000)

  it('cancel stops ffmpeg and leaves no part file', async () => {
    const ac = new AbortController()
    const p = processAudio({ audioPath: voice, look: { cleanup: { declip: { enabled: true } }, reverb: { enabled: true, decay: 6 } } }, host({ signal: ac.signal }))
    setTimeout(() => ac.abort(), 150)
    const r = await p
    expect(!r.ok && r.reason).toBe('CANCELLED')
    expect(leftovers()).toEqual([])
  }, 60_000)

  it('discard removes the file and its sidecar', async () => {
    const r = await processAudio({ audioPath: voice, look: { fades: { out: 2 } } }, host())
    if (!r.ok) throw new Error(r.message)
    await discard(r.file)
    expect(readdirSync(out).some((f) => f.startsWith(r.cacheKey))).toBe(false)
  }, 60_000)
})

describe('watchdog', () => {
  it('kills an ffmpeg that stops making progress (TIMEOUT), instead of waiting forever', async () => {
    // ffmpeg reading raw audio from a stdin nobody writes to: alive, but never progresses
    const t0 = Date.now()
    const err = await runFfmpeg(bin, ['-f', 's16le', '-ar', '48000', '-ac', '1', '-i', 'pipe:0', '-f', 'null', '-'], { stallMs: 1500 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(FfmpegError)
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
    expect(a.hints.some((h) => h.includes('Repair clipping'))).toBe(true)
  }, 60_000)

  it('flags silence', async () => {
    const a = await analyse(silent, { ffmpegPath: bin })
    expect(a.hints).toContain('Silent or nearly silent recording.')
  }, 60_000)
})
