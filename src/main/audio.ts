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
import type { AudioLookState, AudioPreviewResult, AudioPreviewSide } from '@shared/types'
import { analyse, processAudio, validateLook, type AudioAnalysis, type AudioHost, type AudioResult, type LookPatch } from '../plugins/audio/index'
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
export function peaksOf(file: string, buckets = PEAK_BUCKETS, signal?: AbortSignal): Promise<number[]> {
  const bin = ffmpegPath()
  if (!bin) return Promise.reject(new Error('ffmpeg is not available on this computer'))
  return new Promise((res, rej) => {
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-i', file, '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'], { windowsHide: true })
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

const side = (r: Extract<AudioResult, { ok: true }>, peaks: number[]): AudioPreviewSide =>
  ({ file: r.file, durationSec: r.after.durationSec, channels: r.after.channels, lufs: r.after.lufs, truePeak: r.after.truePeak, gainDb: r.gainDb, warnings: r.warnings, peaks })

/** The original excerpt exactly as recorded: cut to the window and stored losslessly, no gain, no processing. */
async function cutOriginal(library: string, audioPath: string, preview: { start: number; seconds: number }, signal?: AbortSignal): Promise<string> {
  const bin = ffmpegPath()
  if (!bin) throw new Error('ffmpeg is not available on this computer')
  const st = await fs.stat(audioPath)
  const key = createHash('sha1').update(`${audioPath}|${st.size}|${st.mtimeMs}|${preview.start}|${preview.seconds}|raw1`).digest('hex').slice(0, 20)
  const dir = audioDir(library)
  const out = join(dir, `${key}-original.flac`)
  if (await fs.access(out).then(() => true, () => false)) return out
  await fs.mkdir(dir, { recursive: true })
  const part = `${out}.part`
  await new Promise<void>((res, rej) => {
    // same -ss/-t placement as the plugin so both excerpts start on the same sample
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(preview.start), '-t', String(preview.seconds), '-i', audioPath, '-vn', '-c:a', 'flac', '-f', 'flac', part], { windowsHide: true })
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

let inflight: AbortController | null = null

/** Render the processed excerpt and the original excerpt at the same loudness. A newer request cancels an older one. */
export async function renderAudioPreview(library: string, audioPath: string, input: { start: number; seconds: number; look: LookPatch; matchLoudness?: boolean }): Promise<AudioPreviewResult> {
  inflight?.abort()
  const ac = new AbortController()
  inflight = ac
  const v = validateLook(input.look ?? {})
  if (!v.ok) return { ok: false, reason: 'INVALID_LOOK', message: v.errors.map((e) => `${e.key}: ${e.message}`).join('\n') }
  try {
    const h = host(library, ac.signal)
    const preview = { start: Math.max(0, input.start), seconds: Math.min(Math.max(1, input.seconds), 600) }
    const p = await processAudio({ audioPath, look: input.look, preview }, h)
    if (!p.ok) return p
    let original: AudioPreviewSide
    if (input.matchLoudness) {
      // the original with one fixed gain so it sits at the processed loudness: judge tone and noise, not volume
      const o = await processAudio({ audioPath, preview, bypass: true, matchLufs: p.after.lufs }, h)
      if (!o.ok) return o
      original = side(o, await peaksOf(o.file, PEAK_BUCKETS, ac.signal))
    } else {
      // the original untouched: only cut to the same window
      const file = await cutOriginal(library, audioPath, preview, ac.signal)
      const [a, peaks] = await Promise.all([analyse(file, { ffmpegPath: h.ffmpegPath, signal: ac.signal }), peaksOf(file, PEAK_BUCKETS, ac.signal)])
      original = { file, durationSec: a.durationSec, channels: a.channels, lufs: a.lufs, truePeak: a.truePeak, gainDb: 0, warnings: [], peaks }
    }
    const pp = await peaksOf(p.file, PEAK_BUCKETS, ac.signal)
    return { ok: true, processed: side(p, pp), original }
  } catch (e) {
    return { ok: false, reason: ac.signal.aborted ? 'CANCELLED' : 'PROCESS_FAILED', message: e instanceof Error ? e.message : String(e) }
  } finally {
    if (inflight === ac) inflight = null
  }
}

export function cancelAudioPreview(): void { inflight?.abort(); inflight = null }

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
