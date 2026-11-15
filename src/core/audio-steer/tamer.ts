/** Ringing after "s" sounds: what counts as the ring, and the Spring tamer settings that counter it. */
import type { RingMeasure } from '../../plugins/audio/types'
import { defaultModules, type Modules } from '../audio-modules'
import { clamp, f1, hz, round } from './util'

/** How far the band stays above its level from before, 100–150 ms after an "s" ends, dB: the one number for "how much
 *  rings". null when too few bursts were found to say. */
export function ringLeftover(r: RingMeasure | null | undefined): number | null {
  return r && r.burstMs ? ((r.excessDb[r.offsets.indexOf(100)] ?? 0) + (r.excessDb[r.offsets.indexOf(150)] ?? 0)) / 2 : null
}

/** A ring under this (dB over the level just before the burst) is left alone. */
const RING_MIN = 1.5
/** The tamer never ducks deeper than this, however much rings: deeper is heard as a hole after the "s". */
const RING_MAX_DEPTH = 8
/** Share of the level above the threshold that is taken off when the recording does not say (ratio 2.5:1). */
export const TAMER_SLOPE = 0.6
/** The share is taken from the recording (how much more a louder "s" rings) only within these limits: 1.7:1 … 3.3:1.
 *  Firmer than that (tried: 5:1) left the loudest "s" sounds up to 2 dB under the room's level, the start of a hole. */
const TAMER_SLOPE_MIN = 0.4, TAMER_SLOPE_MAX = 0.7
/** A measured relation flatter than this is noise, not a relation. */
const TAMER_SLOPE_TRUST = 0.2
/** Measured on recordings from −27 to −47 dBFS burst level (2026-11-13): the ducker reacts as if a typical burst were this
 *  much above the burst level `ring()` reports, so depth ≈ (burst level + this − threshold) × share. */
const TAMER_SEES = 1.5

/** Spring tamer settings that counter the ring `ring()` found, every one from this recording: where the ring lives (its
 *  split), as deep as the ring stands out just after an "s" (threshold), growing with louder "s" sounds the way the ring
 *  itself does (ratio), starting once a typical "s" has passed (delay), letting go as fast as the ring dies away (release). */
export function tamerFor(ring: RingMeasure | null | undefined): { spring: Modules['spring']; text: string } {
  const off = { ...defaultModules().spring, on: false }
  if (!ring || !ring.burstMs) return { spring: off, text: `Off: too few “s” bursts were found above ${hz(ring?.splitHz ?? off.split)} to measure a ring (${ring?.bursts ?? 0}).` }
  const depth = clamp(ringLeftover(ring) ?? 0, 0, RING_MAX_DEPTH)
  const where = ring.bands?.length
    ? ` (looked between ${hz(ring.bands[0]!.fromHz)} and ${hz(ring.bands.at(-1)!.fromHz)}: ${ring.bands.map((b) => `${f1(b.excessDb)} dB from ${hz(b.fromHz)}`).join(', ')})`
    : ''
  if (depth < RING_MIN) return { spring: { ...off, split: ring.splitHz }, text: `Off: no ring to speak of. After an “s” the band above ${hz(ring.splitHz)} is back at its level from before within about 0.1 s (${f1(depth)} dB over it)${where}.` }
  const share = ring.slope >= TAMER_SLOPE_TRUST ? clamp(ring.slope, TAMER_SLOPE_MIN, TAMER_SLOPE_MAX) : TAMER_SLOPE
  const spring: Modules['spring'] = {
    on: true, split: ring.splitHz, ratio: round(1 / (1 - share), 0.1),
    threshold: round(clamp(ring.burstDb + TAMER_SEES - depth / share, -70, 0), 0.5),
    delay: round(clamp(ring.burstMs, 100, 300), 10), attack: 70,
    release: round(clamp(ring.halfMs * 1.3, 400, 1500), 50),
  }
  const grows = ring.slope >= TAMER_SLOPE_TRUST ? `a 1 dB louder “s” rings ${f1(ring.slope)} dB more, so ${spring.ratio.toFixed(1)}:1` : `no clear relation between how loud an “s” is and how much it rings, so the usual ${spring.ratio.toFixed(1)}:1`
  return { spring, text: `On above ${hz(ring.splitHz)}, where the ring starts in this recording${where}. ${ring.bursts} “s” bursts found (${f1(ring.perMin)} a minute); after each, that band stays ${f1(depth)} dB above its level from before and takes about ${(ring.halfMs / 1000).toFixed(1)} s to fall halfway back. So it is turned down by about that much (threshold ${f1(spring.threshold)} dB; ${grows}), starting ${spring.delay} ms after the “s” begins (a typical one has passed by then), easing in over 70 ms, and let go over ${spring.release} ms.` }
}
