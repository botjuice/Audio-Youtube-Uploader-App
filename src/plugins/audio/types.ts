/**
 * Audio plugin — public contract.
 *
 * The app hands the plugin an audio file + a look (a rack of ffmpeg filters, see look.ts) and gets
 * back one processed file (FLAC) or a reason. The plugin imports nothing from src/main or src/core,
 * and does not locate ffmpeg itself: the host passes the binary.
 */
import type { Level, Look, LookError } from './look'

export interface AudioJob {
  /** Absolute path of the original recording. Never modified. */
  audioPath: string
  /** The rack to run. Missing = no effects. Validated with validateLook. */
  look?: Look | unknown
  /** Render only an excerpt (the editor's A/B chunks). Inside the rack, time (t) is recording time, so
   *  fades, `enable` ranges and atrim act exactly where they would in the whole file. Filters still start
   *  cold at the excerpt's first sample: render a little earlier and skip it on playback (the pre-roll). */
  preview?: { start: number; seconds: number }
  /** Ignore the rack (and the look's levelling): only cut the excerpt. Combine with `level` to get
   *  a level-matched original for an A/B comparison. */
  bypass?: boolean
  /** Override the look's levelling for this job: a Level to level to, or null for none. */
  level?: Level | null
  /** Levelling gain to apply instead of measuring this span: the whole recording's (`levellingGain`). An excerpt levelled
   *  on its own gets a different gain than the recording will, and a quiet one is pushed into the limiter. dB. */
  gainDb?: number
  /** With `gainDb`: the rack's output sample rate, also from `levellingGain`. Given both, the render skips its own
   *  measuring pass (it has nothing left to find out). */
  rate?: number
}

export interface AudioHost {
  /** Directory the plugin may write to (processed files + sidecars). Created if missing. */
  outputDir: string
  /** Absolute path of the ffmpeg binary (the app's ffmpeg-static). */
  ffmpegPath: string
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  signal?: AbortSignal
  /** 0–100 over the whole job (measure + render + verify). */
  onProgress?: (percent: number) => void
  /** Kill ffmpeg after this long without progress (default 30 s). */
  stallMs?: number
}

/** What `analyse()` measures. All levels in dB / LUFS. */
export interface AudioAnalysis {
  durationSec: number
  sampleRate: number
  channels: number
  /** Integrated loudness (EBU R128). */
  lufs: number
  /** Loudness range — small (< 5 LU) means already evenly levelled. */
  lra: number
  /** True peak, dBFS (may be slightly above 0 on decoded AAC; that alone is not clipping). */
  truePeak: number
  /** Share of samples above −0.5 dBFS, in %. Normal recordings: 0–0.02 %; clipped audio: far above 0.1 %. */
  hotSamplesPct: number
  /** Background hiss: quiet-moment level above 4 kHz, in dB relative to `lufs`. Lower = cleaner. */
  hissDb: number
  /** Low rumble: median level below 60 Hz, in dB relative to `lufs`. Lower = cleaner. */
  rumbleDb: number
  clipped: boolean
  /** Plain-language findings. */
  hints: string[]
}

/** Bump when `measure()` changes what its numbers mean: stored measurements of an older version are redone. */
export const MEASURE_VERSION = 1
/** Third-octave band centres of `Measure.tone` / `Measure.quiet`, Hz. */
export const MEASURE_BANDS = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500]

/** What `measure()` finds: the recording's tone and level behaviour, everything relative to its own voice level
 *  (a quiet and a loud copy of one recording measure the same). Input for suggesting settings; changes no audio. */
export interface Measure {
  v: number
  durationSec: number
  /** Level of the voice: power-mean of the 64 ms frames that carry it, dBFS. */
  voiceDb: number
  /** Share of the recording that is voice, 0…1. */
  activeShare: number
  /** Tone: mean power per band over voiced frames, dB relative to `voiceDb`. One value per MEASURE_BANDS entry. */
  tone: number[]
  /** Quiet moments: per band, the level 5 % of frames stay below, dB relative to `voiceDb`. */
  quiet: number[]
  /** Broadband level of the quietest moments (2nd percentile of frames), dB relative to `voiceDb`. */
  floorDb: number
  /** Frame levels over voiced frames, dB relative to `voiceDb`: 10th, 50th, 90th, 95th, 99th percentile. */
  levels: { p10: number; p50: number; p90: number; p95: number; p99: number }
  /** Highest sample, dB relative to `voiceDb` (crest). */
  peakDb: number
  /** Sharpness of "s" sounds: the 4–10 kHz share of a frame's power (dB), 95th percentile over voiced frames. */
  sibilance: number
}

/** What `ring()` finds: whether the band above `splitHz` keeps ringing after loud bursts in it ("s" sounds). Levels in dBFS / dB. */
export interface RingMeasure {
  v: number
  splitHz: number
  /** Typical level of the band (median of 10 ms levels). */
  ambientDb: number
  /** Bursts found (the band ≥ 12 dB over its typical level for ≥ 40 ms), and per minute. */
  bursts: number
  perMin: number
  /** How long bursts last, ms: median and 90th percentile. 0 when too few bursts were found to say anything (also for the fields below). */
  burstMs: number
  burstLongMs: number
  /** Level of a typical burst (median of the bursts' mean levels). */
  burstDb: number
  /** Leftover after a burst ends: mean level over the level just before the burst, dB, at `offsets` ms after its end. */
  offsets: number[]
  excessDb: number[]
  /** The ring: that leftover averaged over 150–400 ms after the burst. About 0 = no ring. */
  ringDb: number
  /** How long after the burst until the leftover has halved (in dB), ms. */
  halfMs: number
  /** Louder bursts ring more: ring ≈ slope × (burst level − zeroDb). slope 0 = no such relation found. */
  slope: number
  zeroDb: number
  /** When the split was searched for (`ringSplit`): the ring found in each band it looked at. */
  bands?: RingBand[]
}

/** One band of a ring search: how far it stays above its level from before, 100–250 ms after an "s" ends, dB. */
export interface RingBand { fromHz: number; toHz: number | null; excessDb: number }
/** What `ringSplit()` finds: the frequency above which the ring after "s" sounds lives in this recording. */
export interface RingSplit { splitHz: number; bands: RingBand[]; bursts: number }

/** Measured on the processed file. */
export interface AfterMeasure {
  durationSec: number
  sampleRate: number
  channels: number
  lufs: number
  truePeak: number
  /** Highest sample, dBFS. ≥ 0 means the rack pushed past full scale and the FLAC copy clipped there. */
  samplePeak: number
}

export type AudioReason =
  | 'INVALID_JOB'
  | 'INVALID_LOOK'         // the look failed validateLook, or ffmpeg rejected it (`errors` say which step)
  | 'AUDIO_UNREADABLE'     // the recording, or a file a step reads, cannot be read
  | 'SILENT_INPUT'         // levelling asked for, but there is nothing to level
  | 'FFMPEG_UNUSABLE'      // binary missing, or not the build the catalog was made from
  | 'PROCESS_FAILED'       // ffmpeg exited with an error (message carries its last lines)
  | 'TIMEOUT'              // ffmpeg stopped making progress (watchdog)
  | 'CANCELLED'
  | 'SILENT_OUTPUT'        // the rack removed the signal
  | 'LOUDNESS_OFF_TARGET'  // levelling landed more than 3 LU from the target

export type AudioResult =
  | {
      ok: true
      /** Processed audio: FLAC (32-bit), at whatever rate and channel count the rack produces. */
      file: string
      /** Stable key for audio identity + exact graph + extra files; the app folds it into the video key. */
      cacheKey: string
      /** True when nothing was processed because the file already existed. */
      cached: boolean
      after: AfterMeasure
      /** Length of the input that went in (excerpt or whole recording), seconds. */
      inputSec: number
      /** Gain applied by levelling, dB (0 when there is no levelling). */
      gainDb: number
      /** Non-fatal notes: length changed, clipped peaks, gain capped, … */
      warnings: string[]
    }
  | { ok: false; reason: AudioReason; message: string; errors?: LookError[] }

/** Result of checkLook: ffmpeg's own verdict on a look, mapped to steps where it can be. */
export type LookCheck = { ok: true; sampleRate: number; channels: number } | { ok: false; errors: LookError[] }

export interface PluginManifest {
  id: string
  version: string
  /** Bump to invalidate every cached file (any change to how looks become files). */
  renderVersion: number
  /** Version of the look format (2 = filter rack). */
  lookVersion: number
}
