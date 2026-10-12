import { app, BrowserWindow, dialog, nativeTheme, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { Health, Playlist, PlaylistRule, Privacy, ReciterPatch, RecordPatch, Settings } from '@shared/types'
import type { LibrarySnapshot, SurahEntry, SyncResult } from '@shared/api'
import { DEFAULT_SURAHS, nextQuotaReset, normaliseQuota, remainingUploads, surahKey } from '@core/index'
import { ffmpegAvailable, ffmpegPath } from './ffmpeg'
import { connect, disconnect, getClient, parseClientSecretJson, resetClient } from './google/oauth'
import { createPlaylist, getChannel, listPlaylists, listUploads } from './google/youtube'
import { removeMarker, renameRecordFiles, scanLibrary, writeMarker, type ScanResult } from './library'
import { activity } from './log'
import { Pipeline } from './pipeline'
import { openLibraryStore, secrets, settings, type LibraryStore } from './store'
import { Watcher } from './watcher'

type Listener = (channel: string, payload: unknown) => void

class YoosyApp {
  settings!: Settings
  store: LibraryStore | null = null
  snapshot: ScanResult = { reciters: [], records: [] }
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
    if (this.settings.libraryPath) await this.openLibrary(this.settings.libraryPath)
    void this.verifyYouTube()
  }

  // ── settings ───────────────────────────────────────────────────────────────
  async setSettings(patch: Partial<Settings>): Promise<Settings> {
    const prev = this.settings
    this.settings = await settings.replace({
      ...prev, ...patch,
      upload: { ...prev.upload, ...(patch.upload ?? {}) },
      watcher: { ...prev.watcher, ...(patch.watcher ?? {}) },
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
    this.snapshot = { reciters: [], records: [] }
    activity.setLibrary(path)
    if (path) {
      try {
        await fs.access(path)
        this.store = await openLibraryStore(path)
        await this.migrateLegacy(path)
        await this.rescan()
        activity.info(`Library opened: ${path}`)
      } catch (e) {
        activity.error(`Could not open library ${path}: ${e instanceof Error ? e.message : e}`)
      }
    }
    this.syncWatcher()
    this.pushHealth()
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
            d[folder] = { nameAr: v.name_ar ?? null, prefixOverride: v.filename_prefix ?? null }
            if (v.playlist_id) rules.push({ id: crypto.randomUUID(), match: 'reciter', value: folder, playlistId: v.playlist_id, enabled: v.playlist_enabled ?? true })
          }
        })
        try {
          const p = JSON.parse(await fs.readFile(join(legacy, 'playlists.json'), 'utf8')) as { prayers?: Record<string, { playlist_id?: string; enabled?: boolean }>; surahs?: Record<string, { playlist_id?: string; enabled?: boolean }> }
          for (const [k, v] of Object.entries(p.prayers ?? {})) if (v.playlist_id) rules.push({ id: crypto.randomUUID(), match: 'prayer', value: k, playlistId: v.playlist_id, enabled: !!v.enabled })
          for (const [k, v] of Object.entries(p.surahs ?? {})) if (v.playlist_id) rules.push({ id: crypto.randomUUID(), match: 'surah', value: k, playlistId: v.playlist_id, enabled: !!v.enabled })
        } catch { /* none */ }
        if (rules.length) await this.store.rules.update((d) => { d.rules.push(...rules) })
        activity.info(`Imported v1 settings from ${legacy}`)
      } catch { /* no legacy config — fine */ }
    }
  }

  async rescan(): Promise<LibrarySnapshot> {
    if (this.store && this.settings.libraryPath) {
      this.snapshot = await scanLibrary(this.settings.libraryPath, this.store)
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
    return join(this.req().library, rec.reciterFolder, rec.fileName)
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
      if (rec.status === 'fix' && rec.suggestion) {
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
    const { store } = this.req()
    await store.reciters.update((d) => { d[folder] = { ...d[folder], ...patch } })
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
    await this.req().store.rules.replace({ rules })
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
      await writeMarker(join(library, rec.reciterFolder, rec.fileName), { video_id: vid, title: rec.title, uploaded_at: new Date().toISOString() })
      matched++
      activity.info(`Found on YouTube → marked as uploaded (${vid})`, rec.id)
    }
    activity.success(`Sync complete: ${matched} newly matched, ${alreadyMarked} already marked, ${uploads.length} channel videos checked.`)
    await this.rescan()
    return { matched, alreadyMarked, scannedVideos: uploads.length }
  }

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
    if (this.pipeline.busy || !this.store || !this.settings.libraryPath) return
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
      library: { path: this.settings.libraryPath, reciters: this.snapshot.reciters.length, records: this.snapshot.records.length },
      youtube: { connected: !!this.channelTitle, channel: this.channelTitle, error: this.youtubeError, hasClientSecret: await this.hasClientSecret() },
      ffmpeg: { ok: await ffmpegAvailable(), path: ffmpegPath() },
      quota: { used: q.uploads, limit, remaining: remainingUploads(q, limit), resetsAt: nextQuotaReset().toISOString() },
      watcher: { running: this.watcher.running, busy: this.pipeline.busy, nextRunAt: this.watcher.nextRunAt?.toISOString() ?? null },
    }
  }
  pushHealth(): void { void this.getHealth().then((h) => this.broadcast('evt:health', h)) }

  openExternal(url: string) { return shell.openExternal(url) }
  showInFolder(p: string) { shell.showItemInFolder(p) }
}

export const yoosy = new YoosyApp()
