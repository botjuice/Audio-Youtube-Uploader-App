import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Health, KeywordDef, NewReciter, Playlist, PlaylistRule, Privacy, ReciterPatch, RecordPatch, Settings, TokenValidation } from '@shared/types'
import type { LibrarySnapshot, SurahEntry, SyncResult } from '@shared/api'
import { DEFAULT_SURAHS, conditionKey, describeRule, nextQuotaReset, normaliseQuota, reciterKey, remainingUploads, surahKey, validateRule, validateToken } from '@core/index'
import { ffmpegAvailable, ffmpegPath } from './ffmpeg'
import { connect, disconnect, getClient, parseClientSecretJson, resetClient } from './google/oauth'
import { createPlaylist, getChannel, listPlaylists, listUploads } from './google/youtube'
import { currentVocabulary, effectiveSurahs, removeMarker, renameRecordFiles, scanLibrary, writeMarker, type ScanResult } from './library'
import { activity } from './log'
import { Pipeline } from './pipeline'
import { openLibraryStore, secrets, settings, type LibraryStore } from './store'
import { Watcher } from './watcher'
import { updater } from './updater'
import { buildThumbnailJob, disposeThumbnails, renderJob, sampleJobForReciter, toPreview } from './thumbnails'
import { setThumbnail } from './google/youtube'
import { THUMBNAIL_COST_UNITS, addQuota } from '@core/quota'
import type { ThumbnailPreview } from '@shared/types'

type Listener = (channel: string, payload: unknown) => void

class YoosyApp {
  settings!: Settings
  store: LibraryStore | null = null
  snapshot: ScanResult = { reciters: [], records: [], moves: [] }
  pipeline = new Pipeline()
  watcher = new Watcher()
  private channelTitle: string | null = null
  private youtubeError: string | null = null
  private listeners = new Set<Listener>()

  onBroadcast(l: Listener): () => void { this.listeners.add(l); return () => this.listeners.delete(l) }
  private broadcast(channel: string, payload: unknown) { for (const l of this.listeners) l(channel, payload) }

  async init(): Promise<void> {
    this.settings = await settings.load()
    nativeTheme.themeSource = this.settings.theme
    activity.on('entry', (e) => this.broadcast('evt:activity', e))
    this.pipeline.on('progress', (p) => this.broadcast('evt:progress', p))
    this.pipeline.on('changed', () => void this.rescan())
    this.pipeline.on('done', () => updater.maybeAutoInstall())
    updater.on('state', (s) => this.broadcast('evt:update', s))
    updater.start({
      isBusy: () => this.pipeline.busy,
      isWindowVisible: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized()),
      autoCheck: () => this.settings.updates.autoCheck,
      autoInstall: () => this.settings.updates.autoInstallWhenIdle,
      prepareForRestart: async () => { this.watcher.stop(); this.pushHealth() },
    })
    if (this.settings.libraryPath) await this.openLibrary(this.settings.libraryPath)
    void this.verifyYouTube()
  }

  /** Called by the window on hide — a hidden, idle app may self-update. */
  onWindowHidden(): void { updater.maybeAutoInstall() }

  // ── settings ───────────────────────────────────────────────────────────────
  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const prev = this.settings
    this.settings = await settings.replace({
      ...prev, ...patch,
      upload: { ...prev.upload, ...(patch.upload ?? {}) },
      watcher: { ...prev.watcher, ...(patch.watcher ?? {}) },
      updates: { ...prev.updates, ...(patch.updates ?? {}) },
      thumbnails: { ...prev.thumbnails, ...(patch.thumbnails ?? {}) },
    })
    nativeTheme.themeSource = this.settings.theme
    if (patch.libraryPath !== undefined && patch.libraryPath !== prev.libraryPath) {
      await this.openLibrary(patch.libraryPath)
    }
    if (patch.watcher) {
      if (patch.watcher.startOnLogin !== undefined && patch.watcher.startOnLogin !== prev.watcher.startOnLogin) {
        try { app.setLoginItemSettings({ openAtLogin: this.settings.watcher.startOnLogin, args: ['--hidden'] }) }
        catch (e) { activity.warn(`Could not update "start on login": ${e instanceof Error ? e.message : String(e)}`) }
      }
      this.syncWatcher()
    }
    this.broadcast('evt:settings', this.settings)
    this.pushHealth()
    return this.settings
  }

  // ── library ────────────────────────────────────────────────────────────────
  async chooseLibrary(win: BrowserWindow | null): Promise<string | null> {
    const r = await dialog.showOpenDialog(win ?? undefined as never, {
      title: 'Choose the folder that contains your reciter folders',
      properties: ['openDirectory', 'createDirectory'],
    })
    const p = r.filePaths[0]
    if (!p) return null
    await this.setSettings({ libraryPath: p })
    return p
  }

  async openLibrary(path: string | null): Promise<void> {
    this.watcher.stop()
    this.store = null
    this.snapshot = { reciters: [], records: [], moves: [] }
    activity.setLibrary(path)
    if (path) {
      try {
        await fs.access(path)
        this.store = await openLibraryStore(path)
        await this.migrateLegacy(path)
        await this.migrateV22()
        await this.rescan()
        activity.info(`Library opened: ${path}`)
      } catch (e) {
        activity.error(`Could not open library ${path}: ${e instanceof Error ? e.message : e}`)
      }
    }
    this.syncWatcher()
    this.pushHealth()
  }

  /** v2.0–2.3 → conditions model. Idempotent. */
  private async migrateV22() {
    if (!this.store) return
    type OldRule = { id: string; playlistId: string; enabled: boolean; match?: string; value?: string; conditions?: PlaylistRule['conditions']; label?: string; origin?: PlaylistRule['origin'] }
    type OldKeyword = { name: string; playlistIds?: string[] }
    const r = this.store.rules.get() as unknown as { rules: OldRule[]; keywords?: OldKeyword[] }
    if (!Array.isArray(r.keywords)) r.keywords = []
    let converted = 0
    const rules: PlaylistRule[] = []
    for (const old of r.rules) {
      if (old.conditions) { rules.push(old as PlaylistRule); continue }
      const kind = old.match as PlaylistRule['conditions'][0]['kind'] | undefined
      if (!kind || !old.value) continue
      rules.push({ id: old.id, playlistId: old.playlistId, enabled: old.enabled, conditions: [{ kind, value: old.value, negate: false }], origin: 'migrated' })
      converted++
    }
    const keywords: KeywordDef[] = []
    for (const k of r.keywords) {
      keywords.push({ name: k.name })
      for (const pid of k.playlistIds ?? []) {
        if (rules.some((x) => x.playlistId === pid && x.conditions.length === 1 && x.conditions[0]!.kind === 'keyword' && surahKey(x.conditions[0]!.value) === surahKey(k.name))) continue
        rules.push({ id: crypto.randomUUID(), playlistId: pid, enabled: true, conditions: [{ kind: 'keyword', value: k.name, negate: false }], origin: 'migrated' })
        converted++
      }
    }
    if (converted || r.keywords.some((k) => k.playlistIds)) {
      await this.store.rules.replace({ rules, keywords })
      if (converted) activity.info(`Converted ${converted} rule(s) to the new conditions format`)
    }
    const rec = this.store.reciters.get()
    let changed = false
    for (const [folder, st] of Object.entries(rec)) {
      if (st.prefixOverride) {
        const a = new Set(st.aliases ?? []); if (reciterKey(st.prefixOverride) !== reciterKey(folder)) a.add(st.prefixOverride)
        st.aliases = [...a]; delete st.prefixOverride; changed = true
      }
    }
    if (changed) await this.store.reciters.save()
  }

  /** Import v1 config (script/reciters.json, playlists.json) if present and nothing is configured yet. */
  private async migrateLegacy(path: string) {
    if (!this.store) return
    const legacy = join(path, 'script')
    const rec = this.store.reciters.get()
    if (Object.keys(rec).length === 0) {
      try {
        const j = JSON.parse(await fs.readFile(join(legacy, 'reciters.json'), 'utf8')) as Record<string, { name_ar?: string; filename_prefix?: string; playlist_id?: string; playlist_enabled?: boolean }>
        const rules: PlaylistRule[] = []
        await this.store.reciters.update((d) => {
          for (const [folder, v] of Object.entries(j)) {
            if (folder.startsWith('_')) continue
            d[folder] = { nameAr: v.name_ar ?? null, aliases: v.filename_prefix && reciterKey(v.filename_prefix) !== reciterKey(folder) ? [v.filename_prefix] : [] }
            if (v.playlist_id) rules.push({ id: crypto.randomUUID(), playlistId: v.playlist_id, enabled: v.playlist_enabled ?? true, conditions: [{ kind: 'reciter', value: folder, negate: false }], origin: 'migrated' })
          }
        })
        try {
          const p = JSON.parse(await fs.readFile(join(legacy, 'playlists.json'), 'utf8')) as { prayers?: Record<string, { playlist_id?: string; enabled?: boolean }>; surahs?: Record<string, { playlist_id?: string; enabled?: boolean }> }
          for (const [k, v] of Object.entries(p.prayers ?? {})) if (v.playlist_id) rules.push({ id: crypto.randomUUID(), playlistId: v.playlist_id, enabled: !!v.enabled, conditions: [{ kind: 'prayer', value: k, negate: false }], origin: 'migrated' })
          for (const [k, v] of Object.entries(p.surahs ?? {})) if (v.playlist_id) rules.push({ id: crypto.randomUUID(), playlistId: v.playlist_id, enabled: !!v.enabled, conditions: [{ kind: 'surah', value: k, negate: false }], origin: 'migrated' })
        } catch { /* none */ }
        if (rules.length) await this.store.rules.update((d) => { d.rules.push(...rules) })
        activity.info(`Imported v1 settings from ${legacy}`)
      } catch { /* no legacy config — fine */ }
    }
  }

  async rescan(): Promise<LibrarySnapshot> {
    if (this.store && this.settings.libraryPath) {
      this.snapshot = await scanLibrary(this.settings.libraryPath, this.store, { allowMoves: !this.pipeline.busy })
      for (const m of this.snapshot.moves) activity.info(`Moved ${m.id || m.from} → ${m.newId.split('/')[0]}/`, m.newId)
    }
    const snap = this.getLibrary()
    this.broadcast('evt:library', snap)
    this.pushHealth()
    return snap
  }

  getLibrary(): LibrarySnapshot {
    return {
      reciters: this.snapshot.reciters,
      records: this.snapshot.records,
      rules: this.store?.rules.get().rules ?? [],
      keywords: this.store?.rules.get().keywords ?? [],
      playlists: this.store?.playlists.get().items ?? [],
    }
  }

  private req(): { store: LibraryStore; library: string } {
    if (!this.store || !this.settings.libraryPath) throw new Error('Choose a library folder first')
    return { store: this.store, library: this.settings.libraryPath }
  }
  private abs(id: string): string {
    const rec = this.snapshot.records.find((r) => r.id === id)
    if (!rec) throw new Error(`Unknown recording ${id}`)
    return rec.reciterFolder ? join(this.req().library, rec.reciterFolder, rec.fileName) : join(this.req().library, rec.fileName)
  }

  async patchRecords(ids: string[], patch: RecordPatch): Promise<void> {
    const { store } = this.req()
    await store.records.update((d) => { for (const id of ids) d[id] = { ...d[id], ...patch } })
    await this.rescan()
  }

  async renameRecord(id: string, newFileName: string): Promise<string> {
    const { store } = this.req()
    const rec = this.snapshot.records.find((r) => r.id === id)
    if (!rec) throw new Error('Unknown recording')
    newFileName = newFileName.trim()
    if (!newFileName.toLowerCase().endsWith(rec.ext.toLowerCase())) newFileName += rec.ext
    if (/[\\/:*?"<>|]/.test(newFileName)) throw new Error('Filename contains characters not allowed on Windows (\\ / : * ? " < > |)')
    await renameRecordFiles(this.abs(id), newFileName)
    const newId = `${rec.reciterFolder}/${newFileName}`
    await store.records.update((d) => { if (d[id]) { d[newId] = d[id]!; delete d[id] } })
    activity.info(`Renamed ${rec.fileName} → ${newFileName}`, newId)
    await this.rescan()
    return newId
  }

  async applyFix(id: string): Promise<string> {
    const rec = this.snapshot.records.find((r) => r.id === id)
    if (!rec?.suggestion) throw new Error('No suggested fix for this recording')
    return this.renameRecord(id, rec.suggestion)
  }

  async applyAllFixes(): Promise<number> {
    let n = 0
    for (const rec of [...this.snapshot.records]) {
      if (rec.fixable && rec.suggestion) {
        try { await this.renameRecord(rec.id, rec.suggestion); n++ } catch (e) { activity.warn(`Fix skipped for ${rec.fileName}: ${e instanceof Error ? e.message : e}`) }
      }
    }
    return n
  }

  async markUploaded(id: string, videoId?: string): Promise<void> {
    const rec = this.snapshot.records.find((r) => r.id === id)
    if (!rec) throw new Error('Unknown recording')
    await writeMarker(this.abs(id), { video_id: videoId ?? '', title: rec.title ?? rec.stem, uploaded_at: new Date().toISOString(), manual: true })
    await this.req().store.records.update((d) => { d[id] = { ...d[id], selected: false, lastError: null } })
    activity.info(`Marked as uploaded: ${rec.fileName}`, id)
    await this.rescan()
  }

  async markNotUploaded(id: string): Promise<void> {
    await removeMarker(this.abs(id))
    activity.info(`Marked as not uploaded: ${id}`, id)
    await this.rescan()
  }

  async patchReciter(folder: string, patch: ReciterPatch): Promise<void> {
    const { store, library } = this.req()
    if (patch.aliases) {
      const vocab = await currentVocabulary(library, store, folder)
      const clean: string[] = []
      for (const a of patch.aliases.map((x) => x.trim()).filter(Boolean)) {
        if (reciterKey(a) === reciterKey(folder)) continue
        const v = validateToken('reciter', a, { ...vocab, reciters: { ...vocab.reciters } })
        if (!v.ok) throw new Error(`Alias “${a}”: ${v.error}`)
        if (!clean.some((c) => reciterKey(c) === v.key)) clean.push(a)
      }
      patch = { ...patch, aliases: clean }
    }
    await store.reciters.update((d) => { d[folder] = { ...d[folder], ...patch } })
    await this.rescan()
  }

  /** Create a reciter folder + registration; the next scan files every matching recording into it. */
  async addReciter(input: NewReciter): Promise<{ folder: string; moved: number }> {
    const { store, library } = this.req()
    const name = input.name.trim()
    if (!name) throw new Error('Reciter name is required')
    if (/[\\/:*?"<>|]/.test(name) || name.startsWith('.')) throw new Error('Name contains characters not allowed in folder names')
    const v = validateToken('reciter', name, await currentVocabulary(library, store))
    if (!v.ok) throw new Error(v.error)
    if (this.snapshot.reciters.some((r) => r.key === v.key)) throw new Error('A reciter with that name already exists')
    await fs.mkdir(join(library, name), { recursive: true })
    await store.reciters.update((d) => { d[name] = { nameAr: input.nameAr.trim() || null, aliases: [] } })
    if (input.playlistId) await store.rules.update((d) => { d.rules.push({ id: crypto.randomUUID(), playlistId: input.playlistId!, enabled: true, conditions: [{ kind: 'reciter', value: name, negate: false }], origin: 'reciter-added' }) })
    await this.rescan()
    const moved = this.snapshot.moves.filter((m) => m.newId.startsWith(name + '/')).length
    activity.success(`Added reciter “${name}”${moved ? ` — moved ${moved} recording(s) into the folder` : ''}`)
    return { folder: name, moved }
  }

  async validateToken(kind: 'keyword' | 'reciter', value: string): Promise<TokenValidation> {
    const { store, library } = this.req()
    return validateToken(kind, value, await currentVocabulary(library, store))
  }

  async setKeywords(keywords: KeywordDef[]): Promise<void> {
    const { store, library } = this.req()
    const base = await currentVocabulary(library, store)
    const clean: KeywordDef[] = []
    for (const k of keywords) {
      const name = k.name.trim(); if (!name) continue
      if (clean.some((c) => surahKey(c.name) === surahKey(name))) continue
      const v = validateToken('keyword', name, { ...base, keywords: clean.map((c) => c.name) })
      if (!v.ok) throw new Error(`Keyword “${name}”: ${v.error}`)
      clean.push({ name })
    }
    // a keyword still referenced by a rule cannot be removed
    const removed = store.rules.get().keywords.filter((k) => !clean.some((c) => surahKey(c.name) === surahKey(k.name)))
    for (const k of removed) {
      const users = store.rules.get().rules.filter((r) => r.conditions.some((c) => c.kind === 'keyword' && conditionKey(c) === surahKey(k.name)))
      if (users.length) throw new Error(`Keyword “${k.name}” is used by ${users.length} rule${users.length === 1 ? '' : 's'} — remove those first`)
    }
    await store.rules.update((d) => { d.keywords = clean })
    await this.rescan()
  }

  // ── surahs ─────────────────────────────────────────────────────────────────
  listSurahs(): SurahEntry[] {
    const layer = this.store?.surahs.get() ?? {}
    const out = new Map<string, SurahEntry>()
    for (const [k, v] of Object.entries(DEFAULT_SURAHS)) out.set(k, { key: k, arabic: v, source: 'default' })
    for (const [k, v] of Object.entries(layer)) { if (v === null) out.delete(k); else out.set(k, { key: k, arabic: v, source: 'user' }) }
    return [...out.values()].sort((a, b) => a.key.localeCompare(b.key))
  }
  async setSurah(key: string, arabic: string): Promise<void> {
    const k = surahKey(key)
    if (!k || !arabic.trim()) throw new Error('Both spelling and Arabic name are required')
    await this.req().store.surahs.update((d) => { d[k] = arabic.trim() })
    await this.rescan()
  }
  async deleteSurah(key: string): Promise<void> {
    await this.req().store.surahs.update((d) => { if (key in DEFAULT_SURAHS) d[key] = null; else delete d[key] })
    await this.rescan()
  }

  async setRules(rules: PlaylistRule[]): Promise<void> {
    const { store } = this.req()
    const surahs = effectiveSurahs(store.surahs.get())
    for (const r of rules) {
      const errs = validateRule(r, surahs)
      if (errs.length) throw new Error(`Rule “${describeRule(r)}”: ${errs[0]}`)
    }
    await store.rules.update((d) => { d.rules = rules })
    await this.rescan()
  }

  // ── youtube ────────────────────────────────────────────────────────────────
  async hasClientSecret(): Promise<boolean> { return !!(await secrets.getClient()) }

  async setClientSecretFromFile(win: BrowserWindow | null): Promise<boolean> {
    const r = await dialog.showOpenDialog(win ?? undefined as never, {
      title: 'Select the client_secret_….json you downloaded from Google Cloud',
      filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile'],
    })
    const p = r.filePaths[0]
    if (!p) return false
    await secrets.setClient(parseClientSecretJson(await fs.readFile(p, 'utf8')))
    resetClient(); this.pushHealth()
    return true
  }
  async setClientSecret(clientId: string, clientSecret: string): Promise<void> {
    if (!clientId.trim() || !clientSecret.trim()) throw new Error('Client ID and secret are both required')
    await secrets.setClient({ clientId: clientId.trim(), clientSecret: clientSecret.trim() })
    resetClient(); this.pushHealth()
  }

  async connectYouTube(): Promise<string> {
    await connect()
    const title = await this.verifyYouTube()
    if (!title) throw new Error(this.youtubeError ?? 'Connected, but could not read the channel')
    void this.refreshPlaylists().catch(() => {})
    return title
  }
  async disconnectYouTube(): Promise<void> {
    await disconnect()
    this.channelTitle = null; this.youtubeError = null
    this.pushHealth()
  }
  private async verifyYouTube(): Promise<string | null> {
    try {
      if (!(await getClient())) { this.channelTitle = null; this.youtubeError = null; return null }
      const ch = await getChannel()
      this.channelTitle = ch.title; this.youtubeError = null
      return ch.title
    } catch (e) {
      this.channelTitle = null
      this.youtubeError = e instanceof Error ? e.message : String(e)
      return null
    } finally {
      this.pushHealth()
    }
  }

  async refreshPlaylists(): Promise<Playlist[]> {
    const items = await listPlaylists()
    if (this.store) await this.store.playlists.replace({ items, fetchedAt: new Date().toISOString() })
    await this.rescan()
    return items
  }
  async createPlaylist(title: string, privacy: Privacy): Promise<Playlist> {
    const p = await createPlaylist(title.trim(), privacy)
    activity.success(`Created playlist “${p.title}”`)
    if (this.store) await this.store.playlists.update((d) => { d.items.unshift(p) })
    await this.rescan()
    return p
  }

  /** Match local recordings to videos already on the channel by exact title; mark them. */
  async syncWithYouTube(): Promise<SyncResult> {
    const { library } = this.req()
    const uploads = await listUploads()
    const byTitle = new Map(uploads.map((u) => [u.title.trim(), u.videoId]))
    let matched = 0, alreadyMarked = 0
    for (const rec of this.snapshot.records) {
      if (!rec.title) continue
      const vid = byTitle.get(rec.title.trim())
      if (!vid) continue
      if (rec.status === 'uploaded') { alreadyMarked++; continue }
      await writeMarker(this.abs(rec.id), { video_id: vid, title: rec.title, uploaded_at: new Date().toISOString() })
      matched++
      activity.info(`Found on YouTube → marked as uploaded (${vid})`, rec.id)
    }
    activity.success(`Sync complete: ${matched} newly matched, ${alreadyMarked} already marked, ${uploads.length} channel videos checked.`)
    await this.rescan()
    return { matched, alreadyMarked, scannedVideos: uploads.length }
  }

  // ── thumbnails ─────────────────────────────────────────────────────────────
  async previewThumbnail(recordId: string): Promise<ThumbnailPreview> {
    const { store, library } = this.req()
    const rec = this.snapshot.records.find((r) => r.id === recordId)
    if (!rec) throw new Error('Unknown recording')
    const reciter = this.snapshot.reciters.find((r) => r.key === rec.reciterKey)
    const built = buildThumbnailJob(rec, reciter, effectiveSurahs(store.surahs.get()), this.settings.thumbnails)
    if (!built.ok) return { ok: false, reason: built.reason, message: built.message }
    return toPreview(await renderJob(built.job, library, rec.id))
  }

  async previewReciterThumbnail(folder: string): Promise<ThumbnailPreview> {
    const { library } = this.req()
    const reciter = this.snapshot.reciters.find((r) => r.folder === folder)
    const job = reciter && sampleJobForReciter(reciter, this.settings.thumbnails)
    if (!job) return { ok: false, reason: 'INVALID_JOB', message: 'Set the Arabic name and add a photo to see a preview.' }
    return toPreview(await renderJob(job, library))
  }

  /** Re-send the (cached) thumbnail for an already-uploaded recording. */
  async retryThumbnail(recordId: string): Promise<void> {
    const { store, library } = this.req()
    const rec = this.snapshot.records.find((r) => r.id === recordId)
    if (!rec?.videoId) throw new Error('This recording has no YouTube video id yet')
    const reciter = this.snapshot.reciters.find((r) => r.key === rec.reciterKey)
    const built = buildThumbnailJob(rec, reciter, effectiveSurahs(store.surahs.get()), this.settings.thumbnails)
    if (!built.ok) throw new Error(built.message)
    const result = await renderJob(built.job, library, rec.id)
    if (!result.ok) throw new Error(result.message)
    try {
      await setThumbnail(rec.videoId, result.thumbnail)
      await store.quota.update((q) => addQuota(q, { units: THUMBNAIL_COST_UNITS }))
      await store.records.update((d) => { d[recordId] = { ...d[recordId], thumbnail: { ok: true, key: result.cacheKey, set: true, at: new Date().toISOString() }, lastError: null } })
      activity.success('Thumbnail set on YouTube', recordId)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await store.records.update((d) => { d[recordId] = { ...d[recordId], thumbnail: { ok: true, key: result.cacheKey, set: false, setError: msg, at: new Date().toISOString() } } })
      throw e
    } finally {
      await this.rescan()
    }
  }

  shutdown(): void { this.watcher.stop(); disposeThumbnails() }

  // ── pipeline / watcher ─────────────────────────────────────────────────────
  async startUpload(ids: string[]): Promise<void> {
    const { store, library } = this.req()
    const run = this.pipeline.run(ids, { library, store, settings: this.settings })
    this.pushHealth()
    run.finally(() => this.pushHealth()).catch((e) => activity.error(e instanceof Error ? e.message : String(e)))
  }
  cancelUpload(): void { this.pipeline.cancel() }

  private syncWatcher(): void {
    const w = this.settings.watcher
    if (w.enabled && this.store && this.settings.libraryPath) {
      this.watcher.start({
        library: this.settings.libraryPath,
        intervalMinutes: w.intervalMinutes,
        onChange: () => void this.rescan(),
        onTick: () => this.watcherTick(),
      })
      activity.info(`Watcher on — checking every ${w.intervalMinutes} min.`)
    } else {
      if (this.watcher.running) activity.info('Watcher off.')
      this.watcher.stop()
    }
  }

  private async watcherTick(): Promise<void> {
    if (this.pipeline.busy || updater.installing || !this.store || !this.settings.libraryPath) return
    await this.rescan()
    const ready = this.snapshot.records.filter((r) => (r.status === 'ready' || r.status === 'encoded') && !r.skipped).map((r) => r.id)
    if (ready.length === 0) return
    if (!(await getClient())) { activity.warn('Watcher: new files are ready but Google is not connected.'); return }
    activity.info(`Watcher: ${ready.length} ready — starting run.`)
    await this.startUpload(ready)
  }

  // ── health ─────────────────────────────────────────────────────────────────
  async getHealth(): Promise<Health> {
    const q = normaliseQuota(this.store?.quota.get())
    const limit = this.settings.upload.dailyLimit
    return {
      app: { version: app.getVersion(), platform: process.platform },
      library: { path: this.settings.libraryPath, reciters: this.snapshot.reciters.length, records: this.snapshot.records.length },
      youtube: { connected: !!this.channelTitle, channel: this.channelTitle, error: this.youtubeError, hasClientSecret: await this.hasClientSecret() },
      ffmpeg: { ok: await ffmpegAvailable(), path: ffmpegPath() },
      quota: { used: q.uploads, limit, remaining: remainingUploads(q, limit, this.settings.upload.dailyUnits), units: q.units, unitLimit: this.settings.upload.dailyUnits, resetsAt: nextQuotaReset().toISOString() },
      watcher: { running: this.watcher.running, busy: this.pipeline.busy, nextRunAt: this.watcher.nextRunAt?.toISOString() ?? null },
    }
  }
  pushHealth(): void { void this.getHealth().then((h) => this.broadcast('evt:health', h)) }

  openExternal(url: string) { return shell.openExternal(url) }
  showInFolder(p: string) { shell.showItemInFolder(p) }
}

export const yoosy = new YoosyApp()
