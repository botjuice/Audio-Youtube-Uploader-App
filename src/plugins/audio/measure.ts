/**
 * What a recording sounds like in more detail than `analyse`: its tone (long-term spectrum in
 * third-octave bands), how its level moves, the spectrum of its quietest moments, and how sharp its
 * "s" sounds are. Read-only: nothing here changes audio. The numbers feed the settings suggester.
 *
 * One mono 32 kHz decode, streamed (a 30-minute recording is never held in memory), analysed in
 * 2048-sample frames (64 ms). All levels are relative to the recording's own voice level, so a
 * quiet and a loud copy of the same recording measure the same.
 */
import { spawn } from 'node:child_process'
import { MEASURE_BANDS as BANDS, MEASURE_VERSION, type Measure } from './types'

const RATE = 32000
const N = 2048
/** Frames this far below the voice level do not count as voice (pauses, breaths, tails). */
const ACTIVE_BELOW = 25

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const tr = re[i]!; re[i] = re[j]!; re[j] = tr; const ti = im[i]!; im[i] = im[j]!; im[j] = ti }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < half; k++) {
        const a = i + k, b = a + half
        const xr = re[b]! * cr - im[b]! * ci, xi = re[b]! * ci + im[b]! * cr
        re[b] = re[a]! - xr; im[b] = im[a]! - xi
        re[a] = re[a]! + xr; im[a] = im[a]! + xi
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t
      }
    }
  }
}

const HANN = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N))
const HANN_POWER = HANN.reduce((s, w) => s + w * w, 0) / N
/** Bin range [lo, hi) of every band (edges at ±1/6 octave). */
const BAND_BINS = BANDS.map((f) => {
  const lo = Math.max(1, Math.round((f / Math.pow(2, 1 / 6)) * N / RATE)), hi = Math.min(N / 2, Math.round((f * Math.pow(2, 1 / 6)) * N / RATE))
  return [lo, Math.max(lo + 1, hi)] as const
})
const SIB_BINS = [Math.round(4000 * N / RATE), Math.round(10000 * N / RATE)] as const

const db10 = (p: number) => 10 * Math.log10(Math.max(1e-20, p))
const pct = (sorted: Float32Array | number[], q: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]! : -200
const r1 = (x: number) => Math.round(x * 10) / 10

/** Collects frames from a stream of mono float samples and reduces them to a Measure. */
export class Measurer {
  private frame = new Float64Array(N)
  private fill = 0
  private re = new Float64Array(N)
  private im = new Float64Array(N)
  private power: number[] = []            // per frame: mean square
  private bands: Float32Array[] = []      // per frame: power per band
  private sib: number[] = []              // per frame: 4–10 kHz power
  private peak = 0
  private samples = 0

  push(chunk: Float32Array): void {
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i]!
      const a = v < 0 ? -v : v
      if (a > this.peak) this.peak = a
      this.frame[this.fill++] = v
      if (this.fill === N) { this.take(); this.fill = 0 }
    }
    this.samples += chunk.length
  }

  private take(): void {
    const { frame, re, im } = this
    let ms = 0
    for (let i = 0; i < N; i++) { const v = frame[i]!; ms += v * v; re[i] = v * HANN[i]!; im[i] = 0 }
    this.power.push(ms / N)
    fft(re, im)
    // one-sided power per bin, scaled so the bins of a frame sum to its mean square
    const scale = 2 / (N * N * HANN_POWER)
    const out = new Float32Array(BANDS.length)
    for (let b = 0; b < BANDS.length; b++) {
      const [lo, hi] = BAND_BINS[b]!
      let s = 0
      for (let k = lo; k < hi; k++) s += re[k]! * re[k]! + im[k]! * im[k]!
      out[b] = s * scale
    }
    this.bands.push(out)
    let s = 0
    for (let k = SIB_BINS[0]; k < SIB_BINS[1]; k++) s += re[k]! * re[k]! + im[k]! * im[k]!
    this.sib.push(s * scale)
  }

  /** null when the recording is silent or too short to say anything about. */
  finish(): Measure | null {
    const n = this.power.length
    if (n < 30) return null
    // voice level: power-mean of frames, then again over the frames within ACTIVE_BELOW of it (two passes settle it)
    let voice = this.power.reduce((s, p) => s + p, 0) / n
    if (voice < 1e-12) return null
    let active: number[] = []
    for (let pass = 0; pass < 2; pass++) {
      const gate = voice * Math.pow(10, -ACTIVE_BELOW / 10)
      active = []
      let sum = 0
      for (let i = 0; i < n; i++) if (this.power[i]! >= gate) { active.push(i); sum += this.power[i]! }
      if (!active.length) return null
      voice = sum / active.length
    }
    const voiceDb = db10(voice)
    const tone = BANDS.map((_, b) => { let s = 0; for (const i of active) s += this.bands[i]![b]!; return r1(db10(s / active.length) - voiceDb) })
    const quiet = BANDS.map((_, b) => { const col = Float32Array.from(this.bands, (f) => f[b]!).sort(); return r1(db10(pct(col, 0.05)) - voiceDb) })
    const all = Float32Array.from(this.power).sort()
    const lv = Float32Array.from(active, (i) => this.power[i]!).sort()
    const sib = Float32Array.from(active, (i) => db10(this.sib[i]! / this.power[i]!)).sort()
    const rel = (q: number) => r1(db10(pct(lv, q)) - voiceDb)
    return {
      v: MEASURE_VERSION,
      durationSec: r1(this.samples / RATE),
      voiceDb: r1(voiceDb),
      activeShare: Math.round((active.length / n) * 1000) / 1000,
      tone, quiet,
      floorDb: r1(db10(pct(all, 0.02)) - voiceDb),
      levels: { p10: rel(0.1), p50: rel(0.5), p90: rel(0.9), p95: rel(0.95), p99: rel(0.99) },
      peakDb: r1(20 * Math.log10(Math.max(1e-10, this.peak)) - voiceDb),
      sibilance: r1(pct(sib, 0.95)),
    }
  }
}

/** Measure one file, or (with `rack`: a graph ending in [out], plus its extra input files) what a look makes of it.
 *  Rejects when ffmpeg cannot read it; resolves null for a silent or very short recording. */
export function measureFile(bin: string, file: string, signal?: AbortSignal, rack?: { graph: string; files: string[] }, span?: { start: number; seconds: number }): Promise<Measure | null> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const cut = span ? ['-ss', String(span.start), '-t', String(span.seconds)] : []
    const io = rack ? [...cut, '-i', file, ...rack.files.flatMap((f) => ['-i', f]), '-filter_complex', rack.graph, '-map', '[out]'] : [...cut, '-i', file, '-vn']
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...io, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', 'pipe:1'], { windowsHide: true })
    const m = new Measurer()
    let err = '', carry: Buffer = Buffer.alloc(0)
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (b: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, b]) : b
      const whole = buf.length - (buf.length % 4)
      // copy: the pool-backed buffer is not 4-byte aligned in general
      const f = new Float32Array(whole / 4)
      for (let i = 0; i < f.length; i++) f[i] = buf.readFloatLE(i * 4)
      m.push(f)
      carry = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0)
    })
    child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString() })
    child.on('error', (e) => reject(new Error(`Could not start ffmpeg (${bin}): ${e.message}`)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-2).join(' · ') || `ffmpeg exited with code ${code}`))
      resolve(m.finish())
    })
  })
}
