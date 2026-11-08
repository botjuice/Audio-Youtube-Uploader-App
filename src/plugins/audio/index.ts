/**
 * Audio plugin — the only public surface.
 *
 *   processAudio(job, host) → { ok, file, cacheKey, after, … } | { ok: false, reason, message }
 *   analyse(audioPath, host) → AudioAnalysis
 *
 * Rules: data in, a file or a reason out. Imports nothing from src/main or src/core. The original
 * recording is never written to. Every output is verified (length, not silent, loudness) before
 * it is handed back.
 */
import { promises as fs } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { analyseFile } from './analyse'
import { audioFile, cacheKey, irDir, metaFile, nonEmpty, partFile, writeAtomic } from './cache'
import { buildGraph, n, outputChannels } from './chain'
import { FfmpegError, checkFfmpeg, parseEbur, probe, runFfmpeg, type Probe } from './ffmpeg'
import { irSpec, irWav } from './ir'
import { canonicalLook, validateLook, type Look } from './look'
import type { AfterMeasure, AudioAnalysis, AudioHost, AudioJob, AudioReason, AudioResult, PluginManifest } from './types'

export type { AfterMeasure, AudioAnalysis, AudioHost, AudioJob, AudioReason, AudioResult, PluginManifest } from './types'
export {
  DEFAULT_LOOK, LOOK_FIELDS, LOOK_PRESETS, LOOK_SCHEMA, REVERB_PRESETS, canonicalLook, controllingToggle, describeLook, validateLook,
  type Field, type Look, type LookError, type LookFieldInfo, type LookPatch, type NumberField, type ToggleField,
} from './look'

export const manifest: PluginManifest = { id: 'audio', version: '1.0.1', chainVersion: 2, lookVersion: 1 }

/** The loudness stage never moves a file by more than this (a near-silent file must not be blown up). */
export const MAX_GAIN_DB = 24
export const MIN_GAIN_DB = -30
/** Processed length must match the source within this. */
export const DURATION_TOLERANCE_S = 0.05
/** Loudness further than this from the target fails the job (closer than 1 LU is silent; 1–3 LU is a warning). */
export const LOUDNESS_FAIL_LU = 3
/** Below this a file counts as silent. */
const SILENT_LUFS = -60
const PREVIEW_MAX_S = 600

type Fail = { ok: false; reason: AudioReason; message: string }
const fail = (reason: AudioReason, message: string): Fail => ({ ok: false, reason, message })
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

interface Meta { after: AfterMeasure; gainDb: number; warnings: string[] }

export async function processAudio(job: AudioJob, host: AudioHost): Promise<AudioResult> {
  // ── 1. job + look ──
  if (!job || typeof job.audioPath !== 'string' || !isAbsolute(job.audioPath)) return fail('INVALID_JOB', 'audioPath must be an absolute path.')
  if (job.preview) {
    const { start, seconds } = job.preview
    if (!(Number.isFinite(start) && start >= 0)) return fail('INVALID_JOB', 'preview.start must be ≥ 0 seconds.')
    if (!(Number.isFinite(seconds) && seconds > 0 && seconds <= PREVIEW_MAX_S)) return fail('INVALID_JOB', `preview.seconds must be between 0 and ${PREVIEW_MAX_S}.`)
  }
  if (job.matchLufs !== undefined && !(Number.isFinite(job.matchLufs) && job.matchLufs >= -40 && job.matchLufs <= -5)) return fail('INVALID_JOB', 'matchLufs must be between −40 and −5.')
  const v = validateLook(job.look ?? {})
  if (!v.ok) return fail('INVALID_LOOK', v.errors.map((e) => `${e.key}: ${e.message}`).join('; '))
  const look = v.look
  const bypass = !!job.bypass

  let stat: { size: number; mtimeMs: number }
  try {
    const st = await fs.stat(job.audioPath)
    if (!st.isFile() || st.size === 0) throw new Error('not a file or empty')
    await fs.access(job.audioPath, fs.constants.R_OK)
    stat = { size: st.size, mtimeMs: st.mtimeMs }
  } catch (e) {
    return fail('AUDIO_UNREADABLE', `Recording cannot be read: ${job.audioPath} (${errMsg(e)})`)
  }

  // ── 2. cache ──
  const shape = { look: bypass ? null : canonicalLook(look), ceiling: look.limiter.ceiling, target: bypass ? (job.matchLufs ?? look.loudness.target) : null, preview: job.preview ?? null, bypass }
  const key = cacheKey(job.audioPath, stat, manifest.chainVersion, shape)
  const out = audioFile(host.outputDir, key)
  const metaPath = metaFile(host.outputDir, key)
  if ((await nonEmpty(out)) && (await nonEmpty(metaPath))) {
    try {
      const meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as Meta
      host.onProgress?.(100)
      return { ok: true, file: out, cacheKey: key, cached: true, ...meta }
    } catch { /* unreadable sidecar: process again */ }
  }

  const bin = host.ffmpegPath
  const progress = (from: number, to: number, total: number) => (sec: number) => host.onProgress?.(Math.min(99, Math.round(from + (to - from) * Math.min(1, sec / Math.max(total, 0.001)))))
  let part: string | null = null
  try {
    await checkFfmpeg(bin)
    await fs.mkdir(host.outputDir, { recursive: true })
    host.onProgress?.(0)

    // ── 3. what we are working with ──
    let src: Probe
    try { src = await probe(bin, job.audioPath) } catch (e) { return fail('AUDIO_UNREADABLE', `ffmpeg cannot read ${job.audioPath}: ${errMsg(e)}`) }
    const start = job.preview?.start ?? 0
    if (start >= src.durationSec) return fail('INVALID_JOB', `preview.start (${start} s) is beyond the recording's end (${src.durationSec.toFixed(1)} s).`)
    const expected = job.preview ? Math.min(job.preview.seconds, src.durationSec - start) : src.durationSec
    const touchesStart = start === 0
    const touchesEnd = start + expected >= src.durationSec - 0.01
    const inputArgs = ['-hide_banner', ...(job.preview ? ['-ss', n(start), '-t', n(expected)] : []), '-i', job.audioPath]
    const wantsReverb = !bypass && look.reverb.enabled
    let irArgs: string[] = []
    if (wantsReverb) {
      const spec = irSpec(look)
      const irPath = join(irDir(host.outputDir), `${cacheKey('ir', { size: 0, mtimeMs: 0 }, manifest.chainVersion, { spec })}.wav`)
      if (!(await nonEmpty(irPath))) { await fs.mkdir(irDir(host.outputDir), { recursive: true }); await writeAtomic(irPath, irWav(spec)) }
      irArgs = ['-i', irPath]
    }
    const level = bypass ? true : look.loudness.enabled
    const target = bypass ? (job.matchLufs ?? look.loudness.target) : look.loudness.target
    const warnings: string[] = []

    // ── 4. measure (pass 1) ──
    let gainDb = 0
    if (level) {
      const g = buildGraph(look, { channels: src.channels, mode: 'measure', bypass })
      const r = await runFfmpeg(bin, [...inputArgs, ...irArgs, '-filter_complex', g, '-map', '[out]', '-f', 'null', '-'], { signal: host.signal, onTime: progress(0, 40, expected) })
      const m = parseEbur(r.stderr)
      if (!m) return fail('PROCESS_FAILED', 'Could not read the loudness measurement from ffmpeg.')
      if (!(m.lufs > SILENT_LUFS)) return fail('SILENT_INPUT', `The ${job.preview ? 'excerpt' : 'recording'} is silent (${Number.isFinite(m.lufs) ? `${m.lufs} LUFS` : 'no signal'}).`)
      gainDb = target - m.lufs
      if (gainDb > MAX_GAIN_DB || gainDb < MIN_GAIN_DB) {
        const capped = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb))
        warnings.push(`Needed ${gainDb.toFixed(1)} dB to reach ${target} LUFS; capped at ${capped} dB.`)
        gainDb = capped
      }
    }

    // ── 5. render (pass 2) ──
    const fadeIn = !bypass && touchesStart ? Math.min(look.fades.in, expected / 3) : 0
    const fadeOutD = !bypass && touchesEnd ? Math.min(look.fades.out, expected / 3) : 0
    const g = buildGraph(look, { channels: src.channels, mode: 'render', bypass, gainDb, fadeIn, fadeOut: { start: expected - fadeOutD, duration: fadeOutD } })
    part = partFile(out)
    await runFfmpeg(bin, [...inputArgs, ...irArgs, '-filter_complex', g, '-map', '[out]', '-c:a', 'flac', '-sample_fmt', 's32', '-ar', '48000', '-y', part],
      { signal: host.signal, onTime: progress(level ? 40 : 0, 90, expected) })

    // ── 6. verify ──
    const got = await probe(bin, part).catch(() => null)
    if (!got) return fail('PROCESS_FAILED', 'The processed file cannot be read back.')
    if (Math.abs(got.durationSec - expected) > DURATION_TOLERANCE_S) {
      return fail('DURATION_MISMATCH', `Processed audio is ${got.durationSec.toFixed(2)} s, expected ${expected.toFixed(2)} s — refusing to use it.`)
    }
    const r = await runFfmpeg(bin, ['-hide_banner', '-i', part, '-af', 'ebur128=peak=true:framelog=verbose', '-f', 'null', '-'], { signal: host.signal, onTime: progress(90, 99, got.durationSec) })
    const after = parseEbur(r.stderr)
    if (!after || !(after.lufs > SILENT_LUFS)) return fail('SILENT_OUTPUT', 'The processed audio is silent — the chain removed the signal.')
    if (level) {
      const off = after.lufs - target
      if (Math.abs(off) > LOUDNESS_FAIL_LU && !warnings.length) {
        return fail('LOUDNESS_OFF_TARGET', `Processed loudness is ${after.lufs} LUFS, target ${target} — ${Math.abs(off).toFixed(1)} LU off (the peak ceiling may be holding it down).`)
      }
      if (Math.abs(off) > 1) warnings.push(`Loudness landed at ${after.lufs} LUFS (target ${target}).`)
    }
    if (after.truePeak > look.limiter.ceiling + 0.2) warnings.push(`True peak ${after.truePeak} dBTP is above the ${look.limiter.ceiling} dB ceiling.`)
    const expectCh = outputChannels(look, src.channels, bypass)
    if (got.channels !== expectCh) warnings.push(`Expected ${expectCh} channel(s), got ${got.channels}.`)

    const meta: Meta = { after: { durationSec: got.durationSec, channels: got.channels, lufs: after.lufs, truePeak: after.truePeak }, gainDb: +gainDb.toFixed(2), warnings }
    await fs.rename(part, out); part = null
    await writeAtomic(metaPath, JSON.stringify(meta))
    host.log('info', `Audio processed (${bypass ? 'bypass' : 'look'}${job.preview ? `, preview ${start}+${expected.toFixed(1)} s` : ''}) → ${after.lufs} LUFS, peak ${after.truePeak} dBTP → ${key}`)
    host.onProgress?.(100)
    return { ok: true, file: out, cacheKey: key, cached: false, ...meta }
  } catch (e) {
    if (e instanceof FfmpegError) {
      if (e.reason !== 'CANCELLED') host.log('error', `Audio processing failed: ${e.message}`)
      return fail(e.reason, e.message)
    }
    host.log('error', `Audio processing failed: ${errMsg(e)}`)
    return fail('PROCESS_FAILED', errMsg(e))
  } finally {
    if (part) await fs.rm(part, { force: true }).catch(() => {})
  }
}

/** Measure a recording (or a processed file). Throws only for unreadable files / unusable ffmpeg. */
export async function analyse(audioPath: string, host: Pick<AudioHost, 'ffmpegPath' | 'signal'>): Promise<AudioAnalysis> {
  await checkFfmpeg(host.ffmpegPath)
  return analyseFile(host.ffmpegPath, audioPath, host.signal)
}

/** Delete a processed file and its sidecar (e.g. after a successful upload). Safe if already gone. */
export async function discard(file: string): Promise<void> {
  await fs.rm(file, { force: true })
  await fs.rm(file.replace(/\.flac$/, '.json'), { force: true })
}

/** The exact filter graph a look produces — for logs, the CLI and bug reports. */
export function explain(lookPatch: unknown, channels = 1): { ok: true; measure: string; render: string } | { ok: false; message: string } {
  const v = validateLook(lookPatch ?? {})
  if (!v.ok) return { ok: false, message: v.errors.map((e) => `${e.key}: ${e.message}`).join('; ') }
  const look: Look = v.look
  return { ok: true, measure: buildGraph(look, { channels, mode: 'measure' }), render: buildGraph(look, { channels, mode: 'render', gainDb: 0, fadeIn: look.fades.in, fadeOut: { start: 0, duration: look.fades.out } }) }
}
