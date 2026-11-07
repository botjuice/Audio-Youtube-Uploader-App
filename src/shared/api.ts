import type {
  ActivityEntry, Health, KeywordDef, LibraryRecord, NewReciter, Playlist, PlaylistRule, Privacy, Progress,
  CustomFont, ReciterInfo, ReciterPatch, RecordPatch, RulePhoto, Settings, StyleRenderInput, StyleSchemaInfo, SurahOption, ThumbnailPreview, ThumbnailRule, TokenValidation, UpdateState,
} from './types'

export interface LibrarySnapshot {
  reciters: ReciterInfo[]
  records: LibraryRecord[]
  rules: PlaylistRule[]
  keywords: KeywordDef[]
  thumbnailRules: ThumbnailRule[]   // list order = priority; the last one is the default look
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
  addReciter(input: NewReciter): Promise<{ folder: string; moved: number }>
  validateToken(kind: 'keyword' | 'reciter', value: string): Promise<TokenValidation>
  // surahs
  listSurahs(): Promise<SurahEntry[]>
  setSurah(key: string, arabic: string): Promise<void>
  deleteSurah(key: string): Promise<void>
  // rules & keywords
  setRules(rules: PlaylistRule[]): Promise<void>
  setKeywords(keywords: KeywordDef[]): Promise<void>
  setThumbnailRules(rules: ThumbnailRule[]): Promise<void>
  // youtube
  setClientSecretFromFile(): Promise<boolean>               // opens a file dialog
  setClientSecret(clientId: string, clientSecret: string): Promise<void>
  connectYouTube(): Promise<string>                         // resolves to channel title
  disconnectYouTube(): Promise<void>
  refreshPlaylists(): Promise<Playlist[]>
  createPlaylist(title: string, privacy: Privacy): Promise<Playlist>
  syncWithYouTube(): Promise<SyncResult>
  // thumbnails
  previewThumbnail(recordId: string): Promise<ThumbnailPreview>
  previewReciterThumbnail(folder: string): Promise<ThumbnailPreview>
  retryThumbnail(recordId: string): Promise<void>
  renderStyled(input: StyleRenderInput): Promise<ThumbnailPreview>   // rule editor preview (1080p frame included)
  getStyleSchema(): Promise<StyleSchemaInfo>
  chooseRulePhoto(ruleId: string): Promise<RulePhoto | null>   // file dialog → copy into <library>/.yoosyjoosy/thumb-photos
  getRulePhoto(file: string): Promise<RulePhoto | null>
  chooseFontFile(): Promise<CustomFont | null>              // file dialog → copy into <library>/.yoosyjoosy/fonts, returns the absolute path for the style patch
  listSurahOptions(): Promise<SurahOption[]>
  // pipeline
  startUpload(ids: string[]): Promise<void>
  cancelUpload(): Promise<void>
  // updates
  getUpdateState(): Promise<UpdateState>
  checkForUpdates(): Promise<UpdateState>
  downloadUpdate(): Promise<UpdateState>
  installUpdate(): Promise<void>
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
  on(event: 'settings', cb: (s: Settings) => void): () => void
  on(event: 'update', cb: (u: UpdateState) => void): () => void
}
