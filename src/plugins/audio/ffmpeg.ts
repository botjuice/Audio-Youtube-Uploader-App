/**
 * Running ffmpeg safely: progress, cancel, a stall watchdog, crash detection, and parsers for
 * what ffmpeg prints (duration/stream info, the ebur128 summary, astats).
 *
 * Why a watchdog: `loudnorm` after the reverb mix hangs forever in the ffmpeg 6.0 we ship
 * (reproduced). We no longer use loudnorm, but any future filter combination that stalls must
 * end as a clear TIMEOUT, never as a pipeline that waits forever.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { REQUIRED_FILTERS } from './chain'

export class FfmpegError extends Error {
  constructor(public reason: 'PROCESS_FAILED' | 'TIMEOUT' | 'CANCELLED' | 'FFMPEG_UNUSABLE', message: string) { super(message) }
}

export interface RunOptions {
  signal?: AbortSignal
  /** Kill when the output position has not moved for this long. */
  stallMs?: number
  /** Called with the output position in seconds (from -progress). */
  onTime?: (seconds: number) => void
  /** Collect stdout (e.g. ametadata=print:file=-); otherwise stdout carries -progress. */
  captureStdout?: boolean
}
export interface RunResult { stderr: string; stdout: string }

const TAIL = 64_000

/** Run ffmpeg; resolves with its output when it exits 0, throws FfmpegError otherwise. */
export function runFfmpeg(bin: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  const stallMs = o.stallMs ?? 30_000
  const full = o.captureStdout ? args : ['-progress', 'pipe:1', '-nostats', ...args]
  return new Promise<RunResult>((resolve, reject) => {
    if (o.signal?.aborted) return reject(new FfmpegError('CANCELLED', 'Cancelled'))
    const child = spawn(bin, full, { windowsHide: true })
    let stderr = '', stdout = '', head = ''
    let lastPos = -1, lastMove = Date.now(), stalled = false, cancelled = false
    const onAbort = () => { cancelled = true; child.kill() }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const watchdog = setInterval(() => {
      if (Date.now() - lastMove > stallMs) { stalled = true; child.kill('SIGKILL') }
    }, 1000)
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString()
      if (head.length < 8000) head += s                    // stream info lives at the top
      stderr += s
      if (stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL) // the ebur128 summary lives at the bottom
      lastMove = Date.now()                                 // any output counts as life while not progressing yet
    })
    child.stdout.on('data', (b: Buffer) => {
      const s = b.toString()
      if (o.captureStdout) { stdout += s; lastMove = Date.now(); return }
      for (const m of s.matchAll(/out_time_us=(\d+)/g)) {
        const pos = Number(m[1]) / 1e6
        if (pos !== lastPos) { lastPos = pos; lastMove = Date.now(); o.onTime?.(pos) }
      }
    })
    child.on('error', (e) => { clearInterval(watchdog); reject(new FfmpegError('FFMPEG_UNUSABLE', `Could not start ffmpeg (${bin}): ${e.message}`)) })
    child.on('close', (code, sig) => {
      clearInterval(watchdog)
      o.signal?.removeEventListener('abort', onAbort)
      const all = head.length < 8000 ? head : head + '\n…\n' + stderr
      if (cancelled) return reject(new FfmpegError('CANCELLED', 'Cancelled'))
      if (stalled) return reject(new FfmpegError('TIMEOUT', `ffmpeg made no progress for ${Math.round(stallMs / 1000)} s and was stopped (at ${lastPos < 0 ? 'the start' : `${lastPos.toFixed(1)} s`}).`))
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => l.trim()).slice(-4).join(' · ')
        const how = sig ? `crashed (${sig})` : `exited with code ${code}`
        return reject(new FfmpegError('PROCESS_FAILED', `ffmpeg ${how}${tail ? `: ${tail}` : ''}`))
      }
      resolve({ stderr: all, stdout })
    })
  })
}

// ── Probe ────────────────────────────────────────────────────────────────────

export interface Probe { durationSec: number; sampleRate: number; channels: number; codec: string }

/** Header facts without decoding (`ffmpeg -i file` exits 1 by design; we only read its banner). */
export function probe(bin: string, file: string): Promise<Probe> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['-hide_banner', '-i', file], { windowsHide: true })
    let err = ''
    child.stderr.on('data', (b: Buffer) => { err += b.toString() })
    child.on('error', (e) => reject(new FfmpegError('FFMPEG_UNUSABLE', `Could not start ffmpeg (${bin}): ${e.message}`)))
    child.on('close', () => {
      const p = parseProbe(err)
      if (p) resolve(p)
      else reject(new Error(err.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' · ') || 'ffmpeg could not read the file'))
    })
  })
}

export function parseProbe(text: string): Probe | null {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  const a = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: ([^,\s]+)[^,]*, (\d+) Hz, ([^,]+),/.exec(text)
  if (!d || !a) return null
  const layout = a[3]!.trim()
  const channels = layout === 'mono' ? 1 : layout === 'stereo' ? 2 : Number(/(\d+) channels/.exec(layout)?.[1] ?? (/(\d+)\.(\d+)/.test(layout) ? layout.split('.').reduce((s, x) => s + Number(x), 0) : 2))
  return {
    durationSec: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
    sampleRate: Number(a[2]),
    channels,
    codec: a[1]!,
  }
}

// ── ebur128 / astats parsers ─────────────────────────────────────────────────

export interface Ebur { lufs: number; lra: number; truePeak: number }

/** The *last* ebur128 Summary in the text (one instance per run in our graphs). */
export function parseEbur(text: string): Ebur | null {
  const at = text.lastIndexOf('Summary:')
  if (at < 0) return null
  const s = text.slice(at)
  const num = (re: RegExp) => { const m = re.exec(s); return m ? Number(m[1]) : NaN }
  const lufs = num(/\bI:\s*(-?[\d.]+|-inf) LUFS/), lra = num(/LRA:\s*(-?[\d.]+) LU/), peak = num(/Peak:\s*(-?[\d.]+|-inf) dBFS/)
  if (Number.isNaN(lufs) && !/I:\s*-inf/.test(s)) return null
  return { lufs: Number.isNaN(lufs) ? -Infinity : lufs, lra: Number.isNaN(lra) ? 0 : lra, truePeak: Number.isNaN(peak) ? -Infinity : peak }
}

/** Values printed by `ametadata=print:key=…:file=-`, in order (−inf dropped). */
export function parseMetadataValues(stdout: string, key: string): number[] {
  const out: number[] = []
  for (const m of stdout.matchAll(new RegExp(`${key.replace(/\./g, '\\.')}=(-?[\\d.]+)`, 'g'))) out.push(Number(m[1]))
  return out
}

export function percentile(values: number[], q: number): number {
  if (!values.length) return -Infinity
  const s = [...values].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!
}

// ── Capability check ─────────────────────────────────────────────────────────

const checked = new Map<string, Promise<void>>()

/** Binary exists and has every filter the chain needs. Cached per binary path. */
export function checkFfmpeg(bin: string): Promise<void> {
  let p = checked.get(bin)
  if (!p) {
    p = (async () => {
      try { await fs.access(bin) } catch { throw new FfmpegError('FFMPEG_UNUSABLE', `ffmpeg binary not found: ${bin}`) }
      const listed = await new Promise<string>((resolve, reject) => {
        const child = spawn(bin, ['-hide_banner', '-filters'], { windowsHide: true })
        let out = ''
        child.stdout.on('data', (b: Buffer) => { out += b.toString() })
        child.on('error', (e) => reject(new FfmpegError('FFMPEG_UNUSABLE', `Could not start ffmpeg (${bin}): ${e.message}`)))
        child.on('close', () => resolve(out))
      })
      const have = new Set([...listed.matchAll(/^\s*\S+\s+(\S+)\s/gm)].map((m) => m[1]))
      const missing = REQUIRED_FILTERS.filter((f) => !have.has(f))
      if (missing.length) throw new FfmpegError('FFMPEG_UNUSABLE', `This ffmpeg lacks filters the audio chain needs: ${missing.join(', ')}`)
    })()
    p.catch(() => checked.delete(bin))
    checked.set(bin, p)
  }
  return p
}
