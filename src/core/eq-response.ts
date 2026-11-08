/**
 * Frequency response of the strip's EQ, computed the way ffmpeg's biquad filters are (RBJ cookbook):
 * highpass/lowpass with Q, low/high shelf with Q, peaking with Q. Used only to draw the curve.
 */
import type { EqState } from './audio-modules'

interface Biquad { b0: number; b1: number; b2: number; a0: number; a1: number; a2: number }

function peaking(f0: number, q: number, gainDb: number, fs: number): Biquad {
  const A = Math.pow(10, gainDb / 40), w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0)
  return { b0: 1 + alpha * A, b1: -2 * c, b2: 1 - alpha * A, a0: 1 + alpha / A, a1: -2 * c, a2: 1 - alpha / A }
}
function highpass(f0: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0)
  return { b0: (1 + c) / 2, b1: -(1 + c), b2: (1 + c) / 2, a0: 1 + alpha, a1: -2 * c, a2: 1 - alpha }
}
function lowpass(f0: number, q: number, fs: number): Biquad {
  const w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0)
  return { b0: (1 - c) / 2, b1: 1 - c, b2: (1 - c) / 2, a0: 1 + alpha, a1: -2 * c, a2: 1 - alpha }
}
function lowshelf(f0: number, q: number, gainDb: number, fs: number): Biquad {
  const A = Math.pow(10, gainDb / 40), w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0), s = 2 * Math.sqrt(A) * alpha
  return { b0: A * (A + 1 - (A - 1) * c + s), b1: 2 * A * (A - 1 - (A + 1) * c), b2: A * (A + 1 - (A - 1) * c - s), a0: A + 1 + (A - 1) * c + s, a1: -2 * (A - 1 + (A + 1) * c), a2: A + 1 + (A - 1) * c - s }
}
function highshelf(f0: number, q: number, gainDb: number, fs: number): Biquad {
  const A = Math.pow(10, gainDb / 40), w0 = (2 * Math.PI * f0) / fs, alpha = Math.sin(w0) / (2 * q), c = Math.cos(w0), s = 2 * Math.sqrt(A) * alpha
  return { b0: A * (A + 1 + (A - 1) * c + s), b1: -2 * A * (A - 1 + (A + 1) * c), b2: A * (A + 1 + (A - 1) * c - s), a0: A + 1 - (A - 1) * c + s, a1: 2 * (A - 1 - (A + 1) * c), a2: A + 1 - (A - 1) * c - s }
}

/** |H(f)| in dB for one biquad. */
function magnitudeDb(b: Biquad, f: number, fs: number): number {
  const w = (2 * Math.PI * f) / fs
  const cw = Math.cos(w), sw = Math.sin(w), c2w = Math.cos(2 * w), s2w = Math.sin(2 * w)
  const nr = b.b0 + b.b1 * cw + b.b2 * c2w, ni = -(b.b1 * sw + b.b2 * s2w)
  const dr = b.a0 + b.a1 * cw + b.a2 * c2w, di = -(b.a1 * sw + b.a2 * s2w)
  return 10 * Math.log10((nr * nr + ni * ni) / Math.max(1e-30, dr * dr + di * di))
}

/** The active stages of an EQ state as biquads (ffmpeg highpass/lowpass with poles=2 are one biquad each). */
export function eqBiquads(eq: EqState, fs = 48000): Biquad[] {
  if (!eq.on) return []
  const out: Biquad[] = []
  if (eq.hp.on) out.push(highpass(eq.hp.freq, eq.hp.q, fs))
  if (eq.ls.on && eq.ls.gain !== 0) out.push(lowshelf(eq.ls.freq, eq.ls.q, eq.ls.gain, fs))
  for (const b of eq.bands) if (b.on && b.gain !== 0) out.push(peaking(b.freq, b.q, b.gain, fs))
  if (eq.hs.on && eq.hs.gain !== 0) out.push(highshelf(eq.hs.freq, eq.hs.q, eq.hs.gain, fs))
  if (eq.lp.on) out.push(lowpass(eq.lp.freq, eq.lp.q, fs))
  return out
}

/** Total response in dB at frequency f. */
export function eqResponseDb(eq: EqState, f: number, fs = 48000): number {
  let db = 0
  for (const b of eqBiquads(eq, fs)) db += magnitudeDb(b, f, fs)
  return db
}

/** Log-spaced frequencies for the plot. */
export function logFrequencies(n: number, lo = 20, hi = 20000): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(lo * Math.pow(hi / lo, i / (n - 1)))
  return out
}
