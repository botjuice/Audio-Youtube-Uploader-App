/**
 * Audio plugin — the only public surface. A generic audio editor over ffmpeg.
 *
 *   processAudio(job, host) → { ok, file, cacheKey, after, … } | { ok: false, reason, message, errors? }
 *   checkLook(look, host)   → ffmpeg's verdict on a look in ~100 ms, errors mapped to steps
 *   levellingGain(audioPath, look, host) → the one gain levelling gives the whole recording, nothing rendered
 *   analyse(audioPath, host) → AudioAnalysis                      loudness, peaks, hiss, rumble, clipping
 *   measure(audioPath, host, look?, span?) → Measure | null       tone and level behaviour (of the file, or through a look)
 *   ring(audioPath, host, splitHz?, look?, span?) → RingMeasure | null   ringing after "s" sounds above a split
 *   ringSplit(audioPath, host, span?) → RingSplit                  where that ring starts
 *   CATALOG / filterInfo / optionInfo   every filter and option the bundled ffmpeg has
 *   validateLook / describeLook / LOOK_PRESETS
 *
 * Rules: data in, a file or a reason out. Imports nothing from src/main or src/core. The original
 * recording is never written to. Every output is read back and measured before it is handed back.
 * processAudio, checkLook and levellingGain never throw: they return the reason. The four calls that hand back
 * numbers throw an AudioError with the same reasons. Every ffmpeg run can be cancelled and none can hang.
 */
import { promises as fs } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { analyseFile } from './analyse'
import { measureFile } from './measure'
import { DEFAULT_SPLIT, findSplitFile, measureRingFile } from './ring'
import { audioFile, cacheKey, metaFile, nonEmpty, partFile, writeAtomic } from './cache'
import { FfmpegError, checkFfmpeg, parseEbur, parseOutputStream, probe, runFfmpeg, type FfmpegBuild, type Probe } from './ffmpeg'
import { buildGraph, errorsByStep, n, type BuiltGraph } from './graph'
import { EMPTY_LOOK, filtersUsed, validateLook, type Level, type Look, type LookError } from './look'
import { AudioError, type AfterMeasure, type AudioAnalysis, type AudioHost, type AudioJob, type AudioReason, type AudioResult, type LookCheck, type Measure, type PluginManifest, type RingMeasure, type RingSplit } from './types'

export type { AfterMeasure, AudioAnalysis, AudioHost, AudioJob, AudioReason, AudioResult, LookCheck, Measure, PluginManifest, RingBand, RingMeasure, RingSplit } from './types'
export { AudioError, MEASURE_BANDS, MEASURE_VERSION, RING_VERSION } from './types'
export { CATALOG, filterInfo, filtersByCategory, optionInfo, padCount, type Catalog, type CatalogFilter, type CatalogOption, type FilterRole, type OptionType } from './catalog'
export { EMPTY_LOOK, LEVEL_FIELDS, LIMITS, coerceOption, describeLook, filtersUsed, validateLook, walkSteps, type Level, type Look, type LookError, type LookValidation, type NumberField, type OptionValue, type Source, type Step } from './look'
export { LOOK_PRESETS, type Preset } from './presets'
export { isV1Look, lookFromV1 } from './v1'

export const manifest: PluginManifest = { id: 'audio', version: '2.1.0', renderVersion: 1, lookVersion: 2 }

/** Levelling never moves a file by more than this (a near-silent file must not be blown up). */
export const MAX_GAIN_DB = 24
export const MIN_GAIN_DB = -30
/** Output length differing from the input by more than this is reported (a step changed the length). */
export const DURATION_TOLERANCE_S = 0.05
/** Levelling further than this from the target fails the job (1–3 LU is a warning). */
export const LOUDNESS_FAIL_LU = 3
/** Below this a file counts as silent. */
const SILENT_LUFS = -70
const PREVIEW_MAX_S = 600
/** Sample rates a caller may hand in (`AudioJob.rate`): what ffmpeg's resampler takes without falling over. */
const MIN_RATE = 8000, MAX_RATE = 384000
/** `ring()` splits between these, Hz: below is the voice itself, above nothing is left at 48 kHz. */
const MIN_SPLIT_HZ = 100, MAX_SPLIT_HZ = 20000
/** Outputs are cut at max(2 × input, input + 60 s): an endless source (sine without d=, aloop=-1) must end. */
const outputCap = (inputSec: number) => Math.max(inputSec * 2, inputSec + 60)

type Fail = { ok: false; reason: AudioReason; message: string; errors?: LookError[] }
const fail = (reason: AudioReason, message: string, errors?: LookError[]): Fail => ({ ok: false, reason, message, ...(errors?.length ? { errors } : {}) })
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const lookErrors = (errors: LookError[]) => errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; ')

interface Meta { after: AfterMeasure; inputSec: number; gainDb: number; warnings: string[] }
const r2 = (x: number) => Math.round(x * 100) / 100

/** The recording itself: an absolute path to a file that is there, not empty and readable. */
async function readable(audioPath: unknown): Promise<{ ok: true; size: number; mtimeMs: number } | Fail> {
  if (typeof audioPath !== 'string' || !isAbsolute(audioPath)) return fail('INVALID_JOB', 'audioPath must be an absolute path.')
  try {
    const st = await fs.stat(audioPath)
    if (!st.isFile() || st.size === 0) throw new Error('not a file or empty')
    await fs.access(audioPath, fs.constants.R_OK)
    return { ok: true, size: st.size, mtimeMs: st.mtimeMs }
  } catch (e) {
    return fail('AUDIO_UNREADABLE', `Recording cannot be read: ${audioPath} (${errMsg(e)})`)
  }
}

/** A stretch of a recording: where it starts and how long it is, both in seconds. */
function spanProblem(span: unknown, name: string, maxSeconds = Infinity): string | null {
  if (span === undefined) return null
  const s = span as { start?: unknown; seconds?: unknown } | null
  if (!s || typeof s.start !== 'number' || !(Number.isFinite(s.start) && s.start >= 0)) return `${name}.start must be ≥ 0 seconds.`
  if (typeof s.seconds !== 'number' || !(Number.isFinite(s.seconds) && s.seconds > 0 && s.seconds <= maxSeconds)) return Number.isFinite(maxSeconds) ? `${name}.seconds must be between 0 and ${maxSeconds}.` : `${name}.seconds must be more than 0.`
  return null
}

/** ffmpeg failed: when its messages name filters, it was the look (a value ffmpeg refused) — report per step. */
function ffmpegFailure(e: FfmpegError, g: BuiltGraph): Fail {
  if (e.reason !== 'PROCESS_FAILED') return fail(e.reason, e.message)
  const errors = errorsByStep(e.stderr, g.filterPaths)
  const fromLook = errors.filter((x) => x.path)
  // ffmpeg 6.0 sometimes crashes while cleaning up after a filter refused its settings; when it named the
  // filter while setting the graph up, the settings are the cause, not the crash
  const refusedAtSetup = /Error (re)?initializing filters?|Failed to configure/i.test(e.stderr)
  if (fromLook.length && (refusedAtSetup || !/crashed/.test(e.message))) return fail('INVALID_LOOK', `ffmpeg refused the look: ${lookErrors(fromLook)}`, fromLook)
  return fail('PROCESS_FAILED', e.message, errors)
}

/** Steps whose filter this build of ffmpeg was made without (the catalog lists what the release has; a build can leave some out). */
function notInBuild(look: Look, build: FfmpegBuild): LookError[] {
  return filtersUsed(look).filter((u) => !build.filters.has(u.filter)).map((u) => ({ path: u.path, message: `the ffmpeg on this computer was built without the ${u.filter} filter` }))
}

async function statFiles(g: BuiltGraph): Promise<{ ok: true; stats: [string, number, number][] } | { ok: false; errors: LookError[] }> {
  const stats: [string, number, number][] = [], errors: LookError[] = []
  for (const [i, f] of g.files.entries()) {
    try {
      const st = await fs.stat(f)
      if (!st.isFile() || !st.size) throw new Error('not a file or empty')
      stats.push([f, st.size, Math.round(st.mtimeMs)])
    } catch (e) { errors.push({ path: `${g.filePaths[i]}.path`, message: `cannot read ${f} (${errMsg(e)})` }) }
  }
  return errors.length ? { ok: false, errors } : { ok: true, stats }
}

export async function processAudio(job: AudioJob, host: AudioHost): Promise<AudioResult> {
  // ── 1. job + look ──
  if (!job || typeof job.audioPath !== 'string' || !isAbsolute(job.audioPath)) return fail('INVALID_JOB', 'audioPath must be an absolute path.')
  const badSpan = spanProblem(job.preview ?? undefined, 'preview', PREVIEW_MAX_S)
  if (badSpan) return fail('INVALID_JOB', badSpan)
  if (job.gainDb !== undefined && !(typeof job.gainDb === 'number' && Number.isFinite(job.gainDb))) return fail('INVALID_JOB', 'gainDb must be a number of dB.')
  if (job.rate !== undefined && !(typeof job.rate === 'number' && Number.isInteger(job.rate) && job.rate >= MIN_RATE && job.rate <= MAX_RATE)) return fail('INVALID_JOB', `rate must be a whole number of Hz between ${MIN_RATE} and ${MAX_RATE}.`)
  const v = validateLook(job.look ?? EMPTY_LOOK)
  if (!v.ok) return fail('INVALID_LOOK', lookErrors(v.errors), v.errors)
  let level: Level | null = job.bypass ? null : v.look.level ?? null
  if (job.level !== undefined) {
    const lv = validateLook({ chain: [], level: job.level })
    if (!lv.ok) return fail('INVALID_JOB', `level: ${lookErrors(lv.errors)}`)
    level = lv.look.level ?? null
  }
  const look: Look = job.bypass ? EMPTY_LOOK : v.look

  const stat = await readable(job.audioPath)
  if (!stat.ok) return stat
  // a gain the caller gives: to 0.01 dB (so the same gain is the same file) and within what levelling may ever do
  const given = level && job.gainDb !== undefined ? r2(Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, job.gainDb))) : undefined
  const givenRate = given !== undefined ? job.rate : undefined
  const rack = buildGraph(look, { mode: 'chain' })
  const fileStats = await statFiles(rack)
  if (!fileStats.ok) return fail('AUDIO_UNREADABLE', lookErrors(fileStats.errors), fileStats.errors)

  // ── 2. cache: the exact graph text is the identity, so ids/labels/bypassed steps never re-render ──
  const key = cacheKey(job.audioPath, stat, manifest.renderVersion, { graph: rack.graph, files: fileStats.stats, level, preview: job.preview ?? null, ...(given !== undefined ? { fixedGain: given, ...(givenRate ? { rate: givenRate } : {}) } : {}) })
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
  const run = { signal: host.signal, ...(host.stallMs ? { stallMs: host.stallMs } : {}) }
  const progress = (from: number, to: number, total: number) => (sec: number) => host.onProgress?.(Math.min(99, Math.round(from + (to - from) * Math.min(1, sec / Math.max(total, 0.001)))))
  let part: string | null = null
  let current: BuiltGraph = rack
  try {
    const absent = notInBuild(look, await checkFfmpeg(bin))
    if (absent.length) return fail('INVALID_LOOK', lookErrors(absent), absent)
    await fs.mkdir(host.outputDir, { recursive: true })
    host.onProgress?.(0)

    // ── 3. what we are working with ──
    let src: Probe
    try { src = await probe(bin, job.audioPath, host.signal) } catch (e) { if (e instanceof FfmpegError) throw e; return fail('AUDIO_UNREADABLE', `ffmpeg cannot read ${job.audioPath}: ${errMsg(e)}`) }
    const start = job.preview?.start ?? 0
    if (start >= src.durationSec) return fail('INVALID_JOB', `preview.start (${start} s) is beyond the recording's end (${src.durationSec.toFixed(1)} s).`)
    const inputSec = job.preview ? Math.min(job.preview.seconds, src.durationSec - start) : src.durationSec
    const cap = outputCap(inputSec)
    const inputArgs = ['-hide_banner', ...(job.preview ? ['-ss', n(start), '-t', n(inputSec)] : []), '-i', job.audioPath, ...rack.files.flatMap((f) => ['-i', f])]
    const warnings: string[] = []

    // ── 4. measure (levelling pass 1): the rack's loudness and output format ──
    let gainDb = 0, rate: number | undefined, capped = false
    const measured = !!level && !(given !== undefined && givenRate)
    const renderFrom = measured ? 40 : 0
    if (given !== undefined && level) {
      gainDb = given
      if (given !== r2(job.gainDb!)) { capped = true; warnings.push(`The gain given (${job.gainDb!.toFixed(1)} dB) is outside what levelling may do; ${given} dB was applied.`) }
    }
    if (level && !measured) rate = givenRate   // the caller already measured the whole recording: nothing to find out here
    else if (level) {
      current = buildGraph(look, { mode: 'measure', offset: start })
      const r = await runFfmpeg(bin, [...inputArgs, '-filter_complex', current.graph, '-map', '[out]', '-t', n(cap), '-f', 'null', '-'], { ...run, onTime: progress(0, 40, inputSec) })
      const m = parseEbur(r.stderr)
      if (!m) return fail('PROCESS_FAILED', 'Could not read the loudness measurement from ffmpeg.')
      rate = parseOutputStream(r.stderr)?.sampleRate
      if (!rate) return fail('PROCESS_FAILED', 'Could not read the rack\'s output sample rate from ffmpeg.')
      if (given === undefined) {
        if (!(m.lufs > SILENT_LUFS)) return fail('SILENT_INPUT', `Nothing to level: the ${job.preview ? 'excerpt' : 'recording'} is silent after the rack (${Number.isFinite(m.lufs) ? `${m.lufs} LUFS` : 'no signal'}).`)
        gainDb = level.lufs - m.lufs
        if (gainDb > MAX_GAIN_DB || gainDb < MIN_GAIN_DB) {
          const limit = Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gainDb))
          warnings.push(`Needed ${gainDb.toFixed(1)} dB to reach ${level.lufs} LUFS; capped at ${limit} dB.`)
          gainDb = limit; capped = true
        }
      }
    }

    // ── 5. render ──
    current = buildGraph(look, { mode: 'render', gainDb, offset: start, ...(level ? { ceiling: level.ceiling, rate } : {}) })
    part = partFile(out)
    await runFfmpeg(bin, [...inputArgs, '-filter_complex', current.graph, '-map', '[out]', '-t', n(cap), '-c:a', 'flac', '-sample_fmt', 's32', '-y', part],
      { ...run, onTime: progress(renderFrom, 90, inputSec) })

    // ── 6. verify ──
    const got = await probe(bin, part, host.signal).catch((e: unknown) => { if (e instanceof FfmpegError) throw e; return null })
    if (!got) return fail('PROCESS_FAILED', 'The processed file cannot be read back.')
    const r = await runFfmpeg(bin, ['-hide_banner', '-i', part, '-af', 'ebur128=peak=sample+true:framelog=verbose', '-f', 'null', '-'], { ...run, onTime: progress(90, 99, got.durationSec) })
    const m = parseEbur(r.stderr)
    if (!m || !(m.lufs > SILENT_LUFS)) return fail('SILENT_OUTPUT', 'The processed audio is silent — the rack removed the signal.')
    if (got.durationSec >= cap - 0.05) warnings.push(`Output was cut at ${cap.toFixed(0)} s: a step never ends on its own (a source without a duration, an endless loop?).`)
    else if (Math.abs(got.durationSec - inputSec) > DURATION_TOLERANCE_S) warnings.push(`Output is ${got.durationSec.toFixed(2)} s, the input ${inputSec.toFixed(2)} s: a step changes the length, so it no longer lines up with the original.`)
    if (level && given !== undefined && job.preview) {
      // an excerpt with the whole recording's gain lands wherever that puts it; only the ceiling is checked
      if (m.truePeak > level.ceiling + 0.2) warnings.push(`True peak ${m.truePeak} dBTP is above the ${level.ceiling} dBTP ceiling.`)
    } else if (level) {
      // a whole recording must land on the target, whoever worked out its gain
      const off = m.lufs - level.lufs
      if (Math.abs(off) > LOUDNESS_FAIL_LU && !capped) {
        return fail('LOUDNESS_OFF_TARGET', `Levelled loudness is ${m.lufs} LUFS, target ${level.lufs} — ${Math.abs(off).toFixed(1)} LU off (the peak ceiling may be holding it down).`)
      }
      if (Math.abs(off) > 1) warnings.push(`Loudness landed at ${m.lufs} LUFS (target ${level.lufs}).`)
      if (m.truePeak > level.ceiling + 0.2) warnings.push(`True peak ${m.truePeak} dBTP is above the ${level.ceiling} dBTP ceiling.`)
    } else if (m.samplePeak > -0.05) {
      warnings.push('Peaks reach full scale (0 dBFS): the processed copy is clipped there. Turn something down or add levelling.')
    }

    const after: AfterMeasure = { durationSec: got.durationSec, sampleRate: got.sampleRate, channels: got.channels, lufs: m.lufs, truePeak: m.truePeak, samplePeak: m.samplePeak }
    const meta: Meta = { after, inputSec: +inputSec.toFixed(3), gainDb: +gainDb.toFixed(2), warnings }
    await fs.rename(part, out); part = null
    await writeAtomic(metaPath, JSON.stringify(meta))
    host.log('info', `Audio processed (${job.bypass ? 'bypass' : `${look.chain.length} step${look.chain.length === 1 ? '' : 's'}`}${job.preview ? `, preview ${start}+${inputSec.toFixed(1)} s` : ''}) → ${m.lufs} LUFS, peak ${m.truePeak} dBTP → ${key}`)
    for (const w of warnings) host.log('warn', w)
    host.onProgress?.(100)
    return { ok: true, file: out, cacheKey: key, cached: false, ...meta }
  } catch (e) {
    if (e instanceof FfmpegError) {
      const f = ffmpegFailure(e, current)
      if (f.reason !== 'CANCELLED') host.log('error', `Audio processing failed: ${f.message}`)
      return f
    }
    host.log('error', `Audio processing failed: ${errMsg(e)}`)
    return fail('PROCESS_FAILED', errMsg(e))
  } finally {
    if (part) await fs.rm(part, { force: true }).catch(() => {})
  }
}

/**
 * Asks ffmpeg whether a look works, without processing anything: the whole graph runs on `seconds`
 * of audio (the recording's first seconds when `audioPath` is given, else a 48 kHz tone, mono unless
 * `channels: 2`).
 * Catches what validateLook can't: bad expressions, lists and curves, wrong channel layouts, branch
 * counts that depend on the input. ~50–200 ms; call it after edits settle.
 */
export async function checkLook(lookInput: unknown, host: Pick<AudioHost, 'ffmpegPath' | 'signal'>, opts: { audioPath?: string; seconds?: number; channels?: 1 | 2 } = {}): Promise<LookCheck> {
  const v = validateLook(lookInput)
  if (!v.ok) return { ok: false, errors: v.errors }
  const seconds = Math.min(Math.max(opts.seconds ?? 1, 0.1), 10)
  const g = buildGraph(v.look, { mode: 'chain' })
  const files = await statFiles(g)
  if (!files.ok) return { ok: false, errors: files.errors }
  try {
    const absent = notInBuild(v.look, await checkFfmpeg(host.ffmpegPath))
    if (absent.length) return { ok: false, errors: absent }
    const tone = opts.channels === 2 ? "aevalsrc=exprs=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*554*t):sample_rate=48000:channel_layout=stereo" : 'sine=frequency=440:sample_rate=48000'
    const input = opts.audioPath ? ['-t', n(seconds), '-i', opts.audioPath] : ['-f', 'lavfi', '-t', n(seconds), '-i', tone]
    const r = await runFfmpeg(host.ffmpegPath, ['-hide_banner', ...input, ...g.files.flatMap((f) => ['-i', f]), '-filter_complex', g.graph, '-map', '[out]', '-t', n(seconds + 5), '-f', 'null', '-'], { signal: host.signal, stallMs: 10_000, maxMs: 30_000 })
    const o = parseOutputStream(r.stderr)
    return o ? { ok: true, ...o } : { ok: false, errors: [{ path: '', message: 'ffmpeg ran the look but its output format could not be read' }] }
  } catch (e) {
    if (e instanceof FfmpegError) {
      const errors = e.reason === 'PROCESS_FAILED' ? errorsByStep(e.stderr, g.filterPaths) : []
      // a crash that isn't just ffmpeg 6.0 tripping over its own cleanup after a refusal is worth saying out loud
      if (/crashed/.test(e.message) && !/Error (re)?initializing filters?|Failed to configure/i.test(e.stderr)) errors.push({ path: '', message: e.message })
      if (e.reason === 'TIMEOUT') return { ok: false, errors: [{ path: '', message: `${e.message} A setting makes it run far slower than the audio (or never finish).` }] }
      return { ok: false, errors: errors.length ? errors : [{ path: '', message: e.message }] }
    }
    return { ok: false, errors: [{ path: '', message: errMsg(e) }] }
  }
}

// ── calls that hand back numbers ─────────────────────────────────────────────

type MeasureHost = Pick<AudioHost, 'ffmpegPath' | 'signal' | 'stallMs'>
const runOf = (host: MeasureHost) => ({ signal: host.signal, ...(host.stallMs ? { stallMs: host.stallMs } : {}) })
const thrown = (f: Fail) => new AudioError(f.reason, f.message, f.errors)
/** Whatever went wrong in a measuring call, as the AudioError it is handed out as. */
function asAudioError(e: unknown, g?: BuiltGraph): AudioError {
  if (e instanceof AudioError) return e
  if (e instanceof FfmpegError) return g ? thrown(ffmpegFailure(e, g)) : new AudioError(e.reason, e.message)
  return new AudioError('PROCESS_FAILED', errMsg(e))
}

/** What every measuring call checks before ffmpeg decodes anything: the file, the stretch asked for, and (with a
 *  look) the rack to measure through: built in recording time, so `enable` ranges and fades act where a render of the
 *  same stretch has them, and cut like a render when a step never ends. Throws AudioError. */
async function measuringInput(audioPath: string, host: MeasureHost, look: unknown, span: { start: number; seconds: number } | undefined): Promise<{ rack?: BuiltGraph; input: { rack?: { graph: string; files: string[] }; span?: { start: number; seconds: number }; capSec?: number } }> {
  const file = await readable(audioPath)
  if (!file.ok) throw thrown(file)
  const bad = spanProblem(span, 'span')
  if (bad) throw new AudioError('INVALID_JOB', bad)
  let rack: BuiltGraph | undefined, valid: Look | undefined
  if (look !== undefined && look !== null) {
    const v = validateLook(look)
    if (!v.ok) throw new AudioError('INVALID_LOOK', lookErrors(v.errors), v.errors)
    valid = v.look
    // levelling left out: one gain changes none of what is measured
    rack = buildGraph({ chain: v.look.chain }, { mode: 'chain', ...(span?.start ? { offset: span.start } : {}) })
    const files = await statFiles(rack)
    if (!files.ok) throw new AudioError('AUDIO_UNREADABLE', lookErrors(files.errors), files.errors)
  }
  const build = await checkFfmpeg(host.ffmpegPath)
  const absent = valid ? notInBuild(valid, build) : []
  if (absent.length) throw new AudioError('INVALID_LOOK', lookErrors(absent), absent)
  let src: Probe
  try { src = await probe(host.ffmpegPath, audioPath, host.signal) } catch (e) { throw e instanceof FfmpegError ? e : new AudioError('AUDIO_UNREADABLE', `ffmpeg cannot read ${audioPath}: ${errMsg(e)}`) }
  if (span && span.start >= src.durationSec) throw new AudioError('INVALID_JOB', `span.start (${span.start} s) is beyond the recording's end (${src.durationSec.toFixed(1)} s).`)
  const inputSec = span ? Math.min(span.seconds, src.durationSec - span.start) : src.durationSec
  return { ...(rack ? { rack } : {}), input: { ...(rack ? { rack: { graph: rack.graph, files: rack.files }, capSec: outputCap(inputSec) } : {}), ...(span ? { span } : {}) } }
}

/** Loudness, peaks, hiss, rumble and clipping of a recording (or a processed file). Throws AudioError. */
export async function analyse(audioPath: string, host: MeasureHost): Promise<AudioAnalysis> {
  try {
    const file = await readable(audioPath)
    if (!file.ok) throw thrown(file)
    await checkFfmpeg(host.ffmpegPath)
    return await analyseFile(host.ffmpegPath, audioPath, runOf(host))
  } catch (e) {
    throw e instanceof AudioError || e instanceof FfmpegError ? asAudioError(e) : new AudioError('AUDIO_UNREADABLE', `ffmpeg cannot read ${audioPath}: ${errMsg(e)}`)
  }
}

/**
 * The one gain levelling applies to the WHOLE recording with this look: pass 1 of processAudio, nothing rendered.
 * An editor that plays excerpts needs it, because an excerpt levelled on its own gets a different gain than the
 * recording will. `gainDb` is null when the look has no levelling; otherwise to 0.01 dB and within
 * MIN_GAIN_DB…MAX_GAIN_DB, as a render applies it. Never throws: the reasons are processAudio's.
 */
export async function levellingGain(audioPath: string, lookInput: unknown, host: MeasureHost): Promise<{ ok: true; gainDb: number | null; rackLufs?: number; rackPeak?: number; rate?: number } | Fail> {
  const v = validateLook(lookInput ?? EMPTY_LOOK)
  if (!v.ok) return fail('INVALID_LOOK', lookErrors(v.errors), v.errors)
  const level = v.look.level
  if (!level) return { ok: true, gainDb: null }
  const file = await readable(audioPath)
  if (!file.ok) return file
  const g = buildGraph(v.look, { mode: 'measure' })
  const files = await statFiles(g)
  if (!files.ok) return fail('AUDIO_UNREADABLE', lookErrors(files.errors), files.errors)
  try {
    const absent = notInBuild(v.look, await checkFfmpeg(host.ffmpegPath))
    if (absent.length) return fail('INVALID_LOOK', lookErrors(absent), absent)
    let src: Probe
    try { src = await probe(host.ffmpegPath, audioPath, host.signal) } catch (e) { if (e instanceof FfmpegError) throw e; return fail('AUDIO_UNREADABLE', `ffmpeg cannot read ${audioPath}: ${errMsg(e)}`) }
    const r = await runFfmpeg(host.ffmpegPath, ['-hide_banner', '-i', audioPath, ...g.files.flatMap((f) => ['-i', f]), '-filter_complex', g.graph, '-map', '[out]', '-t', n(outputCap(src.durationSec)), '-f', 'null', '-'], runOf(host))
    const m = parseEbur(r.stderr)
    if (!m || !(m.lufs > SILENT_LUFS)) return fail('SILENT_INPUT', 'Nothing to level: the recording is silent after the rack.')
    // rackPeak: the rack's highest sample before any gain (the true peak can be a little higher), so a caller can tell
    // whether a target needs the limiter. rate: what a render needs to skip its own measuring pass.
    const rate = parseOutputStream(r.stderr)?.sampleRate
    return { ok: true, gainDb: r2(Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, level.lufs - m.lufs))), rackLufs: m.lufs, rackPeak: Number.isFinite(m.samplePeak) ? m.samplePeak : m.truePeak, ...(rate ? { rate } : {}) }
  } catch (e) {
    return e instanceof FfmpegError ? ffmpegFailure(e, g) : fail('PROCESS_FAILED', errMsg(e))
  }
}

/**
 * Tone and level behaviour of a recording (see `Measure`), for suggesting settings. With `look`: of what that look
 * makes of it (so a suggestion can check its own result). With `span`: of that stretch only. Reads only.
 * null = nothing to measure: silent (also when the look removes the signal) or under two seconds. Throws AudioError.
 */
export async function measure(audioPath: string, host: MeasureHost, look?: unknown, span?: { start: number; seconds: number }): Promise<Measure | null> {
  let rack: BuiltGraph | undefined
  try {
    const m = await measuringInput(audioPath, host, look, span)
    rack = m.rack
    return await measureFile(host.ffmpegPath, audioPath, runOf(host), m.input)
  } catch (e) { throw asAudioError(e, rack) }
}

/**
 * Does the band above `splitHz` keep ringing after "s" sounds, and how (see `RingMeasure`)? `look` and `span` as in
 * `measure`. Reads only. null = under 30 seconds: too little to go on. Throws AudioError.
 */
export async function ring(audioPath: string, host: MeasureHost, splitHz = DEFAULT_SPLIT, look?: unknown, span?: { start: number; seconds: number }): Promise<RingMeasure | null> {
  let rack: BuiltGraph | undefined
  try {
    if (!(typeof splitHz === 'number' && Number.isFinite(splitHz) && splitHz >= MIN_SPLIT_HZ && splitHz <= MAX_SPLIT_HZ)) throw new AudioError('INVALID_JOB', `splitHz must be a frequency between ${MIN_SPLIT_HZ} and ${MAX_SPLIT_HZ} Hz.`)
    const m = await measuringInput(audioPath, host, look, span)
    rack = m.rack
    return await measureRingFile(host.ffmpegPath, audioPath, splitHz, runOf(host), m.input)
  } catch (e) { throw asAudioError(e, rack) }
}

/** Above which frequency does the ring after "s" sounds live in this recording (between 3 and 7 kHz)? Read from the
 *  mono downmix, like `ring` and `measure`. Reads only. Throws AudioError. */
export async function ringSplit(audioPath: string, host: MeasureHost, span?: { start: number; seconds: number }): Promise<RingSplit> {
  try {
    const m = await measuringInput(audioPath, host, undefined, span)
    return await findSplitFile(host.ffmpegPath, audioPath, runOf(host), m.input.span)
  } catch (e) { throw asAudioError(e) }
}

/** Delete a processed file and its sidecar (e.g. after a successful upload). Safe if already gone. Only ever removes
 *  what this plugin wrote: a `<key>.flac` named as `processAudio` names its outputs; any other path is left alone. */
export async function discard(file: string): Promise<void> {
  if (typeof file !== 'string' || !/^[0-9a-f]{20}\.flac$/.test(basename(file))) return
  await fs.rm(file, { force: true })
  await fs.rm(file.replace(/\.flac$/, '.json'), { force: true })
}

/** The exact ffmpeg graph a look produces — for logs, the CLI and bug reports. */
export function explain(lookInput: unknown): { ok: true; graph: string; files: string[] } | { ok: false; errors: LookError[] } {
  const v = validateLook(lookInput)
  if (!v.ok) return { ok: false, errors: v.errors }
  const g = buildGraph(v.look, { mode: 'chain' })
  return { ok: true, graph: g.graph, files: g.files }
}
