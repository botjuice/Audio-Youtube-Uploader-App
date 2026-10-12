/** Types shared by main, preload and renderer. Keep this file dependency-free. */

export interface Parsed {
  prayer: string      // canonical, e.g. "Isha"
  surahs: string[]    // as written in the filename, e.g. ["Ahzab", "Munafiqoon"]
  date: string        // normalised DD.MM.YYYY
}

export type ParseReason =
  | 'PREFIX_MISMATCH' | 'NO_PRAYER' | 'PRAYER_ORDER' | 'BAD_DATE'
  | 'UNKNOWN_SURAH' | 'SURAH_FIXABLE'

export type ReasonCode =
  | ParseReason
  | 'NO_RECITER_NAME' | 'NO_IMAGE' | 'ZERO_BYTES' | 'UNREADABLE'
  | 'ENCODED_NOT_UPLOADED' | 'MARKER_CORRUPT' | 'LAST_ERROR'
  | 'SKIPPED' | 'UPLOADED'

export type RecordStatus = 'ready' | 'fix' | 'error' | 'skipped' | 'encoded' | 'uploaded'

export type PipelineStage = 'encode' | 'upload' | 'playlist'

export interface LastError { stage: PipelineStage; message: string; at: string }

export interface LibraryRecord {
  id: string                 // "<reciterFolder>/<fileName>" — stable across sessions
  reciterFolder: string
  fileName: string
  stem: string
  ext: string
  sizeBytes: number
  status: RecordStatus
  reason: ReasonCode | null
  message: string | null     // human explanation of reason
  suggestion: string | null  // suggested new fileName (with ext) when auto-fixable
  parsed: Parsed | null
  title: string | null       // effective title: override ?? generated
  titleOverride: string | null
  playlists: { auto: string[]; final: string[] }
  playlistOverrides: PlaylistOverrides
  selected: boolean
  skipped: boolean
  videoId: string | null
  uploadedAt: string | null
  lastError: LastError | null
  hasVideoFile: boolean
}

export interface ReciterInfo {
  folder: string
  nameAr: string | null
  prefix: string             // effective prefix used for parsing
  prefixOverride: string | null
  imagePath: string | null   // effective image
  imageOverride: string | null
  images: string[]           // all images found in the folder
  total: number
  uploaded: number
}

export type RuleMatch = 'reciter' | 'prayer' | 'surah' | 'keyword'

export interface PlaylistRule {
  id: string
  match: RuleMatch
  value: string
  playlistId: string
  enabled: boolean
}

export interface PlaylistOverrides { include: string[]; exclude: string[] }

export interface Playlist {
  id: string
  title: string
  itemCount?: number
  privacy?: string
}

export type ThemeMode = 'system' | 'light' | 'dark'
export type Privacy = 'public' | 'unlisted' | 'private'

export interface Settings {
  libraryPath: string | null
  theme: ThemeMode
  upload: {
    dailyLimit: number
    privacy: Privacy
    categoryId: string
    tags: string[]
    description: string
    madeForKids: boolean
  }
  watcher: {
    enabled: boolean
    intervalMinutes: number
    startOnLogin: boolean
    closeToTray: boolean
  }
}

export interface Health {
  library: { path: string | null; reciters: number; records: number }
  youtube: { connected: boolean; channel: string | null; error: string | null; hasClientSecret: boolean }
  ffmpeg: { ok: boolean; path: string | null }
  quota: { used: number; limit: number; remaining: number; resetsAt: string }
  watcher: { running: boolean; busy: boolean; nextRunAt: string | null }
}

export interface ActivityEntry {
  at: string
  level: 'info' | 'warn' | 'error' | 'success'
  message: string
  recordId?: string
}

export interface Progress {
  recordId: string
  stage: PipelineStage
  percent: number        // 0..100
  detail?: string
}

export interface ReciterPatch {
  nameAr?: string | null
  prefixOverride?: string | null
  imageOverride?: string | null
}

export interface RecordPatch {
  selected?: boolean
  skipped?: boolean
  titleOverride?: string | null
  playlistOverrides?: PlaylistOverrides
}
