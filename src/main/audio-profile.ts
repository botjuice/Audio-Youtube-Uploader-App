/**
 * Auto-set, host side: measures every recording of a reciter (plugin `measure()`), keeps the measurements
 * beside the library so each file is only decoded once, and hands the editor the reciter's profile plus the
 * chosen recording's own measurement. Everything is derived from the user's files at run time.
 */
import { promises as fs } from 'node:fs'
import { MIN_PROFILE_RECORDINGS, buildProfile, builtInProfile, builtInTarget } from '@core/audio-suggest'
import type { AudioSuggestData } from '@shared/types'
import { MEASURE_VERSION, measure, type Measure } from '../plugins/audio/index'
import { ffmpegPath } from './ffmpeg'
import { readJson, writeJson } from './jsonfile'
import { activity } from './log'
import { stateFile } from './paths'

interface Entry { size: number; mtimeMs: number; m: Measure | null }
interface MeasureCache { v: number; files: Record<string, Entry> }
export interface ReciterFile { /** Key in the cache: path relative to the library. */ rel: string; path: string }

const cacheFile = (library: string) => stateFile(library, 'audio-measures.json')
const CONCURRENT = 3
/** One run per library at a time: a second click waits for the first and then finds everything cached. */
let chain: Promise<unknown> = Promise.resolve()

export type SuggestCore = Omit<AudioSuggestData, 'lufs' | 'ring'>   // what this file finds; the caller adds loudness and ring
export function audioSuggestData(library: string, reciter: string, reciterKey: string | null, target: ReciterFile, files: ReciterFile[], onProgress: (done: number, total: number) => void): Promise<SuggestCore> {
  const run = chain.then(() => collect(library, reciter, reciterKey, target, files, onProgress))
  chain = run.catch(() => {})
  return run
}

async function collect(library: string, reciter: string, reciterKey: string | null, target: ReciterFile, files: ReciterFile[], onProgress: (done: number, total: number) => void): Promise<SuggestCore> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  // a reciter with a target sound needs only this recording measured; otherwise the whole folder, for the profile
  const target0 = builtInTarget(reciterKey)
  if (target0) files = [target]
  const shipped = builtInProfile(reciterKey)
  if (!target0 && files.length < MIN_PROFILE_RECORDINGS && !shipped) throw new Error(`Auto-set needs at least ${MIN_PROFILE_RECORDINGS} recordings of a reciter to know what is typical for them; “${reciter}” has ${files.length}.`)
  const stored = await readJson<MeasureCache>(cacheFile(library), { v: MEASURE_VERSION, files: {} })
  const cache: MeasureCache = stored.v === MEASURE_VERSION && stored.files ? stored : { v: MEASURE_VERSION, files: {} }
  const failed: { file: string; message: string }[] = []
  const todo: { f: ReciterFile; size: number; mtimeMs: number }[] = []
  for (const f of files) {
    try {
      const st = await fs.stat(f.path)
      const hit = cache.files[f.rel]
      if (!hit || hit.size !== st.size || hit.mtimeMs !== st.mtimeMs) todo.push({ f, size: st.size, mtimeMs: st.mtimeMs })
    } catch (e) { failed.push({ file: f.rel, message: e instanceof Error ? e.message : String(e) }) }
  }
  if (todo.length) {
    let next = 0, done = 0
    onProgress(0, todo.length)
    const worker = async () => {
      while (next < todo.length) {
        const t = todo[next++]!
        try { cache.files[t.f.rel] = { size: t.size, mtimeMs: t.mtimeMs, m: await measure(t.f.path, { ffmpegPath: bin }) } }
        catch (e) { delete cache.files[t.f.rel]; failed.push({ file: t.f.rel, message: e instanceof Error ? e.message : String(e) }) }
        onProgress(++done, todo.length)
      }
    }
    await Promise.all(Array.from({ length: CONCURRENT }, worker))
    await writeJson(cacheFile(library), cache)
    activity.info(`Auto-set: measured ${todo.length - failed.length} recording${todo.length - failed.length === 1 ? '' : 's'} of ${reciter}${failed.length ? `, ${failed.length} could not be read` : ''}`)
  }
  const measures = files.map((f) => cache.files[f.rel]?.m).filter((m): m is Measure => !!m)
  const own = cache.files[target.rel]
  if (!own) throw new Error(`This recording could not be measured: ${failed.find((x) => x.file === target.rel)?.message ?? 'unknown error'}`)
  if (!own.m) throw new Error('This recording is silent or too short to measure.')
  // the library's own recordings say most about how this user records the reciter; the shipped profile fills in until there are enough
  if (target0) return { reciter, measure: own.m, profile: null, target: target0, source: 'target', failed }
  const ownProfile = buildProfile(measures)
  const profile = ownProfile ?? shipped
  if (!profile) throw new Error(`Auto-set needs at least ${MIN_PROFILE_RECORDINGS} measurable recordings of a reciter; only ${measures.length} of “${reciter}” could be measured.`)
  return { reciter, measure: own.m, profile, target: null, source: ownProfile ? 'library' : 'built-in', failed }
}

/** One recording's measurement, from the library's cache when the file has not changed since. */
export async function measureOne(library: string, f: ReciterFile): Promise<Measure> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  const run = chain.then(async () => {
    const st = await fs.stat(f.path)
    const stored = await readJson<MeasureCache>(cacheFile(library), { v: MEASURE_VERSION, files: {} })
    const cache: MeasureCache = stored.v === MEASURE_VERSION && stored.files ? stored : { v: MEASURE_VERSION, files: {} }
    const hit = cache.files[f.rel]
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.m
    const m = await measure(f.path, { ffmpegPath: bin })
    cache.files[f.rel] = { size: st.size, mtimeMs: st.mtimeMs, m }
    await writeJson(cacheFile(library), cache)
    return m
  })
  chain = run.catch(() => {})
  const m = await run
  if (!m) throw new Error('This recording is silent or too short to measure.')
  return m
}
