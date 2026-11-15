/**
 * What Auto-set aims at and what it hands back. Kept apart so every part of the steering can share them.
 */
import type { ModuleKey, Modules } from '../audio-modules'

export interface SuggestNote { module: ModuleKey; text: string }

/**
 * The sound every recording under a rule is steered towards: how the rule's reference recordings measure AFTER their
 * settings (the mean), plus the settings it came from for what cannot be measured.
 */
export interface AudioTarget {
  /** Reference recordings it was measured on. */
  count: number
  /** High-pass of the rule's settings, Hz (0 = none). */
  hp: number
  /** Tone of the processed references per MEASURE_BANDS entry, dB relative to the voice level. */
  tone: number[]
  /** How far their loudest moments (99th percentile) sit above their typical level after processing, dB. */
  over: number
  /** Their quiet moments per MEASURE_BANDS entry after processing, dB relative to the voice level: how much static they have. */
  quiet: number[]
  /** What is left of the ring after an “s” in them after processing (100–150 ms after it), dB over the room’s level. */
  ring: number
  /** Their loudness after processing, LUFS: what every recording is brought to. */
  lufs: number
  /** How quiet their quietest moments are after processing, dB under the voice: how much room they have in them. With a
   *  rule that uses reverb, each recording's reverb is set to reach this. */
  floorDb?: number
  /** The first reference's settings. Gain, gate, de-esser, delay and limiter are taste, not something a measurement can
   *  decide, and are taken from here; so are the reverb's character and the peak ceiling. */
  base: Modules
  /** Voice level and typical level of the recording `base` was dialled in on, dBFS: level-dependent settings move with them. */
  baseVoiceDb: number
  baseTypicalDb: number
  measureVersion: number
  capturedAt: string
}
