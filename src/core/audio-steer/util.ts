/** Small helpers and the limits every part of the steering shares. */
import { MEASURE_BANDS } from '../../plugins/audio/types'

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const round = (v: number, step: number) => Number((Math.round(v / step) * step).toFixed(4))
export const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.ceil((s.length - 1) / 2)]!) / 2 : 0 }
export const f1 = (v: number) => v.toFixed(1)
export const signed = (v: number) => `${v > 0 ? '+' : ''}${f1(v)}`
export const hz = (f: number) => (f >= 1000 ? `${Number((f / 1000).toFixed(1))} kHz` : `${Math.round(f)} Hz`)

/** Differences in tone smaller than this are left alone, dB. */
export const TONE_DEADBAND = 1
/** A band is only boosted when the voice in it stands this far above the recording's quiet moments, dB (else the boost raises noise). */
export const BOOST_MIN_CLEARANCE = 10
/** Bands compared: below ~100 Hz is under the voice, above 10 kHz depends on the file format more than on the sound. */
export const FIT_LO = 100, FIT_HI = 10000
/** The most the EQ asks of any band, dB. */
export const EQ_MAX = 9
/** The compared bands, as indexes into MEASURE_BANDS. */
export const idxFit = MEASURE_BANDS.map((f, b) => (f >= FIT_LO && f <= FIT_HI ? b : -1)).filter((b) => b >= 0)
