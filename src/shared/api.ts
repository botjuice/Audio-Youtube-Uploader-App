import type {
  ActivityEntry, Health, LibraryRecord, Playlist, PlaylistRule, Privacy, Progress,
  ReciterInfo, ReciterPatch, RecordPatch, Settings,
} from './types'

export interface LibrarySnapshot {
  reciters: ReciterInfo[]
  records: LibraryRecord[]
  rules: PlaylistRule[]
  playlists: Playlist[]          // cached channel playlists (may be stale until refreshed)
}

export interface SurahEntry { key: string; arabic: string; source: 'default' | 'user' }

export interface SyncResult { matched: number; alreadyMarked: number; scannedVideos: number }

export interface Api {
  // settings
  getSettings(): Promise<Settings>
  setSettings(patch: Partial<Settings>): Promise<Settings>
  // library
  chooseLibrary(): Promise<string | null>
  getLibrary(): Promise<LibrarySnapshot>
  rescan(): Promise<LibrarySnapshot>
  patchRecord(id: string, patch: RecordPatch): Promise<void>
  patchRecords(ids: string[], patch: RecordPatch): Promise<void>
  renameRecord(id: string, newFileName: string): Promise<string>     // returns new id
  applyFix(id: string): Promise<string>
  applyAllFixes(): Promise<number>
  markUploaded(id: string, videoId?: string): Promise<void>
  markNotUploaded(id: string): Promise<void>
  patchReciter(folder: string, patch: ReciterPatch): Promise<void>
  // surahs
  listSurahs(): Promise<SurahEntry[]>
  setSurah(key: string, arabic: string): Promise<void>
  deleteSurah(key: string): Promise<void>
  // rules
  setRules(rules: PlaylistRule[]): Promise<void>
  // youtube
  setClientSecretFromFile(): Promise<boolean>               // opens a file dialog
  setClientSecret(clientId: string, clientSecret: string): Promise<void>
  connectYouTube(): Promise<string>                         // resolves to channel title
  disconnectYouTube(): Promise<void>
  refreshPlaylists(): Promise<Playlist[]>
  createPlaylist(title: string, privacy: Privacy): Promise<Playlist>
  syncWithYouTube(): Promise<SyncResult>
  // pipeline
  startUpload(ids: string[]): Promise<void>
  cancelUpload(): Promise<void>
  // misc
  getHealth(): Promise<Health>
  getActivity(): Promise<ActivityEntry[]>
  openExternal(url: string): Promise<void>
  showInFolder(path: string): Promise<void>
  // events
  on(event: 'library', cb: (snap: LibrarySnapshot) => void): () => void
  on(event: 'progress', cb: (p: Progress | null) => void): () => void
  on(event: 'activity', cb: (e: ActivityEntry) => void): () => void
  on(event: 'health', cb: (h: Health) => void): () => void
}
