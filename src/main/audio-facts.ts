/**
 * What the app knows about a recording before it decides anything: its tone and level behaviour, its loudness and
 * peaks, and the ringing after its "s" sounds. Measured once per file and kept beside the library, so Auto-set, a
 * rule's references and the upload stage all read the same facts and no file is measured twice, even across restarts.
 */
import { promises as fs } from 'node:fs'
import { MEASURE_VERSION, RING_VERSION, analyse, measure, ring, ringSplit, type AudioAnalysis, type Measure, type RingMeasure } from '../plugins/audio/index'
import { ffmpegPath } from './ffmpeg'
import { readJson, writeJson } from './jsonfile'
import { stateFile } from './paths'

export interface AudioFile { /** path relative to the library: the key the facts are stored under */ rel: string; path: string }
export interface Facts { measure: Measure; analysis: AudioAnalysis; ring: RingMeasure | null }

/** Bump when what is stored changes shape or meaning (the plugin's own MEASURE_VERSION and RING_VERSION are part of the key too). */
const FACTS_VERSION = 1
/** The search for where the ring starts runs on this much from the recording's middle: about 35 “s” sounds, enough to tell. */
const SPLIT_SEARCH_S = 240

interface Entry extends Facts { size: number; mtimeMs: number }
interface Stored { v: string; files: Record<string, Entry> }
export const FACTS_STORE_VERSION = `${FACTS_VERSION}.${MEASURE_VERSION}.${RING_VERSION}`
const version = FACTS_STORE_VERSION
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

/** Wait for work that others may be waiting for too, but stop waiting the moment this caller cancels. The work itself
 *  carries on and its result is kept, so the next request for it is answered at once. */
export function untilAborted<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work
  if (signal.aborted) { work.catch(() => {}); return Promise.reject(new Error('Cancelled')) }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new Error('Cancelled'))
    signal.addEventListener('abort', stop, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop))
  })
}

/** Everything known about one recording. From the library's store when the file has not changed since it was measured.
 *  `signal` only ends this caller's wait (see untilAborted). */
export function recordingFacts(library: string, f: AudioFile, signal?: AbortSignal): Promise<Facts> {
  return untilAborted(sharedFacts(library, f), signal)
}

async function sharedFacts(library: string, f: AudioFile): Promise<Facts> {
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

/** A recording was renamed: its stored facts move with it (the file itself is unchanged, so they still hold). */
export function moveFacts(library: string, from: string, to: string): Promise<void> {
  return onDisk(async () => {
    const s = await load(library)
    const hit = s.files[from]
    if (!hit) return
    delete s.files[from]
    s.files[to] = hit
    await writeJson(storeFile(library), s)
  })
}

/** Drop the facts of recordings that are no longer in the library. */
export function pruneFacts(library: string, keep: Set<string>): Promise<void> {
  return onDisk(async () => {
    const s = await load(library)
    const gone = Object.keys(s.files).filter((rel) => !keep.has(rel))
    if (!gone.length) return
    for (const rel of gone) delete s.files[rel]
    await writeJson(storeFile(library), s)
  })
}
