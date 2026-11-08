/**
 * Look → ffmpeg filter graph. Pure: no I/O, so every look's exact filter string is unit-tested.
 *
 * Only numbers from a *validated* look reach the string (formatted by `n()`), never free text:
 * the ffmpeg 6.0 we ship segfaults on an unknown option instead of reporting it.
 *
 * Input pads: [0:a] = the recording, [1:a] = the reverb IR (only when reverb is on).
 * Output pad: [out].
 */
import type { Look } from './look'

/** Every filter the chain or the analysis can use — checked against the binary once. */
export const REQUIRED_FILTERS = [
  'aresample', 'aformat', 'adeclip', 'adeclick', 'highpass', 'lowpass', 'afftdn', 'equalizer', 'treble', 'deesser',
  'acompressor', 'pan', 'asplit', 'afir', 'volume', 'amix', 'alimiter', 'afade', 'ebur128', 'astats',
  'asetnsamples', 'ametadata', 'aeval',
] as const

/** Fixed number format: no exponent, at most 4 decimals. */
export const n = (x: number) => String(+x.toFixed(4))
export const dbToLinear = (db: number) => Math.pow(10, db / 20)

/** Even with a unit-energy IR, the echo of recitation comes out louder than the voice, more so the
 *  longer the decay (sustained notes add up inside the tail). Measured 2026-11-08 on three real
 *  recordings × three decays, loudness of wet-only vs dry (LU): 0.9 s → 2.3–2.8, 2.2 s → 3.5–4.0,
 *  3.5 s → 4.5–5.1. Linear fit below; subtracted so `reverb.amount` means "dB relative to the voice". */
export const reverbLevelOffset = (decaySec: number) => 1.9 + 0.8 * decaySec

export interface ChainOptions {
  /** Source channel count (1 = mono recordings, the usual case). */
  channels: number
  /** 'measure' ends in ebur128 before levelling; 'render' applies gain, limiter and fades. */
  mode: 'measure' | 'render'
  /** Loudness gain in dB (render mode; 0 when levelling is off). */
  gainDb?: number
  /** Fades in render mode, in seconds of the *output* timeline. */
  fadeIn?: number
  fadeOut?: { start: number; duration: number }
  /** Only cut + level: no processing stages (A/B original side). */
  bypass?: boolean
}

/** The processing stages (everything before levelling), as a list of graph segments. */
export function stageFilters(look: Look, channels: number): { linear: string[]; reverb: boolean } {
  const f: string[] = []
  const c = look.cleanup
  if (c.declip.enabled) f.push('adeclip')
  if (c.clicks.enabled) f.push('adeclick')
  if (c.rumble.enabled) f.push(`highpass=f=${n(c.rumble.frequency)}:poles=2`, `highpass=f=${n(c.rumble.frequency)}:poles=2`)
  if (c.hiss.enabled) f.push(`afftdn=nr=${n(c.hiss.amount)}:nf=-42:tn=1`)
  const t = look.tone
  if (t.enabled) {
    if (t.mud.gain !== 0) f.push(`equalizer=f=${n(t.mud.frequency)}:t=q:w=1:g=${n(t.mud.gain)}`)
    if (t.presence.gain !== 0) f.push(`equalizer=f=${n(t.presence.frequency)}:t=q:w=1.2:g=${n(t.presence.gain)}`)
    if (t.air.gain !== 0) f.push(`treble=f=${n(t.air.frequency)}:g=${n(t.air.gain)}`)
    if (t.deesser > 0) f.push(`deesser=i=${n(t.deesser)}:m=0.5:f=0.5`)
  }
  const d = look.dynamics
  if (d.enabled) f.push(`acompressor=threshold=${n(d.threshold)}dB:ratio=${n(d.ratio)}:attack=${n(d.attack)}:release=${n(d.release)}:makeup=1`)
  if (look.reverb.enabled && channels === 1) f.push('pan=stereo|c0=c0|c1=c0')
  return { linear: f, reverb: look.reverb.enabled }
}

/** Number of output channels for a look. */
export const outputChannels = (look: Look, channels: number, bypass = false) => (!bypass && look.reverb.enabled ? Math.max(2, channels) : channels)

/** The whole -filter_complex string. */
export function buildGraph(look: Look, o: ChainOptions): string {
  const head = ['aresample=48000', 'aformat=sample_fmts=fltp']
  const parts: string[] = []
  let label = '[0:a]'
  const segment = (filters: string[], to: string) => { parts.push(`${label}${filters.join(',')}${to}`); label = to }

  if (o.bypass) {
    segment(head, '[pre]')
  } else {
    const { linear, reverb } = stageFilters(look, o.channels)
    segment([...head, ...linear], reverb ? '[dry0]' : '[pre]')
    if (reverb) {
      // dry + calibrated wet; the IR is unit-energy (ir.ts), so `amount` is dB relative to the voice
      parts.push(`[dry0]asplit=2[dry][wetin]`)
      parts.push(`[wetin][1:a]afir=dry=1:wet=1:gtype=none[wet]`)
      parts.push(`[wet]volume=${n(look.reverb.amount - reverbLevelOffset(look.reverb.decay))}dB[wetv]`)
      parts.push(`[dry][wetv]amix=inputs=2:normalize=0:duration=longest[pre]`)
      label = '[pre]'
    }
  }

  const tail: string[] = []
  if (o.mode === 'measure') {
    tail.push('ebur128=peak=true:framelog=verbose')
  } else {
    if (o.gainDb) tail.push(`volume=${n(o.gainDb)}dB`)
    // always: nothing can exceed the ceiling (also guards EQ/reverb boosts when levelling is off).
    // Run at 4× rate so it catches inter-sample (true) peaks: at 48 kHz 8 of 53 real files ended
    // 0.1–0.8 dB over the ceiling as measured by ebur128's true peak; at 192 kHz all land on it.
    tail.push('aresample=192000', `alimiter=limit=${n(dbToLinear(look.limiter.ceiling))}:level=0:attack=5:release=50:latency=1`, 'aresample=48000')
    if (o.fadeIn && o.fadeIn > 0) tail.push(`afade=t=in:st=0:d=${n(o.fadeIn)}`)
    if (o.fadeOut && o.fadeOut.duration > 0) tail.push(`afade=t=out:st=${n(Math.max(0, o.fadeOut.start))}:d=${n(o.fadeOut.duration)}`)
  }
  parts.push(`${label}${tail.join(',')}[out]`)
  return parts.join(';')
}
