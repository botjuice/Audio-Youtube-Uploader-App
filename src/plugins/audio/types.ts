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
