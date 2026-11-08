/**
 * Audio plugin — public contract.
 *
 * The app hands the plugin an audio file + an optional look patch and gets back one processed
 * file (FLAC) or a reason. Nothing else crosses the boundary. The plugin imports nothing from
 * src/main or src/core, and does not locate ffmpeg itself: the host passes the binary.
 */
import type { LookPatch } from './look'

export interface AudioJob {
  /** Absolute path of the original recording. Never modified. */
  audioPath: string
  /** Any subset of the knobs in LOOK_SCHEMA. Missing knobs take the defaults. */
  look?: LookPatch
  /** Render only an excerpt (for the editor's A/B player). Fades are applied only where the
   *  excerpt touches the real start / end of the recording. */
  preview?: { start: number; seconds: number }
  /** Skip every processing stage: only cut the excerpt (if any) and set its loudness.
   *  Used for the "original" side of an A/B comparison. */
  bypass?: boolean
  /** With `bypass`: bring the result to exactly this loudness (pass the processed preview's
   *  `after.lufs`), so the A/B compares sound, not volume. Without it the look's target is used. */
  matchLufs?: number
}

export interface AudioHost {
  /** Directory the plugin may write to (processed files, IR cache). Created if missing. */
  outputDir: string
  /** Absolute path of the ffmpeg binary (the app's ffmpeg-static). */
  ffmpegPath: string
  log: (level: 'info' | 'warn' | 'error', message: string) => void
  signal?: AbortSignal
  /** 0–100 over the whole job (measure + render + verify). */
  onProgress?: (percent: number) => void
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
  /** Plain-language findings, e.g. "Clipped: turn on Repair clipping." */
  hints: string[]
}

/** Measured on the processed file (cheap subset of AudioAnalysis). */
export interface AfterMeasure { durationSec: number; channels: number; lufs: number; truePeak: number }

export type AudioReason =
  | 'INVALID_JOB'
  | 'INVALID_LOOK'
  | 'AUDIO_UNREADABLE'
  | 'SILENT_INPUT'
  | 'FFMPEG_UNUSABLE'      // binary missing or lacks a filter the chain needs
  | 'PROCESS_FAILED'       // ffmpeg exited with an error (message carries its last lines)
  | 'TIMEOUT'              // ffmpeg stopped making progress (watchdog)
  | 'CANCELLED'
  | 'DURATION_MISMATCH'    // processed length differs from the original
  | 'SILENT_OUTPUT'
  | 'LOUDNESS_OFF_TARGET'

export type AudioResult =
  | {
      ok: true
      /** Processed audio: FLAC, 48 kHz, mono (stereo when reverb is on). */
      file: string
      /** Stable key for audio identity + resolved look + chain version; the app folds it into the video key. */
      cacheKey: string
      /** True when nothing was processed because the file already existed. */
      cached: boolean
      after: AfterMeasure
      /** Gain applied by the loudness stage, dB (0 when it is off). */
      gainDb: number
      /** Non-fatal notes (e.g. the gain was capped). */
      warnings: string[]
    }
  | { ok: false; reason: AudioReason; message: string }

export interface PluginManifest {
  id: string
  version: string
  /** Bump to invalidate every cached file (any change to how knobs become filters). */
  chainVersion: number
  /** Bumped when a knob is added or a range changes. */
  lookVersion: number
}
