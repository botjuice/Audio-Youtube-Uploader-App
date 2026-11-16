/**
 * Running ffmpeg safely: progress, cancel, a stall watchdog, crash detection, and parsers for
 * what ffmpeg prints (duration/stream info, the ebur128 summary, astats).
 *
 * Why a watchdog: `loudnorm` after an afir/amix mix hangs forever in the ffmpeg 6.0 we ship
 * (reproduced). Looks can now hold any filter combination, so anything that stalls must end as
 * a clear TIMEOUT, never as a pipeline that waits forever.
 */
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { CATALOG } from './catalog'

export class FfmpegError extends Error {
  /** what ffmpeg printed (banner + tail), for mapping "[Parsed_<filter>_<n>]" lines back to look steps */
  constructor(public reason: 'PROCESS_FAILED' | 'TIMEOUT' | 'CANCELLED' | 'FFMPEG_UNUSABLE', message: string, public stderr = '') { super(message) }
}

export interface RunOptions {
  signal?: AbortSignal
  /** Kill when the output position has not moved for this long. */
  stallMs?: number
  /** Kill after this long no matter what (checks of tiny excerpts). */
  maxMs?: number
  /** Called with the output position in seconds (from -progress). */
  onTime?: (seconds: number) => void
  /** Collect stdout (e.g. ametadata=print:file=-); otherwise stdout carries -progress. */
  captureStdout?: boolean
  /** stdout is the output itself (raw samples), handed over as it arrives. Each chunk counts as progress for the watchdog. */
  onData?: (chunk: Buffer) => void
}
export interface RunResult { stderr: string; stdout: string }

const TAIL = 64_000
/** After a cancel ffmpeg gets this long to stop on its own before it is killed outright. */
const KILL_AFTER_MS = 2000
/** Reading a file's header or ffmpeg's version takes milliseconds; longer than this and it hangs. */
const QUICK_MAX_MS = 20_000

/** Run ffmpeg; resolves with its output when it exits 0, throws FfmpegError otherwise. */
export function runFfmpeg(bin: string, args: string[], o: RunOptions = {}): Promise<RunResult> {
  const stallMs = o.stallMs ?? 30_000
  const full = o.captureStdout || o.onData ? args : ['-progress', 'pipe:1', '-nostats', ...args]
  return new Promise<RunResult>((resolve, reject) => {
    if (o.signal?.aborted) return reject(new FfmpegError('CANCELLED', 'Cancelled'))
    const child = spawn(bin, full, { windowsHide: true })
    let stderr = '', stdout = '', head = ''
    let lastPos = -1, lastMove = Date.now(), stalled = false, cancelled = false
    let killer: ReturnType<typeof setTimeout> | undefined
    const onAbort = () => { cancelled = true; child.kill(); killer = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS) }
    o.signal?.addEventListener('abort', onAbort, { once: true })
    const done = () => { clearInterval(watchdog); clearTimeout(killer); o.signal?.removeEventListener('abort', onAbort) }
    const started = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastMove > stallMs || (o.maxMs && Date.now() - started > o.maxMs)) { stalled = true; child.kill('SIGKILL') }
    }, 250)
    child.stderr.on('data', (b: Buffer) => {
      const s = b.toString()
      if (head.length < 8000) head += s                    // stream info lives at the top
      stderr += s
      if (stderr.length > TAIL * 2) stderr = stderr.slice(-TAIL) // the ebur128 summary lives at the bottom
      // before the first progress report, messages count as life (slow starts); after it only progress does —
      // a filter that warns forever without moving (arealtime at a near-zero speed) must still time out
      if (lastPos < 0 && Date.now() - started < stallMs * 4) lastMove = Date.now()
    })
    child.stdout.on('data', (b: Buffer) => {
      if (o.onData) { lastMove = Date.now(); o.onData(b); return }
      const s = b.toString()
      if (o.captureStdout) { stdout += s; lastMove = Date.now(); return }
      for (const m of s.matchAll(/out_time_us=(\d+)/g)) {
        const pos = Number(m[1]) / 1e6
        if (pos !== lastPos) { lastPos = pos; lastMove = Date.now(); o.onTime?.(pos) }
      }
    })
    child.on('error', (e) => { done(); reject(new FfmpegError('FFMPEG_UNUSABLE', `Could not start ffmpeg (${bin}): ${e.message}`)) })
    child.on('close', (code, sig) => {
      done()
      const all = head.length < 8000 ? head : head + '\n…\n' + stderr
      if (cancelled) return reject(new FfmpegError('CANCELLED', 'Cancelled'))
      if (stalled) return reject(new FfmpegError('TIMEOUT', o.maxMs && Date.now() - started > o.maxMs ? `ffmpeg took longer than ${Math.round(o.maxMs / 1000)} s and was stopped.` : `ffmpeg made no progress for ${Math.round(stallMs / 1000)} s and was stopped (at ${lastPos < 0 ? 'the start' : `${lastPos.toFixed(1)} s`}).`, all))
      if (code !== 0) {
        const tail = stderr.trim().split('\n').filter((l) => l.trim()).slice(-4).join(' · ')
        const how = sig ? `crashed (${sig})` : `exited with code ${code}`
        return reject(new FfmpegError('PROCESS_FAILED', `ffmpeg ${how}${tail ? `: ${tail}` : ''}`, all))
      }
      resolve({ stderr: all, stdout })
    })
  })
}

// ── Probe ────────────────────────────────────────────────────────────────────

export interface Probe { durationSec: number; sampleRate: number; channels: number; codec: string }

/** A short ffmpeg run whose text is all that matters (a file's header, the version): cancellable, and never left hanging. */
function quick(bin: string, args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new FfmpegError('CANCELLED', 'Cancelled'))
    const child = spawn(bin, args, { windowsHide: true })
    let stdout = '', stderr = '', why: 'CANCELLED' | 'TIMEOUT' | null = null
    const stop = (reason: 'CANCELLED' | 'TIMEOUT') => { why = reason; child.kill('SIGKILL') }
    const onAbort = () => stop('CANCELLED')
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => stop('TIMEOUT'), QUICK_MAX_MS)
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) }
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString() })
    child.stderr.on('data', (b: Buffer) => { if (stderr.length < TAIL) stderr += b.toString() })
    child.on('error', (e) => { done(); reject(new FfmpegError('FFMPEG_UNUSABLE', `Could not start ffmpeg (${bin}): ${e.message}`)) })
    child.on('close', () => {
      done()
      if (why === 'CANCELLED') return reject(new FfmpegError('CANCELLED', 'Cancelled'))
      if (why === 'TIMEOUT') return reject(new FfmpegError('TIMEOUT', `ffmpeg did not answer within ${QUICK_MAX_MS / 1000} s and was stopped.`))
      resolve({ stdout, stderr })
    })
  })
}

/** Header facts without decoding (`ffmpeg -i file` exits 1 by design; we only read its banner). Throws a plain Error
 *  when the file is not audio ffmpeg can read, an FfmpegError when ffmpeg itself is the problem (or on cancel). */
export async function probe(bin: string, file: string, signal?: AbortSignal): Promise<Probe> {
  const { stderr } = await quick(bin, ['-hide_banner', '-i', file], signal)
  const p = parseProbe(stderr)
  if (!p) throw new Error(stderr.trim().split('\n').filter((l) => l.trim()).slice(-2).join(' · ') || 'ffmpeg could not read the file')
  return p
}

export function parseProbe(text: string): Probe | null {
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text)
  // the layout ends at a comma — or at the line's end, as ffmpeg cuts very long layouts (64 channels) short
  const a = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio: ([^,\s]+)[^,\n]*, (\d+) Hz, ([^,\n]+)/.exec(text)
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

export interface Ebur { lufs: number; lra: number; truePeak: number; samplePeak: number }

/** The *last* ebur128 Summary in the text (one instance per run in our graphs). With peak=sample+true it
 *  has a "Sample peak:" and a "True peak:" section, each with its own "Peak:" line. */
export function parseEbur(text: string): Ebur | null {
  const at = text.lastIndexOf('Summary:')
  if (at < 0) return null
  const s = text.slice(at)
  const num = (src: string, re: RegExp) => { const m = re.exec(src); return m ? Number(m[1]) : NaN }
  const peakIn = (section: string) => { const i = s.indexOf(section); return i < 0 ? NaN : num(s.slice(i), /Peak:\s*(-?[\d.]+|-inf) dBFS/) }
  const lufs = num(s, /\bI:\s*(-?[\d.]+|-inf) LUFS/), lra = num(s, /LRA:\s*(-?[\d.]+) LU/)
  if (Number.isNaN(lufs) && !/I:\s*-inf/.test(s)) return null
  const anyPeak = num(s, /Peak:\s*(-?[\d.]+|-inf) dBFS/)
  const tp = s.includes('True peak:') ? peakIn('True peak:') : anyPeak
  const sp = s.includes('Sample peak:') ? peakIn('Sample peak:') : NaN
  const fix = (x: number) => (Number.isNaN(x) ? -Infinity : x)
  return { lufs: fix(lufs), lra: Number.isNaN(lra) ? 0 : lra, truePeak: fix(tp), samplePeak: fix(sp) }
}

/** Rate and channels of the first output stream (what the rack produced), from ffmpeg's banner. */
export function parseOutputStream(text: string): { sampleRate: number; channels: number } | null {
  const at = text.indexOf('Output #0')
  if (at < 0) return null
  const p = parseProbe(`Duration: 00:00:00.00\n${text.slice(at)}`)
  return p ? { sampleRate: p.sampleRate, channels: p.channels } : null
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

/** What is known about a binary once it has been checked: the filters this build of it has. */
export interface FfmpegBuild { filters: Set<string> }
const checked = new Map<string, Promise<FfmpegBuild>>()

/** The release a version line names, without the builder's own suffix: "6.0" from
 *  "ffmpeg version 6.0-essentials_build-www.gyan.dev Copyright …". null when it is not ffmpeg's version line. */
export const ffmpegRelease = (versionLine: string): string | null => /^ffmpeg version n?(\d+(?:\.\d+)*)/.exec(versionLine)?.[1] ?? null

/**
 * Binary exists and is the ffmpeg release the catalog was generated from. Another release can have other
 * options, and this ffmpeg crashes on an option it doesn't know — so a mismatch is refused until the
 * catalog is regenerated (`npm run audio -- catalog`). Builds of one release (macOS, Windows, Linux come
 * from different builders) have the same options but not always the same filters, so the filters this
 * one has are read too. Cached per binary path.
 */
export function checkFfmpeg(bin: string): Promise<FfmpegBuild> {
  let p = checked.get(bin)
  if (!p) {
    p = (async () => {
      try { await fs.access(bin) } catch { throw new FfmpegError('FFMPEG_UNUSABLE', `ffmpeg binary not found: ${bin}`) }
      const version = (await quick(bin, ['-hide_banner', '-version']).catch((e: unknown) => {
        throw e instanceof FfmpegError && e.reason === 'TIMEOUT' ? new FfmpegError('FFMPEG_UNUSABLE', `ffmpeg (${bin}) did not answer when asked for its version.`) : e
      })).stdout.split('\n')[0]!.trim()
      const release = ffmpegRelease(version)
      if (!release || release !== ffmpegRelease(CATALOG.ffmpeg)) throw new FfmpegError('FFMPEG_UNUSABLE', `The audio filter catalog was made for "${CATALOG.ffmpeg}" but this ffmpeg is "${version}". Regenerate it: npm run audio -- catalog`)
      const list = (await quick(bin, ['-hide_banner', '-filters'])).stdout
      return { filters: new Set([...list.matchAll(/^ [.T][.S][.C] (\S+)\s/gm)].map((m) => m[1]!)) }
    })()
    p.catch(() => checked.delete(bin))
    checked.set(bin, p)
  }
  return p
}
