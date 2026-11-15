/**
 * Ring detection: does a reverb (a mixer's spring, a hard room) keep ringing in the top band after each loud burst
 * there (an "s", ص, ش)? Reads only. One decode of the band above `splitHz`, its level every 10 ms, then for every burst:
 * how loud it was, how long it lasted, and how far above the level just before it the band still is afterwards.
 *
 * The numbers are what a ducker needs: when the bursts end (its delay), how much the ring stands out (its depth), how
 * that grows with the burst's level (its threshold and ratio) and how fast the ring dies away (its release).
 */
import { spawn } from 'node:child_process'
import type { RingBand, RingMeasure, RingSplit } from './types'

const RATE = 48000, HOP = 480            // 10 ms
/** A burst: the band at least this far above its own typical level … */
const BURST_OVER = 12
/** … for at least this long (shorter ones are plosives: ت ك, not a sustained "s"). */
const BURST_MIN_MS = 40
/** Offsets after a burst ENDS at which the leftover level is read, ms. */
export const RING_OFFSETS = [50, 100, 150, 200, 300, 400, 500, 700, 1000, 1500]

const db = (p: number) => 10 * Math.log10(Math.max(p, 1e-14))
const quant = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]!
const r1 = (x: number) => Math.round(x * 10) / 10

/** A burst in a band's 10 ms levels: frames [start, end) and its mean level, dBFS. */
export interface Burst { start: number; end: number; level: number }

/** The band's typical level and the bursts in it. `clean` = those with nothing else 600 ms before and 1.5 s after
 *  (otherwise "before" is the previous ring and "after" the next "s"). */
export function findBursts(env: Float32Array | number[]): { ambientDb: number; bursts: Burst[]; clean: Burst[] } {
  const n = env.length
  const ambientDb = quant([...env].sort((a, b) => a - b), 0.5)
  const thr = ambientDb + BURST_OVER
  const bursts: Burst[] = []
  for (let t = 0; t < n; t++) {
    if (env[t]! < thr) continue
    let e = t
    // a burst may dip under the line for up to 30 ms and still be one burst
    for (let k = t; k < n; k++) { if (env[k]! >= thr) e = k; else if (k - e > 3) break }
    if ((e - t + 1) * 10 >= BURST_MIN_MS) {
      let p = 0
      for (let k = t; k <= e; k++) p += Math.pow(10, env[k]! / 10)
      bursts.push({ start: t, end: e + 1, level: db(p / (e - t + 1)) })
    }
    t = e + 1
  }
  const clean = bursts.filter((b, i) => (i === 0 || b.start - bursts[i - 1]!.end > 60) && (i === bursts.length - 1 || bursts[i + 1]!.start - b.end > 150) && b.start > 40 && b.end + 150 < n)
  return { ambientDb, bursts, clean: clean.length >= 6 ? clean : bursts.filter((b) => b.start > 40 && b.end + 150 < n) }
}

/** From a band's 10 ms levels (dBFS). null when there is too little to go on. */
export function analyseRing(env: Float32Array | number[], splitHz: number): RingMeasure | null {
  const n = env.length
  if (n < 3000) return null   // under 30 s
  const { ambientDb, bursts, clean: use } = findBursts(env)
  const minutes = n / 6000
  const base: RingMeasure = { v: 1, splitHz, ambientDb: r1(ambientDb), bursts: bursts.length, perMin: r1(bursts.length / minutes), burstMs: 0, burstLongMs: 0, burstDb: 0, offsets: RING_OFFSETS, excessDb: RING_OFFSETS.map(() => 0), ringDb: 0, halfMs: 0, slope: 0, zeroDb: 0 }
  if (bursts.length < 8) return base
  const meanPow = (a: number, b: number) => { let p = 0, c = 0; for (let k = Math.max(0, a); k < Math.min(n, b); k++) { p += Math.pow(10, env[k]! / 10); c++ } return c ? db(p / c) : NaN }
  if (use.length < 6) return base
  const pre = use.map((b) => meanPow(b.start - 30, b.start - 5))                       // 300 … 50 ms before
  const excessAt = (off: number) => use.map((b, i) => meanPow(b.end + off / 10 - 2, b.end + off / 10 + 3) - pre[i]!)   // ±25 ms window
  const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length
  const excess = RING_OFFSETS.map((off) => mean(excessAt(off)))
  // the ring itself: 150 … 400 ms after the burst (the burst's own decay is over, the ring is still there)
  const ringEach = use.map((b, i) => meanPow(b.end + 15, b.end + 40) - pre[i]!)
  const ringDb = mean(ringEach)
  // how long until the leftover is half of that (in dB)
  let halfMs = RING_OFFSETS.at(-1)!
  for (let i = 0; i < RING_OFFSETS.length; i++) if (RING_OFFSETS[i]! >= 300 && excess[i]! <= ringDb / 2) { halfMs = RING_OFFSETS[i]!; break }
  // louder bursts ring more: least-squares line ring = slope × (burst level − zeroDb)
  const lv = use.map((b) => b.level), ml = mean(lv), mr = mean(ringEach)
  let sxy = 0, sxx = 0
  for (let i = 0; i < use.length; i++) { sxy += (lv[i]! - ml) * (ringEach[i]! - mr); sxx += (lv[i]! - ml) ** 2 }
  const slope = sxx > 0 ? sxy / sxx : 0
  const zeroDb = slope > 0.05 ? ml - mr / slope : NaN
  const lens = use.map((b) => (b.end - b.start) * 10).sort((a, b) => a - b)
  return {
    ...base, burstMs: quant(lens, 0.5), burstLongMs: quant(lens, 0.9), burstDb: r1(quant([...lv].sort((a, b) => a - b), 0.5)),
    excessDb: excess.map(r1), ringDb: r1(ringDb), halfMs, slope: Math.round(slope * 100) / 100, zeroDb: Number.isFinite(zeroDb) ? r1(zeroDb) : 0,
  }
}

/** The 10 ms level (dBFS) of the band above `splitHz`, after an optional filter chain (to check a setting's effect). */
export function bandLevels(bin: string, file: string, splitHz: number, signal?: AbortSignal, pre = '', rack?: { graph: string; files: string[] }, span?: { start: number; seconds: number }): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    // the same split a tamer uses, so what is measured is what it will act on
    const split = `aresample=${RATE},acrossover=split=${Math.round(splitHz)}:order=8th[lo][hi];[lo]anullsink`
    const graph = rack ? `${rack.graph};[out]${split}` : `[0:a]${pre ? `${pre},` : ''}${split}`
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...(span ? ['-ss', String(span.start), '-t', String(span.seconds)] : []), '-i', file, ...(rack?.files ?? []).flatMap((f) => ['-i', f]), '-filter_complex', graph, '-map', '[hi]', '-ac', '1', '-f', 'f32le', 'pipe:1'], { windowsHide: true })
    const out: number[] = []
    let carry: Buffer = Buffer.alloc(0), acc = 0, cnt = 0, err = ''
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (b: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, b]) : b
      const whole = buf.length - (buf.length % 4)
      for (let o = 0; o < whole; o += 4) { const x = buf.readFloatLE(o); acc += x * x; if (++cnt === HOP) { out.push(db(acc / HOP)); acc = 0; cnt = 0 } }
      carry = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0)
    })
    child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString() })
    child.on('error', (e) => reject(new Error(`Could not start ffmpeg (${bin}): ${e.message}`)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-2).join(' · ') || `ffmpeg exited with code ${code}`))
      resolve(Float32Array.from(out))
    })
  })
}

export async function measureRingFile(bin: string, file: string, splitHz = 4500, signal?: AbortSignal, rack?: { graph: string; files: string[] }, span?: { start: number; seconds: number }): Promise<RingMeasure | null> {
  return analyseRing(await bandLevels(bin, file, splitHz, signal, '', rack, span), splitHz)
}

// ── where does the ring start? ────────────────────────────────────────────────

/** Band edges the search looks between, Hz. Below the first, a tamer would be ducking the voice's own clarity. */
export const SPLIT_EDGES = [3000, 3750, 4500, 5500, 7000]
/** A band counts as ringing when it stays this far above its level from before … */
const SPLIT_MIN_DB = 2
/** … and at least this share of what the strongest band does. */
const SPLIT_SHARE = 0.4
export const DEFAULT_SPLIT = 4500

/**
 * From the 10 ms levels of the bands between SPLIT_EDGES (the last one open-ended): which bands ring after an "s"?
 * The bursts are found in everything from 4.5 kHz up (where an "s" stands clear of the voice); each band is then read
 * 100–250 ms after a burst ends against 300–50 ms before it began. The voice that follows an "s" is as likely to be
 * louder as quieter than the voice before it, so over many bursts it averages out and what is left is the ring.
 * The split is the lower edge of the lowest band that rings, going down from the strongest one without a gap.
 */
export function chooseSplit(bands: Float32Array[], edges = SPLIT_EDGES): RingSplit {
  const n = bands[0]?.length ?? 0
  const from = edges.indexOf(DEFAULT_SPLIT)
  const ref = new Float32Array(n)
  for (let t = 0; t < n; t++) { let p = 0; for (let k = Math.max(0, from); k < bands.length; k++) p += Math.pow(10, bands[k]![t]! / 10); ref[t] = db(p) }
  const { clean } = findBursts(ref)
  const meanPow = (env: Float32Array, a: number, b: number) => { let p = 0, c = 0; for (let k = Math.max(0, a); k < Math.min(n, b); k++) { p += Math.pow(10, env[k]! / 10); c++ } return c ? db(p / c) : NaN }
  const out: RingBand[] = bands.map((env, k) => {
    const each = clean.map((b) => meanPow(env, b.end + 10, b.end + 25) - meanPow(env, b.start - 30, b.start - 5)).filter(Number.isFinite)
    return { fromHz: edges[k]!, toHz: edges[k + 1] ?? null, excessDb: each.length ? r1(each.reduce((s, x) => s + x, 0) / each.length) : 0 }
  })
  if (clean.length < 6) return { splitHz: DEFAULT_SPLIT, bands: out, bursts: clean.length }
  let top = 0
  for (let k = 1; k < out.length; k++) if (out[k]!.excessDb > out[top]!.excessDb) top = k
  const need = Math.max(SPLIT_MIN_DB, SPLIT_SHARE * out[top]!.excessDb)
  if (out[top]!.excessDb < need) return { splitHz: DEFAULT_SPLIT, bands: out, bursts: clean.length }   // nothing rings: the split does not matter
  let low = top
  while (low > 0 && out[low - 1]!.excessDb >= need) low--
  return { splitHz: out[low]!.fromHz, bands: out, bursts: clean.length }
}

/** The 10 ms levels (dBFS) of each band between `edges` (the last open-ended), from one decode. */
export function multiBandLevels(bin: string, file: string, edges = SPLIT_EDGES, signal?: AbortSignal, span?: { start: number; seconds: number }): Promise<Float32Array[]> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled'))
    const nb = edges.length
    const labels = Array.from({ length: nb + 1 }, (_, i) => `[b${i}]`)
    // one crossover into all bands; the part under the first edge is dropped, the rest travel as channels of one stream
    // (join, not amerge: this ffmpeg refuses to amerge several mono inputs). The map is spelled out: left to itself join
    // puts a mono input on the centre channel first and shuffles the bands.
    const layouts: Record<number, [string, string[]]> = { 1: ['mono', ['FC']], 2: ['stereo', ['FL', 'FR']], 3: ['3.0', ['FL', 'FR', 'FC']], 4: ['4.0', ['FL', 'FR', 'FC', 'BC']], 5: ['5.0', ['FL', 'FR', 'FC', 'BL', 'BR']], 6: ['6.0', ['FL', 'FR', 'FC', 'BC', 'SL', 'SR']], 7: ['7.0', ['FL', 'FR', 'FC', 'BL', 'BR', 'SL', 'SR']] }
    const layout = layouts[nb]
    if (!layout) return reject(new Error('between 1 and 7 band edges'))
    const graph = `[0:a]aresample=${RATE},acrossover=split=${edges.map((e) => Math.round(e)).join(' ')}:order=8th${labels.join('')};[b0]anullsink;${labels.slice(1).join('')}join=inputs=${nb}:channel_layout=${layout[0]}:map=${layout[1].map((c, i) => `${i}.0-${c}`).join('|')}[m]`
    const child = spawn(bin, ['-hide_banner', '-loglevel', 'error', ...(span ? ['-ss', String(span.start), '-t', String(span.seconds)] : []), '-i', file, '-filter_complex', graph, '-map', '[m]', '-f', 'f32le', 'pipe:1'], { windowsHide: true })
    const out: number[][] = Array.from({ length: nb }, () => [])
    const acc = new Float64Array(nb)
    let carry: Buffer = Buffer.alloc(0), cnt = 0, ch = 0, err = ''
    const onAbort = () => child.kill()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout.on('data', (b: Buffer) => {
      const buf = carry.length ? Buffer.concat([carry, b]) : b
      const whole = buf.length - (buf.length % 4)
      for (let o = 0; o < whole; o += 4) {
        const x = buf.readFloatLE(o)
        acc[ch] = acc[ch]! + x * x
        if (++ch === nb) { ch = 0; if (++cnt === HOP) { for (let k = 0; k < nb; k++) { out[k]!.push(db(acc[k]! / HOP)); acc[k] = 0 } cnt = 0 } }
      }
      carry = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0)
    })
    child.stderr.on('data', (b: Buffer) => { if (err.length < 4000) err += b.toString() })
    child.on('error', (e) => reject(new Error(`Could not start ffmpeg (${bin}): ${e.message}`)))
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new Error('Cancelled'))
      if (code !== 0) return reject(new Error(err.trim().split('\n').slice(-2).join(' · ') || `ffmpeg exited with code ${code}`))
      resolve(out.map((a) => Float32Array.from(a)))
    })
  })
}

export async function findSplitFile(bin: string, file: string, signal?: AbortSignal, span?: { start: number; seconds: number }): Promise<RingSplit> {
  return chooseSplit(await multiBandLevels(bin, file, SPLIT_EDGES, signal, span))
}
