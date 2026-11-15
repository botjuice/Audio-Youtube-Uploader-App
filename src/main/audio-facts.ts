/**
 * What the app knows about a recording before it decides anything: its tone and level behaviour, its loudness and
 * peaks, and the ringing after its "s" sounds. Measured once per file and kept beside the library, so Auto-set, a
 * rule's references and the upload stage all read the same facts and no file is measured twice, even across restarts.
 */
import { promises as fs } from 'node:fs'
import { MEASURE_VERSION, analyse, measure, ring, ringSplit, type AudioAnalysis, type Measure, type RingMeasure } from '../plugins/audio/index'
import { ffmpegPath } from './ffmpeg'
import { readJson, writeJson } from './jsonfile'
import { stateFile } from './paths'

export interface AudioFile { /** path relative to the library: the key the facts are stored under */ rel: string; path: string }
export interface Facts { measure: Measure; analysis: AudioAnalysis; ring: RingMeasure | null }

/** Bump when what is stored changes shape or meaning (the plugin's own MEASURE_VERSION is part of the key too). */
const FACTS_VERSION = 1
/** The search for where the ring starts runs on this much from the recording's middle: about 35 “s” sounds, enough to tell. */
const SPLIT_SEARCH_S = 240

interface Entry extends Facts { size: number; mtimeMs: number }
interface Stored { v: string; files: Record<string, Entry> }
const version = `${FACTS_VERSION}.${MEASURE_VERSION}`
const storeFile = (library: string) => stateFile(library, 'audio-facts.json')

const running = new Map<string, Promise<Facts>>()
/** Reads and writes of the stored facts go one after another, so two recordings finishing together cannot lose one. */
let disk: Promise<unknown> = Promise.resolve()
const onDisk = <T>(fn: () => Promise<T>): Promise<T> => { const p = disk.then(fn); disk = p.catch(() => {}); return p }
const load = async (library: string): Promise<Stored> => {
  const s = await readJson<Stored>(storeFile(library), { v: version, files: {} })
  return s.v === version && s.files ? s : { v: version, files: {} }
}

async function gather(bin: string, f: AudioFile): Promise<Facts> {
  const host = { ffmpegPath: bin }
  const [m, analysis] = await Promise.all([measure(f.path, host), analyse(f.path, host)])
  if (!m) throw new Error('This recording is silent or too short to measure.')
  const span = analysis.durationSec > SPLIT_SEARCH_S + 60 ? { start: Math.floor((analysis.durationSec - SPLIT_SEARCH_S) / 2), seconds: SPLIT_SEARCH_S } : undefined
  const split = await ringSplit(f.path, host, span)
  const r = await ring(f.path, host, split.splitHz)
  return { measure: m, analysis, ring: r ? { ...r, bands: split.bands } : r }
}

/** Everything known about one recording. From the library's store when the file has not changed since it was measured. */
export async function recordingFacts(library: string, f: AudioFile): Promise<Facts> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  const st = await fs.stat(f.path)
  const key = `${library}|${f.rel}|${st.size}|${st.mtimeMs}`
  let p = running.get(key)
  if (!p) {
    p = (async () => {
      const hit = (await onDisk(() => load(library))).files[f.rel]
      if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return { measure: hit.measure, analysis: hit.analysis, ring: hit.ring }
      const facts = await gather(bin, f)
      await onDisk(async () => { const s = await load(library); s.files[f.rel] = { ...facts, size: st.size, mtimeMs: st.mtimeMs }; await writeJson(storeFile(library), s) })
      return facts
    })()
    running.set(key, p)
    p.catch(() => running.delete(key))
  }
  return p
}
