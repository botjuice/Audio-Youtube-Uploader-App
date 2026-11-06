/**
 * Thumbnail plugin — public contract.
 *
 * The app hands the plugin a small, data-only job and gets back two image paths or a reason.
 * Nothing else crosses the boundary. The plugin imports nothing from src/main or src/core.
 */
import type { StylePatch } from './style'

export interface ThumbnailJob {
  /** Reciter's Arabic name as stored in the app, e.g. "عبدالله الموسى" (no prefix). */
  reciterNameAr: string
  /** Absolute path to the reciter photo (jpg/png/webp). Any aspect ratio; cropped to 16:9. */
  photoPath: string
  /** 1–2 surah names in Arabic, spelled as the app's dictionary spells them. */
  surahsAr: string[]
  /** Canonical prayer name as the app uses it: "Fajr" | "Isha" | "Taraweeh" | ... */
  prayer: string
  /** Gregorian date "YYYY-MM-DD" (from the filename's DD.MM.YYYY). */
  date: string
  options: {
    /** Prefix the name with «الشيخ». */
    sheikhPrefix: boolean
    /** Template to use. v1 ships one. */
    template: 'default'
  }
  /** Optional look: any subset of the knobs in `STYLE_SCHEMA`, grouped (photo, overlay, text,
   *  shadow, title, reciter, meta, dividers, frame, output). Missing knobs take the locked
   *  design's defaults; an empty or absent style renders the default look exactly. */
  style?: StylePatch
}

export type ThumbnailReason =
  | 'INVALID_JOB'
  | 'INVALID_STYLE'
  | 'PHOTO_UNREADABLE'
  | 'UNKNOWN_SURAH'
  | 'UNKNOWN_PRAYER'
  | 'BAD_DATE'
  | 'FONT_NOT_LOADED'
  | 'TEXT_OVERFLOW'
  | 'RENDER_FAILED'

export type ThumbnailResult =
  | {
      ok: true
      /** 1920×1080 JPEG — the video's still frame. */
      frame: string
      /** 1280×720 JPEG under 2 MB — the YouTube thumbnail. Same render, downscaled. */
      thumbnail: string
      /** Stable key for this job + style + template version; the app may use it to notice changes. */
      cacheKey: string
      /** True when nothing was rendered because both files already existed. */
      cached: boolean
      /** Non-fatal notes, e.g. the text group was pulled back inside the safe area. */
      warnings: string[]
      /** Where the text group landed, in 1280×720 template pixels (absent on cached results). */
      layout?: { inkTop: number; inkBottom: number; inkLeft: number; inkRight: number; clamped: boolean; fit: Record<string, number> }
    }
  | { ok: false; reason: ThumbnailReason; message: string }

/** Everything the app provides. Deliberately tiny: a place to write and a way to log. */
export interface PluginHost {
  /** Directory the plugin may write to. Created if missing. */
  outputDir: string
  log: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface PluginManifest {
  id: string
  version: string
  /** Bump to invalidate every cached render (e.g. after a template change). */
  templateVersion: number
  /** Bumped when a knob is added or a range changes. */
  styleVersion: number
}
