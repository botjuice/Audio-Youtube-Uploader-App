/**
 * Audio editor host side: runs the audio plugin on an excerpt for the A/B player, decodes peak
 * envelopes for the waveform lanes, and keeps the preview folder tidy. Nothing here touches uploads.
 */
import { protocol } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { Readable } from 'node:stream'
import { join, resolve } from 'node:path'
import type { AudioLookState, AudioOverview, AudioTile, AudioTileInput, AudioTileResult } from '@shared/types'
import { analyse, processAudio, validateLook, type AudioAnalysis, type AudioHost } from '../plugins/audio/index'
import { ffmpegPath } from './ffmpeg'
import { activity } from './log'
import { stateFile } from './paths'

export const audioDir = (library: string) => stateFile(library, 'audio')
export const DEFAULT_AUDIO_LOOK: AudioLookState = { look: {}, sample: null }
export const PREVIEW_SECONDS = 45
const PEAK_BUCKETS = 1200

function host(library: string, signal?: AbortSignal): AudioHost {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  return {
    outputDir: audioDir(library), ffmpegPath: bin, signal,
    // previews are chatty; only problems reach the Activity page
    log: (level, message) => { if (level === 'error') activity.error(message); else if (level === 'warn') activity.warn(message) },
  }
}

/** Peak envelope of a mono 16-bit decode: `buckets` [min, max] pairs in −1…1, interleaved. */
export function bucketPeaks(samples: Int16Array, buckets: number): number[] {
  const out = new Array<number>(buckets * 2).fill(0)
  if (!samples.length || buckets <= 0) return out
  const per = samples.length / buckets
  for (let b = 0; b < buckets; b++) {
    const s = Math.floor(b * per), e = Math.min(samples.length, Math.max(s + 1, Math.floor((b + 1) * per)))
    let min = 0, max = 0
    for (let i = s; i < e; i++) { const v = samples[i]! / 32768; if (v < min) min = v; if (v > max) max = v }
    out[b * 2] = min; out[b * 2 + 1] = max
  }
  return out
}

/** Decode a file to 8 kHz mono PCM through ffmpeg and bucket it (fast: a 45 s excerpt is 360k samples). */
export function peaksOf(file: string, buckets = PEAK_BUCKETS, signal?: AbortSignal, fromSec = 0, forSec?: number): Promise<number[]> {
  const bin = ffmpegPath()
  if (!bin) return Promise.reject(new Error('ffmpeg is not available on this computer'))
  return new Promise((res, rej) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...(fromSec > 0 ? ['-ss', String(fromSec)] : []), ...(forSec ? ['-t', String(forSec)] : []), '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true })
    const chunks: Buffer[] = []
    let err = ''
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => { err += c.toString() })
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', rej)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return rej(new Error('cancelled'))
      if (code !== 0) return rej(new Error(err.trim() || `ffmpeg exited with ${code}`))
      const buf = Buffer.concat(chunks)
      const n = buf.length >> 1
      const samples = new Int16Array(n)
      for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(i * 2)
      res(bucketPeaks(samples, buckets))
    })
  })
}

/** Filters start cold at a chunk's first sample; render this much before the chunk and skip it on playback. */
export const TILE_PREROLL_S = 4
/** The original needs no warm-up, only enough before the chunk for the player's 10 ms crossfade and to skip the decoder's first frames. */
export const ORIGINAL_PREROLL_S = 1
/** Audio after the nominal chunk end so neighbouring chunks can overlap and crossfade (ffmpeg cuts land a few samples off). */
export const TILE_POSTROLL_S = 0.5
const TILE_PEAK_BUCKETS = 160   // per 5 s tile → ~32 per second, plenty for a 45 s window

/** The original, exactly as recorded, cut to a window and stored losslessly (no gain, no processing). */
async function cutOriginal(library: string, audioPath: string, start: number, seconds: number, signal?: AbortSignal): Promise<string> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  const st = await fs.stat(audioPath)
  const key = createHash('sha1').update(`${audioPath}|${st.size}|${st.mtimeMs}|${start}|${seconds}|raw1`).digest('hex').slice(0, 20)
  const dir = audioDir(library)
  const out = join(dir, `${key}-original.flac`)
  if (await fs.access(out).then(() => true, () => false)) return out
  await fs.mkdir(dir, { recursive: true })
  const part = `${out}.part`
  await new Promise<void>((res, rej) => {
    // -ss before -i is sample-accurate in this ffmpeg (accurate_seek), and it is what the plugin does, so chunks line up
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(start), '-t', String(seconds), '-i', audioPath, '-vn', '-c:a', 'flac', '-f', 'flac', part], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (c: Buffer) => { err += c.toString() })
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', rej)
    child.on('close', (code) => { signal?.removeEventListener('abort', onAbort); if (signal?.aborted) rej(new Error('cancelled')); else if (code !== 0) rej(new Error(err.trim() || `ffmpeg exited with ${code}`)); else res() })
  }).catch(async (e) => { await fs.rm(part, { force: true }); throw e })
  await fs.rename(part, out)
  return out
}

// Processed chunks of an old look are pointless the moment the look changes: the editor sends a newer generation token
// (a timestamp, so it survives page reloads) and we abort older renders — per recording, so switching recordings doesn't
// cancel anything.
const currentGeneration = new Map<string, number>()
const inflight = new Map<AbortController, { path: string; gen: number }>()
const MAX_CONCURRENT = 2
let running = 0
const queue: (() => void)[] = []
const slot = () => new Promise<void>((res) => { if (running < MAX_CONCURRENT) { running++; res() } else queue.push(() => { running++; res() }) })
const release = () => { running--; queue.shift()?.() }

export function cancelAudioTiles(generation: number, audioPath?: string): void {
  const paths = audioPath ? [audioPath] : [...currentGeneration.keys()]
  for (const path of paths) {
    if (generation > (currentGeneration.get(path) ?? 0)) currentGeneration.set(path, generation)
    const cur = currentGeneration.get(path) ?? 0
    for (const [ac, x] of inflight) if (x.path === path && x.gen > 0 && x.gen < cur) ac.abort()
  }
}

/** Render one chunk: the raw original (cut only) or the processed audio with a warm-up pre-roll the player skips. */
export async function renderAudioTile(library: string, audioPath: string, input: AudioTileInput): Promise<AudioTileResult> {
  const gen = input.kind === 'processed' ? (input.generation ?? 0) : 0
  if (gen) cancelAudioTiles(gen, audioPath)
  if (gen && gen < (currentGeneration.get(audioPath) ?? 0)) return { ok: false, reason: 'CANCELLED', message: 'superseded' }
  const ac = new AbortController()
  inflight.set(ac, { path: audioPath, gen })
  await slot()
  try {
    if (ac.signal.aborted) return { ok: false, reason: 'CANCELLED', message: 'superseded' }
    const h = host(library, ac.signal)
    const start = Math.max(0, input.start), seconds = Math.min(Math.max(0.5, input.seconds), 60)
    if (input.kind === 'original') {
      const pre = Math.min(ORIGINAL_PREROLL_S, start)
      const file = await cutOriginal(library, audioPath, start - pre, seconds + pre + TILE_POSTROLL_S, ac.signal)
      const peaks = await peaksOf(file, TILE_PEAK_BUCKETS, ac.signal, pre, seconds)
      const tile: AudioTile = { kind: 'original', start, seconds, file, offset: pre, peaks, gainDb: 0, lufs: NaN, truePeak: NaN, channels: 1 }
      return { ok: true, tile }
    }
    const v = validateLook(input.look ?? {})
    if (!v.ok) return { ok: false, reason: 'INVALID_LOOK', message: v.errors.map((e) => `${e.key}: ${e.message}`).join('\n') }
    const pre = Math.min(TILE_PREROLL_S, start)
    const r = await processAudio({ audioPath, look: input.look, preview: { start: start - pre, seconds: seconds + pre + TILE_POSTROLL_S } }, h)
    if (!r.ok) return r.reason === 'CANCELLED' ? { ok: false, reason: 'CANCELLED', message: 'superseded' } : r
    const peaks = await peaksOf(r.file, TILE_PEAK_BUCKETS, ac.signal, pre, seconds)
    const tile: AudioTile = { kind: 'processed', start, seconds, file: r.file, offset: pre, peaks, gainDb: r.gainDb, lufs: r.after.lufs, truePeak: r.after.truePeak, channels: r.after.channels }
    return { ok: true, tile }
  } catch (e) {
    return { ok: false, reason: ac.signal.aborted ? 'CANCELLED' : 'PROCESS_FAILED', message: e instanceof Error ? e.message : String(e) }
  } finally {
    inflight.delete(ac)
    release()
  }
}

/** Whole-recording envelope for the overview strip; decoded once per file identity and kept beside the previews. */
export async function audioOverview(library: string, audioPath: string): Promise<AudioOverview> {
  const st = await fs.stat(audioPath)
  const key = createHash('sha1').update(`${audioPath}|${st.size}|${st.mtimeMs}|overview2`).digest('hex').slice(0, 20)
  const dir = audioDir(library)
  const sidecar = join(dir, `${key}-overview.json`)
  try { return JSON.parse(await fs.readFile(sidecar, 'utf8')) as AudioOverview } catch { /* not yet */ }
  const [a, peaks] = await Promise.all([analyseRecording(audioPath), peaksOf(audioPath, 2400)])
  const out: AudioOverview = { durationSec: a.durationSec, lufs: a.lufs, peaks }
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(sidecar, JSON.stringify(out))
  return out
}

const analyses = new Map<string, Promise<AudioAnalysis>>()
/** Full-recording analysis (loudness, peaks, hiss, rumble, clipping), cached per file identity for the session. */
export async function analyseRecording(audioPath: string): Promise<AudioAnalysis> {
  const st = await fs.stat(audioPath)
  const key = `${audioPath}|${st.size}|${st.mtimeMs}`
  let p = analyses.get(key)
  if (!p) {
    const bin = ffmpegPath()
    if (!bin) throw new Error('ffmpeg is not available on this computer')
    p = analyse(audioPath, { ffmpegPath: bin })
    analyses.set(key, p)
    p.catch(() => analyses.delete(key))
  }
  return p
}

/** Only files the plugin wrote may be streamed to the window. */
export function previewFilePath(library: string, file: string): string {
  const dir = resolve(audioDir(library)) + '/'
  const target = resolve(file)
  if (!target.startsWith(dir)) throw new Error('Not a preview file')
  return target
}

/**
 * `yj-audio://preview/?p=<path>` streams a preview FLAC into an <audio> element. Needed because Electron
 * refuses blob: media on a file:// page ("Media load rejected by URL safety check"), and the renderer
 * can't load file:// in dev. Range requests pass through, so seeking works.
 */
export const AUDIO_SCHEME = 'yj-audio'
export const audioUrl = (file: string) => `${AUDIO_SCHEME}://preview/?p=${encodeURIComponent(file)}`

/** Must run before app ready. */
export function registerAudioScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: AUDIO_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: false } }])
}

/** After app ready: serve preview files from the open library's audio folder, nothing else. Byte ranges are honoured so <audio> can seek. */
export function installAudioProtocol(getLibrary: () => string | null | undefined): void {
  protocol.handle(AUDIO_SCHEME, async (req) => {
    try {
      const library = getLibrary()
      const file = new URL(req.url).searchParams.get('p')
      if (!library || !file) return new Response('No library open', { status: 404, headers: { 'Access-Control-Allow-Origin': '*' } })
      const target = previewFilePath(library, file)
      const size = (await fs.stat(target)).size
      const type = target.toLowerCase().endsWith('.flac') ? 'audio/flac' : 'application/octet-stream'
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get('range') ?? '')
      let start = 0, end = size - 1, status = 200
      if (range) {
        if (range[1]) { start = Number(range[1]); end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1 }
        else if (range[2]) { start = Math.max(0, size - Number(range[2])) }   // suffix range: last N bytes
        if (!(start <= end && start < size)) return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
        status = 206
      }
      const body = Readable.toWeb(createReadStream(target, { start, end })) as unknown as ReadableStream
      // the window is a file:// page, so a fetch() to this scheme is cross-origin and needs CORS
      const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges' }
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`
      return new Response(body, { status, headers })
    } catch (e) {
      return new Response(e instanceof Error ? e.message : String(e), { status: 403, headers: { 'Access-Control-Allow-Origin': '*' } })
    }
  })
}

/** Previews pile up as knobs move; drop ones not touched for a week (the plugin re-renders on demand). */
export async function sweepAudioPreviews(library: string, maxAgeMs = 7 * 24 * 60 * 60_000): Promise<number> {
  const dir = audioDir(library)
  let removed = 0
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return 0 }
  const cutoff = Date.now() - maxAgeMs
  for (const name of names) {
    if (!/\.(flac|json|part)$/i.test(name)) continue
    const p = join(dir, name)
    try { const st = await fs.stat(p); if (st.isFile() && st.mtimeMs < cutoff) { await fs.unlink(p); removed++ } } catch { /* raced */ }
  }
  return removed
}
