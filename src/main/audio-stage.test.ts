/**
 * The audio rules end to end against the bundled ffmpeg, on synthetic audio: capture a rule from reference
 * recordings, then run the upload stage on another recording. No Electron, no uploads.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ffmpegStatic from 'ffmpeg-static'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), isPackaged: false }, protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} }, BrowserWindow: class {}, nativeImage: {} }))
import { defaultModules, toLook } from '../core/audio-modules'
import { toneDistance } from '../core/audio-steer'
import { eqResponseDb } from '../core/eq-response'
import { measure } from '../plugins/audio/index'
import { EMPTY_AUDIO_RULES, type AudioRule, type AudioRulesState } from '../core/audio-rules'
import { MEASURE_BANDS } from '../plugins/audio/types'
import { captureRule, followerSettings, targetFor } from './audio-rules'
import { prepareUploadAudio } from './audio-stage'

const bin = ffmpegStatic as unknown as string
const library = mkdtempSync(join(tmpdir(), 'yj-rules-'))
const folder = join(library, 'Reciter')
/** A "voice": a 220 Hz tone with partials up to 3.5 kHz over a little hiss, `tilt` dB per partial darker, at `gain`. */
const voice = (name: string, gain: number, tilt: number) => {
  const parts = [220, 440, 880, 1760, 3520].map((f, i) => `${(0.2 * gain * Math.pow(10, (-(6 + tilt) * i) / 20)).toFixed(5)}*sin(2*PI*${f}*t)*(0.6+0.4*sin(2*PI*0.7*t))`).join('+')
  const p = join(folder, name)
  execFileSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${parts}+0.0005*(random(0)*2-1)':s=48000:d=14`, '-c:a', 'aac', '-b:a', '192k', p])
  return { rel: `Reciter/${name}`, path: p }
}
let good = { rel: '', path: '' }, good2 = good, dull = good
const files = new Map<string, { rel: string; path: string }>()
beforeAll(() => {
  mkdirSync(folder, { recursive: true })
  good = voice('good.m4a', 1, 0); good2 = voice('good2.m4a', 0.5, 1); dull = voice('dull.m4a', 0.7, 5)
  for (const f of [good, good2, dull]) files.set(f.rel, f)
})
afterAll(() => rmSync(library, { recursive: true, force: true }))

const settings = () => {
  const m = defaultModules()
  m.eq = { ...m.eq, on: true, hp: { on: true, freq: 80, q: 0.707 }, hs: { on: true, freq: 1500, gain: 4, q: 0.7 } }
  m.level = { on: true, lufs: -18, ceiling: -1 }
  return m
}
const rule = (): AudioRule => ({ id: 'r1', reciterKey: 'reciter', refs: [{ recordId: good.rel, modules: settings() }, { recordId: good2.rel, modules: null }], target: null })

describe('audio rules on real audio', () => {
  it('captures a rule: every reference processed (followers auto-set to sound like the first), the target their mean', async () => {
    const stages: string[] = []
    const t = await captureRule(library, rule(), (id) => files.get(id) ?? null, (s) => stages.push(s))
    expect(t.count).toBe(2)
    expect(t.hp).toBe(80)
    expect(t.lufs).toBe(-18)
    expect(t.tone).toHaveLength(MEASURE_BANDS.length)
    expect(stages[0]).toBe('Measuring reference 1 of 2…')
    expect(stages).toContain('Measuring reference 2 of 2…')
    expect(stages.some((x) => x.startsWith('Reference 2 of 2: '))).toBe(true)   // the follower being auto-set to sound like the first
    // the +4 dB shelf is in the target: its 3.5 kHz region sits above the unprocessed first reference's
    const single = await captureRule(library, { ...rule(), refs: [{ recordId: good.rel, modules: defaultModules() }] }, (id) => files.get(id) ?? null)
    const b = MEASURE_BANDS.indexOf(3150)
    expect(t.tone[b]! - single.tone[b]!).toBeGreaterThan(1.5)
    await expect(captureRule(library, { ...rule(), refs: [] }, () => null)).rejects.toThrow(/at least one reference/)
    await expect(captureRule(library, rule(), (id) => (id === good.rel ? good : null))).rejects.toThrow(/no longer in the library/)
  }, 120_000)

  it('a follower is auto-set to sound like the first reference after its settings, not given a copy of its knobs', async () => {
    const base = settings()
    const f = (await followerSettings(library, base, good, dull)).modules
    // dull.m4a is 5 dB per partial darker than good.m4a: to sound like good + its +4 dB shelf it needs more top than the shelf alone
    expect(eqResponseDb(f.eq, 3000)).toBeGreaterThan(eqResponseDb(base.eq, 3000) + 2)
    expect(f.eq.hp).toMatchObject({ on: true, freq: 80 })
    expect(f.level.on).toBe(true)
    // and it really does: processed with those settings, the follower's tone is far closer to the first reference's result
    const target = await captureRule(library, { id: 'x', reciterKey: null, refs: [{ recordId: good.rel, modules: base }], target: null }, (id) => files.get(id) ?? null)
    const raw = await measure(dull.path, { ffmpegPath: bin }), after = await measure(dull.path, { ffmpegPath: bin }, toLook(f))
    expect(toneDistance(after!, target)).toBeLessThan(toneDistance(raw!, target) / 2)
    // the same request again is answered from memory
    const t0 = Date.now()
    expect((await followerSettings(library, base, good, dull)).modules).toEqual(f)
    expect(Date.now() - t0).toBeLessThan(200)
  }, 180_000)

  it('the upload stage: off → the original; on → the recording steered to the rule and rendered; cleaned up afterwards', async () => {
    const off = await prepareUploadAudio({ library, state: { ...EMPTY_AUDIO_RULES }, recordId: dull.rel, reciterKey: 'reciter', rel: dull.rel, audioPath: dull.path })
    expect(off).toMatchObject({ ok: true, audio: dull.path, key: 'original', via: 'off' })

    const captured = { ...rule(), target: await captureRule(library, rule(), (id) => files.get(id) ?? null) }
    const state: AudioRulesState = { v: 1, applyToUploads: true, rules: [captured] }
    expect(targetFor(state, 'reciter')?.via).toBe('reciter')
    const seen: string[] = []
    const r = await prepareUploadAudio({ library, state, recordId: dull.rel, reciterKey: 'reciter', rel: dull.rel, audioPath: dull.path, onProgress: (_p, d) => seen.push(d) })
    expect(r.ok, r.ok ? '' : r.message).toBe(true)
    if (!r.ok) return
    expect(r.via).toBe('reciter')
    expect(r.key).not.toBe('original')
    expect(r.audio.endsWith('.flac')).toBe(true)
    expect(existsSync(r.audio)).toBe(true)
    expect(r.toneAfter!).toBeLessThan(3)
    expect(seen).toContain('Rendering')
    // ffmpeg can make the video from it (what the pipeline does next)
    const mp4 = join(library, 'out.mp4'), png = join(library, 'frame.png')
    execFileSync(bin, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=320x180:d=1', '-frames:v', '1', png])
    execFileSync(bin, ['-y', '-v', 'error', '-loop', '1', '-framerate', '2', '-i', png, '-i', r.audio, '-c:v', 'libx264', '-tune', 'stillimage', '-r', '2', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-f', 'mp4', mp4])
    expect(existsSync(mp4)).toBe(true)
    await r.cleanup()
    expect(existsSync(r.audio)).toBe(false)
  }, 180_000)

  it('holds a really bad result instead of passing it off: the rule cannot bring this recording near its target', async () => {
    const t = await captureRule(library, rule(), (id) => files.get(id) ?? null)
    // a target no EQ within its limits can reach from this recording: 40 dB more above 1 kHz
    const impossible = { ...t, tone: t.tone.map((v, b) => v + (MEASURE_BANDS[b]! >= 1000 ? 40 : 0)) }
    const r = await prepareUploadAudio({ library, state: { v: 1, applyToUploads: true, rules: [{ ...rule(), target: impossible }] }, recordId: dull.rel, reciterKey: 'reciter', rel: dull.rel, audioPath: dull.path })
    expect(r).toMatchObject({ ok: false, reason: 'AUDIO_POOR' })
    if (!r.ok) expect(r.message).toMatch(/could not bring this recording near its target/)
    const gone = await prepareUploadAudio({ library, state: { v: 1, applyToUploads: true, rules: [{ ...rule(), target: t }] }, recordId: 'x', reciterKey: 'reciter', rel: 'Reciter/missing.m4a', audioPath: join(folder, 'missing.m4a') })
    expect(gone).toMatchObject({ ok: false, reason: 'AUDIO_FAILED' })
  }, 180_000)
})
