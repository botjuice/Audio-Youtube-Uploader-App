/** Types shared by main, preload and renderer. Keep this file dependency-free. */

/** Everything the tokenizer could attribute in a filename. Fields are null/empty when absent. */
export interface Tokens {
  date: string | null         // normalised DD.MM.YYYY
  dateDirty: boolean          // date had junk characters (e.g. 14x.12.2024) that a fix would clean
  prayer: string | null       // canonical, e.g. "Isha"
  reciter: string | null      // reciter key (folder name normalised) found in the name
  surahs: string[]            // as written in the filename, e.g. ["Ahzab", "Munafiqoon"]
  keywords: string[]          // registered keyword names found
  leftovers: string[]         // fragments nothing could claim
}

/** A fully valid parse: date, prayer and at least one surah, nothing left over. */
export interface Parsed {
  date: string
  prayer: string
  reciter: string | null
  surahs: string[]
  keywords: string[]
}

export type ParseReason = 'NO_DATE' | 'NO_PRAYER' | 'NO_SURAH' | 'LEFTOVER'

export type ReasonCode =
  | ParseReason
  | 'NO_RECITER' | 'FILE_CONFLICT' | 'WRONG_FOLDER'
  | 'NO_RECITER_NAME' | 'NO_IMAGE' | 'ZERO_BYTES' | 'UNREADABLE'
  | 'ENCODED_NOT_UPLOADED' | 'MARKER_CORRUPT' | 'LAST_ERROR'
  | 'SKIPPED' | 'UPLOADED'

export type RecordStatus = 'ready' | 'error' | 'skipped' | 'encoded' | 'uploaded'

export type PipelineStage = 'encode' | 'upload' | 'playlist'

export interface LastError { stage: PipelineStage; message: string; at: string }

export interface LibraryRecord {
  id: string                 // "<reciterFolder>/<fileName>" — stable across sessions ("" folder = library root)
  reciterFolder: string
  reciterKey: string | null  // effective reciter (from the name, else the folder)
  fileName: string
  stem: string
  ext: string
  sizeBytes: number
  status: RecordStatus
  reason: ReasonCode | null
  message: string | null     // human explanation of reason
  suggestion: string | null  // suggested new fileName (with ext): leftovers removed / date cleaned
  fixable: boolean           // suggestion alone would make it Ready
  tokens: Tokens
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
  key: string                // folder name normalised (lowercase, alphanumerics) — what filenames are matched against
  nameAr: string | null
  aliases: string[]          // extra spellings that also identify this reciter in filenames
  imagePath: string | null   // effective image
  imageOverride: string | null
  images: string[]           // all images found in the folder
  total: number
  uploaded: number
}

export type RuleMatch = 'reciter' | 'prayer' | 'surah'

/** A free-form tag recognised in filenames; routes to zero or more playlists. */
export interface KeywordDef { name: string; playlistIds: string[] }

export interface TokenValidation { ok: boolean; key: string; error?: string; warning?: string }

export interface NewReciter { name: string; nameAr: string; playlistId?: string }

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
  updates: {
    autoCheck: boolean          // look for new versions on launch and every 6 h
    autoInstallWhenIdle: boolean // install + relaunch by itself only when the window is hidden and nothing is uploading
  }
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'installing' | 'error'

export interface UpdateState {
  status: UpdateStatus
  current: string
  latest: string | null
  notes: string | null
  releaseUrl: string | null
  percent: number
  error: string | null
  /** Why a ready update hasn't been applied yet (shown to the user). */
  deferred: string | null
  checkedAt: string | null
}

export interface Health {
  app: { version: string; platform: string }
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
  aliases?: string[]
  imageOverride?: string | null
}

export interface RecordPatch {
  selected?: boolean
  skipped?: boolean
  titleOverride?: string | null
  playlistOverrides?: PlaylistOverrides
}
